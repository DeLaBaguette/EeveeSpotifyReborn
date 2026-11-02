/*
 * Research round 2: implements research/PLAN.md exactly.
 *
 *   node research/strategy-lab.js <btcusd_bitstamp_1min_2012-2025.csv.gz> <btcusd_bitstamp_1min_latest.csv>
 *
 * Data: github.com/ff137/bitstamp-btcusd-minute-data (data/historical/*.csv.gz and data/updates/*.csv).
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const E = require('../engine.js');

const HOUR = 36e5;
const DAY = 864e5;
const START = Date.UTC(2017, 5, 1); // warm-up only
const PERIODS = [
  { name: 'DEV', from: Date.UTC(2018, 0, 1), to: Date.UTC(2023, 0, 1) },
  { name: 'VAL', from: Date.UTC(2023, 0, 1), to: Date.UTC(2025, 0, 1) },
  { name: 'TEST', from: Date.UTC(2025, 0, 1), to: Infinity },
];
const COST = 0.0006;   // per fill
const FIN_MAIN = 0.0005; // overnight fee per day held (typical crypto CFD)
const SEEDS = 200;

// ------------------------------------------------------------------ data

function aggregator(ms) {
  const out = [];
  let cur = null;
  return {
    add(t, o, h, l, c, v) {
      const k = Math.floor(t / ms) * ms;
      if (cur && k === cur.t) {
        if (h > cur.h) cur.h = h;
        if (l < cur.l) cur.l = l;
        cur.c = c;
        cur.v += v;
        return;
      }
      if (cur && k < cur.t) return; // ignore out-of-order rows
      if (cur) out.push(cur);
      cur = { t: k, o, h, l, c, v, ct: k + ms - 1 };
    },
    bars: () => out, // the last (possibly partial) bucket is left out
  };
}

async function readCsv(path, gz, onRow) {
  const input = gz ? fs.createReadStream(path).pipe(zlib.createGunzip()) : fs.createReadStream(path);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const a = line.split(',');
    const t = +a[0] * 1000;
    if (t < START) continue;
    onRow(t, +a[1], +a[2], +a[3], +a[4], +a[5]);
  }
}

function regroup(bars, ms) {
  const agg = aggregator(ms);
  for (const b of bars) agg.add(b.t, b.o, b.h, b.l, b.c, b.v);
  return agg.bars();
}

// ------------------------------------------------------------ indicators

function donchian(bars, n) {
  const hi = new Array(bars.length).fill(NaN);
  const lo = new Array(bars.length).fill(NaN);
  for (let i = n; i < bars.length; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - n; j < i; j++) { if (bars[j].h > h) h = bars[j].h; if (bars[j].l < l) l = bars[j].l; }
    hi[i] = h;
    lo[i] = l;
  }
  return { hi, lo };
}

// --------------------------------------------------------------- engine

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generic one-position backtest.
 * strat: { warmup, allowShort, entry(i)->-1|0|1, stopDist(i)->price distance, exit(i,pos)->bool, targetR? }
 * mode.random: { p, rand, holds[] } replaces entry() and exit() with random timing (same stops/costs).
 */
