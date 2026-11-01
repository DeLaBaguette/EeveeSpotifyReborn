//+------------------------------------------------------------------+
//|                                                   SignalDesk.mq5 |
//|  Automated version of the Signal Desk web app's strategy.        |
//|                                                                  |
//|  - 9-condition trend confluence score (0-100) + higher-timeframe |
//|    trend filter, evaluated once per closed candle                |
//|  - Stop beyond the recent swing or 1.5 ATR (kept 1-3 ATR)        |
//|  - TP2 at your risk:reward; optional 50% close at TP1 with the   |
//|    stop moved to entry; time exit                                |
//|  - Position size from a fixed % of balance                       |
//|  - Safety: demo accounts only unless AllowRealAccount = true,    |
//|    daily loss stop, max trades per day, spread filter            |
//|                                                                  |
//|  No strategy wins every trade. Test it in the Strategy Tester    |
//|  and on a demo account before risking real money.                |
//+------------------------------------------------------------------+
#property copyright   "Signal Desk"
#property version     "1.00"
#property description "Signal Desk trend-confluence robot: higher-timeframe filter, ATR/swing stop,"
#property description "scale-out at TP1, fixed % risk per trade."
#property description "Trades DEMO accounts only unless 'Allow trading on a REAL account' is switched on."

#include <Trade/Trade.mqh>

//--- inputs ----------------------------------------------------------
input group "Strategy"
input ENUM_TIMEFRAMES InpTimeframe   = PERIOD_CURRENT; // Timeframe (CURRENT = the chart's timeframe)
input int             InpMinScore    = 60;             // Minimum score to trade (60 normal, 70 strict, 80 very strict)
input double          InpRewardRisk  = 2.0;            // Risk : reward, 1 : x (e.g. 2 or 30)
input bool            InpScaleOut    = true;           // Close 50% at TP1 and move the stop to entry
input int             InpMaxBars     = 0;              // Time exit after N candles (0 = automatic)
input bool            InpTradeLongs  = true;           // Allow BUY trades
input bool            InpTradeShorts = true;           // Allow SELL trades

input group "Risk"
input double InpRiskPercent     = 1.0;  // Risk per trade (% of balance)
input int    InpMaxTradesPerDay = 3;    // Max new trades per day (0 = no limit)
input double InpMaxDailyLossPct = 3.0;  // Stop for the day after losing this % (0 = off)
input double InpMaxSpreadAtr    = 0.25; // Skip when spread is wider than this x ATR (0 = off)

input group "Safety and alerts"
input bool   InpAllowRealAccount  = false;    // Allow trading on a REAL account
input bool   InpPushNotifications = true;     // Send alerts to the MT5 phone app
input ulong  InpMagic             = 20261101; // Magic number (tags this robot's trades)

//--- state -----------------------------------------------------------
#define BARS 300

CTrade          trade;
ENUM_TIMEFRAMES TF;
ENUM_TIMEFRAMES HTF;
int    hE20 = INVALID_HANDLE, hE50 = INVALID_HANDLE, hE200 = INVALID_HANDLE;
int    hE12 = INVALID_HANDLE, hE26 = INVALID_HANDLE, hRsi = INVALID_HANDLE, hAdx = INVALID_HANDLE;
int    hH21 = INVALID_HANDLE, hH50 = INVALID_HANDLE;
double gTp1R = 1.0, gTp2R = 2.0;
int    gMaxBars = 48;
datetime gLastBar = 0;
datetime gLastWarnBar = 0;

// Market snapshot for the last closed candle (index 0 = last closed candle)
MqlRates R[];
double E20[], E50[], E200[], RSI[], ADX[], PDI[], MDI[];
double ATR0 = 0, HIST0 = 0, HIST1 = 0, VOLSMA = 0;
int    HTFTREND = 0;

// For the on-chart panel
int    gLastLong = 0, gLastShort = 0;
string gLastWhy = "";
string gLastStatus = "Waiting for the first candle...";

