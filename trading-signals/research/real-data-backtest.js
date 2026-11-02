/*
 * Replays the Signal Desk engine on real historical prices and compares it with
 * random entries that use the same stops, targets, sizing and costs.
 *
 * Usage (Node 18+):
 *   node research/real-data-backtest.js <bitstamp-btcusd-1min.csv> [xauusd-1h.csv]
 *
 * Data used for the published results (see research/RESULTS.md):
 *   - BTCUSD 1-minute candles from Bitstamp, github.com/ff137/bitstamp-btcusd-minute-data
 *     (data/updates/btcusd_bitstamp_1min_latest.csv: timestamp,open,high,low,close,volume)
 *   - XAUUSD 1-hour sample, github.com/getdata-finance/xauusd-1h-ohlcv-metals-historical-data
 *     (XAUUSD_1h.csv: datetime,open,high,low,close,volume)
 */
const fs = require('fs');
const E = require('../engine.js');
const MS = { '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
const HIGHER = { '15m': '1h', '1h': '4h', '4h': '1d' };

function loadBitstamp(path) {
  const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [ts, o, h, l, c, v] = lines[i].split(',');
    out.push({ t: +ts * 1000, o: +o, h: +h, l: +l, c: +c, v: +v });
  }
  return out;
}
function loadGetdata(path) {
  const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
  return lines.slice(1).map((ln) => { const [dt, o, h, l, c, v] = ln.split(','); return { t: Date.parse(dt), o: +o, h: +h, l: +l, c: +c, v: +v }; });
}
function aggregate(bars, ms) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const k = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, ct: k + ms - 1 }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  return out; // last bucket may be partial -> dropped by caller
}

// Random entries with the same exit rules, sizing and costs (no signal at all).
function randomBaseline(candles, ind, opts, tradesWanted, seeds = 200) {
  const avg = [];
  for (let s = 1; s <= seeds; s++) {
    let a = s * 2654435761 >>> 0;
    const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const p = Math.min(1, tradesWanted / Math.max(1, candles.length - opts.warmup) * 3);
    const trades = [];
    let i = opts.warmup;
    while (i < candles.length - 1) {
      if (rnd() < p && Number.isFinite(ind.atr[i])) {
        const dir = rnd() < 0.5 ? 1 : -1;
        const plan = E.buildPlan(candles, ind, i, dir, candles[i + 1].o, opts);
        const res = E.simulateTrade(candles, i + 1, plan, opts);
        if (res.open) break;
        trades.push(res); i = res.exitIdx;
      } else i++;
    }
    avg.push(E.summarize(trades).avgR);
  }
  avg.sort((x, y) => x - y);
  return { mean: avg.reduce((x, y) => x + y, 0) / avg.length, p95: avg[Math.floor(avg.length * 0.95)] };
}

function evaluateMarket(name, minute, tfs, configs, splitAt) {
  const rows = [];
  for (const tf of tfs) {
    const candles = aggregate(minute, MS[tf]).slice(0, -1);
    const htf = aggregate(minute, MS[HIGHER[tf]]).slice(0, -1);
    const ind = E.computeIndicators(candles);
    const aligned = E.alignHtf(candles, htf);
    for (const cfg of configs) {
      const opts = E.resolveOpts(cfg);
      const trades = E.backtest(candles, ind, aligned, opts);
      const st = E.summarize(trades);
      const first = E.summarize(trades.filter((t) => t.time < splitAt));
      const second = E.summarize(trades.filter((t) => t.time >= splitAt));
      const rb = st.n >= 5 ? randomBaseline(candles, ind, opts, st.n) : { mean: NaN, p95: NaN };
      rows.push({ market: name, tf, rr: opts.tp2R, min: opts.threshold, scale: opts.scaleOut, n: st.n,
        win: st.winRate, avgR: st.avgR, pf: st.profitFactor, totalR: st.totalR, dd: st.maxDrawdownR, streak: st.maxLossStreak,
        tp2: st.outcomes.target, firstAvg: first.avgR, firstN: first.n, secondAvg: second.avgR, secondN: second.n,
        randMean: rb.mean, randP95: rb.p95, bars: candles.length });
    }
  }
  return rows;
}

const configs = [];
for (const min of [60, 70, 80]) for (const rr of [1, 2, 3, 5, 10, 30]) configs.push({ threshold: min, tp2R: rr, scaleOut: true });
configs.push({ threshold: 60, tp2R: 2, scaleOut: false });

const t0 = Date.now();
const [btcPath, goldPath] = process.argv.slice(2);
if (!btcPath) { console.error('usage: node research/real-data-backtest.js <bitstamp-btcusd-1min.csv> [xauusd-1h.csv]'); process.exit(1); }
const btc = loadBitstamp(btcPath);
const btcRows = evaluateMarket('BTCUSD', btc, ['15m', '1h', '4h'], configs, Date.UTC(2026, 0, 1));
const goldRows = goldPath ? evaluateMarket('XAUUSD', loadGetdata(goldPath), ['1h'], configs, Date.UTC(2026, 6, 1)) : [];

const f = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '  n/a');
console.log('market tf   min  rr  scale |   n  win%  avgR   PF   totalR  maxDD streak TP2hits | 1st-half 2nd-half | random avgR (95th pct)');
for (const r of [...btcRows, ...goldRows]) {
  console.log(`${r.market.padEnd(6)} ${r.tf.padEnd(4)} ${String(r.min).padStart(3)} ${String(r.rr).padStart(3)} ${r.scale ? 'yes' : 'no '}   | ${String(r.n).padStart(3)} ${(r.win * 100).toFixed(0).padStart(4)} ${f(r.avgR)} ${Number.isFinite(r.pf) ? r.pf.toFixed(2) : ' inf'} ${f(r.totalR, 1).padStart(7)} ${r.dd.toFixed(1).padStart(6)} ${String(r.streak).padStart(5)} ${String(r.tp2).padStart(6)}  | ${f(r.firstAvg)}(${r.firstN}) ${f(r.secondAvg)}(${r.secondN}) | ${f(r.randMean)} (${f(r.randP95)})`);
}
console.log('bars: BTC', btcRows.filter((r, i, a) => a.findIndex((x) => x.tf === r.tf) === i).map((r) => r.tf + '=' + r.bars).join(' '), goldRows.length ? '| gold 1h ' + goldRows[0].bars : '', '| took', ((Date.now() - t0) / 1000).toFixed(0) + 's');
