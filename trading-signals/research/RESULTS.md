# Signal Desk on real prices

**Run:** 2 November 2026 with `research/real-data-backtest.js`, the app's own engine code, unchanged.

**Data**
- **BTCUSD:** real 1-minute prices from Bitstamp, 7 January 2025 to 2 November 2026. That's 22 months, about 950,000 candles, built into 15m, 1h, 4h and 1d candles. Source: [ff137/bitstamp-btcusd-minute-data](https://github.com/ff137/bitstamp-btcusd-minute-data).
- **XAUUSD:** 1-hour prices from 26 March to 25 September 2026 (3,000 candles; a free sample from a data vendor). Source: [getdata-finance/xauusd-1h-ohlcv-metals-historical-data](https://github.com/getdata-finance/xauusd-1h-ohlcv-metals-historical-data).

**Rules, the same as in the app**
- Entry on the next candle's open.
- One trade at a time.
- TP1 at 1R (close 50%, stop to entry), TP2 at the chosen risk : reward.
- Time exit.
- 0.06% costs per fill.
- The worst case is assumed when a candle touches both the stop and a target.

**Random baseline:** 200 runs of random-direction entries at random times, with the same stops, targets and costs. If the signals can't beat that, they carry no information.

**R** is one unit of risk. −0.25R per trade means losing a quarter of your risk on every trade, on average.

## Headline

| Timeframe | Result per trade (Strict, 1 : 3) | Random entries | Verdict |
|---|---|---|---|
| **15 minutes** | −0.20R over 2,145 trades | −0.27R | **Loses on every setting.** No better than random, even with zero costs (+0.02R vs +0.01R) |
| **1 hour** | −0.04R over 497 trades | −0.09R | **Loses** at every risk : reward up to 1 : 5. Barely better than random |
| **4 hours** | **+0.11R** over 119 trades | −0.06R | **Small profit**, positive in both 2025 (+0.10R) and 2026 (+0.11R). Beats the average random run but not clearly enough to rule out luck |
| 1 day | −0.07R over 12 trades | +0.02R | Too few trades to say anything |
| XAUUSD 1 hour | +0.01R over 90 trades | −0.14R | Break-even. Positive in the first 3 months, negative in the last 3. Too little data |

### What this means
- **15-minute and 1-hour signals should not be traded.** They have been removed from, or labelled in, the app.
- **4-hour signals are the only candidate, and they are unproven.** The default settings (4h, Strict, 1 : 3) were picked from these same results, so real results will probably be worse than shown here.
- **1 : 30 never reached TP2 on 4h** (0 of 40 trades). Its profit came entirely from TP1 and from holding trends until the time exit.
- **Very strict (80+) did worse than Strict on 4h:** −0.16R at 1 : 3. Stricter is not automatically better.
- **Gold:** there isn't enough data to judge.

## Full grid, BTCUSD 4 hours

| Min score | 1 : 1 | 1 : 2 | 1 : 3 | 1 : 5 | 1 : 10 | 1 : 30 |
|---|---|---|---|---|---|---|
| 60 | −0.01 (320) | +0.04 (186) | +0.04 (147) | +0.07 (119) | +0.26 (68) | +0.30 (55) |
| 70 | −0.03 (277) | +0.08 (143) | +0.11 (119) | +0.17 (93) | +0.16 (59) | +0.46 (40) |
| 80 | −0.08 (204) | −0.17 (121) | −0.16 (103) | −0.19 (80) | −0.02 (59) | +0.06 (48) |

Average R per trade (number of trades). Every 15-minute cell is between −0.15 and −0.27. Every 1-hour cell up to 1 : 5 is negative. Run the script for the complete output.
