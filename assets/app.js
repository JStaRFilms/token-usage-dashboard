/* ══════════════════════════════════════════════════════════════════════════
   TOKEN LEDGER — Modern V4 Controller & Interactive Engine
   ══════════════════════════════════════════════════════════════════════════ */

let summary = null;
let events = [];
let eventsLoaded = false;
let eventsLoading = false;

const state = {
  theme: localStorage.getItem('token_ledger_theme') || 'dark',
  currentTab: 'overview',
  timeRange: '6m',
  overviewMetric: 'tokens',
  trendsGranularity: 'daily',
  trendsMetric: 'cost',
  modelsSource: 'all',
  modelsSearch: '',
  expandedModel: null,
  sessionsViewMode: 'sessions', // 'sessions' | 'projects'
  sessionsSearch: '',
  sessionsSource: 'all',
  sessionsSort: 'cost-desc',
  selectedSessionId: null,
  selectedProjectId: null,
  sessionsProjectFilter: null,
  sessionsVisibleCount: 100,
  projectSessionsSearch: '',
  activeModalPane: 'rates',
  drawerSessionId: null,
};

const $ = (id) => document.getElementById(id);
const money = (n) =>
  n == null
    ? '—'
    : '$' +
      Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const num = (n) => Number(n || 0).toLocaleString();

function formatTokensCompact(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toLocaleString();
}

function formatDateDisplay(dayStr) {
  if (!dayStr) return '—';
  try {
    const [y, m, d] = dayStr.split('-');
    if (!y || !m || !d) return dayStr;
    const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dayStr;
  }
}

const short = (s) => (s || '').replace(/^.*[\\/]/, '');
const sourceKey = (e) => e.source_group || e.source || 'unknown';

function formatSourceDisplay(s) {
  if (!s) return 'Unknown';
  if (s === 'takomi/pi' || s === 'pi-global' || s === 'pi-project-linked') return 'Takomi / Pi';
  if (s === 'codex') return 'Codex';
  if (s === 'antigravity' || s.startsWith('antigravity') || s === 'gemini-cli') return 'Antigravity';
  return s;
}

function copyText(text, btnElement, origLabel = 'Copy') {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    if (btnElement) {
      btnElement.textContent = '✓ Copied!';
      btnElement.style.color = 'var(--accent-emerald)';
      setTimeout(() => {
        btnElement.textContent = origLabel;
        btnElement.style.color = '';
      }, 1500);
    }
  }).catch(() => {
    // Fallback
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    document.body.removeChild(t);
    if (btnElement) {
      btnElement.textContent = '✓ Copied!';
      setTimeout(() => { btnElement.textContent = origLabel; }, 1500);
    }
  });
}

/* ─── Instant Data Loading ─── */
async function loadData() {
  try {
    const ts = Date.now();
    // Load summary first: 2MB payload that renders in under 20ms!
    const sRes = await fetch('/data/usage-summary.json?x=' + ts).then((r) => r.json());
    summary = sRes;

    $('status').textContent = '● synced ' + new Date(summary.generated_at).toLocaleTimeString();
    $('status').style.color = 'var(--accent-emerald)';

    initSelectors();
    applyTheme(state.theme);
    renderCurrent();

    // Background lazy fetch for event-level details
    loadEventsInBackground();
  } catch (err) {
    $('status').textContent = '○ sync failed';
    $('status').style.color = 'var(--accent-rose)';
    console.error('Data load error:', err);
  }
}

async function loadEventsInBackground() {
  if (eventsLoaded || eventsLoading) return;
  eventsLoading = true;
  try {
    const eRes = await fetch('/data/usage-events.json?x=' + Date.now()).then((r) => r.json());
    events = eRes;
    eventsLoaded = true;
    if (state.drawerSessionId) {
      populateDrawerEvents(state.drawerSessionId);
    }
    if (deepActiveSession) {
      populateDeepModalData(deepActiveSession);
    }
  } catch (err) {
    console.warn('Background raw events load skipped:', err);
  } finally {
    eventsLoading = false;
  }
}

/* ─── Filter Days by Time Range ─── */
function getCutoffDay(rangeKey) {
  if (rangeKey === 'all') return null;
  const days = (summary && summary.by_day ? summary.by_day.map((d) => d.key) : []).sort();
  const maxDay = days.length ? days[days.length - 1] : new Date().toISOString().slice(0, 10);
  const [y, m, d] = maxDay.split('-').map(Number);
  const date = new Date(y, m - 1, d);

  if (rangeKey === '30d') date.setDate(date.getDate() - 30);
  else if (rangeKey === '90d') date.setDate(date.getDate() - 90);
  else if (rangeKey === '6m') date.setMonth(date.getMonth() - 6);
  else if (rangeKey === '1y') date.setFullYear(date.getFullYear() - 1);

  const py = date.getFullYear();
  const pm = String(date.getMonth() + 1).padStart(2, '0');
  const pd = String(date.getDate()).padStart(2, '0');
  return `${py}-${pm}-${pd}`;
}

function getFilteredDays() {
  if (!summary || !summary.by_day) return [];
  const cutoff = getCutoffDay(state.timeRange);
  if (!cutoff) return summary.by_day;
  return summary.by_day.filter((d) => d.key && d.key >= cutoff);
}

function updateDateRangeBadge(days) {
  if (!days || !days.length) {
    $('dateRangeBadge').textContent = 'No data';
    return;
  }
  const start = formatDateDisplay(days[0].key || days[0]);
  const end = formatDateDisplay(days[days.length - 1].key || days[days.length - 1]);
  $('dateRangeBadge').textContent = `${start} – ${end}`;
}

/* ─── Initializer & Event Listeners ─── */
function initSelectors() {
  const sources = (summary && summary.by_source ? summary.by_source.map((s) => s.key) : []).sort();
  const sourceOptions = '<option value="all">All sources</option>' +
    sources.map((s) => `<option value="${s}">${formatSourceDisplay(s)}</option>`).join('');

  $('modelsSourceSelect').innerHTML = sourceOptions;
  $('sessionsSourceSelect').innerHTML = sourceOptions;
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('token_ledger_theme', theme);
  if (theme === 'dark') {
    $('themeIconSun').style.display = 'block';
    $('themeIconMoon').style.display = 'none';
  } else {
    $('themeIconSun').style.display = 'none';
    $('themeIconMoon').style.display = 'block';
  }
  renderCurrent();
}

function switchTab(tabId) {
  state.currentTab = tabId;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.view-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `pane-${tabId}`);
  });
  renderCurrent();
}

/* ─── Render Dispatcher ─── */
function renderCurrent() {
  if (!summary) return;
  const days = getFilteredDays();
  updateDateRangeBadge(days);

  if (state.currentTab === 'overview') renderOverview(days);
  else if (state.currentTab === 'trends') renderTrends(days);
  else if (state.currentTab === 'models') renderModels();
  else if (state.currentTab === 'sessions') renderSessions();
}

/* ══════════════════════════════════════════════════════════════════════════
   1. OVERVIEW VIEW
   ══════════════════════════════════════════════════════════════════════════ */

