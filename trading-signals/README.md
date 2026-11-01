# Signal Desk

A browser app that scans a list of crypto markets on demand and gives you the best trade idea available right now: **BUY or SELL, entry, stop loss, two take-profit levels and position size**, plus an honest rating of how good the setup is and how these exact rules have performed on that market.

> **Read this first.** No app, indicator, AI or signal service can guarantee winning trades, and anything that claims to is lying. Prices react to news and to millions of other traders. What a tool *can* do is wait for several independent conditions to agree, size the position so one loss is small, and show you the real track record so you know what to expect. A Grade A setup can and will still lose. Expect losing streaks; the app shows you the longest one it found.

## Settings

| Setting | What it does |
|---|---|
| **Markets** | Any Binance pair (e.g. `BTCUSDT`) plus **`XAUUSD`** for gold (also accepts `GOLD`). |
| **Timeframe** | Auto (15m, 1h and 4h) or a single timeframe. |
| **Strictness** | Normal (score 60+), Strict (70+) or Very strict (80+). Stricter means fewer trades, usually better ones, but never zero losers. |
| **Risk : reward** | Any value from 1 : 0.5 to 1 : 50, with quick buttons up to **1 : 30**. Far targets pay more but are hit less often. The card warns you and shows how often TP2 was actually reached. The time exit grows with the target. |
| **Close 50% at TP1** | TP1 is at 1R, or half-way to TP2 if that's closer. |
| **MT5 lot size settings** | Contract size per lot at your broker, e.g. `XAUUSD=100, BTCUSD=1` (find it in MT5 under the symbol's *Specification*). Anything not listed counts as 1 per lot. |
| **Reset to defaults** | Puts every setting back to how it started, including the market list with XAUUSD. |

Every trade plan starts with the **MT5 lot size**. It's rounded down to 0.01 lots so you never risk more than your setting, and it shows what that size actually risks. If even 0.01 lots would risk more than your setting (small account or wide stop), it warns you. The lot size is also on the chips above the live chart, in the results table and in the copied trade plan.

Each stop and target is shown as a distance from the entry (e.g. `−18.40`) as well as a price, so you can place the trade at your broker's price.

**Gold:** Binance has no XAUUSD, so gold is analysed with **PAXG**, a token backed 1:1 by physical gold.
- PAXG tracks spot gold closely but can differ by a few dollars, so set your stop and targets from the distances.
- The live chart shows real `OANDA:XAUUSD`, and the lot size uses 100 oz per lot.
- Gold markets close at weekends while PAXG keeps trading, so ignore weekend gold signals.

## Automatic trading in MetaTrader 5

The iPhone MT5 app can't run trading robots. [`mt5/SignalDesk.mq5`](mt5/SignalDesk.mq5) is an Expert Advisor with the same strategy that runs in MetaTrader 5 on a computer, or on MetaQuotes' Virtual Hosting around the clock. It trades your broker's real prices (including XAUUSD) and sends alerts to the iPhone app. Its safety switch keeps it on demo accounts until you turn real trading on. See the [step-by-step guide](mt5/README.md).

## Run it

No install and no API key. On a phone, open https://raw.githack.com/DeLaBaguette/EeveeSpotifyReborn/claude/trading-app-signals-nlmhea/trading-signals/index.html (and use Share → Add to Home Screen). On a computer you can also open `index.html` directly. Then press **Get trade idea now**.

Market data comes from Binance's public API (`data-api.binance.vision`, falling back to `api.binance.com` and `api.binance.us`). If your network or country blocks Binance, the app will tell you.

To serve it instead of opening the file: `npx serve .` or `python3 -m http.server` in this folder.

## What it does

For every market and timeframe on your list (Auto mode scans 15m, 1h and 4h):

1. **Scores confluence (0–100).** Nine conditions, each weighted:
   - price vs the 200 EMA (15)
   - 20 vs 50 EMA (15)
   - **higher-timeframe trend** (20)
   - MACD momentum (10)
   - momentum accelerating (5)
   - RSI in the trend zone (10)
   - ADX trend strength with the DI pointing the right way (10)
   - not over-extended from the 20 EMA (10)
   - volume above average (5)

   An overbought or oversold RSI against the trade costs −15. A trade is only suggested at **60+**.
2. **Builds the trade plan.**
   - **Stop:** beyond the recent swing high or low, or 1.5 ATR away, whichever is further, kept between 1 and 3 ATR.
   - **TP1** = 1R: close 50% and move the stop to entry, so the rest of the trade can't lose.
   - **TP2** = your chosen risk : reward (1 : 0.5 up to 1 : 50).
   - **Position size:** works out how much to buy or sell so that hitting the stop costs exactly your chosen % of the account.
3. **Backtests the exact same rules** on the last ~1,500 candles of that market:
   - Entry is on the next candle's open.
   - Fees and slippage are included (0.06% per fill).
   - Only one trade is open at a time.
   - When a candle touches both the stop and a target, the stop is assumed to have been hit first.
   - The rules are fixed and never tuned per market, so the results aren't curve-fitted.
4. **Grades the idea.**

   | Grade | Meaning |
   |---|---|
   | **A** | score ≥ 75, ≥ 20 past trades, ≥ +0.2R average, profit factor ≥ 1.3 |
   | **B** | score ≥ 65, ≥ 10 past trades, positive average |
   | **C** | setup present but track record thin or weak: speculative |
   | **D** | these signals have *lost* money on this market recently: skip |

   **Setup quality** blends today's score (60%) with the track record (40%). Thin histories are pulled towards neutral, and quality drops if the signal has been active for many candles. It is **not** a win probability.

   The stats include a **worst-case win rate**: the 95% Wilson lower bound, which accounts for small sample sizes.
5. **Ranks everything.** It shows the best idea with a chart and the full checklist of reasons, plus a table of every market you can click through. If nothing qualifies, it says **No trade right now** and shows the setups closest to triggering. Not trading is often the right call.

## Live TradingView chart

The selected idea is shown on a **real-time TradingView chart**, using TradingView's official Advanced Chart widget with the `BINANCE:` symbol and the matching timeframe. You get TradingView's full set of indicators and drawing tools.
- **Levels:** the Entry, SL, TP1 and TP2 levels appear as chips above the chart. Click one to copy the price, then press **Alt + H** on the chart to draw a horizontal line there. The free widget doesn't let other pages draw on it, so the chips are the quickest way to mark your levels.
- **Reloads:** the chart only reloads when you change market, timeframe or light/dark theme. Auto re-scans keep your zoom and drawings.
- **Open in TradingView ↗** opens the same chart on tradingview.com, and the copied trade plan includes that link.
- **If it's blocked:** if TradingView is blocked (by your network or an ad blocker), the panel says so and you can use the link instead.

The smaller chart under it is a snapshot from the moment of the scan, with the trade zones shaded.

## Re-scan and notifications

Tick **Re-scan every 5 minutes** to keep the tab updating and get a browser notification when a new Grade A or B setup appears.

A **SELL** means opening a short, which needs futures or margin. On spot, read it as "don't buy now / consider taking profit".

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The UI (no framework, no build step) |
| `engine.js` | Indicators, scoring, trade plan, trade simulation, backtest, grading. Pure functions with no I/O |
| `market.js` | Binance kline fetching with pagination and host fallback |
| `scanner.js` | Scans markets × timeframes and ranks the results |
| `mt5/SignalDesk.mq5`, `mt5/README.md` | MetaTrader 5 robot (Expert Advisor) and its setup guide |
| `test/` | Unit tests (`npm test`, Node 18+) |

The tests cover:
- indicator maths against worked examples
- no look-ahead: signals computed on a prefix of the data match those computed on the full data
- higher-timeframe alignment that never peeks at an unfinished candle
- trade simulation edge cases: same-candle stop and target, gaps, scale-out, fees, time stop
- pagination and host fallback
- scanner error handling