//+------------------------------------------------------------------+
int OnInit()
  {
   TF  = (InpTimeframe == PERIOD_CURRENT) ? (ENUM_TIMEFRAMES)Period() : InpTimeframe;
   HTF = HigherTF(TF);
   gTp2R = MathMax(0.5, InpRewardRisk);
   gTp1R = MathMin(1.0, gTp2R / 2.0);
   gMaxBars = (InpMaxBars > 0) ? InpMaxBars : (int)MathMin(300.0, MathMax(48.0, MathRound(24.0 * gTp2R)));

   hE20  = iMA(_Symbol, TF, 20, 0, MODE_EMA, PRICE_CLOSE);
   hE50  = iMA(_Symbol, TF, 50, 0, MODE_EMA, PRICE_CLOSE);
   hE200 = iMA(_Symbol, TF, 200, 0, MODE_EMA, PRICE_CLOSE);
   hE12  = iMA(_Symbol, TF, 12, 0, MODE_EMA, PRICE_CLOSE);
   hE26  = iMA(_Symbol, TF, 26, 0, MODE_EMA, PRICE_CLOSE);
   hRsi  = iRSI(_Symbol, TF, 14, PRICE_CLOSE);
   hAdx  = iADXWilder(_Symbol, TF, 14);
   hH21  = iMA(_Symbol, HTF, 21, 0, MODE_EMA, PRICE_CLOSE);
   hH50  = iMA(_Symbol, HTF, 50, 0, MODE_EMA, PRICE_CLOSE);
   if(hE20 == INVALID_HANDLE || hE50 == INVALID_HANDLE || hE200 == INVALID_HANDLE ||
      hE12 == INVALID_HANDLE || hE26 == INVALID_HANDLE || hRsi == INVALID_HANDLE ||
      hAdx == INVALID_HANDLE || hH21 == INVALID_HANDLE || hH50 == INVALID_HANDLE)
     {
      Print("Signal Desk: could not create indicators, error ", GetLastError());
      return(INIT_FAILED);
     }

   ArraySetAsSeries(R, true);
   ArraySetAsSeries(E20, true);
   ArraySetAsSeries(E50, true);
   ArraySetAsSeries(E200, true);
   ArraySetAsSeries(RSI, true);
   ArraySetAsSeries(ADX, true);
   ArraySetAsSeries(PDI, true);
   ArraySetAsSeries(MDI, true);

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetDeviationInPoints(50);

   if(IsBlockedRealAccount())
      gLastStatus = "REAL account: trading is OFF. Set 'Allow trading on a REAL account' to true to allow it.";

   UpdatePanel();
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   Release(hE20);
   Release(hE50);
   Release(hE200);
   Release(hE12);
   Release(hE26);
   Release(hRsi);
   Release(hAdx);
   Release(hH21);
   Release(hH50);
   Comment("");
  }

void Release(int &handle)
  {
   if(handle != INVALID_HANDLE)
      IndicatorRelease(handle);
   handle = INVALID_HANDLE;
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   ManagePositions();

   datetime bar = iTime(_Symbol, TF, 0);
   if(bar != 0 && bar != gLastBar)
     {
      if(LoadData())       // indicators may need a few ticks to be ready
        {
         gLastBar = bar;
         Evaluate();
        }
     }
   UpdatePanel();
  }

//+------------------------------------------------------------------+
//| Alerts when the broker closes a trade at the stop or target      |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD)
      return;
   if(!HistoryDealSelect(trans.deal))
      return;
   if((ulong)HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != InpMagic)
      return;
   if(HistoryDealGetString(trans.deal, DEAL_SYMBOL) != _Symbol)
      return;
   long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY)
      return;
   long reason = HistoryDealGetInteger(trans.deal, DEAL_REASON);
   if(reason != DEAL_REASON_SL && reason != DEAL_REASON_TP)
      return;   // our own closes are reported where they happen
   double pnl = HistoryDealGetDouble(trans.deal, DEAL_PROFIT) +
                HistoryDealGetDouble(trans.deal, DEAL_SWAP) +
                HistoryDealGetDouble(trans.deal, DEAL_COMMISSION);
   Notify(StringFormat("closed at %s, result %s %s",
                       reason == DEAL_REASON_TP ? "take profit (TP2)" : "stop loss",
                       DoubleToString(pnl, 2), AccountInfoString(ACCOUNT_CURRENCY)));
  }