function run(bars, strat, fin, random) {
  const trades = [];
  let pos = null;
  const close = (fill, time) => {
    const days = Math.max(0, (time - pos.entryTime) / DAY);
    const r = ((fill - pos.entry) * pos.dir) / pos.risk
      - (2 * COST * pos.entry) / pos.risk
      - (fin * days * pos.entry) / pos.risk;
    trades.push({ r, dir: pos.dir, time: pos.entryTime, days, bars: pos.held });
    pos = null;
  };
  for (let i = strat.warmup; i < bars.length - 1; i++) {
    if (pos && pos.start <= i) {
      pos.held = i - pos.start + 1;
      const b = bars[i];
      const hitStop = pos.dir > 0 ? b.l <= pos.stop : b.h >= pos.stop;
      const hitTgt = pos.target != null && (pos.dir > 0 ? b.h >= pos.target : b.l <= pos.target);
      if (hitStop) close(pos.dir > 0 ? Math.min(pos.stop, b.o) : Math.max(pos.stop, b.o), b.ct);
      else if (hitTgt) close(pos.dir > 0 ? Math.max(pos.target, b.o) : Math.min(pos.target, b.o), b.ct);
    }
    if (pos && pos.start <= i) {
      const out = random ? pos.held >= pos.hold : strat.exit(i, pos);
      if (out) close(bars[i + 1].o, bars[i + 1].t);
    }
    if (!pos) {
      let d = 0;
      if (random) {
        if (random.rand() < random.p) d = strat.allowShort && random.rand() < 0.5 ? -1 : 1;
      } else {
        d = strat.entry(i);
        if (d < 0 && !strat.allowShort) d = 0;
      }
      if (d) {
        const dist = strat.stopDist(i);
        if (dist > 0) {
          const entry = bars[i + 1].o;
          pos = {
            dir: d, entry, risk: dist, stop: entry - d * dist,
            target: strat.targetR ? entry + d * dist * strat.targetR : null,
            start: i + 1, entryTime: bars[i + 1].t, held: 0,
            hold: random ? random.holds[Math.floor(random.rand() * random.holds.length)] : 0,
          };
        }
      }
    }
  }
  return trades;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, avgR: 0, win: 0, pf: 0, t: 0, totalR: 0, dd: 0, streak: 0, ret1: 0 };
  let sum = 0, sq = 0, wins = 0, gw = 0, gl = 0, peak = 0, eq = 0, dd = 0, streak = 0, maxStreak = 0, growth = 1;
  for (const x of trades) {
    sum += x.r; sq += x.r * x.r;
    if (x.r > 0) { wins++; gw += x.r; streak = 0; } else { gl -= x.r; streak++; maxStreak = Math.max(maxStreak, streak); }
    eq += x.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    growth *= 1 + 0.01 * x.r;
  }
  const avg = sum / n;
  const sd = Math.sqrt(Math.max(0, sq / n - avg * avg) * (n / Math.max(1, n - 1)));
  return {
    n, avgR: avg, win: wins / n, pf: gl ? gw / gl : (gw ? Infinity : 0),
    t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, totalR: sum, dd, streak: maxStreak, ret1: growth - 1,
  };
}

const inPeriod = (trades, p) => trades.filter((x) => x.time >= p.from && x.time < p.to);

// Random entries with the strategy's own stop rule and holding times.
function randomBaseline(bars, strat, fin, real, period) {
  const own = inPeriod(real, period);
  if (own.length < 5) return { mean: NaN, p95: NaN };
  const holds = own.map((x) => Math.max(1, x.bars || 1));
  const barsInPeriod = bars.filter((b) => b.t >= period.from && b.t < period.to).length;
  let p = own.length / Math.max(1, barsInPeriod);
  // one calibration pass so random runs take about as many trades
  const probe = inPeriod(run(bars, strat, fin, { p, rand: rng(12345), holds }), period).length;
  if (probe > 0) p = Math.min(1, p * (own.length / probe));
  const avgs = [];
  for (let s = 1; s <= SEEDS; s++) avgs.push(stats(inPeriod(run(bars, strat, fin, { p, rand: rng(s * 7919), holds }), period)).avgR);
  avgs.sort((a, b) => a - b);
  return { mean: avgs.reduce((a, b) => a + b, 0) / avgs.length, p95: avgs[Math.floor(avgs.length * 0.95)] };
}

// ------------------------------------------------------------ strategies

