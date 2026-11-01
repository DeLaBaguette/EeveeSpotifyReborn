# Signal Desk robot for MetaTrader 5

`SignalDesk.mq5` is an **Expert Advisor** (a trading robot) that runs the Signal Desk strategy inside MetaTrader 5 and places trades for you. It uses the same 9-condition score, higher-timeframe filter, stop placement, TP1 scale-out and % risk as the web app. It runs on your broker's own prices, so on gold it trades your broker's real XAUUSD.

> **Please read.** No robot wins every trade, and this one will have losing trades and losing streaks. It **only trades demo accounts** until you switch on *Allow trading on a REAL account*. Test it in the Strategy Tester, then run it on a demo account for a few weeks before you even think about real money. It was written carefully but has **not been compiled or run by its author**, so treat the first runs as tests.

## What you need

- **A computer, just for the setup** (Windows PC or Mac) with **MetaTrader 5 desktop** from your broker. **The iPhone MT5 app cannot run robots**; MetaQuotes doesn't allow it.
- **Something that stays on, to trade 24/7.** Either keep that computer on with MT5 open, or rent MetaQuotes' **Virtual Hosting** from inside MT5 (about $10–15/month), which runs the robot for you in the cloud. See step 6.
- **Your iPhone**, to watch the trades and get alerts. Log into the same account in the MT5 iPhone app.

## Step by step

### 1. Download the robot
On the computer, open
https://github.com/DeLaBaguette/EeveeSpotifyReborn/blob/claude/trading-app-signals-nlmhea/trading-signals/mt5/SignalDesk.mq5
and click the **Download raw file** button (the arrow icon at the top right of the code).

### 2. Put it in MetaTrader 5
1. Open MetaTrader 5 and log into a **demo** account (File → Open an Account → demo, if you don't have one).
2. Click **File → Open Data Folder**.
3. Open **MQL5**, then **Experts**, and move `SignalDesk.mq5` into that folder.
4. Back in MT5, press **F4**. The MetaEditor window opens.
5. In MetaEditor, open `SignalDesk.mq5` from the Experts folder on the left, then press **F7** (Compile). The bottom panel should say **0 errors**. If it shows errors, copy them to me and I'll fix them.
6. Close MetaEditor.

### 3. Test it on past data first (5 minutes)
1. In MT5 press **Ctrl + R** to open the **Strategy Tester**.
2. Fill in the settings:
   - **Expert:** SignalDesk
   - **Symbol:** XAUUSD (or GOLD, whatever your broker calls it)
   - **Timeframe:** H1
   - **Date:** last 1–2 years
   - **Modelling:** *Every tick based on real ticks* (or *1 minute OHLC* if that isn't available)
   - **Deposit:** your account size
3. Click **Start**.
4. Open the **Backtest** tab and look at:
   - **Profit Trades (% of total):** the win rate
   - **Total Net Profit**
   - **Balance Drawdown Maximal:** the worst losing stretch
5. Try different **Inputs** (risk:reward, strictness) and compare. This is the honest answer to "how good is it on gold".

### 4. Run it on a demo account
1. Open a chart: **File → New Chart → XAUUSD**, and click **H1** in the toolbar.
2. In the **Navigator** panel (Ctrl + N), open **Expert Advisors** and drag **SignalDesk** onto the chart.
3. In the window that opens:
   - **Common** tab: tick **Allow Algo Trading**.
   - **Inputs** tab: set your risk, risk:reward and so on (see the table below).
   - Click **OK**.
4. Click the **Algo Trading** button in the top toolbar so it turns **green**.
5. The top-left of the chart now shows the robot's panel: the last scores, what agrees, and what it's doing or why it's waiting.

You can put the robot on several charts (for example XAUUSD and BTCUSD). Each chart trades only its own symbol.

### 5. Get alerts on your iPhone
1. In the **MT5 iPhone app**, go to **Settings → Messages** and copy your **MetaQuotes ID**.
2. In MT5 on the computer, go to **Tools → Options → Notifications**:
   - tick **Enable Push Notifications**
   - paste the ID
   - click **Test**.

From now on your phone gets a message whenever the robot opens a trade, hits TP1, or closes at the stop or target.

### 6. Let it run 24/7 without your computer (optional)
1. In the **Navigator**, right-click your account and choose **Register a Virtual Server**.
2. Pick a plan and follow the steps. MT5 copies your charts and robots to MetaQuotes' server.
3. After that you can turn the computer off. If you change the robot's settings, migrate again from the same menu.

No computer at all? You can rent a Windows VPS from any hosting company and control it from your iPhone with Microsoft's **Windows App** (Remote Desktop), then follow these same steps on it.

### 7. Real money (only after weeks of demo)
Open the robot's settings on the chart (double-click the robot's icon at the top right of the chart, or press F7 on the chart), set **Allow trading on a REAL account** to **true**, and start with the smallest risk.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Timeframe | CURRENT | The candle size it trades (CURRENT = the chart's). The trend filter uses the next timeframe up (M15→H1, H1→H4, H4→D1) |
| Minimum score | 60 | 60 normal, 70 strict, 80 very strict. Stricter means fewer trades |
| Risk : reward | 2 | TP2 distance in multiples of the stop distance. 30 means 1:30, which pays big but is rarely reached |
| Close 50% at TP1 | true | TP1 sits at 1R (or half-way to TP2 if that's closer). Closes half and moves the stop to entry, so the rest can't lose |
| Time exit | 0 (auto) | Closes the trade after N candles if neither the stop nor TP2 was hit. Auto grows with the risk:reward |
| Allow BUY / SELL | true | Turn either direction off |
| Risk per trade | 1% | Of your balance. The lot size is calculated so that hitting the stop loses exactly this |
| Max trades per day | 3 | Safety limit (0 = none) |
| Daily loss limit | 3% | No new trades for the rest of the day once you're down this much |
| Max spread × ATR | 0.25 | Skips entries when the spread is unusually wide (e.g. at market open or rollover) |
| Allow trading on a REAL account | **false** | Safety switch. Leave it off until you've tested on demo |
| Push notifications | true | Alerts to the MT5 phone app (set up in step 5) |
| Magic number | 20261101 | Tags this robot's trades. Use a different number for each copy if you want separate daily limits |

## Notes

- One trade at a time per chart. The stop and TP2 are sent to the broker with the order, so they still work if MT5 closes. TP1 scale-out, moving the stop to entry and the time exit need MT5 (or the VPS) to be running.
- The robot decides once per closed candle, like the web app.
- If the account is too small for the broker's minimum lot at your risk %, the robot skips the trade and says why on the chart instead of risking more.