//+------------------------------------------------------------------+
//| Data                                                             |
//+------------------------------------------------------------------+
bool LoadData()
  {
   if(CopyRates(_Symbol, TF, 1, BARS, R) < BARS)
      return(false);
   if(CopyBuffer(hE20, 0, 1, 2, E20) < 2 || CopyBuffer(hE50, 0, 1, 2, E50) < 2 || CopyBuffer(hE200, 0, 1, 2, E200) < 2)
      return(false);
   if(CopyBuffer(hRsi, 0, 1, 2, RSI) < 2)
      return(false);
   if(CopyBuffer(hAdx, 0, 1, 2, ADX) < 2 || CopyBuffer(hAdx, 1, 1, 2, PDI) < 2 || CopyBuffer(hAdx, 2, 1, 2, MDI) < 2)
      return(false);

//--- MACD with an EMA(9) signal line seeded by an SMA (same as the web app)
   double e12[], e26[];
   ArraySetAsSeries(e12, true);
   ArraySetAsSeries(e26, true);
   if(CopyBuffer(hE12, 0, 1, BARS, e12) < BARS || CopyBuffer(hE26, 0, 1, BARS, e26) < BARS)
      return(false);
   double k = 2.0 / 10.0, sig = 0.0, hist = 0.0, prevHist = 0.0;
   int idx = 0;
   for(int j = BARS - 1; j >= 0; j--)          // oldest -> newest
     {
      double m = e12[j] - e26[j];
      if(idx < 9)
        {
         sig += m;
         idx++;
         if(idx < 9)
            continue;
         sig /= 9.0;
        }
      else
        {
         sig = m * k + sig * (1.0 - k);
         idx++;
        }
      prevHist = hist;
      hist = m - sig;
     }
   HIST0 = hist;
   HIST1 = prevHist;

//--- Wilder's ATR(14)
   double atr = 0.0;
   idx = 0;
   for(int j = BARS - 1; j >= 0; j--)
     {
      double tr = R[j].high - R[j].low;
      if(j < BARS - 1)
         tr = MathMax(tr, MathMax(MathAbs(R[j].high - R[j + 1].close), MathAbs(R[j].low - R[j + 1].close)));
      if(idx < 14)
        {
         atr += tr;
         if(idx == 13)
            atr /= 14.0;
        }
      else
         atr = (atr * 13.0 + tr) / 14.0;
      idx++;
     }
   ATR0 = atr;

//--- 20-candle average volume (tick volume)
   double vs = 0.0;
   for(int j = 0; j < 20; j++)
      vs += (double)R[j].tick_volume;
   VOLSMA = vs / 20.0;

//--- higher-timeframe trend from its last CLOSED candle
   double h21[], h50[];
   if(CopyBuffer(hH21, 0, 1, 1, h21) < 1 || CopyBuffer(hH50, 0, 1, 1, h50) < 1)
      return(false);
   double hc = iClose(_Symbol, HTF, 1);
   if(hc <= 0.0)
      return(false);
   HTFTREND = 0;
   if(hc > h50[0] && h21[0] > h50[0])
      HTFTREND = 1;
   if(hc < h50[0] && h21[0] < h50[0])
      HTFTREND = -1;
   return(ATR0 > 0.0);
  }

//+------------------------------------------------------------------+
//| Scoring (identical weights to the web app)                       |
//+------------------------------------------------------------------+
int Cond(bool pass, int weight, string label, string &why)
  {
   if(!pass)
      return(0);
   if(why != "")
      why += ", ";
   why += label;
   return(weight);
  }

int Score(int dir, string &why)
  {
   bool up = (dir > 0);
   double c = R[0].close;
   int s = 0;
   why = "";
   s += Cond(up ? c > E200[0] : c < E200[0], 15, "200 EMA trend", why);
   s += Cond(up ? E20[0] > E50[0] : E20[0] < E50[0], 15, "20/50 EMA", why);
   s += Cond(HTFTREND == dir, 20, "higher timeframe", why);
   s += Cond(up ? HIST0 > 0.0 : HIST0 < 0.0, 10, "MACD", why);
   s += Cond(up ? HIST0 > HIST1 : HIST0 < HIST1, 5, "momentum rising", why);
   s += Cond(up ? (RSI[0] >= 50.0 && RSI[0] <= 70.0) : (RSI[0] >= 30.0 && RSI[0] <= 50.0), 10, "RSI zone", why);
   s += Cond(ADX[0] >= 20.0 && (up ? PDI[0] > MDI[0] : MDI[0] > PDI[0]), 10, "ADX", why);
   s += Cond(MathAbs(c - E20[0]) <= 1.5 * ATR0, 10, "not extended", why);
   s += Cond((double)R[0].tick_volume > VOLSMA, 5, "volume", why);
   if(up ? RSI[0] > 78.0 : RSI[0] < 22.0)
     {
      s -= 15;
      why += (why == "" ? "" : ", ");
      why += "RSI extreme (-15)";
     }
   return((s < 0) ? 0 : s);
  }