function renderOverview(days) {
  let totalTokens = 0;
  let totalCost = 0;
  let cachedTokens = 0;
  let uncachedTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let discountTotal = 0;

  const sourceTotals = {
    'takomi/pi': 0,
    codex: 0,
    antigravity: 0,
  };

  const isAll = state.timeRange === 'all';
  if (isAll && summary && summary.totals) {
    totalTokens = summary.totals.total_tokens || 0;
    totalCost = summary.totals.estimated_cost_usd || 0;
    cachedTokens = summary.totals.cached_input_tokens || 0;
    const inp = summary.totals.input_tokens || 0;
    uncachedTokens = Math.max(0, inp - cachedTokens);
    outputTokens = summary.totals.output_tokens || 0;
    reasoningTokens = summary.totals.reasoning_output_tokens || 0;
    discountTotal = summary.totals.discount_amount_usd || 0;
    for (const s of (summary.by_source || [])) {
      if (s.key in sourceTotals) sourceTotals[s.key] = s.total_tokens || 0;
    }
  } else {
    for (const d of days) {
      totalTokens += d.total_tokens || 0;
      totalCost += d.estimated_cost_usd || 0;
      cachedTokens += d.cached_input_tokens || 0;
      const inp = d.input_tokens || 0;
      const c = d.cached_input_tokens || 0;
      uncachedTokens += Math.max(0, inp - c);
      outputTokens += d.output_tokens || 0;
      reasoningTokens += d.reasoning_output_tokens || 0;
      discountTotal += d.discount_amount_usd || 0;
      if (d.source_tokens) {
        sourceTotals['takomi/pi'] += d.source_tokens['takomi/pi'] || 0;
        sourceTotals['codex'] += d.source_tokens['codex'] || 0;
        sourceTotals['antigravity'] += d.source_tokens['antigravity'] || 0;
      }
    }
  }

  const cutoff = getCutoffDay(state.timeRange);
  const sessionCount = isAll
    ? (summary.session_count || (summary.by_session || []).length)
    : (summary.by_session || []).filter((s) => !cutoff || (s.last_day && s.last_day >= cutoff)).length;

  // Hero Card
  $('ovProcessedTokens').textContent = formatTokensCompact(totalTokens);
  $('ovApiCost').textContent = money(totalCost);
  $('ovSessionCount').textContent = num(sessionCount);

  if (discountTotal > 0) {
    $('ovSavingsTag').textContent = `Saved ${money(discountTotal)} from discounts`;
    $('ovSavingsTag').style.display = 'inline-block';
  } else {
    $('ovSavingsTag').style.display = 'none';
  }

  // Daily Usage Chart with Obvious Dotted Month Demarcations
  renderOverviewDailyChart(days, state.overviewMetric);

  // Sources Breakdown
  const sourcesArr = [
    { key: 'takomi/pi', label: 'Takomi / Pi', tokens: sourceTotals['takomi/pi'], class: 'takomi' },
    { key: 'codex', label: 'Codex', tokens: sourceTotals.codex, class: 'codex' },
    { key: 'antigravity', label: 'Antigravity', tokens: sourceTotals.antigravity, class: 'antigravity' },
  ];

  $('ovSourcesList').innerHTML = sourcesArr
    .map((s) => {
      const pct = totalTokens > 0 ? ((s.tokens / totalTokens) * 100).toFixed(1) : '0.0';
      return `
      <div class="source-bar-row">
        <div class="source-name-col">
          <span class="dot dot-${s.class}"></span>
          <span>${s.label}</span>
        </div>
        <div class="track-wrap">
          <div class="track-fill fill-${s.class}" style="width: ${pct}%"></div>
        </div>
        <div class="source-val-col">${formatTokensCompact(s.tokens)}</div>
        <div class="source-pct-col">${pct}%</div>
      </div>
    `;
    })
    .join('');

  // Token Composition Stacked Bar
  const compTotal = cachedTokens + uncachedTokens + outputTokens;
  const cPct = compTotal > 0 ? ((cachedTokens / compTotal) * 100).toFixed(1) : 0;
  const uPct = compTotal > 0 ? ((uncachedTokens / compTotal) * 100).toFixed(1) : 0;
  const oPct = compTotal > 0 ? ((outputTokens / compTotal) * 100).toFixed(1) : 0;

  $('ovSliceCache').style.width = `${cPct}%`;
  $('ovSliceUncached').style.width = `${uPct}%`;
  $('ovSliceOutput').style.width = `${oPct}%`;

  $('ovCompCacheVal').textContent = formatTokensCompact(cachedTokens);
  $('ovCompCachePct').textContent = `${cPct}%`;
  $('ovCompUncachedVal').textContent = formatTokensCompact(uncachedTokens);
  $('ovCompUncachedPct').textContent = `${uPct}%`;
  $('ovCompOutputVal').textContent = formatTokensCompact(outputTokens);
  $('ovCompOutputPct').textContent = `${oPct}%`;
}

