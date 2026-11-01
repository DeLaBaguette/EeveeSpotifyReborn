/*
 * Scans a list of markets and timeframes and ranks the trade ideas.
 * Browser: window.Scanner (needs SignalEngine and Market loaded first).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./market'));
  else root.Scanner = factory(root.SignalEngine, root.Market);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine, Market) {
  'use strict';

  const DEFAULT_SYMBOLS = ['XAUUSD', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT'];
  const AUTO_INTERVALS = ['15m', '1h', '4h'];
  const HISTORY = 1500;

  // Markets Binance doesn't list directly, analysed through a closely tracking instrument.
  const ALIASES = {
    XAUUSD: {
      data: 'PAXGUSDT',
      tv: 'OANDA:XAUUSD',
      unit: 'oz',
      lotSize: 100,
      note: 'Gold is analysed with PAXG (a token backed 1:1 by physical gold), which tracks spot gold closely but can differ by a few dollars from your broker’s XAUUSD. Use the distances (e.g. “−18.40”) to set your stop and targets from your actual entry price. Gold markets close at weekends while PAXG keeps trading, so ignore weekend gold signals.',
    },
  };
  const SYNONYMS = { GOLD: 'XAUUSD', XAU: 'XAUUSD', XAUUSDT: 'XAUUSD', PAXG: 'XAUUSD', PAXGUSDT: 'XAUUSD' };

  async function pool(items, size, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    });
    await Promise.all(workers);
  }

  function parseSymbols(text) {
    const clean = String(text).toUpperCase().split(/[\s,;]+/).map((s) => s.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    return [...new Set(clean.map((s) => SYNONYMS[s] || s))];
  }

  /**
   * @param {object}   p
   * @param {string[]} p.symbols
   * @param {string[]} p.intervals
   * @param {object}   [p.opts]        engine option overrides
   * @param {function} [p.onProgress]  (done, total) => void
   * @param {number}   [p.now]         override the clock (tests)
   */
  async function scan(p) {
    const now = p.now || Date.now();
    const cache = new Map();
    const get = (symbol, interval) => {
      const key = `${symbol}|${interval}`;
      if (!cache.has(key)) {
        const promise = Market.klines(symbol, interval, HISTORY);
        promise.catch(() => {}); // handled by the awaiting job
        cache.set(key, promise);
      }
      return cache.get(key);
    };

    const jobs = [];
    for (const symbol of p.symbols) for (const interval of p.intervals) jobs.push({ symbol, interval });
    const results = [];
    let done = 0;

    await pool(jobs, 4, async ({ symbol, interval }) => {
      const htfInterval = Market.HIGHER[interval];
      const meta = ALIASES[symbol] || null;
      const dataSymbol = meta ? meta.data : symbol;
      try {
        const [ltfRaw, htfRaw] = await Promise.all([get(dataSymbol, interval), get(dataSymbol, htfInterval)]);
        const ltf = Market.splitClosed(ltfRaw, now);
        const htf = Market.splitClosed(htfRaw, now);
        const analysis = Engine.analyze({
          candles: ltf.closed,
          htfCandles: htf.closed,
          livePrice: ltf.forming ? ltf.forming.c : undefined,
          htfLabel: htfInterval,
          opts: p.opts,
        });
        results.push({ symbol, dataSymbol, meta, interval, htfInterval, ...analysis });
      } catch (e) {
        results.push({ symbol, dataSymbol, meta, interval, htfInterval, error: e.message || String(e) });
      }
      done++;
      if (p.onProgress) p.onProgress(done, jobs.length);
    });

    const ranked = Engine.rank(results);
    const best = ranked.find((r) => !r.error && ['A', 'B', 'C'].includes(r.grade)) || null;
    return { results: ranked, best, scannedAt: now, source: Market.activeHost() };
  }

  return { scan, parseSymbols, DEFAULT_SYMBOLS, AUTO_INTERVALS, ALIASES };
});