function buildStrategies(h1, h4, d1) {
  const list = [];

  // S1: the app's engine (4h, daily trend filter); run through the app's own backtest.
  const ind4 = E.computeIndicators(h4);
  const htf4 = E.alignHtf(h4, d1);
  for (const min of [60, 70]) for (const rr of [2, 3, 5]) {
    const opts = E.resolveOpts({ threshold: min, tp2R: rr });
    list.push({
      family: 'S1 Signal Desk 4h', label: `min ${min}, 1:${rr}`, engine: true, bars: h4,
      trades(fin) {
        return E.backtest(h4, ind4, htf4, opts).map((t) => {
          const plan = E.buildPlan(h4, ind4, t.signalIdx, t.dir, h4[t.signalIdx + 1].o, opts);
          const days = (t.bars * 4) / 24;
          return { r: t.r - (fin * days * plan.entry) / plan.risk, dir: t.dir, time: t.time, days, bars: t.bars };
        });
      },
      random(fin, period) {
        const avgs = [];
        const own = inPeriod(this.trades(fin), period);
        if (own.length < 5) return { mean: NaN, p95: NaN };
        const idx = h4.map((b, i) => i).filter((i) => h4[i].t >= period.from && h4[i].t < period.to && i >= opts.warmup && i < h4.length - 1);
        const p = Math.min(1, (own.length / idx.length) * 3);
        for (let s = 1; s <= SEEDS; s++) {
          const rand = rng(s * 104729);
          const out = [];
          for (let k = 0; k < idx.length; k++) {
            const i = idx[k];
            if (rand() >= p) continue;
            const dir = rand() < 0.5 ? 1 : -1;
            const plan = E.buildPlan(h4, ind4, i, dir, h4[i + 1].o, opts);
            const res = E.simulateTrade(h4, i + 1, plan, opts);
            if (res.open) break;
            out.push(res.r - (fin * ((res.bars * 4) / 24) * plan.entry) / plan.risk);
            while (k < idx.length && idx[k] < res.exitIdx) k++;
          }
          avgs.push(out.length ? out.reduce((a, b) => a + b, 0) / out.length : 0);
        }
        avgs.sort((a, b) => a - b);
        return { mean: avgs.reduce((a, b) => a + b, 0) / avgs.length, p95: avgs[Math.floor(avgs.length * 0.95)] };
      },
    });
  }

  // S2: Donchian breakout (1d and 4h)
  for (const [bars, fam] of [[d1, 'S2d Breakout 1d'], [h4, 'S2h Breakout 4h']]) {
    const atr = E.atr(bars, 20);
    for (const n of [20, 55]) {
      const entryCh = donchian(bars, n);
      const exitCh = donchian(bars, Math.round(n / 2));
      for (const allowShort of [false, true]) {
        list.push(generic(fam, `N ${n}, ${allowShort ? 'long & short' : 'long only'}`, bars, {
          warmup: Math.max(n, 21), allowShort,
          entry: (i) => (bars[i].c > entryCh.hi[i] ? 1 : bars[i].c < entryCh.lo[i] ? -1 : 0),
          stopDist: (i) => 2 * atr[i],
          exit: (i, pos) => (pos.dir > 0 ? bars[i].c < exitCh.lo[i] : bars[i].c > exitCh.hi[i]),
        }));
      }
    }
  }

  // S3: moving-average trend (1d)
  {
    const atr = E.atr(d1, 20);
    const closes = d1.map((b) => b.c);
    for (const n of [50, 100, 200]) {
      const ma = E.sma(closes, n);
      for (const allowShort of [false, true]) {
        list.push(generic('S3 MA trend 1d', `SMA ${n}, ${allowShort ? 'long & short' : 'long only'}`, d1, {
          warmup: n, allowShort,
          entry: (i) => (d1[i].c > ma[i] ? 1 : d1[i].c < ma[i] ? -1 : 0),
          stopDist: (i) => 3 * atr[i],
          exit: (i, pos) => (pos.dir > 0 ? d1[i].c < ma[i] : d1[i].c > ma[i]),
        }));
      }
    }
  }

  // S4: RSI(2) pullback in trend (1h and 4h)
  for (const [bars, fam] of [[h1, 'S4h RSI(2) pullback 1h'], [h4, 'S4f RSI(2) pullback 4h']]) {
    const closes = bars.map((b) => b.c);
    const r2 = E.rsi(closes, 2);
    const ma = E.sma(closes, 200);
    const atr = E.atr(bars, 14);
    for (const allowShort of [false, true]) {
      list.push(generic(fam, allowShort ? 'long & short' : 'long only', bars, {
        warmup: 200, allowShort,
        entry: (i) => (bars[i].c > ma[i] && r2[i] < 10 ? 1 : bars[i].c < ma[i] && r2[i] > 90 ? -1 : 0),
        stopDist: (i) => 2.5 * atr[i],
        exit: (i, pos) => (pos.dir > 0 ? r2[i] > 70 : r2[i] < 30) || pos.held >= 10,
      }));
    }
  }
  return list;
}

function generic(family, label, bars, strat) {
  const cache = new Map();
  return {
    family, label, bars,
    trades(fin) {
      if (!cache.has(fin)) cache.set(fin, run(bars, strat, fin, null));
      return cache.get(fin);
    },
    random(fin, period) { return randomBaseline(bars, strat, fin, this.trades(fin), period); },
  };
}

