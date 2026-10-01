export function dashboardHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Pi Stats</title>
  <style>
    :root {
      --ground: #0f0f0f;
      --panel: #1a1a1a;
      --selected: #222222;
      --rule: #2d2d2d;
      --rule-strong: #414141;
      --ink: #dcdcdc;
      --strong: #f0f0f0;
      --muted: #a5a5a5;
      --dim: #7c7c7c;
      --accent: #d8a766;
      --accent-hover: #e8c092;
      --on-accent: #0f0f0f;
      --chart: #414141;
      --critical: #e2574c;
      --notice: #231e18;
      --focus: #d8a766;
      color-scheme: dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    :root[data-theme="dark"] {
      --ground: #0f0f0f; --panel: #1a1a1a; --selected: #222222;
      --rule: #2d2d2d; --rule-strong: #414141; --ink: #dcdcdc;
      --strong: #f0f0f0; --muted: #a5a5a5; --dim: #7c7c7c;
      --accent: #d8a766; --accent-hover: #e8c092; --on-accent: #0f0f0f;
      --chart: #414141; --critical: #e2574c; --notice: #231e18;
      --focus: #d8a766; color-scheme: dark;
    }
    :root[data-theme="light"] {
      --ground: #f8f8f8; --panel: #f0f0f0; --selected: #dcdcdc;
      --rule: #c0c0c0; --rule-strong: #a5a5a5; --ink: #0f0f0f;
      --strong: #0f0f0f; --muted: #575757; --dim: #575757;
      --accent: #d8a766; --accent-hover: #e8c092; --on-accent: #0f0f0f;
      --chart: #a5a5a5; --critical: #e2574c; --notice: #e8c092;
      --focus: #575757; color-scheme: light;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--ground); color: var(--ink); }
    button, a { font: inherit; }
    button:focus-visible, a:focus-visible, .bars:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 64px; display: grid; gap: 26px; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--rule); padding-bottom: 18px; }
    .eyebrow { color: var(--accent); font: 700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 5px 0 0; color: var(--strong); font-size: clamp(28px, 5vw, 48px); line-height: 1; letter-spacing: -.035em; text-wrap: balance; }
    .toolbar { display: flex; align-items: center; gap: 10px; }
    button { border: 1px solid var(--rule); background: var(--panel); color: var(--ink); padding: 8px 11px; cursor: pointer; }
    button:hover { border-color: var(--accent); background: var(--selected); }
    #refresh { border-color: var(--accent); background: var(--accent); color: var(--on-accent); font-weight: 700; }
    #refresh:hover { background: var(--accent-hover); }
    #stamp { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .rollup { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
    .metric { min-width: 0; padding: 18px; border: 1px solid var(--rule); background: var(--panel); display: grid; gap: 7px; }
    .metric-label { color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
    .metric-value { color: var(--strong); font: 650 clamp(23px, 3vw, 34px)/1 ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .metric-note { color: var(--muted); font-size: 12px; }
    .activity { border: 1px solid var(--rule); background: var(--panel); padding: 18px; display: grid; gap: 15px; }
    .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    h2 { margin: 0; font-size: 14px; letter-spacing: .01em; }
    .section-note { color: var(--muted); font-size: 12px; }
    .bars { min-height: 130px; display: flex; align-items: end; gap: 4px; border-bottom: 1px solid var(--rule); padding-top: 12px; }
    .bar-wrap { flex: 1; min-width: 4px; height: 120px; display: flex; align-items: end; position: relative; }
    .bar { width: 100%; min-height: 2px; background: var(--chart); }
    .bar-wrap:hover .bar { background: var(--accent); }
    .bar-wrap span { display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); z-index: 2; background: var(--ink); color: var(--ground); padding: 4px 6px; white-space: nowrap; font: 11px/1.2 ui-monospace, monospace; }
    .bar-wrap:hover span { display: block; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    .table-panel { min-width: 0; border: 1px solid var(--rule); background: var(--panel); }
    .table-panel .section-head { padding: 15px 16px; border-bottom: 1px solid var(--rule); }
    .table-scroll { overflow-x: auto; max-height: 420px; overflow-y: auto; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--rule); text-align: right; white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
    th { position: sticky; top: 0; background: var(--panel); color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
    td { font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
    tr:last-child td { border-bottom: 0; }
    .empty { color: var(--muted); padding: 18px; }
    .warning { color: var(--on-accent); background: var(--accent-hover); padding: 2px 4px; }
    .critical { color: var(--critical); }
    #stamp.critical { color: var(--strong); font-weight: 700; }
    .notice { border: 1px solid var(--critical); background: var(--notice); padding: 12px 14px; color: var(--ink); }
    .notice p { margin: 0 0 10px; }
    .notice button { border-color: var(--accent); }
    [data-state="loading"] .metric-value, [data-state="loading"] .metric-note { color: transparent; background: var(--selected); }
    .loading-bars { width: 100%; min-height: 118px; display: flex; align-items: end; gap: 8px; }
    .loading-bars i { flex: 1; background: var(--selected); }
    .loading-bars i:nth-child(3n + 1) { height: 35%; }
    .loading-bars i:nth-child(3n + 2) { height: 58%; }
    .loading-bars i:nth-child(3n) { height: 76%; }
    .loading-table { display: grid; gap: 10px; padding: 18px; }
    .loading-table i { height: 12px; background: var(--selected); }
    .loading-table i:nth-child(2n) { width: 72%; }
    footer { color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 18px; }
    @media (max-width: 800px) {
      .rollup { grid-template-columns: 1fr 1fr; }
      .grid { grid-template-columns: 1fr; }
      header { align-items: start; flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <main class="shell" id="dashboard" data-state="loading" aria-busy="true">
    <header>
      <div><div class="eyebrow">Local agent ledger</div><h1>Pi Stats</h1></div>
      <div class="toolbar"><span id="stamp">Loading…</span><button id="theme" type="button">Light theme</button><button id="refresh" type="button">Refresh</button></div>
    </header>
    <div class="notice" id="notice" role="status" aria-live="polite" hidden><p id="notice-message"></p><button id="retry" type="button">Retry</button></div>
    <section class="rollup" aria-label="Usage overview">
      <div class="metric"><span class="metric-label">Requests</span><strong class="metric-value" id="requests">—</strong><span class="metric-note" id="sessions">— session files</span></div>
      <div class="metric"><span class="metric-label">Cost</span><strong class="metric-value" id="cost">—</strong><span class="metric-note">Cost reported by providers</span></div>
      <div class="metric"><span class="metric-label">Tokens</span><strong class="metric-value" id="tokens">—</strong><span class="metric-note" id="token-note">— output</span></div>
      <div class="metric"><span class="metric-label">Prompt cache reuse</span><strong class="metric-value" id="cache">—</strong><span class="metric-note" id="cache-note">Cached input ÷ reusable prompt input</span></div>
      <div class="metric"><span class="metric-label">Failed requests</span><strong class="metric-value" id="errors">—</strong><span class="metric-note" id="error-note">Model request failures; session logs pending</span></div>
    </section>
    <section class="activity"><div class="section-head"><h2>Daily cost</h2><span class="section-note">All recorded days</span></div><div class="bars" id="bars" tabindex="0" role="img" aria-label="Daily cost chart loading"><div class="loading-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div></section>
    <section class="grid"><div class="table-panel"><div class="section-head"><h2>Provider models</h2><span class="section-note">Recent = latest 20 requests with usage data</span></div><div class="table-scroll" id="models"><div class="loading-table" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div></div><div class="table-panel"><div class="section-head"><h2>Projects</h2><span class="section-note">Local folder names only</span></div><div class="table-scroll" id="projects"><div class="loading-table" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div></div></section>
    <footer><span>Read-only · loopback-only · refreshes every 30 seconds</span><span id="provider-count"></span></footer>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get('token') || '';
    const number = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    const percent = value => (value * 100).toFixed(1) + '%';
    const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    function table(rows) {
      if (!rows.length) return '<div class="empty">No usage recorded.</div>';
      return '<table><thead><tr><th>Name</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' + rows.map(row => '<tr><td title="' + esc(row.key) + '">' + esc(row.key) + '</td><td>' + number.format(row.requests) + '</td><td>' + number.format(row.totalTokens) + '</td><td>' + money.format(row.cost) + '</td></tr>').join('') + '</tbody></table>';
    }
    function cacheWrite(row) {
      if (row.cacheWriteStatus === 'reported') return number.format(row.cacheWriteReported) + ' reported';
      if (row.cacheWriteStatus === 'not-reported') {
        if (row.cacheWriteReported && row.cacheWriteUnreported) return number.format(row.cacheWriteReported) + ' reported; ' + number.format(row.cacheWriteUnreported) + ' unreported';
        if (row.cacheWriteReported) return number.format(row.cacheWriteReported) + ' reported; additional writes not reported';
        if (row.cacheWriteUnreported) return number.format(row.cacheWriteUnreported) + ' unreported';
        return 'Not reported';
      }
      if (row.cacheWriteStatus === 'none-recorded') return 'None recorded';
      return '—';
    }
    function modelTable(rows) {
      if (!rows.length) return '<div class="empty">No usage recorded.</div>';
      return '<table><thead><tr><th>Name</th><th>Requests</th><th>Cache reuse</th><th>Recent reuse</th><th>Recent misses</th><th>First-request misses</th><th>Later misses</th><th>Cache writes</th><th>Cost</th></tr></thead><tbody>' + rows.map(row => {
        const reusable = row.input + row.cacheRead + row.cacheWriteReported;
        const reuse = reusable ? percent(row.cacheRead / reusable) : '—';
        const recent = row.recentCacheReuse === null ? '—' : percent(row.recentCacheReuse);
        return '<tr><td title="' + esc(row.key) + '">' + esc(row.key) + '</td><td>' + number.format(row.requests) + '</td><td>' + reuse + '</td><td>' + recent + '</td><td>' + number.format(row.recentCacheMisses) + '</td><td>' + number.format(row.coldStartMisses) + '</td><td>' + number.format(row.midSessionMisses) + '</td><td>' + cacheWrite(row) + '</td><td>' + money.format(row.cost) + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    const dashboard = document.querySelector('#dashboard');
    const notice = document.querySelector('#notice');
    const noticeMessage = document.querySelector('#notice-message');
    async function load(showLoading = false) {
      dashboard.setAttribute('aria-busy', 'true');
      if (showLoading) dashboard.dataset.state = 'loading';
      notice.hidden = true;
      const response = await fetch('/api/stats?token=' + encodeURIComponent(token), { cache: 'no-store' });
      if (!response.ok) throw new Error('Stats request failed: ' + response.status);
      const stats = await response.json();
      const t = stats.totals;
      const reusable = t.input + t.cacheRead + t.cacheWriteReported;
      document.querySelector('#requests').textContent = number.format(t.requests);
      document.querySelector('#sessions').textContent = number.format(stats.sessionFiles) + ' session files';
      document.querySelector('#cost').textContent = money.format(t.cost);
      document.querySelector('#tokens').textContent = number.format(t.totalTokens);
      document.querySelector('#token-note').textContent = number.format(t.output) + ' output · ' + number.format(t.reasoning) + ' reasoning';
      document.querySelector('#cache').textContent = percent(reusable ? t.cacheRead / reusable : 0);
      document.querySelector('#cache-note').textContent = 'Cached input ÷ reusable prompt input · ' + (stats.cacheWriteStatus === 'reported' ? number.format(t.cacheWriteReported) + ' write tokens reported' : stats.cacheWriteStatus === 'not-reported' ? (t.cacheWriteReported && t.cacheWriteUnreported ? number.format(t.cacheWriteReported) + ' write tokens reported; ' + number.format(t.cacheWriteUnreported) + ' unreported' : t.cacheWriteReported ? number.format(t.cacheWriteReported) + ' write tokens reported; additional writes not reported' : t.cacheWriteUnreported ? number.format(t.cacheWriteUnreported) + ' write tokens unreported' : 'writes not reported') : stats.cacheWriteStatus === 'none-recorded' ? 'no cache writes recorded' : 'usage unmetered');
      document.querySelector('#errors').textContent = percent(t.requests ? t.errors / t.requests : 0);
      document.querySelector('#errors').className = 'metric-value ' + (t.errors ? 'critical' : '');
      const sessionLogNote = stats.malformedLines ? 'Session log parse issues: ' + number.format(stats.malformedLines) + ' unreadable JSONL lines skipped' : 'Session logs parsed cleanly';
      document.querySelector('#error-note').textContent = number.format(t.errors) + ' failed of ' + number.format(t.requests) + ' model requests · ' + sessionLogNote;
      document.querySelector('#error-note').className = 'metric-note ' + (stats.malformedLines ? 'warning' : '');
      document.querySelector('#models').innerHTML = modelTable(stats.byProviderModel);
      document.querySelector('#projects').innerHTML = table(stats.byProject);
      const max = Math.max(0.000001, ...stats.byDay.map(day => day.cost));
      const bars = document.querySelector('#bars');
      bars.innerHTML = stats.byDay.map(day => '<div class="bar-wrap"><div class="bar" style="height:' + Math.max(2, day.cost / max * 100) + '%"></div><span>' + esc(day.key) + ' · ' + money.format(day.cost) + '</span></div>').join('') || '<div class="empty">No dated usage recorded.</div>';
      const peak = stats.byDay.reduce((highest, day) => !highest || day.cost > highest.cost ? day : highest, null);
      bars.setAttribute('aria-label', peak ? 'Daily cost across ' + stats.byDay.length + ' recorded days. Highest: ' + money.format(peak.cost) + ' on ' + peak.key + '.' : 'Daily cost chart. No dated usage recorded.');
      document.querySelector('#provider-count').textContent = stats.byProvider.length + ' providers · ' + stats.byModel.length + ' models';
      document.querySelector('#stamp').textContent = 'Updated ' + new Date(stats.generatedAt).toLocaleTimeString();
      document.querySelector('#stamp').className = '';
      dashboard.dataset.state = 'ready';
      dashboard.setAttribute('aria-busy', 'false');
    }
    document.querySelector('#refresh').addEventListener('click', () => load(true).catch(showError));
    document.querySelector('#retry').addEventListener('click', () => load(true).catch(showError));
    document.querySelector('#theme').addEventListener('click', event => {
      const root = document.documentElement;
      const next = (root.dataset.theme || 'dark') === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      event.currentTarget.textContent = next === 'dark' ? 'Light theme' : 'Dark theme';
    });
    function showError(error) {
      const message = error instanceof Error ? error.message : String(error);
      document.querySelector('#stamp').textContent = 'Update failed';
      document.querySelector('#stamp').className = 'critical';
      noticeMessage.textContent = 'Could not load the local ledger. Refresh to retry. ' + message;
      notice.hidden = false;
      dashboard.dataset.state = 'error';
      dashboard.setAttribute('aria-busy', 'false');
    }
    load(true).catch(showError);
    setInterval(() => load().catch(showError), 30000);
  </script>
</body>
</html>`;
}
