# Research round 2: plan, written before any results were seen

**Goal:** find out honestly whether any simple, well-known strategy has a real edge on BTCUSD after realistic costs, using data it was never tuned on.

## Data
- **Market:** BTCUSD, Bitstamp 1-minute candles ([ff137/bitstamp-btcusd-minute-data](https://github.com/ff137/bitstamp-btcusd-minute-data)), from June 2017 to 2 November 2026, built into 1h, 4h and 1d candles. June to December 2017 is only used to warm up the indicators.
- **Other markets:** none. No trustworthy long ETH or gold history was available, so nothing here says anything about gold.

## Periods (assigned by the trade's entry time)
| Period | Dates | Use |
|---|---|---|
| **Development** | 2018-01-01 to 2022-12-31 | Choose each strategy's settings |
| **Validation** | 2023-01-01 to 2024-12-31 | Check the chosen settings. A strategy only stays a candidate if it passes |
| **Final test** | 2025-01-01 to 2026-11-02 | Run once, at the end, for every chosen setting. Never used to choose anything |

**Caveat:** the existing Signal Desk rules (S1) were already looked at on 2025–2026 in round 1, so S1's "final test" isn't truly unseen. Every other strategy's final test is.

## Trading rules for every strategy
- Decisions are made at a candle's close. Entry and exit happen at the **next candle's open**.
- One position at a time.
- Every trade has a stop loss and is sized to risk 1% of the account, so results are in R (1R = the risk).
- If a candle touches both the stop and a target, the stop counts as hit first. A gap through the stop fills at the open.
- **Costs:** 0.06% per fill (spread and commission).
- **Overnight fees:** charged on the full position for every day it is held. Two cases are reported:
  - **0.05% per day**, about 18% a year, typical for crypto CFDs at MT5 brokers. **This is the main case.**
  - 0% per day, for swap-free accounts.

## Strategies and the settings tried (development only)
| ID | Strategy | Timeframe | Settings tried |
|---|---|---|---|
| S1 | Signal Desk confluence (the app's current engine) | 4h | min score {60, 70} × risk : reward {2, 3, 5} |
| S2d | Donchian channel breakout: enter on a close beyond the N-candle high/low, exit on a close beyond the opposite N/2-candle channel, 2 ATR(20) initial stop | 1d | N {20, 55} × {long only, long & short} |
| S2h | Same breakout | 4h | N {20, 55} × {long only, long & short} |
| S3 | Moving-average trend: in the market while the close is above (long) or below (short) SMA(N), exit on a close back across it, 3 ATR(20) safety stop | 1d | N {50, 100, 200} × {long only, long & short} |
| S4h | RSI(2) pullback: buy RSI(2) < 10 when the close is above SMA(200) (short: RSI(2) > 90 below SMA(200)), exit when RSI(2) crosses 70 (30 for shorts) or after 10 candles, 2.5 ATR(14) stop | 1h | {long only, long & short} |
| S4f | Same pullback | 4h | {long only, long & short} |

## Selection rule (development)
For each strategy, pick the setting with the **highest average R per trade** among those with **at least 30 trades**. If none has 30 trades, the strategy is dropped.

## Pass rule (validation)
The chosen setting must have, in validation:
- an average R per trade **above 0**
- a t-statistic **of at least 1.0** (average R divided by its standard error)
- an average R **above the average of random entries** that use the same exits, stops and costs (200 runs).

## Reported for everything
Trades, win rate, average R, profit factor, t-statistic, worst drawdown in R, longest losing streak, the random baseline, and BTC buy-and-hold over the same period.

## What counts as success
A strategy that passes validation **and** is positive in the final test with costs and overnight fees. Even then it is a *candidate* for demo trading, not proof. One or two periods of BTC history is a small sample, and an edge of +0.1R per trade at 1% risk is only about +5–10% a year.
