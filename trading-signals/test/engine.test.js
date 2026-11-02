'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine');
const { series, toCandles, mockFetch } = require('./fixtures');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);
const NOW = Date.UTC(2026, 10, 1, 12, 30);
const opts = (o) => ({ ...E.DEFAULTS, ...o });

// Flat candle helper: open, high, low, close.
const bar = (o, h, l, c, i = 0) => ({ t: i * 60000, o, h, l, c, v: 1, ct: i * 60000 + 59999 });

test('ema is seeded with an SMA and follows the textbook recursion', () => {
  const values = Array.from({ length: 10 }, (_, i) => i + 1);
  const out = E.ema(values, 3);
  assert.ok(Number.isNaN(out[1]));
  // For a straight line, EMA(3) lags by exactly one step.
  for (let i = 2; i < 10; i++) near(out[i], i, 1e-12, `ema[${i}]`);
});

test('ema skips leading NaNs (used for the MACD signal line)', () => {
  const out = E.ema([NaN, NaN, 2, 4, 6], 2);
  assert.ok(Number.isNaN(out[2]));
  near(out[3], 3, 1e-12);
  near(out[4], 5, 1e-12);
});

test('rsi matches Wilder\'s worked example (StockCharts reference data)', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
    46.00, 46.03, 46.41, 46.22, 45.64];
  const out = E.rsi(closes, 14);
  // Exact by hand: the first 14 changes have gains summing to 3.34 and losses to 1.40.
  near(out[14], 100 - 100 / (1 + 3.34 / 1.40), 1e-9, 'rsi[14] exact');
  // StockCharts' published table (it rounds intermediate averages, hence the tolerance).
  const published = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97];
  published.forEach((v, k) => near(out[14 + k], v, 0.1, `rsi[${14 + k}]`));
});

test('atr of constant-range candles equals the range', () => {
  const candles = Array.from({ length: 30 }, (_, i) => bar(100, 101, 99, 100, i));
  const out = E.atr(candles, 14);
  near(out[29], 2, 1e-12);
});

test('adx is high with +DI dominant in a clean uptrend', () => {
  const candles = Array.from({ length: 80 }, (_, i) => bar(100 + i, 101.5 + i, 99.5 + i, 101 + i, i));
  const { adx, pdi, mdi } = E.adx(candles, 14);
  assert.ok(adx[79] > 40, `adx ${adx[79]}`);
  assert.ok(pdi[79] > mdi[79]);
});

test('indicators and signals never look ahead', () => {
  const candles = toCandles(series('LOOKUSDT', '1h', 900, NOW)).slice(0, -1);
  const htf = toCandles(series('LOOKUSDT', '4h', 600, NOW)).slice(0, -1);
  const full = E.computeIndicators(candles);
  const fullHtf = E.alignHtf(candles, htf);
  for (const i of [300, 450, 600, 750]) {
    const prefix = candles.slice(0, i + 1);
    const part = E.computeIndicators(prefix);
    const partHtf = E.alignHtf(prefix, htf);
    near(part.ema200[i], full.ema200[i], 1e-9, 'ema200');
    near(part.rsi[i], full.rsi[i], 1e-9, 'rsi');
    near(part.dmi.adx[i], full.dmi.adx[i], 1e-9, 'adx');
    near(part.macd.hist[i], full.macd.hist[i], 1e-9, 'macd');
    const a = E.evaluate(prefix, part, partHtf, i, E.DEFAULTS);
    const b = E.evaluate(candles, full, fullHtf, i, E.DEFAULTS);
    assert.equal(a.score, b.score);
    assert.equal(a.dir, b.dir);
  }
});

