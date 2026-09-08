/* ══════════════════════════════════════════════════════════════════════════
   TOKEN LEDGER — Modern V4 Controller & Interactive Engine
   ══════════════════════════════════════════════════════════════════════════ */

let summary = null;
let events = [];

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
  sessionsSearch: '',
  sessionsSource: 'all',
  sessionsSort: 'cost-desc',
  selectedSessionId: null,
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

/* ─── Data Loading ─── */
async function loadData() {
  try {
    const ts = Date.now();
    const [sRes, eRes] = await Promise.all([
      fetch('/data/usage-summary.json?x=' + ts).then((r) => r.json()),
      fetch('/data/usage-events.json?x=' + ts).then((r) => r.json()),
    ]);
    summary = sRes;
    events = eRes;

    $('status').textContent = '● synced ' + new Date(summary.generated_at).toLocaleTimeString();
    $('status').style.color = 'var(--accent-emerald)';

    initSelectors();
    applyTheme(state.theme);
    renderCurrent();
  } catch (err) {
    $('status').textContent = '○ sync failed';
    $('status').style.color = 'var(--accent-rose)';
    console.error('Data load error:', err);
  }
}

/* ─── Filter Events by Time Range ─── */
function getCutoffDay(rangeKey) {
  if (rangeKey === 'all') return null;
  const days = events.map((e) => e.day).filter(Boolean).sort();
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

function getFilteredRows() {
  const cutoff = getCutoffDay(state.timeRange);
  if (!cutoff) return events;
  return events.filter((e) => e.day && e.day >= cutoff);
}

function updateDateRangeBadge(rows) {
  const days = rows.map((e) => e.day).filter(Boolean).sort();
  if (!days.length) {
    $('dateRangeBadge').textContent = 'No data';
    return;
  }
  const start = formatDateDisplay(days[0]);
  const end = formatDateDisplay(days[days.length - 1]);
  $('dateRangeBadge').textContent = `${start} – ${end}`;
}

/* ─── Initializer & Event Listeners ─── */
function initSelectors() {
  const sources = [...new Set(events.map(sourceKey))].sort();
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
  if (!summary || !events.length) return;
  const rows = getFilteredRows();
  updateDateRangeBadge(rows);

  if (state.currentTab === 'overview') renderOverview(rows);
  else if (state.currentTab === 'trends') renderTrends(rows);
  else if (state.currentTab === 'models') renderModels(rows);
  else if (state.currentTab === 'sessions') renderSessions(rows);
}

/* ══════════════════════════════════════════════════════════════════════════
   1. OVERVIEW VIEW
   ══════════════════════════════════════════════════════════════════════════ */

function renderOverview(rows) {
  let totalTokens = 0;
  let totalCost = 0;
  let cachedTokens = 0;
  let uncachedTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let discountTotal = 0;

  const sessionIds = new Set();
  const sourceTotals = {
    'takomi/pi': 0,
    codex: 0,
    antigravity: 0,
  };

  for (const e of rows) {
    const t = e.total_tokens || 0;
    const c = e.cached_input_tokens || 0;
    const inp = e.input_tokens || 0;
    const out = e.output_tokens || 0;
    const cost = e.estimated_cost_usd || 0;

    totalTokens += t;
    totalCost += cost;
    cachedTokens += c;
    outputTokens += out;
    reasoningTokens += e.reasoning_output_tokens || 0;
    discountTotal += e.discount_amount_usd || 0;

    const uncache = e.input_includes_cache ? Math.max(0, inp - c) : inp;
    uncachedTokens += uncache;

    if (e.session_id) sessionIds.add(e.session_id);

    const s = sourceKey(e);
    if (s === 'takomi/pi') sourceTotals['takomi/pi'] += t;
    else if (s === 'codex') sourceTotals.codex += t;
    else if (s === 'antigravity') sourceTotals.antigravity += t;
    else sourceTotals['takomi/pi'] += t;
  }

  // Hero Card
  $('ovProcessedTokens').textContent = formatTokensCompact(totalTokens);
  $('ovApiCost').textContent = money(totalCost);
  $('ovSessionCount').textContent = num(sessionIds.size);

  if (discountTotal > 0) {
    $('ovSavingsTag').textContent = `Saved ${money(discountTotal)} from discounts`;
    $('ovSavingsTag').style.display = 'inline-block';
  } else {
    $('ovSavingsTag').style.display = 'none';
  }

  // Daily Usage Chart with Obvious Dotted Month Demarcations
  renderOverviewDailyChart(rows, state.overviewMetric);

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

function renderOverviewDailyChart(rows, metric) {
  $('ovDailyChartUnit').textContent = metric === 'tokens' ? 'Tokens' : 'Estimated cost';

  const dayMap = new Map();
  for (const e of rows) {
    if (!e.day) continue;
    const v = metric === 'tokens' ? (e.total_tokens || 0) : (e.estimated_cost_usd || 0);
    dayMap.set(e.day, (dayMap.get(e.day) || 0) + v);
  }

  const sortedDays = [...dayMap.keys()].sort();
  if (!sortedDays.length) {
    $('ovDailySvg').innerHTML = '';
    return;
  }

  const data = sortedDays.map((day) => ({ day, val: dayMap.get(day) }));
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

function renderTrends(rows) {
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

  for (const e of rows) {
    const key = isMonthly
      ? (e.month || (e.day ? e.day.slice(0, 7) : 'unknown'))
      : (e.day || 'unknown');
    if (key === 'unknown') continue;

    const val = isCost ? (e.estimated_cost_usd || 0) : (e.total_tokens || 0);
    allBucketMap.set(key, (allBucketMap.get(key) || 0) + val);

    const s = sourceKey(e);
    if (s === 'takomi/pi') takomiMap.set(key, (takomiMap.get(key) || 0) + val);
    else if (s === 'codex') codexMap.set(key, (codexMap.get(key) || 0) + val);
    else if (s === 'antigravity') antigravityMap.set(key, (antigravityMap.get(key) || 0) + val);
  }

  const buckets = [...allBucketMap.keys()].sort();
  renderTrendsMultiChart(buckets, takomiMap, codexMap, antigravityMap, isCost, isMonthly);

  // Peak Day & Daily Average
  let peakDay = '—';
  let peakVal = 0;
  let dailySum = 0;
  let dailyCount = 0;

  const dayTotals = new Map();
  for (const e of rows) {
    if (!e.day) continue;
    const v = e.estimated_cost_usd || 0;
    dayTotals.set(e.day, (dayTotals.get(e.day) || 0) + v);
  }

  for (const [d, v] of dayTotals.entries()) {
    dailySum += v;
    dailyCount++;
    if (v > peakVal) {
      peakVal = v;
      peakDay = d;
    }
  }

  $('trendsPeakDayLabel').textContent = peakDay !== '—' ? formatDateDisplay(peakDay) : '—';
  $('trendsPeakDayVal').textContent = money(peakVal);
  $('trendsDailyAvgVal').textContent = dailyCount > 0 ? money(dailySum / dailyCount) : '$0.00';

  // Monthly Column Bars
  renderTrendsMonthlyColumns(rows);
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

function renderTrendsMonthlyColumns(rows) {
  const monthMap = new Map();
  for (const e of rows) {
    const m = e.month || (e.day ? e.day.slice(0, 7) : 'unknown');
    if (m === 'unknown') continue;
    monthMap.set(m, (monthMap.get(m) || 0) + (e.estimated_cost_usd || 0));
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

function renderModels(rows) {
  const src = state.modelsSource;
  const q = state.modelsSearch.toLowerCase();

  const modelMap = new Map();
  let totalCost = 0;

  for (const e of rows) {
    if (src !== 'all' && sourceKey(e) !== src) continue;
    const m = e.model || 'unknown';
    if (q && !m.toLowerCase().includes(q)) continue;

    const cost = e.estimated_cost_usd || 0;
    const tokens = e.total_tokens || 0;
    const cached = e.cached_input_tokens || 0;
    const inp = e.input_tokens || 0;
    const out = e.output_tokens || 0;
    const reasoning = e.reasoning_output_tokens || 0;
    const uncache = e.input_includes_cache ? Math.max(0, inp - cached) : inp;

    totalCost += cost;

    if (!modelMap.has(m)) {
      modelMap.set(m, {
        model: m,
        cost: 0,
        tokens: 0,
        cached: 0,
        uncached: 0,
        output: 0,
        reasoning: 0,
        events: 0,
      });
    }

    const item = modelMap.get(m);
    item.cost += cost;
    item.tokens += tokens;
    item.cached += cached;
    item.uncached += uncache;
    item.output += out;
    item.reasoning += reasoning;
    item.events++;
  }

  const modelList = [...modelMap.values()].sort((a, b) => b.cost - a.cost);

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
      renderModels(rows);
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   4. SESSIONS VIEW
   ══════════════════════════════════════════════════════════════════════════ */

function renderSessions(rows) {
  const src = state.sessionsSource;
  const q = state.sessionsSearch.toLowerCase();
  const sort = state.sessionsSort;

  // Session Aggregator
  const sessionMap = new Map();

  for (const e of rows) {
    if (src !== 'all' && sourceKey(e) !== src) continue;
    const sid = e.session_id || 'unknown';
    if (q && !JSON.stringify([sid, e.model, e.file, sourceKey(e)]).toLowerCase().includes(q)) {
      continue;
    }

    if (!sessionMap.has(sid)) {
      sessionMap.set(sid, {
        session_id: sid,
        source: sourceKey(e),
        cost: 0,
        tokens: 0,
        events: 0,
        day: e.day || '',
        lastDay: e.day || '',
        models: new Map(),
        file: e.file || '',
        records: [],
      });
    }

    const sObj = sessionMap.get(sid);
    const cost = e.estimated_cost_usd || 0;
    sObj.cost += cost;
    sObj.tokens += e.total_tokens || 0;
    sObj.events++;
    sObj.records.push(e);

    if (e.day && (!sObj.day || e.day < sObj.day)) sObj.day = e.day;
    if (e.day && (!sObj.lastDay || e.day > sObj.lastDay)) sObj.lastDay = e.day;

    const m = e.model || 'unknown';
    sObj.models.set(m, (sObj.models.get(m) || 0) + cost);
    if (!sObj.file && e.file) sObj.file = e.file;
  }

  let sessionList = [...sessionMap.values()];

  // Sort
  if (sort === 'cost-desc') sessionList.sort((a, b) => b.cost - a.cost);
  else if (sort === 'date-desc') sessionList.sort((a, b) => (b.lastDay || '').localeCompare(a.lastDay || ''));
  else if (sort === 'tokens-desc') sessionList.sort((a, b) => b.tokens - a.tokens);

  // Top Session Selection
  if (!state.selectedSessionId && sessionList.length) {
    state.selectedSessionId = sessionList[0].session_id;
  } else if (state.selectedSessionId && !sessionMap.has(state.selectedSessionId) && sessionList.length) {
    state.selectedSessionId = sessionList[0].session_id;
  }

  // Render Session Cards
  $('sessionsList').innerHTML = sessionList
    .slice(0, 100)
    .map((s) => {
      const isSelected = s.session_id === state.selectedSessionId;
      const shortId = s.session_id.length > 12 ? s.session_id.slice(0, 10) + '…' : s.session_id;
      const dateDisp = formatDateDisplay(s.lastDay || s.day);

      return `
      <div class="session-card-item ${isSelected ? 'selected' : ''}" data-session="${s.session_id}">
        <div class="sess-id-col">
          <div class="sess-id">${shortId}</div>
          <div class="sess-date">${dateDisp}</div>
        </div>
        <div class="sess-source-col">${formatSourceDisplay(s.source)}</div>
        <div class="sess-cost-col">${money(s.cost)}</div>
        <div class="sess-tokens-col">${formatTokensCompact(s.tokens)}</div>
        <div class="sess-arrow-col">&rsaquo;</div>
      </div>
    `;
    })
    .join('') || '<p style="padding:24px; color:var(--text-dim)">No sessions found.</p>';

  // Bind Card Click
  $('sessionsList').querySelectorAll('.session-card-item').forEach((card) => {
    card.addEventListener('click', () => {
      state.selectedSessionId = card.dataset.session;
      renderSessions(rows);
    });
  });

  // Render Inspector
  const selectedObj = sessionMap.get(state.selectedSessionId);
  renderSessionInspector(selectedObj);
}

function renderSessionInspector(session) {
  const inspector = $('sessionInspector');
  if (!session) {
    inspector.innerHTML = '<p style="color:var(--text-dim)">Select a session to inspect.</p>';
    return;
  }

  // Top model
  let topModel = '—';
  let topModelCost = -1;
  for (const [m, c] of session.models.entries()) {
    if (c > topModelCost) {
      topModelCost = c;
      topModel = m;
    }
  }

  inspector.innerHTML = `
    <div class="inspector-cost-val">${money(session.cost)}</div>
    <div class="inspector-cost-sub">Estimated API cost</div>

    <div class="inspector-meta-grid">
      <div class="inspector-meta-label">Date</div>
      <div class="inspector-meta-val">${formatDateDisplay(session.lastDay || session.day)}</div>
      <div class="inspector-meta-label">Source</div>
      <div class="inspector-meta-val">${formatSourceDisplay(session.source)}</div>
      <div class="inspector-meta-label">Primary model</div>
      <div class="inspector-meta-val"><code>${topModel}</code></div>
    </div>

    <div class="inspector-tokens-row">
      <div class="inspector-tokens-col">
        <div class="num">${formatTokensCompact(session.tokens)}</div>
        <div class="lbl">tokens</div>
      </div>
      <div class="inspector-tokens-col">
        <div class="num">${num(session.events)}</div>
        <div class="lbl">events</div>
      </div>
    </div>

    <div class="session-activity-header">Session activity</div>
    <div class="session-activity-box" id="sessActivityWrap">
      <svg id="sessActivitySvg" width="100%" height="100%"></svg>
    </div>

    <button class="view-events-btn" id="openDrawerBtn">View events &rarr;</button>

    <button class="file-pricing-details-toggle" id="toggleFileDetailsBtn">
      <span>File &amp; pricing details</span>
      <span id="fileDetailsChevron">&rsaquo;</span>
    </button>
    <div class="file-pricing-content" id="fileDetailsContent">
      <p style="margin-bottom:6px"><strong>File:</strong><br/>${session.file || '—'}</p>
      <p><strong>Session ID:</strong><br/>${session.session_id}</p>
    </div>
  `;

  // Draw Activity Timeline
  renderSessionActivityTimeline(session.records);

  // Bind Drawer Button
  $('openDrawerBtn').onclick = () => openSessionEventsDrawer(session);

  // Bind Accordion Toggle
  $('toggleFileDetailsBtn').onclick = () => {
    const box = $('fileDetailsContent');
    box.classList.toggle('open');
    $('fileDetailsChevron').textContent = box.classList.contains('open') ? '▼' : '›';
  };
}

function renderSessionActivityTimeline(records) {
  const svg = $('sessActivitySvg');
  if (!svg || !records || !records.length) return;

  const w = svg.clientWidth || 350;
  const h = svg.clientHeight || 90;
  const pad = 10;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;

  const pts = records.map((r, i) => {
    const cost = r.estimated_cost_usd || 0.0001;
    return { idx: i, cost };
  });

  const maxC = Math.max(...pts.map((p) => p.cost), 0.001);

  const bars = pts.map((p, i) => {
    const x = pad + (i / Math.max(1, pts.length - 1)) * plotW;
    const barH = Math.max(2, (p.cost / maxC) * plotH);
    const y = h - pad - barH;
    return `<rect x="${x - 1}" y="${y}" width="2.5" height="${barH}" fill="var(--accent-cyan)" rx="1"/>`;
  });

  svg.innerHTML = `
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--border-subtle)" stroke-width="1"/>
    ${bars.join('')}
  `;
}

function openSessionEventsDrawer(session) {
  state.drawerSessionId = session.session_id;
  $('drawerSessionTitle').textContent = `Session: ${session.session_id.slice(0, 12)}…`;
  $('drawerSessionSub').textContent = `${session.records.length} calls · ${money(session.cost)} total`;

  $('drawerEventsList').innerHTML = `
    <table class="modal-table-wrap" style="width:100%">
      <thead>
        <tr>
          <th>Time</th>
          <th>Model</th>
          <th>Tokens</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        ${session.records
          .map((r) => {
            const time = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '—';
            return `
            <tr>
              <td>${time}</td>
              <td><code>${r.model}</code></td>
              <td>${formatTokensCompact(r.total_tokens)}</td>
              <td style="color:var(--accent-orange); font-weight:600">${money(r.estimated_cost_usd)}</td>
            </tr>
          `;
          })
          .join('')}
      </tbody>
    </table>
  `;

  $('sessionEventsDrawer').style.display = 'flex';
}

/* ══════════════════════════════════════════════════════════════════════════
   5. PRICING MODAL & DRAWERS
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
   6. SERVER INTEGRATION & ACTIONS
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
   7. EVENT LISTENERS ATTACHMENT
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
$('openPricingBtn').onclick = openPricingModal;
$('closePricingBtn').onclick = () => ($('pricingModal').style.display = 'none');
$('closeDrawerBtn').onclick = () => ($('sessionEventsDrawer').style.display = 'none');

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
  if (e.target === $('pricingModal')) $('pricingModal').style.display = 'none';
  if (e.target === $('sessionEventsDrawer')) $('sessionEventsDrawer').style.display = 'none';
});

// Window resize chart redraw
window.addEventListener('resize', () => {
  if (state.currentTab === 'overview' || state.currentTab === 'trends') {
    renderCurrent();
  }
});

// Boot
loadData();
