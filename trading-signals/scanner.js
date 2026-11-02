/*
 * Scans a list of markets and timeframes and ranks the trade ideas.
 * Browser: window.Scanner (needs SignalEngine and Market loaded first).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./market'));
  else root.Scanner = factory(root.SignalEngine, root.Market);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine, Market) {
  'use strict';

  // Broker-style (MT5) names. Prices for "XXXUSD" come from Binance's "XXXUSDT".
  const DEFAULT_SYMBOLS = ['XAUUSD', 'BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD', 'DOGEUSD', 'ADAUSD', 'AVAXUSD', 'LINKUSD', 'LTCUSD'];
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

  const STABLE_USD = /(BUSD|TUSD|FDUSD|USDC)$/; // Binance quotes that merely end in "USD"

  // User input -> broker-style name: "btcusdt", "BTCUSD" and "btc" all become "BTCUSD".
  function normalizeSymbol(s) {
    if (SYNONYMS[s]) return SYNONYMS[s];
    if (/USDT$/.test(s)) return s.slice(0, -1);
    if (/^[A-Z]{2,5}$/.test(s) && !/USD$/.test(s)) return s + 'USD'; // bare coin like BTC or SOL
    return s;
  }

  // Broker-style name -> the Binance symbol we read prices from.
  function dataSymbolFor(symbol) {
    if (ALIASES[symbol]) return ALIASES[symbol].data;
    if (/USD$/.test(symbol) && !STABLE_USD.test(symbol)) return symbol + 'T';
    return symbol;
  }

  function parseSymbols(text) {
    const clean = String(text).toUpperCase().split(/[\s,;]+/).map((s) => s.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
    return [...new Set(clean.map(normalizeSymbol))];
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
      const dataSymbol = dataSymbolFor(symbol);
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

  return { scan, parseSymbols, normalizeSymbol, dataSymbolFor, DEFAULT_SYMBOLS, AUTO_INTERVALS, ALIASES };
});
