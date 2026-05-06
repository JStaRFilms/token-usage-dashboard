let summary=null, events=[];
const $=id=>document.getElementById(id);
const money=n=>n==null?'—':'$'+Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const num=n=>Number(n||0).toLocaleString();
const short=s=>(s||'').replace(/^.*[\\/]/,'');

async function loadData(){
  try{
    summary=await fetch('data/usage-summary.json?x='+Date.now()).then(r=>r.json());
    events=await fetch('data/usage-events.json?x='+Date.now()).then(r=>r.json());
    $('status').textContent='Updated '+new Date(summary.generated_at).toLocaleTimeString();
    populateFilters(); render();
  }catch(e){
    $('status').textContent='Sync Failed';
    console.error(e);
  }
}

function populateFilters(){
  const sources=[...new Set(events.map(e=>e.source))].sort();
  const models=[...new Set(events.map(e=>e.model))].sort();
  if ($('sourceFilter').options.length <= 1) {
    $('sourceFilter').innerHTML='<option value="all">All sources</option>'+sources.map(s=>`<option>${s}</option>`).join('');
    $('modelFilter').innerHTML='<option value="all">All models</option>'+models.map(s=>`<option>${s}</option>`).join('');
  }
}

function filteredEvents(){
  const q=$('search').value.toLowerCase(), src=$('sourceFilter').value, model=$('modelFilter').value;
  return events.filter(e=>(src==='all'||e.source===src)&&(model==='all'||e.model===model)&&(!q||JSON.stringify([e.model,e.source,e.session_id,e.file]).toLowerCase().includes(q)));
}

function sumRows(rows){return rows.reduce((a,e)=>{for(const k of ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'])a[k]=(a[k]||0)+(e[k]||0);a.estimated_cost_usd=(a.estimated_cost_usd||0)+(e.estimated_cost_usd||0);return a},{})}

function render(){
  const rows=filteredEvents(), totals=sumRows(rows);
  
  $('cards').innerHTML=[
    ['Estimated cost',money(totals.estimated_cost_usd),'priced rows only'],
    ['Total tokens',num(totals.total_tokens),'explicit usage'],
    ['Cached input',num(totals.cached_input_tokens),'discounted'],
    ['Output tokens',num(totals.output_tokens),'results'],
    ['Events',num(rows.length),`${new Set(rows.map(e=>e.session_id)).size} sessions`]
  ].map(c=>`
    <article class="stat-card">
      <div class="stat-label">${c[0]}</div>
      <div class="stat-value">${c[1]}</div>
      <div class="stat-hint">${c[2]}</div>
    </article>
  `).join('');

  renderBars('modelBars', group(rows,'model').sort((a,b)=>b.cost-a.cost).slice(0,12));
  renderBars('dayBars', group(rows,'day').sort((a,b)=>a.key.localeCompare(b.key)).slice(-30));
  
  renderTable('sourceTable', group(rows,'source').sort((a,b)=>b.cost-a.cost), ['Key', 'Cost', 'Tokens', 'Rows']);
  renderTable('modelTable', group(rows,'model').sort((a,b)=>b.cost-a.cost), ['Model', 'Cost', 'Total', 'Input', 'Cache', 'Output', 'Calls']);
  
  renderEvents(rows.sort((a,b)=>(b.estimated_cost_usd||0)-(a.estimated_cost_usd||0)).slice(0,120));
  renderPrices();

  $('caveats').innerHTML=(summary.caveats||[]).map(x=>`<li>${x}</li>`).join('');
  $('warnings').textContent=(summary.warnings||[]).join('\n')||'No system warnings.';
}

function group(rows,key){
  const m=new Map(); 
  for(const e of rows){
    const k=e[key]||'unknown'; 
    if(!m.has(k))m.set(k,{key:k,cost:0,input:0,cache:0,output:0,total:0,events:0}); 
    const r=m.get(k); 
    r.cost+=e.estimated_cost_usd||0; 
    r.input+=e.input_tokens||0; 
    r.cache+=e.cached_input_tokens||0; 
    r.output+=e.output_tokens||0; 
    r.total+=e.total_tokens||0; 
    r.events++;
  } 
  return [...m.values()];
}

function renderBars(id, rows){
  const max=Math.max(...rows.map(r=>r.cost), 0.01); 
  $(id).innerHTML=rows.map(r=>`
    <div class="bar-row">
      <div class="bar-key"><code>${r.key}</code></div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.max(1, (r.cost/max)*100)}%"></div>
      </div>
      <div class="bar-value">${money(r.cost)}</div>
    </div>
  `).join('')||'<p class="stat-hint">No data available</p>';
}

function renderTable(id, rows, headers){
  $(id).innerHTML=`
    <table>
      <thead>
        <tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${rows.map(r=>`
          <tr>
            <td><code>${r.key}</code></td>
            <td style="color:var(--cost);font-weight:600">${money(r.cost)}</td>
            ${headers.length > 4 ? `
              <td>${num(r.total)}</td>
              <td>${num(r.input)}</td>
              <td>${num(r.cache)}</td>
              <td>${num(r.output)}</td>
            ` : `<td>${num(r.total)}</td>`}
            <td>${num(r.events)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderEvents(rows){
  $('eventTable').innerHTML=`
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Source</th>
          <th>Model</th>
          <th>Cost</th>
          <th>Tokens</th>
          <th>File</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(e=>`
          <tr>
            <td style="white-space:nowrap">${e.day}</td>
            <td><span class="pill">${e.source}</span></td>
            <td><code>${e.model}</code></td>
            <td style="color:var(--cost);font-weight:600">${money(e.estimated_cost_usd)}</td>
            <td>${num(e.total_tokens)}</td>
            <td><div class="stat-hint" title="${e.file}">${short(e.file)}</div></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderPrices(){
  const p=summary.price_table||{}; 
  $('priceTable').innerHTML=`
    <table>
      <thead>
        <tr><th>Model</th><th>In</th><th>Cache</th><th>Out</th></tr>
      </thead>
      <tbody>
        ${Object.entries(p).map(([m,v])=>`
          <tr>
            <td><code title="${v.note||''}">${m}</code></td>
            <td>$${v.input}</td>
            <td>$${v.cached}</td>
            <td>$${v.output}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// Interactive background effect
document.addEventListener('mousemove', e => {
  const x = (e.clientX / window.innerWidth) * 100;
  const y = (e.clientY / window.innerHeight) * 100;
  document.body.style.setProperty('--x', x + '%');
  document.body.style.setProperty('--y', y + '%');
});

async function refreshScan(){
  $('status').textContent='Refreshing…';
  try{await fetch('/refresh',{method:'POST'}); pollStatus();}catch(e){$('status').textContent='Server not found';}
}

async function pollStatus(){
  try{
    const s=await fetch('/status?x='+Date.now()).then(r=>r.json()); 
    $('status').textContent=s.running?'Scanning…':(s.error?'Error':'Ready'); 
    if(s.running)setTimeout(pollStatus,1500); 
    else loadData();
  }catch{}
}

$('refreshBtn').onclick=refreshScan; 
$('reloadBtn').onclick=loadData; 
['search','sourceFilter','modelFilter'].forEach(id=>$(id).addEventListener('input',render));

loadData(); 
setInterval(loadData,60000);