test('alignHtf only uses higher-timeframe candles that had already closed', () => {
  const ltf = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ t: k * 10, ct: k * 10 + 9, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  // HTF bars cover 4 LTF bars each and close at t=39 and t=79.
  const up = Array.from({ length: 60 }, (_, k) => ({ t: -1e6 + k, ct: -1e6 + k, o: k, h: k, l: k, c: k + 1, v: 1 }));
  // The HTF bar closing at t=39 is a crash that breaks the uptrend.
  const htf = [...up, { t: 0, ct: 39, o: 60, h: 60, l: 1, c: 1, v: 1 }, { t: 40, ct: 79, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const trend = E.htfTrend(htf);
  assert.equal(trend[59], 1);
  assert.notEqual(trend[60], 1);
  const out = E.alignHtf(ltf, htf);
  // LTF bars closing at 9, 19, 29 must not know about the crash yet; from 39 on they must.
  assert.deepEqual(out, [1, 1, 1, trend[60], trend[60], trend[60], trend[60], trend[61]]);
  // Without HTF data the check simply never passes.
  assert.deepEqual(E.alignHtf(ltf, []), new Array(8).fill(0));
});

test('simulateTrade: stop and target in the same candle counts as a loss', () => {
  const plan = { dir: 1, entry: 100, risk: 1, sl: 99, tp1: 101, tp2: 102 };
  const res = E.simulateTrade([bar(100, 102.5, 98.5, 100)], 0, plan, opts({ costPerSide: 0, scaleOut: true }));
  assert.equal(res.outcome, 'stop');
  near(res.r, -1, 1e-12);
});

test('simulateTrade: TP1 then back to entry is a small win (scale-out)', () => {
  const plan = { dir: 1, entry: 100, risk: 1, sl: 99, tp1: 101, tp2: 102 };
  const c = [bar(100, 101.2, 99.5, 101), bar(101, 101.1, 99.9, 100)];
  const res = E.simulateTrade(c, 0, plan, opts({ costPerSide: 0, scaleOut: true, tp1R: 1, tp2R: 2 }));
  assert.equal(res.outcome, 'breakeven');
  near(res.r, 0.5, 1e-12);
  assert.equal(res.exitIdx, 1);
});

test('simulateTrade: TP1 then TP2 pays half of each', () => {
  const plan = { dir: 1, entry: 100, risk: 1, sl: 99, tp1: 101, tp2: 102 };
  const c = [bar(100, 101.2, 99.5, 101), bar(101, 102.3, 100.5, 102)];
  const res = E.simulateTrade(c, 0, plan, opts({ costPerSide: 0, scaleOut: true, tp1R: 1, tp2R: 2 }));
  assert.equal(res.outcome, 'target');
  near(res.r, 1.5, 1e-12);
});

test('simulateTrade: TP1 and TP2 in the same candle only books TP1 for that candle', () => {
  const plan = { dir: 1, entry: 100, risk: 1, sl: 99, tp1: 101, tp2: 102 };
  const c = [bar(100, 102.5, 99.5, 102), bar(102, 102.2, 99.8, 100)];
  const res = E.simulateTrade(c, 0, plan, opts({ costPerSide: 0, scaleOut: true, tp1R: 1, tp2R: 2 }));
  assert.equal(res.outcome, 'breakeven');
});

test('simulateTrade: single target and short side', () => {
  const plan = { dir: -1, entry: 100, risk: 2, sl: 102, tp1: 98, tp2: 96 };
  const c = [bar(100, 101, 97, 98), bar(98, 98.5, 95.5, 96)];
  const res = E.simulateTrade(c, 0, plan, opts({ costPerSide: 0, scaleOut: false, tp2R: 2 }));
  assert.equal(res.outcome, 'target');
  near(res.r, 2, 1e-12);
});

test('simulateTrade: gap through the stop fills at the open', () => {
  const plan = { dir: 1, entry: 100, risk: 1, sl: 99, tp1: 101, tp2: 102 };
  const c = [bar(100, 100.5, 99.5, 99.6), bar(98, 98.5, 97.5, 98)];
  const res = E.simulateTrade(c, 0, plan, opts({ costPerSide: 0 }));
  assert.equal(res.outcome, 'stop');
  near(res.r, -2, 1e-12);
});

test('simulateTrade: fees are charged and time stop works; unfinished trades are "open"', () => {
  const plan = { dir: 1, entry: 100, risk: 1, sl: 99, tp1: 101, tp2: 102 };
  const flat = Array.from({ length: 5 }, (_, i) => bar(100, 100.5, 99.5, 100.2, i));
  const res = E.simulateTrade(flat, 0, plan, opts({ costPerSide: 0.001, maxBars: 5 }));
  assert.equal(res.outcome, 'timeout');
  near(res.r, 0.2 - 0.2, 1e-9); // +0.2R move minus 2 × 0.1% of 100 / 1 = 0.2R in costs
  assert.deepEqual(E.simulateTrade(flat, 0, plan, opts({ maxBars: 6 })), { open: true });
});

test('wilsonLower gives a pessimistic win-rate bound', () => {
  near(E.wilsonLower(50, 100), 0.4038, 1e-3);
  assert.equal(E.wilsonLower(0, 0), 0);
  assert.ok(E.wilsonLower(9, 10) < 0.9);
});

test('summarize computes win rate, expectancy, streaks and drawdown', () => {
  const trades = [-1, -1, 1.5, 0.5, -1, 1.5].map((r) => ({ r, outcome: r > 1 ? 'target' : r > 0 ? 'breakeven' : 'stop' }));
  const s = E.summarize(trades);
  assert.equal(s.n, 6);
  assert.equal(s.wins, 3);
  near(s.avgR, 0.5 / 6, 1e-12);
  near(s.profitFactor, 3.5 / 3, 1e-12);
  assert.equal(s.maxLossStreak, 2);
  near(s.maxDrawdownR, 2, 1e-12);
  assert.deepEqual(s.outcomes, { target: 2, breakeven: 1, stop: 3, timeout: 0 });
});

test('backtest trades never overlap and always enter after the signal candle', () => {
  const candles = toCandles(series('BTUSDT', '1h', 1500, NOW)).slice(0, -1);
  const htf = toCandles(series('BTUSDT', '4h', 1500, NOW)).slice(0, -1);
  const ind = E.computeIndicators(candles);
  const trades = E.backtest(candles, ind, E.alignHtf(candles, htf), E.DEFAULTS);
  assert.ok(trades.length > 0, 'expected some trades on synthetic data');
  let lastExit = -1;
  for (const t of trades) {
    assert.ok(t.signalIdx >= lastExit, 'overlapping trade');
    assert.ok(t.exitIdx > t.signalIdx);
    assert.ok(t.score >= E.DEFAULTS.threshold);
    lastExit = t.exitIdx;
  }
});

test('grading rules', () => {
  const st = (n, avgR, pf) => ({ n, avgR, profitFactor: pf });
  assert.equal(E.gradeFor(50, st(40, 0.5, 2), E.DEFAULTS), 'none');
  assert.equal(E.gradeFor(80, st(40, 0.3, 1.6), E.DEFAULTS), 'A');
  assert.equal(E.gradeFor(80, st(12, 0.3, 1.6), E.DEFAULTS), 'B');
  assert.equal(E.gradeFor(62, st(40, 0.3, 1.6), E.DEFAULTS), 'C');
  assert.equal(E.gradeFor(90, st(30, -0.1, 0.8), E.DEFAULTS), 'D');
  assert.equal(E.gradeFor(70, st(3, 1, 5), E.DEFAULTS), 'C');
  assert.ok(E.qualityFor(80, st(40, 0.3, 1.6)) > E.qualityFor(80, st(2, 0.3, 1.6)));
});

test('analyze returns a consistent plan whenever it signals', () => {
  let signals = 0;
  for (const sym of ['AAUSDT', 'BBUSDT', 'CCUSDT', 'DDUSDT', 'EEUSDT', 'FFUSDT', 'GGUSDT', 'HHUSDT']) {
    for (const cut of [0, 37, 81, 140]) {
      const rows = series(sym, '1h', 1500, NOW);
      const candles = toCandles(rows).slice(0, rows.length - 1 - cut);
      const htf = toCandles(series(sym, '4h', 1500, NOW)).slice(0, -1);
      const a = E.analyze({ candles, htfCandles: htf, htfLabel: '4h' });
      assert.ok(a.score >= 0 && a.score <= 100);
      if (!a.signal) {
        assert.equal(a.plan, null);
        assert.equal(a.grade, 'none');
        continue;
      }
      signals++;
      const p = a.plan;
      assert.ok(['A', 'B', 'C', 'D'].includes(a.grade));
      if (a.dir > 0) assert.ok(p.sl < p.entry && p.entry < p.tp1 && p.tp1 < p.tp2);
      else assert.ok(p.sl > p.entry && p.entry > p.tp1 && p.tp1 > p.tp2);
      assert.ok(p.risk >= a.atr * 0.999 && p.risk <= a.atr * 3.001, 'stop between 1 and 3 ATR');
      assert.ok(a.ageBars >= 1);
      assert.ok(a.quality >= 0 && a.quality <= 100);
    }
  }
  assert.ok(signals > 0, 'expected at least one signal across the synthetic markets');
});

test('analyze refuses to guess with too little history', () => {
  const candles = toCandles(series('SHORTUSDT', '1h', 100, NOW));
  assert.throws(() => E.analyze({ candles }), /Not enough history/);
});

test('market: pagination, forming candle split and host fallback', async () => {
  const Market = require('../market');
  Market._reset();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(NOW, { down: ['https://data-api.binance.vision'], calls });
  try {
    const candles = await Market.klines('BTCUSDT', '1h', 1500);
    assert.equal(candles.length, 1500);
    for (let i = 1; i < candles.length; i++) assert.equal(candles[i].t - candles[i - 1].t, 3600e3, 'contiguous');
    assert.equal(Market.activeHost(), 'https://api.binance.com');
    const { closed, forming } = Market.splitClosed(candles, NOW);
    assert.ok(forming && forming.ct >= NOW);
    assert.equal(closed.length, 1499);
    await assert.rejects(Market.klines('NOPE', '1h', 10), /Invalid symbol/);
  } finally {
    globalThis.fetch = realFetch;
    Market._reset();
  }
});

test('scanner ranks results and reports bad symbols without failing the scan', async () => {
  const Scanner = require('../scanner');
  require('../market')._reset();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(NOW);
  try {
    const progress = [];
    const out = await Scanner.scan({
      symbols: ['AAUSDT', 'BBUSDT', 'CCUSDT', 'BAD-ONE'],
      intervals: ['15m', '1h'],
      now: NOW,
      onProgress: (d, t) => progress.push([d, t]),
    });
    assert.equal(out.results.length, 8);
    assert.deepEqual(progress[progress.length - 1], [8, 8]);
    const errors = out.results.filter((r) => r.error);
    assert.equal(errors.length, 2);
    assert.ok(out.results.slice(-2).every((r) => r.error), 'errors sort last');
    if (out.best) assert.ok(['A', 'B', 'C'].includes(out.best.grade));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('parseSymbols cleans user input', () => {
  const { parseSymbols } = require('../scanner');
  assert.deepEqual(parseSymbols(' btcusdt, ETHUSDT;eth-usdt  btcusdt\n'), ['BTCUSD', 'ETHUSD']);
  // broker-style names, bare coins, and non-USD pairs left alone
  assert.deepEqual(parseSymbols('btc, SOLUSD, dogeusdt, ETHBTC, gold'), ['BTCUSD', 'SOLUSD', 'DOGEUSD', 'ETHBTC', 'XAUUSD']);
});

test('resolveOpts: TP1 never beyond half of TP2, time stop grows with far targets', () => {
  const d = E.resolveOpts({});
  assert.equal(d.tp1R, 1);
  assert.equal(d.maxBars, 48);
  const far = E.resolveOpts({ tp2R: 30 });
  assert.equal(far.tp1R, 1);
  assert.equal(far.maxBars, 300);
  const near = E.resolveOpts({ tp2R: 1 });
  assert.equal(near.tp1R, 0.5);
  assert.equal(near.maxBars, 48);
  // explicit values win
  assert.equal(E.resolveOpts({ tp2R: 30, tp1R: 2, maxBars: 10 }).tp1R, 2);
  assert.equal(E.resolveOpts({ tp2R: 30, tp1R: 2, maxBars: 10 }).maxBars, 10);
});

test('custom risk:reward and strictness flow through the plan and backtest', () => {
  const rows = series('RRUSDT', '1h', 1500, NOW);
  const candles = toCandles(rows).slice(0, -1);
  const htf = toCandles(series('RRUSDT', '4h', 1500, NOW)).slice(0, -1);
  const normal = E.analyze({ candles, htfCandles: htf, opts: { tp2R: 30, threshold: 50 } });
  if (normal.plan) {
    near((normal.plan.tp2 - normal.plan.entry) / (normal.plan.entry - normal.plan.sl), 30, 1e-9, 'TP2 at 30R');
    assert.ok(normal.warnings.some((w) => /Far target/.test(w)));
  }
  // every TP2 hit at 1:30 pays 0.5R (TP1) + 0.5 × 30R
  for (const t of normal.recentTrades) if (t.outcome === 'target') assert.ok(t.r > 15);
  const strict = E.analyze({ candles, htfCandles: htf, opts: { threshold: 85 } });
  const loose = E.analyze({ candles, htfCandles: htf, opts: { threshold: 50 } });
  assert.ok(strict.stats.n <= loose.stats.n, 'stricter rules take fewer trades');
});

test('gold: XAUUSD is analysed through PAXGUSDT and charted as real XAUUSD', async () => {
  const Scanner = require('../scanner');
  require('../market')._reset();
  assert.deepEqual(Scanner.parseSymbols('gold, xau, XAUUSD, paxgusdt, btcusdt'), ['XAUUSD', 'BTCUSD']);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(NOW, { calls });
  try {
    const out = await Scanner.scan({ symbols: ['XAUUSD'], intervals: ['1h'], now: NOW });
    const r = out.results[0];
    assert.ok(!r.error, r.error);
    assert.equal(r.symbol, 'XAUUSD');
    assert.equal(r.dataSymbol, 'PAXGUSDT');
    assert.equal(r.meta.tv, 'OANDA:XAUUSD');
    assert.ok(calls.every((u) => u.includes('symbol=PAXGUSDT')), 'fetches PAXG data');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('broker names: BTCUSD is priced from Binance BTCUSDT and keeps its broker name', async () => {
  const Scanner = require('../scanner');
  require('../market')._reset();
  assert.equal(Scanner.dataSymbolFor('BTCUSD'), 'BTCUSDT');
  assert.equal(Scanner.dataSymbolFor('XAUUSD'), 'PAXGUSDT');
  assert.equal(Scanner.dataSymbolFor('ETHBTC'), 'ETHBTC');
  assert.equal(Scanner.dataSymbolFor('BTCFDUSD'), 'BTCFDUSD');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(NOW, { calls });
  try {
    const out = await Scanner.scan({ symbols: ['BTCUSD'], intervals: ['1h'], now: NOW });
    const r = out.results[0];
    assert.ok(!r.error, r.error);
    assert.equal(r.symbol, 'BTCUSD');
    assert.equal(r.dataSymbol, 'BTCUSDT');
    assert.ok(calls.every((u) => u.includes('symbol=BTCUSDT')));
  } finally {
    globalThis.fetch = realFetch;
  }
});