function buyHold(d1, p) {
  const bars = d1.filter((b) => b.t >= p.from && b.t < p.to);
  let peak = 0, dd = 0;
  for (const b of bars) { peak = Math.max(peak, b.c); dd = Math.max(dd, 1 - b.c / peak); }
  return { ret: bars[bars.length - 1].c / bars[0].o - 1, dd };
}

// ------------------------------------------------------------------ main

(async () => {
  const [histPath, latestPath] = process.argv.slice(2);
  if (!histPath || !latestPath) {
    console.error('usage: node research/strategy-lab.js <historical.csv.gz> <latest.csv>');
    process.exit(1);
  }
  const t0 = Date.now();
  const agg = aggregator(HOUR);
  await readCsv(histPath, true, agg.add);
  await readCsv(latestPath, false, agg.add);
  const h1 = agg.bars();
  const h4 = regroup(h1, 4 * HOUR);
  const d1 = regroup(h1, DAY);
  console.log(`Data: ${new Date(h1[0].t).toISOString().slice(0, 10)} -> ${new Date(h1[h1.length - 1].ct).toISOString().slice(0, 16)} | 1h ${h1.length}, 4h ${h4.length}, 1d ${d1.length} bars | loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const [DEV, VAL, TEST] = PERIODS;
  const strategies = buildStrategies(h1, h4, d1);
  const f = (x, d = 2) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : 'n/a');
  const row = (s) => `n ${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(0).padStart(3)}%  avg ${f(s.avgR)}R  PF ${Number.isFinite(s.pf) ? s.pf.toFixed(2) : 'inf'}  t ${f(s.t, 1)}  DD ${s.dd.toFixed(1)}R  streak ${s.streak}  @1%risk ${f(s.ret1 * 100, 0)}%`;

  console.log(`\n=== 1. DEVELOPMENT ${'2018-2022'}: every setting (overnight fee ${FIN_MAIN * 100}%/day) ===`);
  const families = new Map();
  for (const s of strategies) {
    const dev = stats(inPeriod(s.trades(FIN_MAIN), DEV));
    console.log(`${s.family.padEnd(24)} ${s.label.padEnd(22)} ${row(dev)}`);
    if (!families.has(s.family)) families.set(s.family, []);
    families.get(s.family).push({ s, dev });
  }

  console.log('\n=== 2. CHOSEN SETTINGS -> VALIDATION 2023-2024 ===');
  const chosen = [];
  for (const [fam, items] of families) {
    const eligible = items.filter((x) => x.dev.n >= 30).sort((a, b) => b.dev.avgR - a.dev.avgR);
    if (!eligible.length) { console.log(`${fam.padEnd(24)} dropped: no setting with 30+ development trades`); continue; }
    const pick = eligible[0];
    const val = stats(inPeriod(pick.s.trades(FIN_MAIN), VAL));
    const rnd = pick.s.random(FIN_MAIN, VAL);
    const pass = val.n > 0 && val.avgR > 0 && val.t >= 1 && val.avgR > rnd.mean;
    chosen.push({ ...pick, val, rndVal: rnd, pass });
    console.log(`${fam.padEnd(24)} ${pick.s.label.padEnd(22)} DEV avg ${f(pick.dev.avgR)}R (${pick.dev.n}) | VAL ${row(val)} | random ${f(rnd.mean)} (95th ${f(rnd.p95)}) => ${pass ? 'PASS' : 'fail'}`);
  }

  console.log('\n=== 3. FINAL TEST 2025-2026 (run once) ===');
  for (const c of chosen) {
    const test = stats(inPeriod(c.s.trades(FIN_MAIN), TEST));
    const test0 = stats(inPeriod(c.s.trades(0), TEST));
    const rnd = c.s.random(FIN_MAIN, TEST);
    console.log(`${(c.pass ? '[candidate] ' : '[failed val] ') + c.s.family.padEnd(24)} ${c.s.label.padEnd(22)} | ${row(test)} | random ${f(rnd.mean)} (95th ${f(rnd.p95)}) | no overnight fee: avg ${f(test0.avgR)}R`);
  }

  console.log('\n=== Buy & hold BTC (for comparison) ===');
  for (const p of PERIODS) {
    const bh = buyHold(d1, p);
    console.log(`${p.name.padEnd(5)} return ${f(bh.ret * 100, 0)}%  worst drop ${(bh.dd * 100).toFixed(0)}%`);
  }
  console.log(`\nfinished in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
