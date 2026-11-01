(function () {
  'use strict';

  const Engine = window.SignalEngine;
  const Scanner = window.Scanner;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'signal-desk-settings-v1';
  const AUTO_MS = 5 * 60 * 1000;

  const els = {
    form: $('controls'), symbols: $('symbols'), interval: $('interval'), account: $('account'),
    risk: $('risk'), tp2: $('tp2'), scaleOut: $('scaleOut'), auto: $('auto'), go: $('go'),
    status: $('status'), progress: $('progress'), idea: $('idea'), ideaMore: $('ideaMore'),
    tablePanel: $('tablePanel'), tbody: $('tbody'), scanMeta: $('scanMeta'),
    tvPanel: $('tvPanel'), tvTitle: $('tvTitle'), tvOpen: $('tvOpen'), tvLevels: $('tvLevels'), tvFrame: $('tvFrame'),
  };

  const TV_SCRIPT = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  const TV_INTERVAL = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
  let tvKey = null;   // symbol|interval|theme currently mounted
  let tvShown = null; // result whose chart is shown

  let lastScan = null;
  let selected = null;
  let settings = null;
  let busy = false;
  let timer = null;
  let liveIdeas = new Set();

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { s = {}; }
    els.symbols.value = s.symbols || Scanner.DEFAULT_SYMBOLS.join(', ');
    els.interval.value = s.interval || 'auto';
    els.account.value = s.account != null ? s.account : 1000;
    els.risk.value = s.riskPct != null ? s.riskPct : 1;
    els.tp2.value = String(s.tp2R || 2);
    els.scaleOut.checked = s.scaleOut != null ? s.scaleOut : true;
  }

  function readSettings() {
    const s = {
      symbols: els.symbols.value,
      interval: els.interval.value,
      account: Math.max(0, parseFloat(els.account.value) || 0),
      riskPct: Math.min(10, Math.max(0.1, parseFloat(els.risk.value) || 1)),
      tp2R: parseFloat(els.tp2.value) || 2,
      scaleOut: els.scaleOut.checked,
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
    return s;
  }

  // -------------------------------------------------------------- formatting

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function decimalsFor(p) {
    if (!Number.isFinite(p) || p === 0) return 2;
    return Math.min(8, Math.max(2, 5 - Math.floor(Math.log10(Math.abs(p)))));
  }
  const num = (x, d) => x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const price = (p, ref) => num(p, decimalsFor(ref || p));
  const money = (x) => '$' + num(x, 2);
  const pct = (x) => (x >= 0 ? '+' : '−') + num(Math.abs(x) * 100, 2) + '%';
  const rText = (r) => (r >= 0 ? '+' : '−') + num(Math.abs(r), 2) + 'R';
  const qty = (u) => (u >= 100 ? num(u, 2) : u >= 1 ? num(u, 4) : u.toPrecision(4));
  const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dirWord = (d) => (d > 0 ? 'BUY' : 'SELL');
  const lean = (d) => (d > 0 ? 'long' : d < 0 ? 'short' : 'neutral');

  const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI', 'EUR', 'TRY', 'BTC', 'ETH', 'BNB'];
  function baseAsset(sym) {
    for (const q of QUOTES) if (sym.endsWith(q) && sym.length > q.length) return sym.slice(0, -q.length);
    return sym;
  }

  function sizing(r, s) {
    const riskAmt = (s.account * s.riskPct) / 100;
    const units = r.plan ? riskAmt / r.plan.risk : 0;
    const notional = units * (r.plan ? r.plan.entry : 0);
    return { riskAmt, units, notional, leverage: s.account > 0 ? notional / s.account : 0 };
  }

  // ---------------------------------------------------------------- scanning

  function setStatus(text) { els.status.textContent = text; }

  function setProgress(frac) {
    if (frac === null) { els.progress.hidden = true; return; }
    els.progress.hidden = false;
    els.progress.firstElementChild.style.width = Math.round(frac * 100) + '%';
  }

  async function run(trigger) {
    if (busy) return;
    settings = readSettings();
    const symbols = Scanner.parseSymbols(settings.symbols);
    if (!symbols.length) {
      renderError('Add at least one market, e.g. BTCUSDT.');
      return;
    }
    const intervals = settings.interval === 'auto' ? Scanner.AUTO_INTERVALS : [settings.interval];
    busy = true;
    els.go.disabled = true;
    els.go.textContent = 'Scanning…';
    setStatus(`Scanning ${symbols.length * intervals.length} market/timeframe combinations…`);
    setProgress(0);
    try {
      const scan = await Scanner.scan({
        symbols,
        intervals,
        opts: { tp2R: settings.tp2R, scaleOut: settings.scaleOut },
        onProgress: (d, t) => setProgress(d / t),
      });
      lastScan = scan;
      const ok = scan.results.filter((r) => !r.error);
      if (!ok.length) {
        renderError(scan.results[0] ? scan.results[0].error : 'No data returned.');
        els.tablePanel.hidden = true;
        setStatus('Scan failed');
        return;
      }
      // Keep the user's selection on auto-refresh if it still exists.
      const keep = trigger === 'auto' && selected &&
        scan.results.find((r) => r.symbol === selected.symbol && r.interval === selected.interval && !r.error);
      selected = keep || scan.best || null;
      renderIdea();
      renderTable();
      notifyNew(scan, trigger);
      const host = scan.source ? new URL(scan.source).hostname : 'Binance';
      setStatus(`Updated ${new Date(scan.scannedAt).toLocaleTimeString()} · ${host}`);
    } catch (e) {
      renderError(e.message || String(e));
      setStatus('Scan failed');
    } finally {
      busy = false;
      els.go.disabled = false;
      els.go.textContent = 'Get trade idea now';
      setProgress(null);
    }
  }

  function notifyNew(scan, trigger) {
    const current = scan.results.filter((r) => !r.error && (r.grade === 'A' || r.grade === 'B'));
    const keys = new Set(current.map((r) => `${r.symbol}|${r.interval}|${r.dir}`));
    const fresh = current.filter((r) => !liveIdeas.has(`${r.symbol}|${r.interval}|${r.dir}`));
    liveIdeas = keys;
    if (trigger !== 'auto' || !fresh.length) return;
    const r = fresh[0];
    document.title = `● ${dirWord(r.dir)} ${r.symbol} — Signal Desk`;
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`${dirWord(r.dir)} ${r.symbol} (${r.interval}) — Grade ${r.grade}`, {
          body: `Entry ${price(r.plan.entry)} · SL ${price(r.plan.sl, r.plan.entry)} · TP1 ${price(r.plan.tp1, r.plan.entry)} · TP2 ${price(r.plan.tp2, r.plan.entry)}`,
        });
      } catch (e) { /* notifications unsupported in this context */ }
    }
  }

  // --------------------------------------------------------------- rendering

  function renderError(msg) {
    els.ideaMore.innerHTML = '';
    els.tvPanel.hidden = true;
    els.idea.innerHTML = `
      <div class="panel error-card">
        <h2>Couldn’t get market data</h2>
        <p>${esc(msg)}</p>
        <p class="muted">Check the symbol names (they must exist on Binance, e.g. BTCUSDT) and your internet connection. Some networks and countries block Binance; a VPN or a different network may help.</p>
      </div>`;
  }

  function renderIdea() {
    const r = selected;
    if (!r) return renderNoTrade();
    const s = settings;
    const p = r.plan;
    const dir = r.dir;
    const head = `
      <div class="card-head">
        <div>
          <div class="pair">${esc(r.symbol)} <span class="tf">${esc(r.interval)}</span></div>
          <div class="sub">Price ${price(r.livePrice)} · last closed candle ${when(r.lastBarTime)}${r.signal ? ` · signal active for ${r.ageBars} candle${r.ageBars === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div class="verdict">
          ${r.signal
            ? `<span class="badge ${dir > 0 ? 'buy' : 'sell'}">${dirWord(dir)}</span>`
            : `<span class="badge wait">WAIT</span>`}
          <span class="grade g-${r.grade}">${r.grade === 'none' ? 'No trade' : 'Grade ' + r.grade}</span>
        </div>
      </div>`;

    const quality = r.signal ? `
      <div class="quality">
        <div class="q-label">Setup quality <b>${r.quality}</b>/100</div>
        <div class="meter"><span style="width:${r.quality}%"></span></div>
        <div class="q-note">${esc(r.gradeText)}. This blends today’s confluence with the track record below — it is not a probability of winning.</div>
      </div>` : `
      <div class="quality">
        <div class="q-label">Leaning <b>${lean(dir)}</b> — score ${r.score}/100, needs ${r.opts.threshold} for a trade</div>
        <div class="q-note">${esc(r.gradeText)}.</div>
      </div>`;

    const warnings = r.warnings.length
      ? `<ul class="warnings">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';

    let levels = '';
    if (p) {
      const z = sizing(r, s);
      const move = (x) => pct((x - p.entry) / p.entry);
      levels = `
        <div class="levels">
          <h3>Trade plan</h3>
          <table>
            <tr class="entry"><th>Entry</th><td class="px">${price(p.entry)}</td><td class="note">market price now</td></tr>
            <tr class="sl"><th>Stop loss</th><td class="px">${price(p.sl, p.entry)}</td><td class="note">${move(p.sl)} · −1R</td></tr>
            <tr class="tp"><th>TP1</th><td class="px">${price(p.tp1, p.entry)}</td><td class="note">${move(p.tp1)} · ${rText(p.tp1R)}${p.scaleOut ? ' · close 50%, move stop to entry' : ' · reference level'}</td></tr>
            <tr class="tp"><th>TP2</th><td class="px">${price(p.tp2, p.entry)}</td><td class="note">${move(p.tp2)} · ${rText(p.tp2R)} · close the rest</td></tr>
          </table>
          <div class="sizing">
            <div>Position size: <b>${qty(z.units)} ${esc(baseAsset(r.symbol))}</b> (≈ ${money(z.notional)})</div>
            <div>Risk if stopped: <b>${money(z.riskAmt)}</b> (${s.riskPct}% of ${money(s.account)})${z.leverage > 1 ? ` · needs ${num(z.leverage, 1)}× leverage` : ''}</div>
            <div class="muted">Exit at market after ${r.opts.maxBars} candles if neither the stop nor TP2 is hit.</div>
          </div>
          ${dir < 0 ? '<div class="short-note">A SELL means opening a short (futures or margin). On spot only, treat it as “don’t buy now / consider taking profit”.</div>' : ''}
          <div class="actions"><button type="button" id="copyPlan">Copy trade plan</button></div>
        </div>`;
    }

    const checks = `
      <div class="why">
        <h3>Why — score ${r.score}/100</h3>
        <ul class="checklist">
          ${r.checks.map((c) => `
            <li class="${c.penalty ? 'penalty' : c.pass ? 'pass' : 'fail'}">
              <span class="ic">${c.penalty ? '!' : c.pass ? '✓' : '✗'}</span>
              <span>${esc(c.label)}</span>
              <span class="w">${c.penalty ? c.weight : (c.pass ? '+' : '') + (c.pass ? c.weight : 0) + '/' + c.weight}</span>
            </li>`).join('')}
        </ul>
      </div>`;

    const chart = `
      <div class="chart-wrap">
        <canvas class="chart" id="chart" aria-label="Price chart with trade levels" role="img"></canvas>
        <div class="legend">
          <span><i style="background:var(--ema1)"></i>20 EMA</span>
          <span><i style="background:var(--ema2)"></i>50 EMA</span>
          ${p ? '<span><i style="background:var(--up)"></i>Targets</span><span><i style="background:var(--down)"></i>Stop loss</span>' : ''}
        </div>
      </div>`;

    els.idea.innerHTML = `
      <article class="panel card">
        ${head}
        ${quality}
        ${warnings}
        <div class="grid2">${levels || checks}${levels ? checks : historyBlock(r)}</div>
      </article>`;
    els.ideaMore.innerHTML = `
      <article class="panel card">
        <div>
          <h3>${p ? 'Trade plan on the chart (at scan time)' : 'Price at scan time'}</h3>
          ${chart}
        </div>
        ${levels ? historyBlock(r) : ''}
      </article>`;

    renderTradingView(r);
    drawChart($('chart'), r);
    const eq = $('equity');
    if (eq) drawEquity(eq, r.stats.equity);
    const copy = $('copyPlan');
    if (copy) copy.addEventListener('click', () => copyPlan(r, copy));
  }

  function historyBlock(r) {
    const st = r.stats;
    const sd = r.sameDir;
    if (!st.n) {
      return `<div class="history"><h3>Track record</h3><p class="muted">These rules didn’t trigger on ${esc(r.symbol)} ${esc(r.interval)} in the available history, so there is nothing to judge them on yet.</p></div>`;
    }
    const s = settings;
    const perTrade = (st.avgR * s.account * s.riskPct) / 100;
    const o = st.outcomes;
    const share = (k) => (100 * o[k]) / st.n;
    const pf = Number.isFinite(st.profitFactor) ? num(st.profitFactor, 2) : '∞';
    return `
      <div class="history">
        <h3>Track record of these exact rules on ${esc(r.symbol)} ${esc(r.interval)}</h3>
        <p class="muted small">${st.n} past trades over the last ~1,500 candles, one at a time, fees and slippage included, worst case assumed when a candle touched both stop and target.</p>
        <div class="stats">
          <div class="stat"><div class="k">Win rate</div><div class="v">${num(st.winRate * 100, 0)}%</div></div>
          <div class="stat"><div class="k">Worst-case win rate (95%)</div><div class="v">${num(st.winRateLow * 100, 0)}%</div></div>
          <div class="stat"><div class="k">Average per trade</div><div class="v ${st.avgR >= 0 ? 'pos' : 'neg'}">${rText(st.avgR)}</div></div>
          <div class="stat"><div class="k">Profit factor</div><div class="v">${pf}</div></div>
          <div class="stat"><div class="k">Longest losing streak</div><div class="v">${st.maxLossStreak}</div></div>
          <div class="stat"><div class="k">Worst drawdown</div><div class="v">${rText(-st.maxDrawdownR)}</div></div>
        </div>
        <div class="outcomes" aria-hidden="true">
          <span class="o-target" style="width:${share('target')}%"></span>
          <span class="o-breakeven" style="width:${share('breakeven')}%"></span>
          <span class="o-timeout" style="width:${share('timeout')}%"></span>
          <span class="o-stop" style="width:${share('stop')}%"></span>
        </div>
        <div class="o-legend">
          <span><i class="o-target"></i>Hit TP2: ${o.target}</span>
          ${r.opts.scaleOut ? `<span><i class="o-breakeven"></i>TP1 then stop at entry: ${o.breakeven}</span>` : ''}
          <span><i class="o-timeout"></i>Time exit: ${o.timeout}</span>
          <span><i class="o-stop"></i>Full stop loss: ${o.stop}</span>
        </div>
        <canvas class="equity" id="equity" aria-label="Cumulative result of every past signal, in R" role="img"></canvas>
        <p class="muted small">Line: running total in R if you had taken every past signal. At your risk size the average works out to about ${perTrade >= 0 ? '+' : '−'}${money(Math.abs(perTrade))} per trade.
        ${r.dir && sd.n ? ` ${r.dir > 0 ? 'Longs' : 'Shorts'} only: ${sd.n} trades, ${num(sd.winRate * 100, 0)}% win rate, ${rText(sd.avgR)} average.` : ''}</p>
      </div>`;
  }

  function renderNoTrade() {
    const ok = lastScan ? lastScan.results.filter((r) => !r.error) : [];
    const avoid = ok.filter((r) => r.grade === 'D');
    const closest = ok.filter((r) => r.grade === 'none').sort((a, b) => b.score - a.score).slice(0, 4);
    els.ideaMore.innerHTML = '';
    renderTradingView(closest[0] || ok[0] || null);
    els.idea.innerHTML = `
      <article class="panel card">
        <div class="card-head">
          <div><div class="pair">No trade right now</div>
          <div class="sub">${ok.length} market/timeframe combinations scanned</div></div>
          <div class="verdict"><span class="badge wait">WAIT</span></div>
        </div>
        <p>Nothing on your list has enough conditions lining up with a track record worth trusting. Sitting out <em>is</em> a position — most losses come from forcing trades. Try again later, add more markets, or switch timeframe.</p>
        ${avoid.length ? `<p class="muted">${avoid.length} signal${avoid.length === 1 ? '' : 's'} fired but ${avoid.length === 1 ? 'is' : 'are'} graded D (these rules have been losing money there): ${avoid.map((r) => esc(`${r.symbol} ${r.interval}`)).join(', ')}.</p>` : ''}
        ${closest.length ? `
          <div>
            <h3>Closest to triggering</h3>
            <ul class="closest">
              ${closest.map((r) => `<li><button type="button" data-key="${esc(r.symbol + '|' + r.interval)}"><span><b>${esc(r.symbol)}</b> ${esc(r.interval)} — leaning ${lean(r.dir)}</span><span>${r.score}/${r.opts.threshold}</span></button></li>`).join('')}
            </ul>
          </div>` : ''}
      </article>`;
    els.idea.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => select(b.dataset.key)));
  }

  function renderTable() {
    const rows = lastScan.results;
    els.tablePanel.hidden = false;
    els.scanMeta.textContent = `${rows.length} scanned · ${new Date(lastScan.scannedAt).toLocaleTimeString()}`;
    els.tbody.innerHTML = rows.map((r) => {
      const key = esc(r.symbol + '|' + r.interval);
      const sel = selected && selected.symbol === r.symbol && selected.interval === r.interval ? ' class="sel"' : '';
      if (r.error) {
        return `<tr data-key="${key}"${sel}><td><b>${esc(r.symbol)}</b></td><td>${esc(r.interval)}</td><td class="err" colspan="7">${esc(r.error)}</td></tr>`;
      }
      const bias = r.signal
        ? `<span class="${r.dir > 0 ? 'long' : 'short'}">${dirWord(r.dir)}</span>`
        : `<span class="muted">leaning ${lean(r.dir)}</span>`;
      return `<tr data-key="${key}"${sel}>
        <td><b>${esc(r.symbol)}</b></td><td>${esc(r.interval)}</td>
        <td class="num">${price(r.livePrice)}</td><td>${bias}</td><td class="num">${r.score}</td>
        <td><span class="g-${r.grade}">${r.grade === 'none' ? '—' : r.grade}</span></td>
        <td class="num">${r.stats.n}</td>
        <td class="num">${r.stats.n ? num(r.stats.winRate * 100, 0) + '%' : '—'}</td>
        <td class="num ${r.stats.avgR >= 0 ? 'long' : 'short'}">${r.stats.n ? rText(r.stats.avgR) : '—'}</td>
      </tr>`;
    }).join('');
    els.tbody.querySelectorAll('tr[data-key]').forEach((tr) => tr.addEventListener('click', () => select(tr.dataset.key)));
  }

  function select(key) {
    const r = lastScan && lastScan.results.find((x) => x.symbol + '|' + x.interval === key);
    if (!r) return;
    if (r.error) { renderError(`${r.symbol} ${r.interval}: ${r.error}`); return; }
    selected = r;
    renderIdea();
    renderTable();
    els.idea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function planText(r) {
    const p = r.plan;
    const z = sizing(r, settings);
    const rel = (x) => pct((x - p.entry) / p.entry);
    return [
      `${dirWord(r.dir)} ${r.symbol} (${r.interval}) — Grade ${r.grade}, quality ${r.quality}/100, score ${r.score}/100`,
      `Entry: ${price(p.entry)}`,
      `Stop loss: ${price(p.sl, p.entry)} (${rel(p.sl)})`,
      `TP1: ${price(p.tp1, p.entry)} (${rel(p.tp1)})${p.scaleOut ? ' — close 50%, move stop to entry' : ''}`,
      `TP2: ${price(p.tp2, p.entry)} (${rel(p.tp2)})`,
      `Size: ${qty(z.units)} ${baseAsset(r.symbol)} (≈ ${money(z.notional)}), risking ${money(z.riskAmt)}`,
      r.stats.n ? `Track record here: ${r.stats.n} trades, ${num(r.stats.winRate * 100, 0)}% win rate, ${rText(r.stats.avgR)} average per trade` : 'Track record here: none yet',
      `Chart: ${tvLink(r)}`,
      'Not financial advice. No setup is guaranteed.',
    ].join('\n');
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
      ta.remove();
    }
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = 'Copied ✓';
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1300);
  }

  const copyPlan = (r, btn) => copyText(planText(r), btn);

  // ------------------------------------------------------- TradingView chart

  const isLight = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);

  function timeZone() {
    let tz = 'Etc/UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (e) { /* keep UTC */ }
    return /^(UTC|GMT|Etc\/(UTC|GMT|Universal|Zulu)|Universal|Zulu)$/.test(tz) ? 'Etc/UTC' : tz;
  }

  function tvSymbol(symbol) {
    const host = lastScan && lastScan.source ? lastScan.source : '';
    return (host.includes('binance.us') ? 'BINANCEUS:' : 'BINANCE:') + symbol;
  }

  function tvLink(r) {
    return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol(r.symbol))}&interval=${encodeURIComponent(TV_INTERVAL[r.interval] || '60')}`;
  }

  function renderTradingView(r) {
    tvShown = r;
    if (!r) { els.tvPanel.hidden = true; return; }
    els.tvPanel.hidden = false;
    const symbol = tvSymbol(r.symbol);
    const interval = TV_INTERVAL[r.interval] || '60';
    els.tvTitle.textContent = `${symbol} · ${r.interval}`;
    els.tvOpen.href = tvLink(r);
    renderLevelChips(r);
    const theme = isLight() ? 'light' : 'dark';
    const key = `${symbol}|${interval}|${theme}`;
    if (key === tvKey) return; // same chart: keep it (and any drawings) as is
    tvKey = key;
    mountTradingView(symbol, interval, theme);
  }

  // TradingView's official Advanced Chart embed: a container, a widget div and
  // the embed script carrying its JSON config as the script body.
  function mountTradingView(symbol, interval, theme) {
    const frame = els.tvFrame;
    frame.textContent = '';
    const box = document.createElement('div');
    box.className = 'tradingview-widget-container';
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    const credit = document.createElement('div');
    credit.className = 'tradingview-widget-copyright';
    credit.innerHTML = '<a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank">Charts by TradingView</a>';
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = TV_SCRIPT;
    script.async = true;
    script.textContent = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      timezone: timeZone(),
      theme,
      style: '1',
      locale: 'en',
      allow_symbol_change: true,
      hide_side_toolbar: false,
      withdateranges: true,
      save_image: true,
      calendar: false,
      details: false,
      support_host: 'https://www.tradingview.com',
    });
    script.onerror = () => {
      frame.innerHTML = '<div class="tv-fallback">TradingView couldn’t load. It may be blocked on this network or by an ad blocker. Use “Open in TradingView ↗” above instead.</div>';
      tvKey = null; // try again on the next render
    };
    box.append(widget, credit, script);
    frame.appendChild(box);
  }

  function renderLevelChips(r) {
    const p = r.plan;
    if (!p) {
      els.tvLevels.innerHTML = `<span class="chip-note">No trade levels for ${esc(r.symbol)} ${esc(r.interval)} right now — watching it live.</span>`;
      return;
    }
    const d = decimalsFor(p.entry);
    const chip = (cls, label, v) =>
      `<button type="button" class="chip ${cls}" data-price="${v.toFixed(d)}" title="Copy ${label}">${label} ${price(v, p.entry)}</button>`;
    els.tvLevels.innerHTML = [
      chip('entry', `${dirWord(p.dir)} entry`, p.entry),
      chip('sl', 'SL', p.sl),
      chip('tp', 'TP1', p.tp1),
      chip('tp', 'TP2', p.tp2),
    ].join('');
    els.tvLevels.querySelectorAll('[data-price]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.price, b)));
  }

  // ------------------------------------------------------------------ charts

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function drawChart(canvas, r) {
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const { candles, ema20, ema50 } = r.chart;
    const p = r.plan;
    const colors = {
      up: cssVar('--up'), down: cssVar('--down'), grid: cssVar('--grid'), muted: cssVar('--muted'),
      text: cssVar('--text'), panel: cssVar('--panel'), ema1: cssVar('--ema1'), ema2: cssVar('--ema2'),
      upSoft: cssVar('--up-soft'), downSoft: cssVar('--down-soft'),
    };
    const padL = 4;
    const padR = 84;
    const padT = 10;
    const padB = 10;
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of candles) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
    const levels = [r.livePrice];
    if (p) levels.push(p.sl, p.tp1, p.tp2);
    for (const v of levels) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.04 || hi * 0.01;
    lo -= pad;
    hi += pad;

    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const slots = candles.length + 10; // room on the right for the projected levels
    const step = plotW / slots;
    const x = (i) => padL + step * (i + 0.5);
    const y = (v) => padT + ((hi - v) / (hi - lo)) * plotH;
    const ref = r.livePrice;

    // grid + price axis (axis labels are skipped where a level label will sit)
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const levelYs = (p ? [p.sl, p.entry, p.tp1, p.tp2] : [r.livePrice]).map(y);
    for (let g = 0; g <= 4; g++) {
      const v = lo + ((hi - lo) * g) / 4;
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      if (levelYs.some((ly) => Math.abs(ly - yy) < 14)) continue;
      ctx.fillStyle = colors.muted;
      ctx.fillText(price(v, ref), w - padR + 6, yy);
    }

    // trade zones
    if (p) {
      const x0 = x(candles.length - 1);
      const x1 = w - padR;
      ctx.fillStyle = colors.downSoft;
      ctx.fillRect(x0, Math.min(y(p.entry), y(p.sl)), x1 - x0, Math.abs(y(p.sl) - y(p.entry)));
      ctx.fillStyle = colors.upSoft;
      ctx.fillRect(x0, Math.min(y(p.entry), y(p.tp2)), x1 - x0, Math.abs(y(p.tp2) - y(p.entry)));
    }

    // candles
    const bw = Math.max(1, Math.min(10, step * 0.62));
    candles.forEach((b, i) => {
      const col = b.c >= b.o ? colors.up : colors.down;
      const cx = Math.round(x(i)) + 0.5;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(cx, y(b.h)); ctx.lineTo(cx, y(b.l)); ctx.stroke();
      const top = y(Math.max(b.o, b.c));
      const bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      ctx.fillStyle = col;
      ctx.fillRect(cx - bw / 2, top, bw, bh);
    });

    // EMAs
    const line = (series, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      series.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
      });
      ctx.stroke();
      ctx.lineWidth = 1;
    };
    line(ema50, colors.ema2);
    line(ema20, colors.ema1);

    // level lines + labels
    const labels = [];
    const level = (v, color, text, dashed) => {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = color;
      ctx.setLineDash(dashed ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(p ? x(candles.length - 1) : padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.setLineDash([]);
      labels.push({ y: yy, color, text: `${text} ${price(v, ref)}` });
    };
    if (p) {
      level(p.tp2, colors.up, 'TP2', false);
      level(p.tp1, colors.up, 'TP1', true);
      level(p.entry, colors.text, 'Entry', false);
      level(p.sl, colors.down, 'SL', false);
    } else {
      level(r.livePrice, colors.muted, 'Now', true);
    }
    // keep labels from overlapping
    labels.sort((a, b) => a.y - b.y);
    for (let k = 1; k < labels.length; k++) {
      if (labels[k].y - labels[k - 1].y < 16) labels[k].y = labels[k - 1].y + 16;
    }
    ctx.font = '600 11px system-ui, sans-serif';
    for (const l of labels) {
      const tw = ctx.measureText(l.text).width;
      const bx = w - padR + 2;
      ctx.fillStyle = l.color;
      ctx.fillRect(bx, l.y - 8, Math.min(padR - 4, tw + 8), 16);
      ctx.fillStyle = colors.panel;
      ctx.fillText(l.text, bx + 4, l.y, padR - 10);
    }
  }

  function drawEquity(canvas, equity) {
    const { ctx, w, h } = setupCanvas(canvas);
    if (!equity.length) return;
    const pts = [0, ...equity];
    const lo = Math.min(0, ...pts);
    const hi = Math.max(0, ...pts);
    const span = hi - lo || 1;
    const x = (i) => 4 + ((w - 8) * i) / (pts.length - 1 || 1);
    const y = (v) => 6 + ((hi - v) / span) * (h - 12);
    ctx.strokeStyle = cssVar('--grid');
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(4, y(0)); ctx.lineTo(w - 4, y(0)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = pts[pts.length - 1] >= 0 ? cssVar('--up') : cssVar('--down');
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
  }

  function redraw() {
    if (!selected) return;
    drawChart($('chart'), selected);
    const eq = $('equity');
    if (eq) drawEquity(eq, selected.stats.equity);
  }

  // ------------------------------------------------------------------ wiring

  els.form.addEventListener('submit', (e) => { e.preventDefault(); document.title = 'Signal Desk'; run('manual'); });

  els.auto.addEventListener('change', async () => {
    clearInterval(timer);
    timer = null;
    if (!els.auto.checked) return;
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    timer = setInterval(() => run('auto'), AUTO_MS);
    if (!lastScan) run('manual');
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redraw, 120); });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) mq.addEventListener('change', () => { redraw(); if (tvShown) renderTradingView(tvShown); });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Signal Desk'; });

  loadSettings();
  settings = readSettings();
})();