//+------------------------------------------------------------------+
void Evaluate()
  {
   string whyL = "", whyS = "";
   int L = Score(1, whyL);
   int S = Score(-1, whyS);
   gLastLong = L;
   gLastShort = S;
   int dir = (L > S) ? 1 : (S > L) ? -1 : 0;
   int score = (dir > 0) ? L : S;
   gLastWhy = (dir >= 0) ? whyL : whyS;

   if(dir == 0 || score < InpMinScore)
     {
      int best = (L > S) ? L : S;
      gLastStatus = StringFormat("No trade: best score %d, needs %d", best, InpMinScore);
      return;
     }
   string side = (dir > 0) ? "BUY" : "SELL";
   if((dir > 0 && !InpTradeLongs) || (dir < 0 && !InpTradeShorts))
     {
      gLastStatus = side + " signal skipped: that direction is switched off";
      return;
     }
   string block = WhyNotOpen();
   if(block != "")
     {
      gLastStatus = StringFormat("%s signal (score %d) skipped: %s", side, score, block);
      return;
     }
   OpenTrade(dir, score);
  }

//+------------------------------------------------------------------+
//| Guards                                                           |
//+------------------------------------------------------------------+
bool IsBlockedRealAccount()
  {
   if(MQLInfoInteger(MQL_TESTER))
      return(false);
   return(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL && !InpAllowRealAccount);
  }

string WhyNotOpen()
  {
   if(IsBlockedRealAccount())
      return("real account and 'Allow trading on a REAL account' is off");
   if(!MQLInfoInteger(MQL_TESTER) && (!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)))
      return("Algo Trading is switched off (toolbar button / Allow Algo Trading)");
   if(HasPosition())
      return("a trade is already open");
   if(InpMaxTradesPerDay > 0 && TradesToday() >= InpMaxTradesPerDay)
      return(StringFormat("daily limit of %d trades reached", InpMaxTradesPerDay));
   if(InpMaxDailyLossPct > 0.0)
     {
      double start = DayStartEquity();
      if(start > 0.0 && (start - AccountInfoDouble(ACCOUNT_EQUITY)) >= start * InpMaxDailyLossPct / 100.0)
         return(StringFormat("daily loss limit (%.1f%%) reached", InpMaxDailyLossPct));
     }
   double spread = SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(InpMaxSpreadAtr > 0.0 && spread > InpMaxSpreadAtr * ATR0)
      return("spread too wide (" + DoubleToString(spread, _Digits) + ")");
   return("");
  }

bool HasPosition()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && (ulong)PositionGetInteger(POSITION_MAGIC) == InpMagic)
         return(true);
     }
   return(false);
  }

datetime DayStart()
  {
   MqlDateTime d;
   TimeToStruct(TimeCurrent(), d);
   d.hour = 0;
   d.min = 0;
   d.sec = 0;
   return(StructToTime(d));
  }

int TradesToday()
  {
   if(!HistorySelect(DayStart(), TimeCurrent() + 60))
      return(0);
   int n = 0;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0)
         continue;
      if((ulong)HistoryDealGetInteger(d, DEAL_MAGIC) == InpMagic &&
         HistoryDealGetString(d, DEAL_SYMBOL) == _Symbol &&
         HistoryDealGetInteger(d, DEAL_ENTRY) == DEAL_ENTRY_IN)
         n++;
     }
   return(n);
  }

string GvName(string what)
  {
   return("SignalDesk_" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + (string)InpMagic + "_" + _Symbol + "_" + what);
  }

// Equity at the start of today (survives restarts via terminal global variables)
double DayStartEquity()
  {
   MqlDateTime d;
   TimeToStruct(TimeCurrent(), d);
   double today = (double)(d.year * 10000 + d.mon * 100 + d.day);
   string kd = GvName("day"), ke = GvName("equity");
   if(!GlobalVariableCheck(kd) || GlobalVariableGet(kd) != today)
     {
      GlobalVariableSet(kd, today);
      GlobalVariableSet(ke, AccountInfoDouble(ACCOUNT_EQUITY));
     }
   return(GlobalVariableGet(ke));
  }

//+------------------------------------------------------------------+
//| Orders                                                           |
//+------------------------------------------------------------------+
double RoundToTick(double price)
  {
   double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(ts <= 0.0)
      ts = _Point;
   return(NormalizeDouble(MathRound(price / ts) * ts, _Digits));
  }

