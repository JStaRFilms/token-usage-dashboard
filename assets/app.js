/* ═══════════════════════════════════════════════
   TOKEN LEDGER — V3 Runtime
   ═══════════════════════════════════════════════ */

let summary = null;
let events = [];

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
const short = (s) => (s || '').replace(/^.*[\\/]/, '');

/* ─── Data Loading ─── */
async function loadData() {
  try {
    summary = await fetch('data/usage-summary.json?x=' + Date.now()).then((r) =>
      r.json()
    );
    events = await fetch('data/usage-events.json?x=' + Date.now()).then((r) =>
      r.json()
    );
    $('status').textContent =
      '● synced ' + new Date(summary.generated_at).toLocaleTimeString();
    $('status').style.color = '#39ff14';
    populateFilters();
    render();
  } catch (e) {
    $('status').textContent = '○ sync failed';
    $('status').style.color = '#ff4d2a';
    console.error(e);
  }
}

/* ─── Filters ─── */
function populateFilters() {
  const sources = [...new Set(events.map((e) => e.source))].sort();
  const models = [...new Set(events.map((e) => e.model))].sort();
  if ($('sourceFilter').options.length <= 1) {
    $('sourceFilter').innerHTML =
      '<option value="all">All sources</option>' +
      sources.map((s) => `<option>${s}</option>`).join('');
    $('modelFilter').innerHTML =
      '<option value="all">All models</option>' +
      models.map((s) => `<option>${s}</option>`).join('');
  }
}

function filteredEvents() {
  const q = $('search').value.toLowerCase();
  const src = $('sourceFilter').value;
  const model = $('modelFilter').value;
  return events.filter(
    (e) =>
      (src === 'all' || e.source === src) &&
      (model === 'all' || e.model === model) &&
      (!q ||
        JSON.stringify([e.model, e.source, e.session_id, e.file])
          .toLowerCase()
          .includes(q))
  );
}

function sumRows(rows) {
  return rows.reduce((a, e) => {
    for (const k of [
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
      'total_tokens',
    ])
      a[k] = (a[k] || 0) + (e[k] || 0);
    a.estimated_cost_usd =
      (a.estimated_cost_usd || 0) + (e.estimated_cost_usd || 0);
    return a;
  }, {});
}

/* ─── Grouping ─── */
function group(rows, key) {
  const m = new Map();
  for (const e of rows) {
    const k = e[key] || 'unknown';
    if (!m.has(k))
      m.set(k, { key: k, cost: 0, input: 0, cache: 0, output: 0, total: 0, events: 0 });
    const r = m.get(k);
    r.cost += e.estimated_cost_usd || 0;
    r.input += e.input_tokens || 0;
    r.cache += e.cached_input_tokens || 0;
    r.output += e.output_tokens || 0;
    r.total += e.total_tokens || 0;
    r.events++;
  }
  return [...m.values()];
}

/* ─── Render Orchestrator ─── */
function render() {
  const rows = filteredEvents();
  const totals = sumRows(rows);

  // Stat cards
  const cards = [
    ['Est. Cost', money(totals.estimated_cost_usd), 'priced rows only'],
    ['Total Tokens', num(totals.total_tokens), 'explicit usage'],
    ['Cached Input', num(totals.cached_input_tokens), 'discounted'],
    ['Output', num(totals.output_tokens), 'results'],
    [
      'Events',
      num(rows.length),
      `${new Set(rows.map((e) => e.session_id)).size} sessions`,
    ],
  ];

  $('cards').innerHTML = cards
    .map(
      (c) => `
    <article class="stat-card">
      <div class="stat-label">${c[0]}</div>
      <div class="stat-value">${c[1]}</div>
      <div class="stat-hint">${c[2]}</div>
    </article>
  `
    )
    .join('');

  // Charts
  renderBars(
    'modelBars',
    group(rows, 'model')
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 12)
  );
  renderBars(
    'dayBars',
    group(rows, 'day')
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(-30)
  );

  // Tables
  renderTable(
    'sourceTable',
    group(rows, 'source').sort((a, b) => b.cost - a.cost),
    ['Key', 'Cost', 'Tokens', 'Rows']
  );
  renderTable(
    'modelTable',
    group(rows, 'model').sort((a, b) => b.cost - a.cost),
    ['Model', 'Cost', 'Total', 'Input', 'Cache', 'Output', 'Calls']
  );

  renderEvents(
    rows
      .sort((a, b) => (b.estimated_cost_usd || 0) - (a.estimated_cost_usd || 0))
      .slice(0, 120)
  );
  renderPrices();

  // Footer meta
  $('caveats').innerHTML = (summary.caveats || [])
    .map((x) => `<li>${x}</li>`)
    .join('');
  $('warnings').textContent =
    (summary.warnings || []).join('\n') || 'No system warnings.';
}

