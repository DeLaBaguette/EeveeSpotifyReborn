/*
 * Market data from Binance's public REST API (no API key needed).
 * Works in the browser (window.Market) and in Node 18+ (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Market = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Tried in order; the first one that answers is remembered.
  // data-api.binance.vision is Binance's market-data-only mirror.
  const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api.binance.us'];

  const INTERVAL_MS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5 };

  // Which higher timeframe confirms the trend for each trading timeframe.
  const HIGHER = { '5m': '1h', '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1w' };

  let preferred = null;

  async function fetchWithTimeout(url, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    try {
      return await fetch(url, ctl ? { signal: ctl.signal } : undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function getJson(path) {
    const hosts = preferred ? [preferred, ...HOSTS.filter((h) => h !== preferred)] : HOSTS;
    let lastErr = null;
    for (const host of hosts) {
      let res;
      try {
        res = await fetchWithTimeout(host + path, 12000);
      } catch (e) {
        lastErr = e;
        continue; // network error / blocked / timeout: try the next host
      }
      if (res.ok) {
        preferred = host;
        return res.json();
      }
      if (res.status === 400) {
        // Binance answers 400 for unknown symbols — no point trying elsewhere.
        const body = await res.json().catch(() => ({}));
        throw new Error(body.msg || 'Invalid request');
      }
      lastErr = new Error(`HTTP ${res.status} from ${host}`);
    }
    throw new Error(`Could not reach Binance market data (${lastErr ? lastErr.message : 'no response'})`);
  }

  const parse = (k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] });

  // Up to `total` most recent candles (the last one may still be forming).
  async function klines(symbol, interval, total = 1500) {
    let out = [];
    let endTime = null;
    while (out.length < total) {
      const limit = Math.min(1000, total - out.length);
      const q = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}` +
        (endTime !== null ? `&endTime=${endTime}` : '');
      const rows = await getJson(q);
      if (!Array.isArray(rows) || !rows.length) break;
      out = rows.map(parse).concat(out);
      if (rows.length < limit) break;
      endTime = rows[0][0] - 1;
    }
    return out;
  }

  // Separate finished candles from the one still forming.
  function splitClosed(candles, now = Date.now()) {
    const last = candles[candles.length - 1];
    if (last && last.ct >= now) return { closed: candles.slice(0, -1), forming: last };
    return { closed: candles, forming: null };
  }

  return {
    HOSTS,
    INTERVAL_MS,
    HIGHER,
    klines,
    splitClosed,
    activeHost: () => preferred,
    _reset: () => { preferred = null; },
  };
});