double FloorVolume(double v)
  {
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0)
      step = 0.01;
   int digits = (int)MathMax(0.0, MathCeil(-MathLog10(step) - 1e-9));
   return(NormalizeDouble(MathFloor(v / step + 1e-9) * step, digits));
  }

// Lots so that hitting the stop loses `riskMoney` (0 = can't size that small)
double LotsForRisk(ENUM_ORDER_TYPE type, double entry, double sl, double riskMoney)
  {
   double lossPerLot = 0.0;
   if(!OrderCalcProfit(type, _Symbol, 1.0, entry, sl, lossPerLot) || lossPerLot >= 0.0)
      return(0.0);
   double lots = FloorVolume(riskMoney / -lossPerLot);
   if(lots < SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN))
      return(0.0);
   return(MathMin(lots, SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX)));
  }

void OpenTrade(int dir, int score)
  {
   string side = (dir > 0) ? "BUY" : "SELL";
   double entry = (dir > 0) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);

//--- stop beyond the 10-candle swing (+0.25 ATR) or 1.5 ATR, kept between 1 and 3 ATR
   double swing = (dir > 0) ? R[0].low : R[0].high;
   for(int j = 1; j < 10; j++)
      swing = (dir > 0) ? MathMin(swing, R[j].low) : MathMax(swing, R[j].high);
   double structural = (dir > 0) ? entry - swing + 0.25 * ATR0 : swing - entry + 0.25 * ATR0;
   double risk = MathMax(1.5 * ATR0, structural);
   risk = MathMin(MathMax(risk, 1.0 * ATR0), 3.0 * ATR0);

   double sl = RoundToTick(entry - dir * risk);
   double tp = RoundToTick(entry + dir * risk * gTp2R);
   double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   if(MathAbs(entry - sl) <= minDist || MathAbs(tp - entry) <= minDist)
     {
      gLastStatus = side + " skipped: stop is closer than the broker allows";
      return;
     }

   ENUM_ORDER_TYPE type = (dir > 0) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double riskMoney = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPercent / 100.0;
   double lots = LotsForRisk(type, entry, sl, riskMoney);
   if(lots <= 0.0)
     {
      gLastStatus = side + " skipped: even the minimum lot would risk more than " + DoubleToString(InpRiskPercent, 2) + "% here";
      Print("Signal Desk: ", gLastStatus);
      return;
     }
   double margin = 0.0;
   if(OrderCalcMargin(type, _Symbol, lots, entry, margin) && margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
     {
      gLastStatus = side + " skipped: not enough free margin";
      Print("Signal Desk: ", gLastStatus);
      return;
     }

   string comment = "SignalDesk " + IntegerToString(score);
   bool sent = (dir > 0) ? trade.Buy(lots, _Symbol, 0.0, sl, tp, comment)
                         : trade.Sell(lots, _Symbol, 0.0, sl, tp, comment);
   uint rc = trade.ResultRetcode();
   if(!sent || (rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_DONE_PARTIAL && rc != TRADE_RETCODE_PLACED))
     {
      gLastStatus = side + " order failed: " + trade.ResultRetcodeDescription();
      Print("Signal Desk: ", gLastStatus);
      return;
     }
   gLastStatus = StringFormat("%s %s lots, SL %s, TP2 %s (score %d)", side, DoubleToString(lots, 2),
                              DoubleToString(sl, _Digits), DoubleToString(tp, _Digits), score);
   Notify(StringFormat("%s %s lots at %s, SL %s, TP1 %s, TP2 %s, score %d, 1:%s",
                       side, DoubleToString(lots, 2), DoubleToString(trade.ResultPrice() > 0 ? trade.ResultPrice() : entry, _Digits),
                       DoubleToString(sl, _Digits), DoubleToString(RoundToTick(entry + dir * risk * gTp1R), _Digits),
                       DoubleToString(tp, _Digits), score, DoubleToString(gTp2R, 1)));
  }