/* ─── Bar Renderer ─── */
function renderBars(id, rows) {
  const max = Math.max(...rows.map((r) => r.cost), 0.01);
  $(id).innerHTML =
    rows
      .map(
        (r) => `
    <div class="bar-row">
      <div class="bar-key"><code>${r.key}</code></div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.max(1, (r.cost / max) * 100)}%"></div>
      </div>
      <div class="bar-value">${money(r.cost)}</div>
    </div>
  `
      )
      .join('') || '<p class="stat-hint">No data available</p>';
}

/* ─── Sort State ─── */
const sortState = {};

function getSortKey(id, colIdx) {
  if (!sortState[id] || sortState[id].col !== colIdx) return null;
  return sortState[id];
}

function toggleSort(id, colIdx) {
  const prev = sortState[id];
  if (prev && prev.col === colIdx) {
    sortState[id] = { col: colIdx, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    sortState[id] = { col: colIdx, dir: 'desc' };
  }
}

function sortArrow(id, colIdx) {
  const s = getSortKey(id, colIdx);
  if (!s) return '';
  return `<span class="sort-arrow">${s.dir === 'asc' ? '▲' : '▼'}</span>`;
}

function sortRows(rows, colIdx, dir, getVal) {
  return [...rows].sort((a, b) => {
    const va = getVal(a, colIdx);
    const vb = getVal(b, colIdx);
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return dir === 'asc' ? va - vb : vb - va;
  });
}

/* ─── Table Renderer (sortable) ─── */
function renderTable(id, rows, headers) {
  const fieldMap = headers.length > 4
    ? ['key', 'cost', 'total', 'input', 'cache', 'output', 'events']
    : ['key', 'cost', 'total', 'events'];

  const s = sortState[id];
  if (s) {
    const field = fieldMap[s.col];
    rows = sortRows(rows, s.col, s.dir, (r) => r[field]);
  }

  $(id).innerHTML = `
    <table>
      <thead>
        <tr>${headers.map((h, i) => `<th data-table="${id}" data-col="${i}">${h}${sortArrow(id, i)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td><code>${r.key}</code></td>
            <td style="color:var(--ember);font-weight:600">${money(r.cost)}</td>
            ${
              headers.length > 4
                ? `
              <td>${num(r.total)}</td>
              <td>${num(r.input)}</td>
              <td>${num(r.cache)}</td>
              <td>${num(r.output)}</td>
            `
                : `<td>${num(r.total)}</td>`
            }
            <td>${num(r.events)}</td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `;

  // Bind sort clicks
  $(id).querySelectorAll('th[data-table]').forEach((th) => {
    th.addEventListener('click', () => {
      toggleSort(th.dataset.table, parseInt(th.dataset.col));
      render();
    });
  });
}

/* ─── Events Table (sortable) ─── */
function renderEvents(rows) {
  const id = 'eventTable';
  const headers = ['When', 'Source', 'Model', 'Cost', 'Tokens', 'File'];
  const fieldExtract = [
    (e) => e.day || '',
    (e) => e.source || '',
    (e) => e.model || '',
    (e) => e.estimated_cost_usd || 0,
    (e) => e.total_tokens || 0,
    (e) => short(e.file) || '',
  ];

  const s = sortState[id];
  if (s) {
    const extract = fieldExtract[s.col];
    rows = sortRows(rows, s.col, s.dir, (r) => extract(r));
  }

  $(id).innerHTML = `
    <table>
      <thead>
        <tr>
          ${headers.map((h, i) => `<th data-table="${id}" data-col="${i}">${h}${sortArrow(id, i)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (e) => `
          <tr>
            <td style="white-space:nowrap">${e.day}</td>
            <td><span class="pill">${e.source}</span></td>
            <td><code>${e.model}</code></td>
            <td style="color:var(--ember);font-weight:600">${money(e.estimated_cost_usd)}</td>
            <td>${num(e.total_tokens)}</td>
            <td><div class="stat-hint" title="${e.file}">${short(e.file)}</div></td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `;

  $(id).querySelectorAll('th[data-table]').forEach((th) => {
    th.addEventListener('click', () => {
      toggleSort(th.dataset.table, parseInt(th.dataset.col));
      render();
    });
  });
}

/* ─── Pricing Table (sortable) ─── */
function renderPrices() {
  const id = 'priceTable';
  const p = summary.price_table || {};
  let entries = Object.entries(p).map(([m, v]) => ({ model: m, input: v.input, cached: v.cached, output: v.output, note: v.note || '' }));
  const headers = ['Model', 'In', 'Cache', 'Out'];
  const fields = ['model', 'input', 'cached', 'output'];

  const s = sortState[id];
  if (s) {
    const field = fields[s.col];
    entries = sortRows(entries, s.col, s.dir, (r) => r[field]);
  }

  $(id).innerHTML = `
    <table>
      <thead>
        <tr>${headers.map((h, i) => `<th data-table="${id}" data-col="${i}">${h}${sortArrow(id, i)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${entries
          .map(
            (v) => `
          <tr>
            <td><code title="${v.note}">${v.model}</code></td>
            <td>$${v.input}</td>
            <td>$${v.cached}</td>
            <td>$${v.output}</td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `;

  $(id).querySelectorAll('th[data-table]').forEach((th) => {
    th.addEventListener('click', () => {
      toggleSort(th.dataset.table, parseInt(th.dataset.col));
      render();
    });
  });
}

/* ─── Interactive background glow ─── */
document.addEventListener('mousemove', (e) => {
  const x = (e.clientX / window.innerWidth) * 100;
  const y = (e.clientY / window.innerHeight) * 100;
  document.body.style.setProperty('--x', x + '%');
  document.body.style.setProperty('--y', y + '%');
});

/* ─── Server Integration ─── */
async function refreshScan() {
  $('status').textContent = '◌ refreshing…';
  $('status').style.color = '#ffc107';
  try {
    await fetch('/refresh', { method: 'POST' });
    pollStatus();
  } catch (e) {
    $('status').textContent = '○ server not found';
    $('status').style.color = '#ff4d2a';
  }
}

async function pollStatus() {
  try {
    const s = await fetch('/status?x=' + Date.now()).then((r) => r.json());
    $('status').textContent = s.running
      ? '◌ scanning…'
      : s.error
        ? '○ error'
        : '● ready';
    $('status').style.color = s.running
      ? '#ffc107'
      : s.error
        ? '#ff4d2a'
        : '#39ff14';
    if (s.running) setTimeout(pollStatus, 1500);
    else loadData();
  } catch {}
}

/* ─── Init ─── */
$('refreshBtn').onclick = refreshScan;
$('reloadBtn').onclick = loadData;
['search', 'sourceFilter', 'modelFilter'].forEach((id) =>
  $(id).addEventListener('input', render)
);

loadData();
setInterval(loadData, 60000);
