'use strict';
// Deterministic synthetic market data in Binance /api/v3/klines format, for tests only.

const MS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Random walk with trending regimes; the last row is the still-forming candle.
function series(symbol, interval, count, now) {
  const ms = MS[interval];
  const lastOpen = Math.floor(now / ms) * ms;
  const rand = mulberry32(hash(symbol + '|' + interval));
  let price = 20 + (hash(symbol) % 5000);
  let drift = 0;
  const rows = [];
  for (let k = 0; k < count; k++) {
    if (k % 150 === 0) drift = (rand() - 0.5) * 0.006;
    const o = price;
    const c = o * (1 + drift + (rand() - 0.5) * 0.012);
    const h = Math.max(o, c) * (1 + rand() * 0.004);
    const l = Math.min(o, c) * (1 - rand() * 0.004);
    const v = 100 + rand() * 100 + (Math.abs(c - o) / o) * 20000;
    const t = lastOpen - (count - 1 - k) * ms;
    rows.push([t, o.toFixed(8), h.toFixed(8), l.toFixed(8), c.toFixed(8), v.toFixed(3), t + ms - 1, '0', 10, '0', '0', '0']);
    price = c;
  }
  return rows;
}

// Answers a klines URL the way Binance does (limit, endTime, unknown symbols).
function klinesResponse(url, now, count = 3000) {
  const u = new URL(url);
  const symbol = u.searchParams.get('symbol');
  const interval = u.searchParams.get('interval');
  if (!/^[A-Z0-9]+USDT$/.test(symbol) || !MS[interval]) {
    return { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } };
  }
  const limit = Math.min(1000, Number(u.searchParams.get('limit') || 500));
  const endTime = u.searchParams.has('endTime') ? Number(u.searchParams.get('endTime')) : Infinity;
  const rows = series(symbol, interval, count, now).filter((r) => r[0] <= endTime);
  return { status: 200, body: rows.slice(-limit) };
}

// A fetch() replacement. `down` lists hosts that should fail with a network error.
function mockFetch(now, { down = [], calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    const host = new URL(url).origin;
    if (down.includes(host)) throw new TypeError('Failed to fetch');
    const { status, body } = klinesResponse(url, now);
    return { ok: status === 200, status, json: async () => body };
  };
}

// Convert Binance rows to engine candles.
const toCandles = (rows) => rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] }));

module.exports = { MS, series, klinesResponse, mockFetch, toCandles, mulberry32 };