function renderOverviewDailyChart(days, metric) {
  $('ovDailyChartUnit').textContent = metric === 'tokens' ? 'Tokens' : 'Estimated cost';

  const data = (days || [])
    .map((d) => ({
      day: d.key || d.day,
      val: metric === 'tokens' ? (d.total_tokens || 0) : (d.estimated_cost_usd || 0),
    }))
    .filter((d) => d.day);

  if (!data.length) {
    $('ovDailySvg').innerHTML = '';
    return;
  }
  const maxVal = Math.max(...data.map((d) => d.val), 1);

  // SVG dimensions
  const svg = $('ovDailySvg');
  const w = svg.clientWidth || 600;
  const h = svg.clientHeight || 230;
  const padLeft = 55;
  const padRight = 24;
  const padTop = 26;
  const padBottom = 32;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const pts = data.map((d, i) => {
    const x = padLeft + (i / Math.max(1, data.length - 1)) * plotW;
    const y = padTop + (1 - d.val / maxVal) * plotH;
    return { x, y, day: d.day, val: d.val };
  });

  // Smooth Area & Line paths
  let pathD = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const mx = (p0.x + p1.x) / 2;
    pathD += ` C ${mx} ${p0.y}, ${mx} ${p1.y}, ${p1.x} ${p1.y}`;
  }
  const areaD = `${pathD} L ${pts[pts.length - 1].x} ${padTop + plotH} L ${pts[0].x} ${padTop + plotH} Z`;

  // Horizontal Grid Lines
  const gridLines = [];
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const yVal = (maxVal / yTicks) * i;
    const yPos = padTop + (1 - i / yTicks) * plotH;
    const label = metric === 'tokens' ? formatTokensCompact(yVal) : money(yVal).replace('.00', '');
    gridLines.push(`
      <line x1="${padLeft}" y1="${yPos}" x2="${w - padRight}" y2="${yPos}" stroke="var(--border-card)" stroke-dasharray="2,2" stroke-width="1" />
      <text x="${padLeft - 10}" y="${yPos + 4}" font-size="10" fill="var(--text-dim)" text-anchor="end">${label}</text>
    `);
  }

  // Obvious Dotted Vertical Lines Demarcating Each Month
  const monthDemarcations = [];
  let currentMonthKey = null;

  for (let i = 0; i < pts.length; i++) {
    const mKey = pts[i].day.slice(0, 7);
    if (mKey !== currentMonthKey) {
      const isFirst = currentMonthKey === null;
      currentMonthKey = mKey;

      const [year, mo] = mKey.split('-');
      const dObj = new Date(parseInt(year), parseInt(mo) - 1, 1);
      const mShort = dObj.toLocaleDateString('en-US', { month: 'short' });
      const mFull = `${mShort} ${year}`;

      const xPos = pts[i].x;

      if (!isFirst) {
        // Vertical dotted line demarcating the start of the month
        monthDemarcations.push(`
          <line x1="${xPos}" y1="${padTop - 8}" x2="${xPos}" y2="${padTop + plotH}" stroke="var(--accent-purple)" stroke-dasharray="4,4" stroke-width="1.75" stroke-opacity="0.8" />
        `);
      }

      // Obvious month label at bottom axis
      monthDemarcations.push(`
        <text x="${xPos + 6}" y="${h - 8}" font-size="11" font-weight="700" fill="var(--accent-purple)" text-anchor="start">${mShort}</text>
      `);

      // Top badge label on the demarcation line
      if (!isFirst) {
        monthDemarcations.push(`
          <text x="${xPos + 6}" y="${padTop - 2}" font-size="10" font-weight="700" fill="var(--text-muted)" text-anchor="start">${mFull}</text>
        `);
      }
    }
  }

  svg.innerHTML = `
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent-cyan)" stop-opacity="0.32" />
        <stop offset="100%" stop-color="var(--accent-cyan)" stop-opacity="0.0" />
      </linearGradient>
    </defs>
    ${gridLines.join('')}
    ${monthDemarcations.join('')}
    <path d="${areaD}" fill="url(#areaGrad)" />
    <path d="${pathD}" fill="none" stroke="var(--accent-cyan)" stroke-width="2.5" stroke-linecap="round" />
    <g id="ovHoverGroup" style="display:none">
      <line id="ovHoverLine" y1="${padTop}" y2="${padTop + plotH}" stroke="var(--accent-cyan)" stroke-dasharray="2,2" stroke-width="1" />
      <circle id="ovHoverDot" r="4.5" fill="var(--accent-cyan)" stroke="var(--bg-card)" stroke-width="2" />
    </g>
  `;

  // Hover Interaction
  const tooltip = $('ovDailyTooltip');
  const wrap = $('ovDailyChartWrap');

  wrap.onmousemove = (evt) => {
    const rect = svg.getBoundingClientRect();
    const mouseX = evt.clientX - rect.left;
    if (mouseX < padLeft || mouseX > w - padRight) {
      $('ovHoverGroup').style.display = 'none';
      tooltip.style.display = 'none';
      return;
    }

    const relX = (mouseX - padLeft) / plotW;
    const idx = Math.min(pts.length - 1, Math.max(0, Math.round(relX * (pts.length - 1))));
    const p = pts[idx];

    $('ovHoverGroup').style.display = 'block';
    $('ovHoverLine').setAttribute('x1', p.x);
    $('ovHoverLine').setAttribute('x2', p.x);
    $('ovHoverDot').setAttribute('cx', p.x);
    $('ovHoverDot').setAttribute('cy', p.y);

    const valStr = metric === 'tokens' ? `${num(p.val)} tokens` : money(p.val);
    tooltip.innerHTML = `<strong>${formatDateDisplay(p.day)}</strong><br/>${valStr}`;
    tooltip.style.left = `${Math.min(w - 140, Math.max(10, p.x - 50))}px`;
    tooltip.style.top = `${Math.max(10, p.y - 45)}px`;
    tooltip.style.display = 'block';
  };

  wrap.onmouseleave = () => {
    $('ovHoverGroup').style.display = 'none';
    tooltip.style.display = 'none';
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   2. TRENDS VIEW
   ══════════════════════════════════════════════════════════════════════════ */

function renderTrends(days) {
  const isMonthly = state.trendsGranularity === 'monthly';
  const isCost = state.trendsMetric === 'cost';

  $('trendsChartTitle').textContent = isCost
    ? 'Estimated API cost over time'
    : 'Token usage volume over time';
  $('trendsChartSubtitle').textContent = isCost
    ? `Total ${isMonthly ? 'monthly' : 'daily'} cost by source.`
    : `Total ${isMonthly ? 'monthly' : 'daily'} tokens by source.`;

  // Multi-source Series Construction
  const takomiMap = new Map();
  const codexMap = new Map();
  const antigravityMap = new Map();
  const allBucketMap = new Map();

  for (const d of days) {
    const key = isMonthly ? (d.key ? d.key.slice(0, 7) : 'unknown') : (d.key || 'unknown');
    if (key === 'unknown') continue;

    const sCost = d.sources || {};
    const sTok = d.source_tokens || {};
    const takomiVal = isCost ? (sCost['takomi/pi'] || 0) : (sTok['takomi/pi'] || 0);
    const codexVal = isCost ? (sCost['codex'] || 0) : (sTok['codex'] || 0);
    const agVal = isCost ? (sCost['antigravity'] || 0) : (sTok['antigravity'] || 0);

    takomiMap.set(key, (takomiMap.get(key) || 0) + takomiVal);
    codexMap.set(key, (codexMap.get(key) || 0) + codexVal);
    antigravityMap.set(key, (antigravityMap.get(key) || 0) + agVal);

    const totalVal = isCost ? (d.estimated_cost_usd || 0) : (d.total_tokens || 0);
    allBucketMap.set(key, (allBucketMap.get(key) || 0) + totalVal);
  }

  const buckets = [...allBucketMap.keys()].sort();
  renderTrendsMultiChart(buckets, takomiMap, codexMap, antigravityMap, isCost, isMonthly);

  // Peak Day & Daily Average
  let peakDay = '—';
  let peakVal = 0;
  let dailySum = 0;
  let dailyCount = 0;

  for (const d of days) {
    if (!d.key) continue;
    const v = d.estimated_cost_usd || 0;
    dailySum += v;
    dailyCount++;
    if (v > peakVal) {
      peakVal = v;
      peakDay = d.key;
    }
  }

  $('trendsPeakDayLabel').textContent = peakDay !== '—' ? formatDateDisplay(peakDay) : '—';
  $('trendsPeakDayVal').textContent = money(peakVal);
  $('trendsDailyAvgVal').textContent = dailyCount > 0 ? money(dailySum / dailyCount) : '$0.00';

  // Monthly Column Bars
  renderTrendsMonthlyColumns(days);
}

function renderTrendsMultiChart(buckets, s1Map, s2Map, s3Map, isCost, isMonthly) {
  const svg = $('trendsSvg');
  if (!buckets.length) {
    svg.innerHTML = '';
    return;
  }

  const w = svg.clientWidth || 900;
  const h = svg.clientHeight || 320;
  const padLeft = 60;
  const padRight = 30;
  const padTop = 26;
  const padBottom = 32;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const maxVal = Math.max(...buckets.map((b) => Math.max(s1Map.get(b) || 0, s2Map.get(b) || 0, s3Map.get(b) || 0)), 1);

  function makePoints(map) {
    return buckets.map((b, i) => {
      const v = map.get(b) || 0;
      const x = padLeft + (i / Math.max(1, buckets.length - 1)) * plotW;
      const y = padTop + (1 - v / maxVal) * plotH;
      return { x, y, key: b, val: v };
    });
  }

  const pts1 = makePoints(s1Map); // Takomi/Pi
  const pts2 = makePoints(s2Map); // Codex
  const pts3 = makePoints(s3Map); // Antigravity

  function makeSmoothPath(pts) {
    if (!pts.length) return '';
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const mx = (p0.x + p1.x) / 2;
      d += ` C ${mx} ${p0.y}, ${mx} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    return d;
  }

  // Grid
  const gridLines = [];
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const yVal = (maxVal / yTicks) * i;
    const yPos = padTop + (1 - i / yTicks) * plotH;
    const label = isCost ? money(yVal).replace('.00', '') : formatTokensCompact(yVal);
    gridLines.push(`
      <line x1="${padLeft}" y1="${yPos}" x2="${w - padRight}" y2="${yPos}" stroke="var(--border-card)" stroke-dasharray="2,2" stroke-width="1" />
      <text x="${padLeft - 10}" y="${yPos + 4}" font-size="11" fill="var(--text-dim)" text-anchor="end">${label}</text>
    `);
  }

  // Obvious Dotted Vertical Lines Demarcating Each Month
  const monthDemarcations = [];
  if (!isMonthly) {
    let currentMonthKey = null;
    for (let i = 0; i < buckets.length; i++) {
      const mKey = buckets[i].slice(0, 7);
      if (mKey !== currentMonthKey) {
        const isFirst = currentMonthKey === null;
        currentMonthKey = mKey;
        const [year, mo] = mKey.split('-');
        const dObj = new Date(parseInt(year), parseInt(mo) - 1, 1);
        const mShort = dObj.toLocaleDateString('en-US', { month: 'short' });
        const xPos = pts1[i].x;

        if (!isFirst) {
          monthDemarcations.push(`
            <line x1="${xPos}" y1="${padTop - 8}" x2="${xPos}" y2="${padTop + plotH}" stroke="var(--accent-purple)" stroke-dasharray="4,4" stroke-width="1.75" stroke-opacity="0.8" />
          `);
        }

        monthDemarcations.push(`
          <text x="${xPos + 6}" y="${h - 8}" font-size="11" font-weight="700" fill="var(--accent-purple)" text-anchor="start">${mShort}</text>
        `);

        if (!isFirst) {
          monthDemarcations.push(`
            <text x="${xPos + 6}" y="${padTop - 2}" font-size="10" font-weight="700" fill="var(--text-muted)" text-anchor="start">${mShort} ${year}</text>
          `);
        }
      }
    }
  } else {
    // In monthly mode, each bucket is a month
    for (let i = 0; i < buckets.length; i++) {
      const xPos = pts1[i].x;
      monthDemarcations.push(`
        <text x="${xPos}" y="${h - 8}" font-size="11" font-weight="600" fill="var(--text-dim)" text-anchor="middle">${buckets[i]}</text>
      `);
    }
  }

  svg.innerHTML = `
    ${gridLines.join('')}
    ${monthDemarcations.join('')}
    <path d="${makeSmoothPath(pts3)}" fill="none" stroke="var(--accent-orange)" stroke-width="2" stroke-linecap="round" />
    <path d="${makeSmoothPath(pts2)}" fill="none" stroke="var(--accent-purple)" stroke-width="2" stroke-linecap="round" />
    <path d="${makeSmoothPath(pts1)}" fill="none" stroke="var(--accent-cyan)" stroke-width="2.5" stroke-linecap="round" />
    <g id="trendsHoverGroup" style="display:none">
      <line id="trendsHoverLine" y1="${padTop}" y2="${padTop + plotH}" stroke="var(--text-dim)" stroke-dasharray="2,2" stroke-width="1" />
      <circle id="trendsDot1" r="4.5" fill="var(--accent-cyan)" stroke="var(--bg-card)" stroke-width="2" />
      <circle id="trendsDot2" r="4" fill="var(--accent-purple)" stroke="var(--bg-card)" stroke-width="2" />
      <circle id="trendsDot3" r="4" fill="var(--accent-orange)" stroke="var(--bg-card)" stroke-width="2" />
    </g>
  `;

  // Hover Interaction
  const tooltip = $('trendsTooltip');
  const wrap = $('trendsChartWrap');

  wrap.onmousemove = (evt) => {
    const rect = svg.getBoundingClientRect();
    const mouseX = evt.clientX - rect.left;
    if (mouseX < padLeft || mouseX > w - padRight) {
      $('trendsHoverGroup').style.display = 'none';
      tooltip.style.display = 'none';
      return;
    }

    const relX = (mouseX - padLeft) / plotW;
    const idx = Math.min(buckets.length - 1, Math.max(0, Math.round(relX * (buckets.length - 1))));
    const p1 = pts1[idx];
    const p2 = pts2[idx];
    const p3 = pts3[idx];

    $('trendsHoverGroup').style.display = 'block';
    $('trendsHoverLine').setAttribute('x1', p1.x);
    $('trendsHoverLine').setAttribute('x2', p1.x);
    $('trendsDot1').setAttribute('cx', p1.x);
    $('trendsDot1').setAttribute('cy', p1.y);
    $('trendsDot2').setAttribute('cx', p2.x);
    $('trendsDot2').setAttribute('cy', p2.y);
    $('trendsDot3').setAttribute('cx', p3.x);
    $('trendsDot3').setAttribute('cy', p3.y);

    const f = isCost ? money : formatTokensCompact;
    tooltip.innerHTML = `
      <strong>${p1.key}</strong><br/>
      <span style="color:var(--accent-cyan)">● Takomi/Pi:</span> ${f(p1.val)}<br/>
      <span style="color:var(--accent-purple)">● Codex:</span> ${f(p2.val)}<br/>
      <span style="color:var(--accent-orange)">● Antigravity:</span> ${f(p3.val)}
    `;
    tooltip.style.left = `${Math.min(w - 160, Math.max(10, p1.x - 60))}px`;
    tooltip.style.top = `${Math.max(10, Math.min(p1.y, p2.y, p3.y) - 60)}px`;
    tooltip.style.display = 'block';
  };

  wrap.onmouseleave = () => {
    $('trendsHoverGroup').style.display = 'none';
    tooltip.style.display = 'none';
  };
}

function renderTrendsMonthlyColumns(days) {
  const monthMap = new Map();
  for (const d of days) {
    if (!d.key) continue;
    const m = d.key.slice(0, 7);
    monthMap.set(m, (monthMap.get(m) || 0) + (d.estimated_cost_usd || 0));
  }

  // Fallback to summary.by_month if days array is small
  if (!monthMap.size && summary && summary.by_month) {
    for (const mObj of summary.by_month) {
      if (mObj.key) monthMap.set(mObj.key, mObj.estimated_cost_usd || 0);
    }
  }

  const sortedMonths = [...monthMap.keys()].sort();
  const maxMonthVal = Math.max(...sortedMonths.map((m) => monthMap.get(m)), 0.01);

  const maxMonthKey = sortedMonths.reduce(
    (maxK, k) => (monthMap.get(k) > (monthMap.get(maxK) || 0) ? k : maxK),
    sortedMonths[0]
  );

  $('trendsMonthlyColumns').innerHTML = sortedMonths
    .map((m) => {
      const val = monthMap.get(m);
      const hPct = Math.max(6, (val / maxMonthVal) * 100);
      const isPeak = m === maxMonthKey;
      const [year, mo] = m.split('-');
      const dObj = new Date(parseInt(year), parseInt(mo) - 1, 1);
      const shortName = dObj.toLocaleDateString('en-US', { month: 'short' });

      return `
      <div class="monthly-col-item">
        <div class="monthly-col-val">${money(val).replace('.00', '')}</div>
        <div class="monthly-col-bar ${isPeak ? 'peak' : ''}" style="height: ${hPct}%"></div>
        <div class="monthly-col-label">${shortName}</div>
      </div>
    `;
    })
    .join('');
}

/* ══════════════════════════════════════════════════════════════════════════
   3. MODELS VIEW
   ══════════════════════════════════════════════════════════════════════════ */

function renderModels() {
  const src = state.modelsSource;
  const q = state.modelsSearch.toLowerCase();
  const rawModels = (summary && summary.by_model) || [];

  let totalCost = 0;
  const modelList = [];

  for (const m of rawModels) {
    const modelName = m.key || 'unknown';
    if (q && !modelName.toLowerCase().includes(q)) continue;

    const sourcesObj = m.sources || {};
    if (src !== 'all' && !(sourcesObj[src] > 0)) continue;

    const cost = src === 'all' ? (m.estimated_cost_usd || 0) : (sourcesObj[src] || 0);
    const tokens = m.total_tokens || 0;
    const cached = m.cached_input_tokens || 0;
    const inp = m.input_tokens || 0;
    const uncached = Math.max(0, inp - cached);
    const out = m.output_tokens || 0;
    const reasoning = m.reasoning_output_tokens || 0;

    totalCost += cost;

    modelList.push({
      model: modelName,
      cost,
      tokens,
      cached,
      uncached,
      output: out,
      reasoning,
      events: m.events || 0,
      sources: sourcesObj,
    });
  }

  modelList.sort((a, b) => b.cost - a.cost);

  $('modelsAccordionList').innerHTML = modelList
    .map((item) => {
      const share = totalCost > 0 ? ((item.cost / totalCost) * 100).toFixed(1) : '0.0';
      const isOpen = state.expandedModel === item.model;

      const compTot = item.cached + item.uncached + item.output;
      const cPct = compTot > 0 ? ((item.cached / compTot) * 100).toFixed(1) : 0;
      const uPct = compTot > 0 ? ((item.uncached / compTot) * 100).toFixed(1) : 0;
      const oPct = compTot > 0 ? ((item.output / compTot) * 100).toFixed(1) : 0;

      return `
      <div class="model-row-wrap ${isOpen ? 'open' : ''}" data-model="${item.model}">
        <div class="model-summary-row">
          <div class="model-title-col">
            <span class="dot dot-cache"></span>
            <span>${item.model}</span>
          </div>
          <div class="model-tokens-col">${formatTokensCompact(item.tokens)}</div>
          <div class="model-cost-col">${money(item.cost)}</div>
          <div class="model-share-col">
            <div class="share-track">
              <div class="share-fill" style="width: ${share}%"></div>
            </div>
            <div class="share-pct">${share}%</div>
          </div>
          <div class="chevron-col">
            <svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>

        <div class="model-detail-drawer">
          <div class="model-detail-title">${item.model} / Token breakdown</div>
          <div class="model-comp-stats">
            <div class="model-comp-stat">
              <div class="val">${formatTokensCompact(item.cached)}</div>
              <div class="lbl">Cached input</div>
            </div>
            <div class="model-comp-stat">
              <div class="val">${formatTokensCompact(item.uncached)}</div>
              <div class="lbl">Uncached input</div>
            </div>
            <div class="model-comp-stat">
              <div class="val">${formatTokensCompact(item.output)}</div>
              <div class="lbl">Output</div>
            </div>
          </div>
          <div class="model-segmented-bar">
            <div style="width:${cPct}%; background-color:var(--accent-cyan); height:100%"></div>
            <div style="width:${uPct}%; background-color:var(--accent-purple); height:100%"></div>
            <div style="width:${oPct}%; background-color:var(--accent-orange); height:100%"></div>
          </div>
          <div class="model-comp-legend">
            <div><span class="dot dot-uncached"></span> Cached input ${cPct}%</div>
            <div><span class="dot dot-cache"></span> Uncached input ${uPct}%</div>
            <div><span class="dot dot-output"></span> Output ${oPct}%</div>
          </div>
        </div>
      </div>
    `;
    })
    .join('') || '<p style="padding:24px; color:var(--text-dim)">No models match your filter.</p>';

  // Accordion clicks
  $('modelsAccordionList').querySelectorAll('.model-summary-row').forEach((row) => {
    row.addEventListener('click', () => {
      const wrap = row.closest('.model-row-wrap');
      const m = wrap.dataset.model;
      state.expandedModel = state.expandedModel === m ? null : m;
      renderModels();
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   4. SESSIONS VIEW & PROJECT GROUPING
   ══════════════════════════════════════════════════════════════════════════ */

function renderSessions() {
  const isProjectMode = state.sessionsViewMode === 'projects';
  const q = state.sessionsSearch.toLowerCase();
  const src = state.sessionsSource;
  const sort = state.sessionsSort;
  const cutoff = getCutoffDay(state.timeRange);

  // Manage Project Filter Banner
  const banner = $('sessionsProjectFilterBanner');
  if (banner) {
    if (!isProjectMode && state.sessionsProjectFilter) {
      banner.style.display = 'flex';
      banner.innerHTML = `
        <div>
          <span>Filtering by project:</span>
          <strong class="filter-tag">${state.sessionsProjectFilter}</strong>
        </div>
        <div class="filter-actions">
          <button class="filter-btn" id="bannerBackToProjectsBtn">&larr; Back to Group by Project</button>
          <button class="filter-btn" id="bannerClearFilterBtn">&times; Show all projects</button>
        </div>
      `;
      $('bannerBackToProjectsBtn').onclick = () => {
        state.sessionsProjectFilter = null;
        state.sessionsViewMode = 'projects';
        $('viewBtnProjects').classList.add('active');
        $('viewBtnSessions').classList.remove('active');
        renderSessions();
      };
      $('bannerClearFilterBtn').onclick = () => {
        state.sessionsProjectFilter = null;
        renderSessions();
      };
    } else {
      banner.style.display = 'none';
      banner.innerHTML = '';
    }
  }

  if (isProjectMode) {
    renderProjectGroupedList(q, src, sort);
  } else {
    renderIndividualSessionsList(q, src, sort, cutoff);
  }
}

function renderIndividualSessionsList(q, src, sort, cutoff) {
  const rawSessions = (summary && summary.by_session) || [];
  let sessionList = [];

  for (const s of rawSessions) {
    if (src !== 'all' && s.source !== src && s.source_detail !== src) continue;
    if (cutoff && s.last_day && s.last_day < cutoff) continue;
    if (state.sessionsProjectFilter && s.project !== state.sessionsProjectFilter) continue;

    if (q) {
      const hay = `${s.session_id} ${s.project} ${s.directory} ${s.primary_model} ${s.file} ${s.source}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }

    sessionList.push(s);
  }

  // Sort
  if (sort === 'cost-desc') sessionList.sort((a, b) => (b.estimated_cost_usd || 0) - (a.estimated_cost_usd || 0));
  else if (sort === 'date-desc') sessionList.sort((a, b) => (b.last_day || '').localeCompare(a.last_day || ''));
  else if (sort === 'tokens-desc') sessionList.sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0));

  // Auto-selection
  if (!state.selectedSessionId && sessionList.length) {
    state.selectedSessionId = sessionList[0].session_id;
  } else if (state.selectedSessionId && !sessionList.some((s) => s.session_id === state.selectedSessionId) && sessionList.length) {
    state.selectedSessionId = sessionList[0].session_id;
  }

  // Ensure active session is within the rendered slice
  const selIdx = sessionList.findIndex((s) => s.session_id === state.selectedSessionId);
  if (selIdx >= state.sessionsVisibleCount) {
    state.sessionsVisibleCount = Math.min(sessionList.length, selIdx + 50);
  }
  const visibleSessions = sessionList.slice(0, state.sessionsVisibleCount);
  const hasMore = sessionList.length > state.sessionsVisibleCount;

  // Render cards
  const cardsHtml = visibleSessions
    .map((s) => {
      const isSelected = s.session_id === state.selectedSessionId;
      const shortId = s.session_id.length > 12 ? s.session_id.slice(0, 10) + '…' : s.session_id;
      const dateDisp = formatDateDisplay(s.last_day || s.first_day);
      const projName = s.project || 'Unknown Project';

      return `
      <div class="session-card-item ${isSelected ? 'selected' : ''}" data-session="${s.session_id}">
        <div class="sess-main-col">
          <div class="sess-project-row">
            <svg class="sess-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            <span class="sess-project-name" title="${projName}">${projName}</span>
          </div>
          <div class="sess-meta-row">
            <span class="sess-id">${shortId}</span>
            <span>·</span>
            <span>${dateDisp}</span>
            <span class="sess-source-pill">${formatSourceDisplay(s.source)}</span>
          </div>
        </div>
        <div class="sess-right-col">
          <div class="sess-cost-val">${money(s.estimated_cost_usd)}</div>
          <div class="sess-tokens-val">${formatTokensCompact(s.total_tokens)}</div>
        </div>
      </div>
    `;
    })
    .join('');

  const footerHtml = hasMore
    ? `
    <div class="sessions-load-footer">
      <span>Showing ${visibleSessions.length} of ${num(sessionList.length)} sessions</span>
      <div style="display:flex; gap:6px">
        <button class="secondary-btn" id="loadMoreSessionsBtn" style="font-size:11px; padding:4px 10px">Load 100 more</button>
        <button class="secondary-btn" id="loadAllSessionsBtn" style="font-size:11px; padding:4px 10px">Load all (${num(sessionList.length)})</button>
      </div>
    </div>
  `
    : (sessionList.length > 0
      ? `
    <div style="text-align:center; padding:16px 0; font-size:11px; color:var(--text-dim)">
      All ${num(sessionList.length)} sessions loaded
    </div>
  `
      : '');

  $('sessionsList').innerHTML = (cardsHtml + footerHtml) || '<p style="padding:24px; color:var(--text-dim)">No sessions found.</p>';

  // Bind Card Click
  $('sessionsList').querySelectorAll('.session-card-item').forEach((card) => {
    card.addEventListener('click', () => {
      state.selectedSessionId = card.dataset.session;
      renderIndividualSessionsList(q, src, sort, cutoff);
    });
  });

  // Bind Load More buttons
  if ($('loadMoreSessionsBtn')) {
    $('loadMoreSessionsBtn').onclick = () => {
      state.sessionsVisibleCount += 100;
      renderIndividualSessionsList(q, src, sort, cutoff);
    };
  }
  if ($('loadAllSessionsBtn')) {
    $('loadAllSessionsBtn').onclick = () => {
      state.sessionsVisibleCount = sessionList.length;
      renderIndividualSessionsList(q, src, sort, cutoff);
    };
  }

  // Infinite Scroll Listener
  const listEl = $('sessionsList');
  listEl.onscroll = () => {
    if (hasMore && listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 300) {
      state.sessionsVisibleCount += 100;
      renderIndividualSessionsList(q, src, sort, cutoff);
    }
  };

  // Render Inspector
  const selectedObj = rawSessions.find((s) => s.session_id === state.selectedSessionId) || sessionList[0];
  renderSessionInspector(selectedObj);

  // Auto-scroll to highlighted session card
  setTimeout(() => {
    const activeCard = $('sessionsList').querySelector('.session-card-item.selected');
    if (activeCard) {
      activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, 40);
}

function renderProjectGroupedList(q, src, sort) {
  const rawProjects = (summary && summary.by_project) || [];
  let projectList = [];

  for (const p of rawProjects) {
    if (q) {
      const hay = `${p.project} ${p.directory}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    projectList.push(p);
  }

  // Sort
  if (sort === 'cost-desc') projectList.sort((a, b) => (b.estimated_cost_usd || 0) - (a.estimated_cost_usd || 0));
  else if (sort === 'date-desc') projectList.sort((a, b) => (b.last_day || '').localeCompare(a.last_day || ''));
  else if (sort === 'tokens-desc') projectList.sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0));

  // Auto-selection
  if (!state.selectedProjectId && projectList.length) {
    state.selectedProjectId = projectList[0].project;
  } else if (state.selectedProjectId && !projectList.some((p) => p.project === state.selectedProjectId) && projectList.length) {
    state.selectedProjectId = projectList[0].project;
  }

  // Render cards
  $('sessionsList').innerHTML = projectList
    .map((p) => {
      const isSelected = p.project === state.selectedProjectId;
      return `
      <div class="project-card-item ${isSelected ? 'selected' : ''}" data-project="${p.project}">
        <div class="sess-main-col">
          <div class="proj-title-row">
            <svg class="sess-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            <span class="proj-title">${p.project}</span>
            <span class="proj-sessions-count">${num(p.sessions_count)} sessions</span>
          </div>
          <div class="proj-dir" title="${p.directory || ''}">${p.directory || '—'}</div>
        </div>
        <div class="sess-right-col">
          <div class="sess-cost-val">${money(p.estimated_cost_usd)}</div>
          <div class="sess-tokens-val">${formatTokensCompact(p.total_tokens)}</div>
        </div>
      </div>
    `;
    })
    .join('') || '<p style="padding:24px; color:var(--text-dim)">No projects found.</p>';

  // Bind Card Click
  $('sessionsList').querySelectorAll('.project-card-item').forEach((card) => {
    card.addEventListener('click', () => {
      state.selectedProjectId = card.dataset.project;
      state.projectSessionsSearch = '';
      renderProjectGroupedList(q, src, sort);
    });
  });

  // Render Inspector
  const selectedProj = rawProjects.find((p) => p.project === state.selectedProjectId) || projectList[0];
  renderProjectInspector(selectedProj);

  // Auto-scroll to highlighted project card
  setTimeout(() => {
    const activeProj = $('sessionsList').querySelector('.project-card-item.selected');
    if (activeProj) {
      activeProj.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, 40);
}

function renderSessionInspector(session) {
  const inspector = $('sessionInspector');
  if (!session) {
    inspector.innerHTML = '<p style="color:var(--text-dim)">Select a session to inspect.</p>';
    return;
  }

  const projName = session.project || 'Unknown Project';
  const projDir = session.directory || '';
  const dateDisp = formatDateDisplay(session.last_day || session.first_day);
  const shortId = session.session_id.length > 16 ? session.session_id.slice(0, 14) + '…' : session.session_id;

  inspector.innerHTML = `
    <div class="inspector-project-banner">
      <div class="inspector-project-header">
        <div class="inspector-project-title" title="${projName}">
          <svg class="sess-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>${projName}</span>
        </div>
        ${projDir ? `<button class="copy-mini-btn" id="copyProjPathBtn" title="Copy folder path">Copy path</button>` : ''}
      </div>
      <div class="inspector-project-path">${projDir || 'No directory path recorded'}</div>
    </div>

    <div class="inspector-cost-val">${money(session.estimated_cost_usd)}</div>
    <div class="inspector-cost-sub">Estimated API cost</div>

    <div class="inspector-meta-grid">
      <div class="inspector-meta-label">Date</div>
      <div class="inspector-meta-val">${dateDisp}</div>

      <div class="inspector-meta-label">Source</div>
      <div class="inspector-meta-val">${formatSourceDisplay(session.source)}</div>

      <div class="inspector-meta-label">Primary model</div>
      <div class="inspector-meta-val"><code>${session.primary_model || '—'}</code></div>

      <div class="inspector-meta-label">Session ID</div>
      <div class="inspector-meta-val" style="display:flex; align-items:center; gap:6px">
        <code title="${session.session_id}">${shortId}</code>
        <button class="copy-mini-btn" id="copySessionIdBtn" title="Copy full ID">Copy</button>
      </div>
    </div>

    <div class="inspector-tokens-row">
      <div class="inspector-tokens-col">
        <div class="num">${formatTokensCompact(session.total_tokens)}</div>
        <div class="lbl">tokens</div>
      </div>
      <div class="inspector-tokens-col">
        <div class="num">${num(session.events)}</div>
        <div class="lbl">calls</div>
      </div>
    </div>

    <div class="inspector-activity-header-row">
      <div class="session-activity-header">Session activity</div>
      <button class="expand-chart-btn" id="expandChartBtn" title="Enlarge timeline">Expand ⤢</button>
    </div>
    <div class="session-activity-box" id="sessActivityWrap">
      <svg id="sessActivitySvg" width="100%" height="100%"></svg>
    </div>

    <button class="view-events-btn" id="openDrawerBtn">View events &rarr;</button>

    <button class="file-pricing-details-toggle" id="toggleFileDetailsBtn">
      <span>File &amp; session details</span>
      <span id="fileDetailsChevron">&rsaquo;</span>
    </button>
    <div class="file-pricing-content" id="fileDetailsContent">
      <div style="margin-bottom:8px">
        <strong>Log File:</strong><br/>
        <div style="display:flex; align-items:flex-start; gap:6px; margin-top:4px">
          <span style="word-break:break-all; flex:1">${session.file || '—'}</span>
          ${session.file ? `<button class="copy-mini-btn" id="copyFilePathBtn">Copy</button>` : ''}
        </div>
      </div>
      <div>
        <strong>Full Session ID:</strong><br/>
        <code style="word-break:break-all">${session.session_id}</code>
      </div>
    </div>
  `;

  // Draw sparkline timeline
  renderSessionActivityTimeline(session.activity || []);

  // Bind Buttons
  if (projDir && $('copyProjPathBtn')) {
    $('copyProjPathBtn').onclick = () => copyText(projDir, $('copyProjPathBtn'), 'Copy path');
  }
  if ($('copySessionIdBtn')) {
    $('copySessionIdBtn').onclick = () => copyText(session.session_id, $('copySessionIdBtn'), 'Copy');
  }
  if (session.file && $('copyFilePathBtn')) {
    $('copyFilePathBtn').onclick = () => copyText(session.file, $('copyFilePathBtn'), 'Copy');
  }
  $('expandChartBtn').onclick = () => openDeepSessionModal(session);
  $('openDrawerBtn').onclick = () => openDeepSessionModal(session);

  // Accordion Toggle
  $('toggleFileDetailsBtn').onclick = () => {
    const box = $('fileDetailsContent');
    box.classList.toggle('open');
    $('fileDetailsChevron').textContent = box.classList.contains('open') ? '▼' : '›';
  };
}

function renderProjectInspector(project) {
  const inspector = $('sessionInspector');
  if (!project) {
    inspector.innerHTML = '<p style="color:var(--text-dim); padding:24px">Select a project to inspect.</p>';
    return;
  }

  const projName = project.project || 'Unknown Project';
  const projDir = project.directory || '';
  const dateDisp = formatDateDisplay(project.last_day);

  // Find all sessions for this project from by_session
  const allProjectSessions = ((summary && summary.by_session) || []).filter((s) => s.project === projName);

  // Apply project-level sessions search if any
  const q = (state.projectSessionsSearch || '').toLowerCase().trim();
  const projectSessions = q
    ? allProjectSessions.filter((s) => `${s.session_id} ${s.primary_model} ${s.first_day} ${s.last_day}`.toLowerCase().includes(q))
    : allProjectSessions;

  inspector.innerHTML = `
    <div class="project-inspector-wrap">
      <div class="project-inspector-top">
        <div class="inspector-project-banner" style="margin-bottom:0">
          <div class="inspector-project-header">
            <div class="inspector-project-title" title="${projName}">
              <svg class="sess-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>${projName}</span>
            </div>
            ${projDir ? `<button class="copy-mini-btn" id="copyProjPathBtn" title="Copy folder path">Copy path</button>` : ''}
          </div>
          <div class="inspector-project-path">${projDir || 'No directory path recorded'}</div>
        </div>

        <div class="inspector-kpi-grid">
          <div class="inspector-kpi-card">
            <div class="inspector-kpi-label">Project Cost</div>
            <div class="inspector-kpi-val" style="color:var(--accent-orange)">${money(project.estimated_cost_usd)}</div>
          </div>
          <div class="inspector-kpi-card">
            <div class="inspector-kpi-label">Total Tokens</div>
            <div class="inspector-kpi-val">${formatTokensCompact(project.total_tokens)}</div>
          </div>
          <div class="inspector-kpi-card">
            <div class="inspector-kpi-label">Sessions</div>
            <div class="inspector-kpi-val">${num(allProjectSessions.length || project.sessions_count)}</div>
          </div>
          <div class="inspector-kpi-card">
            <div class="inspector-kpi-label">Total Calls</div>
            <div class="inspector-kpi-val">${num(project.events)}</div>
          </div>
        </div>
      </div>

      <div class="project-sessions-box">
        <div class="project-sessions-box-header">
          <div style="font-weight:600; font-size:13px; color:var(--text-main); display:flex; align-items:center; gap:6px">
            <span>Sessions (${num(allProjectSessions.length)})</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px">
            <input type="text" id="projectSessionsSearch" class="project-sessions-filter-input" placeholder="Search sessions…" value="${state.projectSessionsSearch || ''}" />
            <button class="project-filter-pill-btn" id="filterSessionsTabBtn" title="Show these sessions in main Sessions list">
              Filter Sessions tab &rarr;
            </button>
          </div>
        </div>

        <div class="project-sessions-scroll-list" id="projectSessionsScroll">
          ${projectSessions.map((s) => {
            const shortId = s.session_id.length > 14 ? s.session_id.slice(0, 12) + '…' : s.session_id;
            const sessDate = formatDateDisplay(s.last_day || s.first_day);
            const callsCount = s.events || (s.activity ? s.activity.length : 0);
            return `
              <div class="project-session-card" data-sess-id="${s.session_id}">
                <div style="min-width:0; flex:1">
                  <div style="display:flex; align-items:center; gap:8px">
                    <code style="font-size:12px; font-weight:700; color:var(--text-main)" title="${s.session_id}">${shortId}</code>
                    <span class="sess-source-pill" style="font-size:10px">${s.primary_model || '—'}</span>
                  </div>
                  <div style="font-size:11px; color:var(--text-muted); margin-top:3px">
                    ${sessDate} · ${num(callsCount)} calls
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:12px">
                  <div style="display:flex; flex-direction:column; align-items:flex-end; gap:1px">
                    <div style="font-size:13px; font-weight:700; color:var(--accent-orange)">${money(s.estimated_cost_usd)}</div>
                    <div style="font-size:11px; color:var(--text-muted)">${formatTokensCompact(s.total_tokens)}</div>
                  </div>
                  <button class="copy-mini-btn inspect-session-btn" data-sess-id="${s.session_id}" title="Inspect full session timeline and calls">Inspect ⤢</button>
                </div>
              </div>
            `;
          }).join('') || '<p style="padding:24px; text-align:center; color:var(--text-dim); font-size:12px">No matching sessions found in this project.</p>'}
        </div>
      </div>
    </div>
  `;

  if (projDir && $('copyProjPathBtn')) {
    $('copyProjPathBtn').onclick = () => copyText(projDir, $('copyProjPathBtn'), 'Copy path');
  }

  // Bind project sessions search input
  const searchInput = $('projectSessionsSearch');
  if (searchInput) {
    searchInput.oninput = (e) => {
      state.projectSessionsSearch = e.target.value;
      renderProjectInspector(project);
      const inputAfter = $('projectSessionsSearch');
      if (inputAfter) {
        inputAfter.focus();
        inputAfter.selectionStart = inputAfter.selectionEnd = inputAfter.value.length;
      }
    };
  }

  // Bind Filter Sessions Tab button
  if ($('filterSessionsTabBtn')) {
    $('filterSessionsTabBtn').onclick = () => {
      state.sessionsProjectFilter = projName;
      state.sessionsViewMode = 'sessions';
      state.sessionsVisibleCount = 100;
      $('viewBtnSessions').classList.add('active');
      $('viewBtnProjects').classList.remove('active');
      renderSessions();
    };
  }

  // Bind click on session cards and Inspect buttons to open deep inspector modal
  inspector.querySelectorAll('.project-session-card').forEach((card) => {
    const sessId = card.dataset.sessId;
    const sess = allProjectSessions.find((s) => s.session_id === sessId);
    card.onclick = () => {
      if (sess) openDeepSessionModal(sess);
    };
  });
}


function renderSessionActivityTimeline(activity) {
  const svg = $('sessActivitySvg');
  if (!svg || !activity || !activity.length) {
    if (svg) svg.innerHTML = '';
    return;
  }

  const w = svg.clientWidth || 350;
  const h = svg.clientHeight || 90;
  const pad = 10;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;

  const maxC = Math.max(...activity.map((p) => p.cost || 0), 0.001);

  const bars = activity.map((p, i) => {
    const x = pad + (i / Math.max(1, activity.length - 1)) * plotW;
    const barH = Math.max(3, ((p.cost || 0) / maxC) * plotH);
    const y = h - pad - barH;
    return `<rect x="${x - 1.25}" y="${y}" width="2.5" height="${barH}" fill="var(--accent-cyan)" rx="1"/>`;
  });

  svg.innerHTML = `
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--border-subtle)" stroke-width="1"/>
    ${bars.join('')}
  `;
}

/* ══════════════════════════════════════════════════════════════════════════
   5. UNIFIED IN-DEPTH SESSION INSPECTOR MODAL
   ══════════════════════════════════════════════════════════════════════════ */

let deepActiveSession = null;
let deepMetricMode = 'cost'; // 'cost' or 'tokens'
let deepCallsList = [];
let deepActiveCallIdx = null;
let deepCoords = [];

function openDeepSessionModal(session) {
  if (!session) return;
  deepActiveSession = session;
  state.drawerSessionId = session.session_id;

  const projName = session.project || 'General Project';
  const dateDisp = formatDateDisplay(session.last_day || session.first_day);
  const fileName = session.file ? session.file.split(/[\\/]/).pop() : '';

  if ($('deepSessionSource')) {
    $('deepSessionSource').textContent = session.source || 'Session';
  }
  if ($('deepProjectBadge')) {
    $('deepProjectBadge').textContent = projName;
  }
  if ($('deepSessionId')) {
    $('deepSessionId').textContent = session.session_id;
  }
  if ($('deepCopyIdBtn')) {
    $('deepCopyIdBtn').onclick = () => copyText(session.session_id, $('deepCopyIdBtn'), 'Copy');
  }
  if ($('deepSessionSub')) {
    $('deepSessionSub').textContent = `${dateDisp}${fileName ? ` · ${fileName}` : ''}`;
  }

  // 4 Top Metric Cards
  if ($('deepSessionMetrics')) {
    const costVal = session.estimated_cost_usd ?? session.cost ?? 0;
    const tokensVal = session.total_tokens ?? session.tokens ?? 0;
    const callsVal = session.events ?? session.records?.length ?? (session.activity ? session.activity.length : 0);

    $('deepSessionMetrics').innerHTML = `
      <div class="modal-metric-card">
        <div class="modal-metric-label">Estimated API cost</div>
        <div class="modal-metric-val" style="color:var(--accent-orange)">${money(costVal)}</div>
      </div>
      <div class="modal-metric-card">
        <div class="modal-metric-label">Total processed tokens</div>
        <div class="modal-metric-val">${formatTokensCompact(tokensVal)}</div>
      </div>
      <div class="modal-metric-card">
        <div class="modal-metric-label">Indexed API calls</div>
        <div class="modal-metric-val">${num(callsVal)}</div>
      </div>
      <div class="modal-metric-card">
        <div class="modal-metric-label">Primary model</div>
        <div class="modal-metric-val" style="font-size:14px; font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${session.primary_model || '—'}</div>
      </div>
    `;
  }

  populateDeepModalData(session);
  $('sessionDeepModal').style.display = 'flex';
}

function populateDeepModalData(session) {
  if (!session) return;

  // Extract calls list: check full raw events first, fallback to session.activity
  let calls = [];
  if (eventsLoaded && events.length) {
    const rawMatches = events.filter((e) => e.session_id === session.session_id);
    if (rawMatches.length) {
      calls = rawMatches.map((r, i) => ({
        idx: i + 1,
        time: r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '—',
        rawTs: r.timestamp,
        model: r.model || session.primary_model || '—',
        tokens: r.total_tokens ?? 0,
        cost: r.estimated_cost_usd ?? 0,
      }));
    }
  }

  if (!calls.length && session.activity && session.activity.length) {
    calls = session.activity.map((r, i) => ({
      idx: i + 1,
      time: r.ts ? new Date(r.ts).toLocaleTimeString() : `Call #${i + 1}`,
      rawTs: r.ts,
      model: r.model || session.primary_model || '—',
      tokens: r.tokens ?? 0,
      cost: r.cost ?? 0,
    }));
  }

  if (!calls.length) {
    calls = [{
      idx: 1,
      time: formatDateDisplay(session.last_day || session.first_day),
      rawTs: null,
      model: session.primary_model || '—',
      tokens: session.total_tokens ?? 0,
      cost: session.estimated_cost_usd ?? session.cost ?? 0,
    }];
  }

  deepCallsList = calls;
  if ($('deepCallCountBadge')) {
    $('deepCallCountBadge').textContent = `${num(deepCallsList.length)} calls`;
  }

  // Populate Ledger Table
  const tbody = $('deepCallsTbody');
  if (tbody) {
    tbody.innerHTML = deepCallsList.map((c) => `
      <tr class="deep-call-row" data-idx="${c.idx}">
        <td><span style="font-family:var(--font-mono); color:var(--text-dim)">#${c.idx}</span></td>
        <td style="white-space:nowrap">${c.time}</td>
        <td><code>${c.model}</code></td>
        <td>${formatTokensCompact(c.tokens)}</td>
        <td style="color:var(--accent-orange); font-weight:600">${money(c.cost)}</td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.deep-call-row').forEach((row) => {
      const idx = parseInt(row.dataset.idx, 10);
      row.onclick = () => selectDeepCall(idx, false);
      row.onmouseenter = () => selectDeepCall(idx, false);
    });
  }

  renderDeepInteractiveChart();

  if (deepCallsList.length > 0) {
    selectDeepCall(deepCallsList[0].idx, false);
  }
}

function renderDeepInteractiveChart() {
  const svg = $('deepChartSvg');
  if (!svg || !deepCallsList.length) {
    if (svg) svg.innerHTML = '<text x="50%" y="50%" fill="var(--text-dim)" text-anchor="middle">No activity points available.</text>';
    return;
  }

  const w = svg.clientWidth || 600;
  const h = svg.clientHeight || 280;
  const padLeft = 60;
  const padRight = 24;
  const padTop = 24;
  const padBottom = 36;
  const plotW = Math.max(10, w - padLeft - padRight);
  const plotH = Math.max(10, h - padTop - padBottom);

  const isCost = deepMetricMode === 'cost';
  const values = deepCallsList.map((c) => (isCost ? (c.cost ?? 0) : (c.tokens ?? 0)));
  const maxVal = Math.max(...values, isCost ? 0.005 : 100);

  deepCoords = deepCallsList.map((c, i) => {
    const val = isCost ? (c.cost ?? 0) : (c.tokens ?? 0);
    const x = padLeft + (deepCallsList.length > 1 ? (i / (deepCallsList.length - 1)) * plotW : plotW / 2);
    const y = padTop + (1 - val / maxVal) * plotH;
    return { ...c, val, x, y };
  });

  // Smooth Bézier Path
  let pathD = `M ${deepCoords[0].x} ${deepCoords[0].y}`;
  for (let i = 1; i < deepCoords.length; i++) {
    const p0 = deepCoords[i - 1];
    const p1 = deepCoords[i];
    const mx = (p0.x + p1.x) / 2;
    pathD += ` C ${mx} ${p0.y}, ${mx} ${p1.y}, ${p1.x} ${p1.y}`;
  }

  const areaD = `${pathD} L ${deepCoords[deepCoords.length - 1].x} ${padTop + plotH} L ${deepCoords[0].x} ${padTop + plotH} Z`;

  // Grid Lines & Ticks (4 horizontal divisions)
  const gridLines = [];
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const tickVal = (maxVal / yTicks) * i;
    const yPos = padTop + (1 - i / yTicks) * plotH;
    const label = isCost ? money(tickVal) : formatTokensCompact(tickVal);
    gridLines.push(`
      <line x1="${padLeft}" y1="${yPos}" x2="${w - padRight}" y2="${yPos}" stroke="var(--border-card)" stroke-dasharray="2,2" stroke-width="1" />
      <text x="${padLeft - 10}" y="${yPos + 4}" font-size="11" fill="var(--text-dim)" text-anchor="end">${label}</text>
    `);
  }

  const dotsSvg = deepCoords.length <= 40
    ? deepCoords.map((c) => `<circle cx="${c.x}" cy="${c.y}" r="3" fill="var(--accent-purple)" stroke="var(--bg-card)" stroke-width="1.5" />`).join('')
    : '';

  svg.innerHTML = `
    <defs>
      <linearGradient id="deepChartGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent-purple)" stop-opacity="0.35" />
        <stop offset="100%" stop-color="var(--accent-purple)" stop-opacity="0.0" />
      </linearGradient>
    </defs>
    ${gridLines.join('')}
    <line x1="${padLeft}" y1="${padTop + plotH}" x2="${w - padRight}" y2="${padTop + plotH}" stroke="var(--border-subtle)" stroke-width="1" />
    <path d="${areaD}" fill="url(#deepChartGrad)" />
    <path d="${pathD}" fill="none" stroke="var(--accent-purple)" stroke-width="2.5" stroke-linecap="round" />
    ${dotsSvg}
    <g id="deepScrubGroup" style="display:none">
      <line id="deepScrubLine" y1="${padTop}" y2="${padTop + plotH}" stroke="var(--accent-cyan)" stroke-dasharray="3,3" stroke-width="1.5" />
      <circle id="deepScrubDot" r="5.5" fill="var(--accent-cyan)" stroke="var(--bg-card)" stroke-width="2" />
    </g>
  `;

  // Attach scrub interaction to container
  const wrap = $('deepChartWrap');
  if (wrap) {
    wrap.onmousemove = (evt) => {
      const rect = svg.getBoundingClientRect();
      const mouseX = evt.clientX - rect.left;
      if (mouseX < padLeft || mouseX > w - padRight) return;

      const relX = (mouseX - padLeft) / plotW;
      const targetIdx = Math.min(deepCoords.length - 1, Math.max(0, Math.round(relX * (deepCoords.length - 1))));
      const targetCall = deepCoords[targetIdx];
      if (targetCall) {
        selectDeepCall(targetCall.idx, true);
      }
    };

    wrap.onclick = (evt) => {
      const rect = svg.getBoundingClientRect();
      const mouseX = evt.clientX - rect.left;
      if (mouseX < padLeft || mouseX > w - padRight) return;

      const relX = (mouseX - padLeft) / plotW;
      const targetIdx = Math.min(deepCoords.length - 1, Math.max(0, Math.round(relX * (deepCoords.length - 1))));
      const targetCall = deepCoords[targetIdx];
      if (targetCall) {
        selectDeepCall(targetCall.idx, true);
      }
    };
  }
}

function selectDeepCall(idx, scrollTable) {
  deepActiveCallIdx = idx;

  // Highlight table row
  const tbody = $('deepCallsTbody');
  if (tbody) {
    const prev = tbody.querySelector('.deep-call-row.active-row');
    if (prev) prev.classList.remove('active-row');

    const activeRow = tbody.querySelector(`.deep-call-row[data-idx="${idx}"]`);
    if (activeRow) {
      activeRow.classList.add('active-row');
      if (scrollTable) {
        activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  // Update chart crosshair and tooltip
  updateDeepChartScrubber(idx);
}

function updateDeepChartScrubber(idx) {
  const pt = deepCoords.find((c) => c.idx === idx);
  const scrubGroup = $('deepScrubGroup');
  const scrubLine = $('deepScrubLine');
  const scrubDot = $('deepScrubDot');
  const tooltip = $('deepChartTooltip');
  const svg = $('deepChartSvg');

  if (!pt || !scrubGroup || !scrubLine || !scrubDot || !tooltip || !svg) return;

  scrubGroup.style.display = 'block';
  scrubLine.setAttribute('x1', pt.x);
  scrubLine.setAttribute('x2', pt.x);
  scrubDot.setAttribute('cx', pt.x);
  scrubDot.setAttribute('cy', pt.y);

  const w = svg.clientWidth || 600;
  tooltip.innerHTML = `
    <div style="font-weight:700; margin-bottom:2px">Call #${pt.idx} · ${pt.time}</div>
    <div style="color:var(--accent-orange); font-weight:700">${money(pt.cost)}</div>
    <div style="color:var(--text-muted); font-size:11px">${formatTokensCompact(pt.tokens)} tokens</div>
    <div style="margin-top:2px"><code>${pt.model}</code></div>
  `;
  tooltip.style.left = `${Math.min(w - 160, Math.max(10, pt.x - 70))}px`;
  tooltip.style.top = `${Math.max(10, pt.y - 75)}px`;
  tooltip.style.display = 'block';
}

// Backward-compatible stubs
function openExpandChartModal(session) {
  openDeepSessionModal(session);
}

function openSessionEventsDrawer(session) {
  openDeepSessionModal(session);
}

function populateDrawerEvents(sessionId) {
  if (deepActiveSession && deepActiveSession.session_id === sessionId) {
    populateDeepModalData(deepActiveSession);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   7. PRICING MODAL & DRAWERS
   ══════════════════════════════════════════════════════════════════════════ */

function openPricingModal() {
  const p = summary.price_table || {};
  $('pricingTableWrap').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Input / 1M</th>
          <th>Cached / 1M</th>
          <th>Output / 1M</th>
          <th>Pricing Notes</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(p)
          .map(
            ([m, v]) => `
          <tr>
            <td><code>${m}</code></td>
            <td>$${v.input}</td>
            <td>$${v.cached}</td>
            <td>$${v.output}</td>
            <td style="color:var(--text-dim); font-size:11px">${v.note || '—'}</td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `;

  // Discounts
  const discounts = summary.discounts || [];
  $('pricingDiscountsWrap').innerHTML = discounts.length
    ? `<pre class="warnings-box">${JSON.stringify(discounts, null, 2)}</pre>`
    : '<p style="color:var(--text-dim)">No active discount rules configured in config.json.</p>';

  // Caveats
  $('pricingCaveatsList').innerHTML = (summary.caveats || [])
    .map((c) => `<li>${c}</li>`)
    .join('');

  // Warnings
  $('pricingWarningsText').textContent =
    (summary.warnings || []).join('\n') || 'No parse or system warnings detected.';

  $('pricingModal').style.display = 'flex';
}

/* ══════════════════════════════════════════════════════════════════════════
   8. SERVER INTEGRATION & ACTIONS
   ══════════════════════════════════════════════════════════════════════════ */

async function refreshScan() {
  $('status').textContent = '◌ refreshing…';
  $('status').style.color = 'var(--accent-amber)';
  try {
    await fetch('/refresh', { method: 'POST' });
    pollStatus();
  } catch (e) {
    $('status').textContent = '○ server not found';
    $('status').style.color = 'var(--accent-rose)';
  }
}

async function pollStatus() {
  try {
    const s = await fetch('/status?x=' + Date.now()).then((r) => r.json());
    if (s.running) {
      $('status').textContent = '◌ scanning…';
      $('status').style.color = 'var(--accent-amber)';
      setTimeout(pollStatus, 1500);
    } else {
      $('status').textContent = s.error ? '○ error' : '● synced';
      $('status').style.color = s.error ? 'var(--accent-rose)' : 'var(--accent-emerald)';
      loadData();
    }
  } catch {}
}

/* ══════════════════════════════════════════════════════════════════════════
   9. EVENT LISTENERS ATTACHMENT
   ══════════════════════════════════════════════════════════════════════════ */

// Navigation
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

$('ovExploreModelsBtn').onclick = () => switchTab('models');

// Time Range
$('timeRangeSelect').addEventListener('change', (e) => {
  state.timeRange = e.target.value;
  renderCurrent();
});

// Theme Toggle
$('themeToggleBtn').addEventListener('click', () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
});

// Refresh
$('refreshBtn').addEventListener('click', refreshScan);

// Overview Metric Toggle
document.querySelectorAll('#ovDailyMetricToggle .toggle-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ovDailyMetricToggle .toggle-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.overviewMetric = btn.dataset.metric;
    renderCurrent();
  });
});

// Trends Granularity Toggle
document.querySelectorAll('#trendsGranularityToggle .toggle-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#trendsGranularityToggle .toggle-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.trendsGranularity = btn.dataset.granularity;
    renderCurrent();
  });
});

// Trends Metric Toggle
document.querySelectorAll('#trendsMetricToggle .toggle-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#trendsMetricToggle .toggle-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.trendsMetric = btn.dataset.metric;
    renderCurrent();
  });
});

// Models Search & Source
$('modelsSearchInput').addEventListener('input', (e) => {
  state.modelsSearch = e.target.value;
  renderCurrent();
});

$('modelsSourceSelect').addEventListener('change', (e) => {
  state.modelsSource = e.target.value;
  renderCurrent();
});

// Sessions View Mode Toggle (Sessions vs Group by Project)
if ($('viewBtnSessions') && $('viewBtnProjects')) {
  $('viewBtnSessions').addEventListener('click', () => {
    state.sessionsViewMode = 'sessions';
    $('viewBtnSessions').classList.add('active');
    $('viewBtnProjects').classList.remove('active');
    renderCurrent();
  });
  $('viewBtnProjects').addEventListener('click', () => {
    state.sessionsViewMode = 'projects';
    $('viewBtnProjects').classList.add('active');
    $('viewBtnSessions').classList.remove('active');
    renderCurrent();
  });
}

// Sessions Search, Source & Sort
$('sessionsSearchInput').addEventListener('input', (e) => {
  state.sessionsSearch = e.target.value;
  renderCurrent();
});

$('sessionsSourceSelect').addEventListener('change', (e) => {
  state.sessionsSource = e.target.value;
  renderCurrent();
});

$('sessionsSortSelect').addEventListener('change', (e) => {
  state.sessionsSort = e.target.value;
  renderCurrent();
});

// Modals & Drawers
if ($('openPricingBtn')) $('openPricingBtn').onclick = openPricingModal;
if ($('closePricingBtn')) $('closePricingBtn').onclick = () => {
  if ($('pricingModal')) $('pricingModal').style.display = 'none';
};
if ($('closeDeepModalBtn')) {
  $('closeDeepModalBtn').onclick = () => {
    if ($('sessionDeepModal')) $('sessionDeepModal').style.display = 'none';
    deepActiveSession = null;
  };
}
if ($('closeDrawerBtn') && $('sessionEventsDrawer')) {
  $('closeDrawerBtn').onclick = () => ($('sessionEventsDrawer').style.display = 'none');
}
if ($('closeSessionChartBtn') && $('sessionChartModal')) {
  $('closeSessionChartBtn').onclick = () => ($('sessionChartModal').style.display = 'none');
}

// Deep Modal Metric Toggle (Cost vs Tokens)
if ($('deepMetricBtnCost') && $('deepMetricBtnTokens')) {
  $('deepMetricBtnCost').addEventListener('click', () => {
    deepMetricMode = 'cost';
    $('deepMetricBtnCost').classList.add('active');
    $('deepMetricBtnTokens').classList.remove('active');
    renderDeepInteractiveChart();
    if (deepActiveCallIdx) updateDeepChartScrubber(deepActiveCallIdx);
  });
  $('deepMetricBtnTokens').addEventListener('click', () => {
    deepMetricMode = 'tokens';
    $('deepMetricBtnTokens').classList.add('active');
    $('deepMetricBtnCost').classList.remove('active');
    renderDeepInteractiveChart();
    if (deepActiveCallIdx) updateDeepChartScrubber(deepActiveCallIdx);
  });
}

// Modal Tab Switcher
document.querySelectorAll('.modal-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const paneId = btn.dataset.modalPane;
    document.querySelectorAll('.modal-pane').forEach((p) => {
      p.classList.toggle('active', p.id === `modalPane${paneId.charAt(0).toUpperCase() + paneId.slice(1)}`);
    });
  });
});

// Close modals on outside click
window.addEventListener('click', (e) => {
  if ($('pricingModal') && e.target === $('pricingModal')) $('pricingModal').style.display = 'none';
  if ($('sessionDeepModal') && e.target === $('sessionDeepModal')) {
    $('sessionDeepModal').style.display = 'none';
    deepActiveSession = null;
  }
  if ($('sessionEventsDrawer') && e.target === $('sessionEventsDrawer')) $('sessionEventsDrawer').style.display = 'none';
  if ($('sessionChartModal') && e.target === $('sessionChartModal')) $('sessionChartModal').style.display = 'none';
});

// Close modals on Escape key
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('pricingModal')) $('pricingModal').style.display = 'none';
    if ($('sessionDeepModal')) {
      $('sessionDeepModal').style.display = 'none';
      deepActiveSession = null;
    }
    if ($('sessionEventsDrawer')) $('sessionEventsDrawer').style.display = 'none';
    if ($('sessionChartModal')) $('sessionChartModal').style.display = 'none';
  }
});

// Window resize chart redraw
window.addEventListener('resize', () => {
  if (state.currentTab === 'overview' || state.currentTab === 'trends') {
    renderCurrent();
  }
  if (deepActiveSession && $('sessionDeepModal') && $('sessionDeepModal').style.display === 'flex') {
    renderDeepInteractiveChart();
    if (deepActiveCallIdx) updateDeepChartScrubber(deepActiveCallIdx);
  }
});

// Boot
loadData();

