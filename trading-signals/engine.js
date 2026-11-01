/*
 * Signal Desk engine — pure functions, no network or DOM access.
 *
 * Works in the browser (exposed as window.SignalEngine) and in Node (require).
 *
 * Candle format: { t: openTimeMs, o, h, l, c, v, ct: closeTimeMs }
 *
 * Everything here is causal: the value at bar i only ever uses bars 0..i,
 * so the backtest cannot "see the future".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignalEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    threshold: 60,        // minimum confluence score (0-100) before a trade is suggested
    tp1R: 1,              // first target, in multiples of the risk (R)
    tp2R: 2,              // final target, in R
    scaleOut: true,       // close 50% at TP1 and move the stop to entry
    slAtr: 1.5,           // base stop distance in ATRs
    minSlAtr: 1.0,        // never tighter than this
    maxSlAtr: 3.0,        // never wider than this
    swingLookback: 10,    // bars used to find the recent swing high/low for the stop
    maxBars: 48,          // time stop: exit at market after this many bars
    costPerSide: 0.0006,  // fees + slippage per fill, as a fraction of price (0.06%)
    warmup: 210,          // bars needed before indicators (200 EMA) are reliable
  });

  // ---------------------------------------------------------------------------
  // Indicators
  // ---------------------------------------------------------------------------

  function sma(values, period) {
    const out = new Array(values.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  // EMA seeded with the SMA of the first `period` finite values (leading NaNs skipped).
  function ema(values, period) {
    const out = new Array(values.length).fill(NaN);
    const k = 2 / (period + 1);
    let start = 0;
    while (start < values.length && !Number.isFinite(values[start])) start++;
    if (values.length - start < period) return out;
    let prev = 0;
    for (let i = start; i < start + period; i++) prev += values[i];
    prev /= period;
    out[start + period - 1] = prev;
    for (let i = start + period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  const toRsi = (ag, al) => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));

  // Wilder's RSI.
  function rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(NaN);
    if (closes.length <= period) return out;
    let ag = 0;
    let al = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) ag += d;
      else al -= d;
    }
    ag /= period;
    al /= period;
    out[period] = toRsi(ag, al);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + Math.max(d, 0)) / period;
      al = (al * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = toRsi(ag, al);
    }
    return out;
  }

  function trueRanges(candles) {
    return candles.map((b, i) => {
      if (i === 0) return b.h - b.l;
      const pc = candles[i - 1].c;
      return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    });
  }

  // Wilder's ATR.
  function atr(candles, period = 14) {
    const tr = trueRanges(candles);
    const out = new Array(tr.length).fill(NaN);
    if (tr.length < period) return out;
    let prev = 0;
    for (let i = 0; i < period; i++) prev += tr[i];
    prev /= period;
    out[period - 1] = prev;
    for (let i = period; i < tr.length; i++) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const line = closes.map((_, i) => ef[i] - es[i]);
    const sig = ema(line, signal);
    const hist = line.map((v, i) => v - sig[i]);
    return { line, signal: sig, hist };
  }

  // Wilder's DMI / ADX.
  function adx(candles, period = 14) {
    const n = candles.length;
    const adxOut = new Array(n).fill(NaN);
    const pdiOut = new Array(n).fill(NaN);
    const mdiOut = new Array(n).fill(NaN);
    if (n < period * 2) return { adx: adxOut, pdi: pdiOut, mdi: mdiOut };
    const tr = trueRanges(candles);
    const dx = new Array(n).fill(NaN);
    let sTR = 0;
    let sP = 0;
    let sM = 0;
    for (let i = 1; i < n; i++) {
      const up = candles[i].h - candles[i - 1].h;
      const down = candles[i - 1].l - candles[i].l;
      const pDM = up > down && up > 0 ? up : 0;
      const mDM = down > up && down > 0 ? down : 0;
      if (i <= period) {
        sTR += tr[i];
        sP += pDM;
        sM += mDM;
        if (i < period) continue;
      } else {
        sTR = sTR - sTR / period + tr[i];
        sP = sP - sP / period + pDM;
        sM = sM - sM / period + mDM;
      }
      const pdi = sTR === 0 ? 0 : (100 * sP) / sTR;
      const mdi = sTR === 0 ? 0 : (100 * sM) / sTR;
      pdiOut[i] = pdi;
      mdiOut[i] = mdi;
      dx[i] = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    }
    let prev = 0;
    for (let i = period; i < 2 * period; i++) prev += dx[i];
    prev /= period;
    adxOut[2 * period - 1] = prev;
    for (let i = 2 * period; i < n; i++) {
      prev = (prev * (period - 1) + dx[i]) / period;
      adxOut[i] = prev;
    }
    return { adx: adxOut, pdi: pdiOut, mdi: mdiOut };
  }

  function computeIndicators(candles) {
    const closes = candles.map((b) => b.c);
    return {
      ema20: ema(closes, 20),
      ema50: ema(closes, 50),
      ema200: ema(closes, 200),
      rsi: rsi(closes, 14),
      macd: macd(closes),
      atr: atr(candles, 14),
      dmi: adx(candles, 14),
      volSma: sma(candles.map((b) => b.v), 20),
    };
  }

  // Higher-timeframe trend per HTF bar: +1 up, -1 down, 0 unclear.
  function htfTrend(htfCandles) {
    const closes = htfCandles.map((b) => b.c);
    const e21 = ema(closes, 21);
    const e50 = ema(closes, 50);
    return htfCandles.map((b, i) => {
      if (!Number.isFinite(e50[i])) return 0;
      if (b.c > e50[i] && e21[i] > e50[i]) return 1;
      if (b.c < e50[i] && e21[i] < e50[i]) return -1;
      return 0;
    });
  }

  // For each lower-timeframe bar, the trend of the last HTF bar that had
  // already closed by then (no peeking at an unfinished HTF candle).
  function alignHtf(ltf, htf) {
    const out = new Array(ltf.length).fill(0);
    if (!htf || !htf.length) return out;
    const trend = htfTrend(htf);
    let k = -1;
    for (let i = 0; i < ltf.length; i++) {
      while (k + 1 < htf.length && htf[k + 1].ct <= ltf[i].ct) k++;
      out[i] = k >= 0 ? trend[k] : 0;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  function scoreAt(candles, ind, htf, i, dir, htfLabel) {
    const b = candles[i];
    const c = b.c;
    const up = dir > 0;
    const e20 = ind.ema20[i];
    const e50 = ind.ema50[i];
    const e200 = ind.ema200[i];
    const hist = ind.macd.hist[i];
    const histPrev = ind.macd.hist[i - 1];
    const r = ind.rsi[i];
    const a = ind.atr[i];
    const adxv = ind.dmi.adx[i];
    const pdi = ind.dmi.pdi[i];
    const mdi = ind.dmi.mdi[i];
    const tf = htfLabel ? ` (${htfLabel})` : '';

    const checks = [
      { key: 'trend', weight: 15, pass: up ? c > e200 : c < e200,
        label: up ? 'Price above the 200 EMA — long-term uptrend' : 'Price below the 200 EMA — long-term downtrend' },
      { key: 'emaStack', weight: 15, pass: up ? e20 > e50 : e20 < e50,
        label: up ? '20 EMA above 50 EMA — short-term trend up' : '20 EMA below 50 EMA — short-term trend down' },
      { key: 'htf', weight: 20, pass: htf[i] === dir,
        label: `Higher timeframe${tf} trend agrees` },
      { key: 'macd', weight: 10, pass: up ? hist > 0 : hist < 0,
        label: up ? 'MACD momentum is positive' : 'MACD momentum is negative' },
      { key: 'macdTurn', weight: 5, pass: up ? hist > histPrev : hist < histPrev,
        label: 'Momentum is accelerating in the trade direction' },
      { key: 'rsi', weight: 10, pass: up ? r >= 50 && r <= 70 : r >= 30 && r <= 50,
        label: up ? 'RSI in the bullish zone (50–70)' : 'RSI in the bearish zone (30–50)' },
      { key: 'adx', weight: 10, pass: adxv >= 20 && (up ? pdi > mdi : mdi > pdi),
        label: 'Trend is strong (ADX ≥ 20) and pointing the right way' },
      { key: 'extension', weight: 10, pass: Math.abs(c - e20) <= 1.5 * a,
        label: 'Not over-extended (within 1.5 ATR of the 20 EMA)' },
      { key: 'volume', weight: 5, pass: b.v > ind.volSma[i],
        label: 'Volume above its 20-bar average' },
    ];

    let score = 0;
    for (const ch of checks) if (ch.pass) score += ch.weight;

    if (up ? r > 78 : r < 22) {
      score -= 15;
      checks.push({ key: 'exhaustion', weight: -15, pass: true, penalty: true,
        label: up ? 'RSI overbought (> 78) — high risk of chasing the top' : 'RSI oversold (< 22) — high risk of chasing the bottom' });
    }
    return { score: Math.max(0, score), checks };
  }

  function indicatorsReady(ind, i) {
    return [ind.ema200[i], ind.rsi[i], ind.atr[i], ind.macd.hist[i - 1], ind.dmi.adx[i], ind.volSma[i]]
      .every(Number.isFinite);
  }

  // Best direction at bar i. `dir` is the leaning direction (even when weak);
  // `signal` is true only when the score clears the threshold.
  function evaluate(candles, ind, htf, i, opts, htfLabel) {
    if (i < 1 || !indicatorsReady(ind, i)) {
      return { dir: 0, score: 0, longScore: 0, shortScore: 0, checks: [], signal: false };
    }
    const L = scoreAt(candles, ind, htf, i, 1, htfLabel);
    const S = scoreAt(candles, ind, htf, i, -1, htfLabel);
    const dir = L.score > S.score ? 1 : S.score > L.score ? -1 : 0;
    const best = dir >= 0 ? L : S;
    return {
      dir,
      score: dir === 0 ? L.score : best.score,
      longScore: L.score,
      shortScore: S.score,
      checks: best.checks,
      signal: dir !== 0 && best.score >= opts.threshold,
    };
  }

  // ---------------------------------------------------------------------------
  // Trade plan & simulation
  // ---------------------------------------------------------------------------

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function buildPlan(candles, ind, i, dir, entry, opts) {
    const a = ind.atr[i];
    const from = Math.max(0, i - opts.swingLookback + 1);
    let swing = dir > 0 ? Infinity : -Infinity;
    for (let j = from; j <= i; j++) {
      swing = dir > 0 ? Math.min(swing, candles[j].l) : Math.max(swing, candles[j].h);
    }
    // Stop goes beyond the recent swing (plus a buffer) or 1.5 ATR, whichever is
    // further, but is kept between 1 and 3 ATR.
    const structural = dir > 0 ? entry - swing + 0.25 * a : swing - entry + 0.25 * a;
    const risk = clamp(Math.max(opts.slAtr * a, structural), opts.minSlAtr * a, opts.maxSlAtr * a);
    return {
      dir,
      entry,
      risk,
      atr: a,
      sl: entry - dir * risk,
      tp1: entry + dir * risk * opts.tp1R,
      tp2: entry + dir * risk * opts.tp2R,
      tp1R: opts.tp1R,
      tp2R: opts.tp2R,
      scaleOut: opts.scaleOut,
    };
  }

  // Walk forward bar by bar from `startIdx` (entry at that bar's open price).
  // Whenever one candle touches both the stop and a target we assume the stop
  // was hit first — the pessimistic choice.
  function simulateTrade(candles, startIdx, plan, opts) {
    const { dir, entry, risk } = plan;
    const half = opts.scaleOut ? 0.5 : 0;
    const costR = (2 * opts.costPerSide * entry) / risk;
    const lastWanted = startIdx + opts.maxBars - 1;
    const last = Math.min(candles.length - 1, lastWanted);
    let stop = plan.sl;
    let stage = 0;
    let locked = 0;
    const done = (outcome, r, exitIdx) => ({ outcome, r, exitIdx, bars: exitIdx - startIdx + 1 });

    for (let j = startIdx; j <= last; j++) {
      const b = candles[j];
      const hitStop = dir > 0 ? b.l <= stop : b.h >= stop;
      const hitT2 = dir > 0 ? b.h >= plan.tp2 : b.l <= plan.tp2;
      // If the candle opened through the stop (a gap), we get filled at the open.
      const stopFill = dir > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o);
      if (stage === 0) {
        if (hitStop) return done('stop', ((stopFill - entry) * dir) / risk - costR, j);
        if (!opts.scaleOut && hitT2) return done('target', opts.tp2R - costR, j);
        const hitT1 = opts.scaleOut && (dir > 0 ? b.h >= plan.tp1 : b.l <= plan.tp1);
        if (hitT1) {
          locked = half * opts.tp1R;
          stage = 1;
          stop = entry;
          continue; // don't give ourselves the rest of this candle
        }
      } else {
        if (hitStop) return done('breakeven', locked + ((1 - half) * (stopFill - entry) * dir) / risk - costR, j);
        if (hitT2) return done('target', locked + (1 - half) * opts.tp2R - costR, j);
      }
    }
    if (last < lastWanted) return { open: true };
    const remaining = stage === 0 ? 1 : 1 - half;
    return done('timeout', locked + (remaining * (candles[last].c - entry) * dir) / risk - costR, last);
  }

  // Replay the exact same rules over history. One trade at a time, entry on the
  // next candle's open, fees included. Rules are fixed (not tuned per market),
  // so this is an honest out-of-sample-style check rather than curve fitting.
  function backtest(candles, ind, htf, opts) {
    const trades = [];
    let i = Math.max(opts.warmup, 1);
    while (i < candles.length - 1) {
      const ev = evaluate(candles, ind, htf, i, opts);
      if (ev.signal) {
        const plan = buildPlan(candles, ind, i, ev.dir, candles[i + 1].o, opts);
        const res = simulateTrade(candles, i + 1, plan, opts);
        if (res.open) break;
        trades.push({ ...res, dir: ev.dir, score: ev.score, signalIdx: i, time: candles[i + 1].t });
        i = res.exitIdx; // next decision is made at the close of the exit candle
      } else {
        i++;
      }
    }
    return trades;
  }

  // Lower bound of the Wilson score interval: a pessimistic estimate of the
  // true win rate given a limited number of trades.
  function wilsonLower(wins, n, z = 1.96) {
    if (!n) return 0;
    const p = wins / n;
    const z2 = z * z;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    return Math.max(0, (centre - margin) / (1 + z2 / n));
  }

  function summarize(trades) {
    const n = trades.length;
    let wins = 0;
    let grossWin = 0;
    let grossLoss = 0;
    let total = 0;
    let streak = 0;
    let maxLossStreak = 0;
    let peak = 0;
    let maxDrawdownR = 0;
    const equity = [];
    const outcomes = { target: 0, breakeven: 0, stop: 0, timeout: 0 };
    for (const t of trades) {
      total += t.r;
      equity.push(total);
      outcomes[t.outcome]++;
      if (t.r > 0) {
        wins++;
        grossWin += t.r;
        streak = 0;
      } else {
        grossLoss -= t.r;
        streak++;
        maxLossStreak = Math.max(maxLossStreak, streak);
      }
      peak = Math.max(peak, total);
      maxDrawdownR = Math.max(maxDrawdownR, peak - total);
    }
    return {
      n,
      wins,
      winRate: n ? wins / n : 0,
      winRateLow: wilsonLower(wins, n),
      avgR: n ? total / n : 0,
      totalR: total,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      maxLossStreak,
      maxDrawdownR,
      outcomes,
      equity,
    };
  }

  // ---------------------------------------------------------------------------
  // Grading
  // ---------------------------------------------------------------------------

  const GRADES = {
    A: 'Strong setup with a solid track record on this market',
    B: 'Good setup with a positive track record',
    C: 'Speculative — the setup is there but its track record is thin or weak',
    D: 'Avoid — these signals have lost money on this market recently',
    none: 'No trade — not enough conditions agree right now',
  };
  const GRADE_ORDER = { A: 4, B: 3, C: 2, D: 1, none: 0 };

  function gradeFor(score, stats, opts) {
    if (score < opts.threshold) return 'none';
    if (stats.n >= 15 && stats.avgR < 0) return 'D';
    if (score >= 75 && stats.n >= 20 && stats.avgR >= 0.2 && stats.profitFactor >= 1.3) return 'A';
    if (score >= 65 && stats.n >= 10 && stats.avgR > 0) return 'B';
    return 'C';
  }

  // 0-100. 60% from today's confluence, 40% from history (shrunk toward neutral
  // when there are few trades). This is a quality score, not a win probability.
  function qualityFor(score, stats) {
    const raw = clamp(50 + stats.avgR * 100, 0, 100);
    const w = stats.n / (stats.n + 20);
    const hist = 50 + w * (raw - 50);
    return Math.round(0.6 * score + 0.4 * hist);
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  /**
   * @param {object} p
   * @param {Array}  p.candles      closed candles, oldest first
   * @param {Array}  [p.htfCandles] closed higher-timeframe candles
   * @param {number} [p.livePrice]  current price (defaults to the last close)
   * @param {string} [p.htfLabel]   e.g. "4h", used in the explanation
   * @param {object} [p.opts]       overrides for DEFAULTS
   */
  function analyze(p) {
    const opts = { ...DEFAULTS, ...(p.opts || {}) };
    const candles = p.candles;
    if (!candles || candles.length < opts.warmup + 50) {
      throw new Error(`Not enough history (need ${opts.warmup + 50} candles, got ${candles ? candles.length : 0})`);
    }
    const ind = computeIndicators(candles);
    const htf = alignHtf(candles, p.htfCandles);
    const i = candles.length - 1;
    const ev = evaluate(candles, ind, htf, i, opts, p.htfLabel);
    const trades = backtest(candles, ind, htf, opts);
    const stats = summarize(trades);
    const sameDir = summarize(trades.filter((t) => t.dir === ev.dir));
    const lastClose = candles[i].c;
    const entry = Number.isFinite(p.livePrice) ? p.livePrice : lastClose;
    const a = ind.atr[i];

    let ageBars = 0;
    if (ev.signal) {
      for (let j = i; j >= opts.warmup; j--) {
        const e = evaluate(candles, ind, htf, j, opts);
        if (e.signal && e.dir === ev.dir) ageBars++;
        else break;
      }
    }

    const plan = ev.signal ? buildPlan(candles, ind, i, ev.dir, entry, opts) : null;
    const grade = gradeFor(ev.signal ? ev.score : 0, stats, opts);
    // Fresh signals are preferred over moves that have been running for a while.
    const maturityPenalty = ageBars > 24 ? 10 : ageBars > 8 ? 5 : 0;
    const warnings = [];
    if (plan) {
      const moved = ((entry - lastClose) * ev.dir) / a;
      if (moved > 0.75) warnings.push(`Price has already run ${moved.toFixed(1)} ATR since the signal candle closed — a late entry. Consider waiting for a pullback.`);
      if (maturityPenalty) warnings.push(`This signal has been active for ${ageBars} candles — the move may be mature (quality reduced by ${maturityPenalty}).`);
      if (stats.n < 10) warnings.push(`Only ${stats.n} past trades to judge this setup on — the track record is not meaningful yet.`);
    }

    return {
      signal: ev.signal,
      dir: ev.dir,
      score: ev.score,
      longScore: ev.longScore,
      shortScore: ev.shortScore,
      checks: ev.checks,
      grade,
      gradeText: GRADES[grade],
      quality: ev.signal ? Math.max(0, qualityFor(ev.score, stats) - maturityPenalty) : 0,
      plan,
      stats,
      sameDir,
      recentTrades: trades.slice(-10),
      ageBars,
      warnings,
      lastClose,
      livePrice: entry,
      atr: a,
      lastBarTime: candles[i].t,
      chart: {
        candles: candles.slice(-120),
        ema20: ind.ema20.slice(-120),
        ema50: ind.ema50.slice(-120),
      },
      opts,
    };
  }

  // Best ideas first: grade, then quality, then raw score.
  function rank(results) {
    return results.slice().sort((a, b) => {
      if (a.error || b.error) return (a.error ? 1 : 0) - (b.error ? 1 : 0);
      return (GRADE_ORDER[b.grade] - GRADE_ORDER[a.grade]) || (b.quality - a.quality) || (b.score - a.score);
    });
  }

  return {
    DEFAULTS,
    GRADES,
    sma, ema, rsi, atr, macd, adx,
    computeIndicators, htfTrend, alignHtf,
    scoreAt, evaluate, buildPlan, simulateTrade, backtest,
    wilsonLower, summarize, gradeFor, qualityFor,
    analyze, rank,
  };
});