//+------------------------------------------------------------------+
//| Open trade management: TP1 scale-out, stop to entry, time exit   |
//+------------------------------------------------------------------+
void ManagePositions()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || (ulong)PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;

      int    dir  = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 1 : -1;
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl   = PositionGetDouble(POSITION_SL);
      double tp   = PositionGetDouble(POSITION_TP);
      double vol  = PositionGetDouble(POSITION_VOLUME);
      double px   = (dir > 0) ? SymbolInfoDouble(_Symbol, SYMBOL_BID) : SymbolInfoDouble(_Symbol, SYMBOL_ASK);

      //--- time exit
      int barsOpen = iBarShift(_Symbol, TF, (datetime)PositionGetInteger(POSITION_TIME), false);
      if(gMaxBars > 0 && barsOpen >= gMaxBars)
        {
         if(trade.PositionClose(ticket))
            Notify(StringFormat("time exit after %d candles", barsOpen));
         continue;
        }

      if(!InpScaleOut)
         continue;

      string key = GvName("scaled_" + (string)ticket);
      bool scaled = GlobalVariableCheck(key);
      bool stopBelowEntry = (sl > 0.0) && ((dir > 0) ? sl < open : sl > open);

      if(scaled)
        {
         if(!stopBelowEntry)
            continue;   // stop already at entry: nothing left to do
         // Price came back to entry before the stop could be moved: close the rest flat.
         if((dir > 0) ? px <= open : px >= open)
           {
            if(trade.PositionClose(ticket))
               Notify("closed the rest at entry after TP1");
            continue;
           }
         MoveStopToEntry(ticket, open, tp);
         continue;
        }

      if(!stopBelowEntry)
         continue;      // stop was moved by hand; leave the trade alone
      double tp1 = open + dir * MathAbs(open - sl) * gTp1R;
      if((dir > 0) ? px < tp1 : px > tp1)
         continue;

      //--- TP1 reached: close half (when the volume can be split), then stop to entry
      double half = FloorVolume(vol / 2.0);
      double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
      if(half >= vmin && vol - half >= vmin - 1e-9)
        {
         if(!trade.PositionClosePartial(ticket, half))
           {
            WarnOncePerBar("partial close failed: " + trade.ResultRetcodeDescription());
            continue;
           }
         Notify(StringFormat("TP1 hit: closed %s lots, moving stop to entry", DoubleToString(half, 2)));
        }
      else
         Notify("TP1 hit (position too small to split): moving stop to entry");
      GlobalVariableSet(key, 1.0);
      MoveStopToEntry(ticket, open, tp);
     }
  }

void MoveStopToEntry(ulong ticket, double open, double tp)
  {
   if(!trade.PositionModify(ticket, RoundToTick(open), tp))
      WarnOncePerBar("could not move stop to entry yet: " + trade.ResultRetcodeDescription());
  }

void WarnOncePerBar(string msg)
  {
   datetime bar = iTime(_Symbol, TF, 0);
   if(bar == gLastWarnBar)
      return;
   gLastWarnBar = bar;
   Print("Signal Desk: ", msg);
  }

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
ENUM_TIMEFRAMES HigherTF(ENUM_TIMEFRAMES tf)
  {
   int s = PeriodSeconds(tf);
   if(s <= 15 * 60)
      return(PERIOD_H1);
   if(s <= 60 * 60)
      return(PERIOD_H4);
   if(s <= 4 * 60 * 60)
      return(PERIOD_D1);
   return(PERIOD_W1);
  }

string TfName(ENUM_TIMEFRAMES tf)
  {
   return(StringSubstr(EnumToString(tf), 7));   // "PERIOD_H1" -> "H1"
  }

void Notify(string msg)
  {
   string text = "Signal Desk " + _Symbol + ": " + msg;
   Print(text);
   if(InpPushNotifications && !MQLInfoInteger(MQL_TESTER) && TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED))
      SendNotification(StringSubstr(text, 0, 255));
  }

void UpdatePanel()
  {
   string account = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL) ? "REAL" : "DEMO";
   string text = StringFormat("Signal Desk  |  %s %s  (trend filter %s)  |  %s account\n",
                              _Symbol, TfName(TF), TfName(HTF), account);
   text += StringFormat("Risk %s%% per trade  |  1:%s  |  min score %d  |  time exit %d candles\n",
                        DoubleToString(InpRiskPercent, 2), DoubleToString(gTp2R, 1), InpMinScore, gMaxBars);
   text += StringFormat("Last closed candle: BUY score %d  /  SELL score %d\n", gLastLong, gLastShort);
   if(gLastWhy != "")
      text += "Agreeing: " + gLastWhy + "\n";
   text += gLastStatus;
   Comment(text);
  }
//+------------------------------------------------------------------+
