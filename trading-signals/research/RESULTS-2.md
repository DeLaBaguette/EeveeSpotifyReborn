# Research round 2: results

**Plan:** [PLAN.md](PLAN.md), committed before this was run.
**Script:** [strategy-lab.js](strategy-lab.js).
**Data:** BTCUSD from Bitstamp, June 2017 to 2 November 2026 (82,586 hourly candles, also built into 4h and daily).
**Costs:** 0.06% per fill, plus a 0.05% overnight fee per day held, unless stated otherwise.

## Bottom line

**No strategy passed the final 2025–2026 test convincingly.**

- **The best result** was a daily moving-average trend filter (long only, SMA 50). It averaged +0.07R per trade over 23 trades, about **+2% in 22 months** at 1% risk per trade. That's statistically indistinguishable from luck (t = 0.4).
- **Trend-following looked strong in 2018–2024,** but much of that came from BTC's bull market: random long trades also made money in 2023–2024. The edge faded in 2025–2026, when BTC fell 16% with a 53% drop along the way.
- **Mean reversion lost in every period** (−0.13R per trade in the final test, t = −4.1).
- **The app's own 4h strategy (S1)** was +0.1R per trade in 2018–2024 but about **break-even in 2025–2026** after overnight fees (+0.01R).
- **Overnight fees on CFDs** take away most of the edge from any trade held for days. Without them, the trend strategies would have been +0.13 to +0.16R per trade in the final test. That's still small and uncertain.

## 1. Development 2018–2022: settings chosen here

| Strategy | Best setting (30+ trades) | Trades | Avg R | t |
|---|---|---|---|---|
| S1 Signal Desk, 4h | min 70, 1 : 5 | 228 | +0.16 | 1.8 |
| S2d Breakout, daily | N 20, long & short | 45 | +1.74 | 1.3 |
| S2h Breakout, 4h | N 55, long only | 72 | +0.94 | 1.6 |
| S3 MA trend, daily | SMA 50, long only | 44 | +1.20 | 1.1 |
| S4h RSI(2) pullback, 1h | long only | 937 | −0.01 | −0.5 |
| S4f RSI(2) pullback, 4h | long & short | 452 | −0.03 | −1.0 |

Even the best development results were weak statistically (t of 1.1 to 1.8).

## 2. Validation 2023–2024

| Strategy | Trades | Avg R | t | Random trades (avg / 95th pct) | Result |
|---|---|---|---|---|---|
| S1 Signal Desk, 4h | 97 | +0.11 | 0.9 | −0.05 / +0.14 | fail (t < 1) |
| S2d Breakout, daily | 22 | +0.57 | 1.1 | +0.02 / +0.82 | pass |
| S2h Breakout, 4h | 31 | +1.98 | 1.5 | +0.49 / +1.73 | pass |
| S3 MA trend, daily | 18 | +1.07 | 2.0 | +0.46 / +1.13 | pass |
| S4h RSI(2), 1h | 398 | −0.06 | −2.0 | −0.07 / −0.02 | fail |
| S4f RSI(2), 4h | 204 | +0.01 | 0.2 | −0.04 / +0.04 | fail |

BTC buy-and-hold over the same two years: +465%. Random long-only trades averaged +0.46 to +0.49R in this bull market, which shows how much of the "edge" was just BTC going up.

## 3. Final test 2025–2026 (run once)

| Strategy | Trades | Avg R | t | Worst drawdown | At 1% risk | Random (avg) | No overnight fee |
|---|---|---|---|---|---|---|---|
| S2d Breakout, daily *(candidate)* | 21 | **−0.16** | −0.6 | 8.1R | −3% | −0.12 | −0.01 |
| S2h Breakout, 4h *(candidate)* | 25 | **−0.07** | −0.2 | 10.4R | −2% | −0.09 | +0.13 |
| S3 MA trend, daily *(candidate)* | 23 | **+0.07** | 0.4 | 2.5R | +2% | −0.04 | +0.16 |
| S1 Signal Desk, 4h | 99 | +0.01 | 0.1 | 8.3R | 0% | −0.13 | +0.10 |
| S4h RSI(2), 1h | 340 | −0.13 | −4.1 | 44.1R | −36% | −0.09 | −0.12 |
| S4f RSI(2), 4h | 172 | −0.06 | −1.5 | 10.3R | −10% | −0.05 | −0.05 |

BTC buy-and-hold in 2025–2026: −16%, with a worst drop of 53%.

## What this means

None of these simple, well-known indicator strategies has a reliable, tradable edge on BTCUSD through a CFD broker. The best of them roughly broke even over the last 22 months. Taking more trades, using more leverage or automating them would not change that; it would only make the losses faster.
