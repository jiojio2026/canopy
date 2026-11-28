const $ = (s) => document.querySelector(s);
let config = null;
let messages = [];
let ws = null;
let liveFrames = [];
let lastTraceRows = [];
let expandedTraceRowKey = null;
let signalDefinitions = [];
let selectedSignalFrame = null;
let signalContextFrame = null;
let signalEditorFrame = null;
let signalPreviewTimer = null;
let signalPreviewGeneration = 0;
let renderPending = false;
let latestDirty = false;
let traceRefreshing = false;
let traceRefreshQueued = false;
let traceRevision = 0;
let wsSubscribed = false;
let wsReconnectTimer = null;
const TRACE_RENDER_LIMIT = 1000;
const TRACE_SCROLL_LIMIT = 3000;

const TRACE_LAYOUT_KEY = 'canopy.trace.layout.v1';
const TRACE_OLD_WIDTHS = {seq:86,time:128,direction:72,channel:72,kind:78,id:94,signals:335,flags:95,data:440,frequency:156};
const TRACE_INSPECTOR_HEIGHT_KEY = 'canopy.trace.inspector.height.v1';
const TRACE_COLUMN_DEFS = [
  {key:'seq', label:'Seq', width:65, min:58},
  {key:'time', label:'时间', width:113, min:105},
  {key:'direction', label:'方向', width:62, min:55},
  {key:'channel', label:'通道', width:67, min:58},
  {key:'kind', label:'类型', width:72, min:62},
  {key:'id', label:'CAN ID', width:88, min:72},
  {key:'signals', label:'解析信号', width:260, min:165},
  {key:'flags', label:'标志', width:70, min:56},
  {key:'data', label:'数据 HEX', width:340, min:140},
  {key:'frequency', label:'Hz / 周期', width:125, min:96},
];
const TRACE_SORTABLE = new Set(TRACE_COLUMN_DEFS.map(c=>c.key));
let traceSort = {key:'seq', direction:'desc'};
let traceHeaderSignature = '';
function defaultTraceLayout() {
  return {density:'compact', columns:TRACE_COLUMN_DEFS.map(c=>({
    key:c.key, visible:true, width:c.width,
  }))};
}
function loadTraceLayout() {
  const fallback = defaultTraceLayout();
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const saved = JSON.parse(localStorage.getItem(TRACE_LAYOUT_KEY) || 'null');
    if (!saved || !Array.isArray(saved.columns)) return fallback;
    const byKey = new Map(saved.columns.map(c => [c.key,c]));
    const order = saved.columns.map(c=>c.key).filter((k,i,a)=>
      TRACE_COLUMN_DEFS.some(d=>d.key===k) && a.indexOf(k)===i);
    const columns = [...order, ...TRACE_COLUMN_DEFS.map(d=>d.key).filter(k=>!order.includes(k))]
      .map(key=>{
        const definition = TRACE_COLUMN_DEFS.find(d=>d.key===key);
        const raw = byKey.get(key) || {};
        const width = Number(raw.width);
        // Migrate v0.5.0 default widths while preserving user-resized columns.
        const targetWidth = Number.isFinite(width) && width !== TRACE_OLD_WIDTHS[key] ? width : definition.width;
        return {key, visible:raw.visible !== false,
          width:Math.max(definition.min,Math.min(900,Math.round(targetWidth)))};
      });
    if (!columns.some(c=>c.visible)) columns.find(c=>c.key==='id').visible = true;
    return {density:saved.density==='standard'?'standard':'compact',columns};
  } catch { return fallback; }
}
let traceLayout = loadTraceLayout();
function persistTraceLayout() {
  try {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(TRACE_LAYOUT_KEY,JSON.stringify(traceLayout));
  } catch { /* Private mode or storage quota: settings still apply this session. */ }
}
function visibleTraceColumns() {
  return traceLayout.columns.filter(c=>c.visible);
}
function renderTraceColumnOptions() {
  const target = $('#traceColumnOptions');
  if (!target) return;
  target.innerHTML = traceLayout.columns.map((c,i)=>{
    const definition = TRACE_COLUMN_DEFS.find(d=>d.key===c.key);
    return '<div class="trace-column-option" data-column-key="' + c.key + '">' +
      '<label><input type="checkbox" data-trace-visible="' + c.key + '"' +
      (c.visible?' checked':'') + '> ' + esc(definition.label) + '</label>' +
      '<div class="trace-column-move">' +
      '<button type="button" data-trace-move="' + c.key + '" data-delta="-1" '+
      (i===0?'disabled':'')+' aria-label="上移 ' + esc(definition.label) + '">↑</button>' +
      '<button type="button" data-trace-move="' + c.key + '" data-delta="1" '+
      (i===traceLayout.columns.length-1?'disabled':'')+' aria-label="下移 ' + esc(definition.label) + '">↓</button>' +
      '</div></div>';
  }).join('');
}
function traceColumnChanged() {
  traceHeaderSignature = '';
  persistTraceLayout();
  renderTraceColumnOptions();
  renderTrace(lastTraceRows);
}
function setTraceColumnVisible(key,visible) {
  const column = traceLayout.columns.find(c=>c.key===key);
  if (!column) return;
  if (!visible && visibleTraceColumns().length===1 && column.visible) {
    toast('至少保留一列',true);
    renderTraceColumnOptions();
    return;
  }
  column.visible=Boolean(visible);
  traceColumnChanged();
}
function moveTraceColumn(key,delta) {
  const index = traceLayout.columns.findIndex(c=>c.key===key);
  const next = index+delta;
  if (index<0||next<0||next>=traceLayout.columns.length) return;
  const [column] = traceLayout.columns.splice(index,1);
  traceLayout.columns.splice(next,0,column);
  traceColumnChanged();
}
function setTraceDensity(mode) {
  traceLayout.density = mode==='standard'?'standard':'compact';
  const panel = $('#trace');
  panel.classList.toggle('trace-compact',traceLayout.density==='compact');
  panel.classList.toggle('trace-standard',traceLayout.density==='standard');
  $('#traceDensity').value=traceLayout.density;
  persistTraceLayout();
}
function resetTraceLayout() {
  traceLayout=defaultTraceLayout();
  traceSort={key:'seq',direction:'desc'};
  setTraceDensity(traceLayout.density);
  traceColumnChanged();
}
function traceColumnDefinition(key) {
  return TRACE_COLUMN_DEFS.find(d=>d.key===key);
}
function renderTraceHeader() {
  const columns = visibleTraceColumns();
  const signature=JSON.stringify([columns,traceSort]);
  if (signature===traceHeaderSignature) return;
  traceHeaderSignature=signature;
  $('#traceColgroup').innerHTML=columns.map(c=>
    '<col data-trace-col="'+c.key+'" style="width:'+c.width+'px">').join('');
  $('#traceTable').style.width=columns.reduce((total,c)=>total+c.width,0)+'px';
  $('#traceHeaderRow').innerHTML=columns.map(c=>{
    const definition=traceColumnDefinition(c.key);
    const direction=traceSort.key===c.key?(traceSort.direction==='asc'?' ▲':' ▼'):'';
    return '<th scope="col" data-trace-col="'+c.key+'" ' +
      'aria-sort="'+(traceSort.key===c.key?(traceSort.direction==='asc'?'ascending':'descending'):'none')+'">' +
      '<button type="button" class="trace-header-sort" data-trace-sort="'+c.key+
      '" title="点击排序">'+esc(definition.label)+'<span class="trace-sort-arrow">'+direction+'</span></button>' +
      '<span class="trace-column-resizer" data-trace-resize="'+c.key+
      '" role="separator" aria-label="调整 '+esc(definition.label)+' 列宽" tabindex="0"></span></th>';
  }).join('');
}
function traceSortValue(frame,key) {
  switch(key) {
    case 'seq': return Number(frame.seq)||0;
    case 'time': return Number(frame.timestamp_ns)||0;
    case 'direction': return frame.direction||'';
    case 'channel': return Number(frame.channel)||0;
    case 'kind': return frame.frame_kind||'';
    case 'id': return Number(frame.can_id)||0;
    case 'signals': return (frame.decoded_signals||[])[0]?.name||'';
    case 'flags': return [frame.extended,frame.remote,frame.brs,frame.esi].map(x=>x?1:0).join('');
    case 'data': return frame.data_hex||'';
    case 'frequency': return Number(frame.frequency_hz)||0;
    default: return 0;
  }
}
function filteredSortedTraceFrames(frames) {
  const filter=$('#traceFilterId')?.value.trim()||'';
  const channel=$('#traceFilterChannel')?.value||'all';
  const direction=$('#traceFilterDirection')?.value||'all';
  const isHex=/^0x[0-9a-f]+$/i.test(filter);
  const isDecimal=/^[0-9]+$/.test(filter);
  const id=filter?(isHex?parseInt(filter,16):isDecimal?Number(filter):NaN):null;
  const visible=frames.filter(frame=>
    (id===null||frame.can_id===id) &&
    (channel==='all'||String(frame.channel)===channel) &&
    (direction==='all'||frame.direction===direction));
  const factor=traceSort.direction==='asc'?1:-1;
  // Do not mutate the rolling buffer; it must stay in time order.
  visible.sort((a,b)=>{
    const x=traceSortValue(a,traceSort.key),y=traceSortValue(b,traceSort.key);
    let cmp=(typeof x==='number'&&typeof y==='number')?x-y:String(x).localeCompare(String(y));
    if (cmp===0) cmp=(Number(a.seq)||0)-(Number(b.seq)||0);
    return cmp*factor;
  });
  return {visible,filterInvalid:Boolean(filter)&&!Number.isFinite(id)};
}
function changeTraceSort(key) {
  if (!TRACE_SORTABLE.has(key)) return;
  traceSort = traceSort.key===key
    ? {key,direction:traceSort.direction==='asc'?'desc':'asc'}
    : {key,direction:key==='seq'||key==='time'||key==='frequency'?'desc':'asc'};
  traceHeaderSignature='';
  renderTrace(lastTraceRows);
}
function applyTraceFilters() { renderTrace(lastTraceRows); }
function onTraceModeChange() {
  expandedTraceRowKey=null;
  void refreshTrace(true);
}
function initTraceLayoutControls() {
  setTraceDensity(traceLayout.density);
  renderTraceColumnOptions();
  $('#traceDensity').addEventListener('change',e=>setTraceDensity(e.target.value));
  for (const id of ['traceFilterId','traceFilterChannel','traceFilterDirection'])
    $('#'+id).addEventListener(id==='traceFilterId'?'input':'change',applyTraceFilters);
  $('#traceColumnOptions').addEventListener('change',e=>{
    if (e.target.matches('[data-trace-visible]'))
      setTraceColumnVisible(e.target.dataset.traceVisible,e.target.checked);
  });
  $('#traceColumnOptions').addEventListener('click',e=>{
    const btn=e.target.closest('[data-trace-move]');
    if (btn) moveTraceColumn(btn.dataset.traceMove,Number(btn.dataset.delta));
  });
  $('#traceResetLayout').addEventListener('click',resetTraceLayout);
  $('#traceHeaderRow').addEventListener('click',e=>{
    const btn=e.target.closest('[data-trace-sort]');
    if (btn) changeTraceSort(btn.dataset.traceSort);
  });
  let dragging=null;
  const dragUpdate=e=>{
    if (!dragging) return;
    const column=traceLayout.columns.find(c=>c.key===dragging.key);
    const def=traceColumnDefinition(dragging.key);
    if (!column||!def) return;
    column.width=Math.max(def.min,Math.min(900,dragging.width+e.clientX-dragging.x));
    const col=$('#traceColgroup').querySelector('[data-trace-col="'+column.key+'"]');
    if (col) col.style.width=column.width+'px';
    $('#traceTable').style.width=visibleTraceColumns().reduce((total,c)=>total+c.width,0)+'px';
  };
  const dragEnd=()=>{
    if (!dragging) return;
    dragging=null;
    document.removeEventListener('pointermove',dragUpdate);
    document.removeEventListener('pointerup',dragEnd);
    document.removeEventListener('pointercancel',dragEnd);
    traceHeaderSignature=''; // Width is reflected on next snapshot.
    persistTraceLayout();
  };
  $('#traceHeaderRow').addEventListener('pointerdown',e=>{
    const grip=e.target.closest('[data-trace-resize]');
    if (!grip||e.button!==0) return;
    const column=traceLayout.columns.find(c=>c.key===grip.dataset.traceResize);
    if (!column) return;
    e.preventDefault();
    e.stopPropagation();
    dragging={key:column.key,x:e.clientX,width:column.width};
    document.addEventListener('pointermove',dragUpdate);
    document.addEventListener('pointerup',dragEnd);
    document.addEventListener('pointercancel',dragEnd);
  });
  $('#traceHeaderRow').addEventListener('keydown',e=>{
    const grip=e.target.closest('[data-trace-resize]');
    if (!grip||!['ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const column=traceLayout.columns.find(c=>c.key===grip.dataset.traceResize);
    const def=traceColumnDefinition(column?.key);
    if (!column||!def) return;
    column.width=Math.max(def.min,Math.min(900,column.width+(e.key==='ArrowRight'?20:-20)));
    traceColumnChanged();
  });
}


function traceIsVisible() {
  return !document.hidden && $('#trace').classList.contains('active');
}
function syncTraceSubscription() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const wantFrames = traceIsVisible();
  if (wantFrames === wsSubscribed) return;
  ws.send(wantFrames ? 'subscribe' : 'unsubscribe');
  wsSubscribed = wantFrames;
}
document.addEventListener('visibilitychange', () => {
  syncTraceSubscription();
  if (traceIsVisible()) void refreshTrace(true);
});

function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = String(msg);
  el.style.background = err ? '#991b1b' : '#111827';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}
function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
async function api(url, opt = {}) {
  const {timeoutMs = 15000, ...fetchOpt} = opt;
  if (fetchOpt.body && typeof fetchOpt.body !== 'string') {
    fetchOpt.headers = {'Content-Type': 'application/json', ...(fetchOpt.headers || {})};
    fetchOpt.body = JSON.stringify(fetchOpt.body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  fetchOpt.signal = controller.signal;
  try {
    const r = await fetch(url, fetchOpt);
    const j = await r.json().catch(() => ({ok: false, message: r.statusText}));
    if (!r.ok || j.ok === false) throw new Error(j.detail || j.message || `请求失败 (${r.status})`);
    return j.data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`请求超过 ${Math.round(timeoutMs/1000)} 秒，已停止等待；后端状态仍可通过“刷新状态”查看`);
    throw e;
  } finally { clearTimeout(timer); }
}

function setDeviceAction(state, message, details = '') {
  const el = $('#deviceAction');
  if (!el) return;
  el.className = `operation ${state || 'idle'}`;
  const text = [message || '等待操作', details].filter(Boolean).join('\n');
  el.innerHTML = `<b>设备操作状态</b><span>${esc(text)}</span>`;
}

function operationText(op) {
  if (!op) return null;
  const extra = op.error || (op.results ? `设备类型返回值：${JSON.stringify(op.results)}` : '');
  return {state: op.state || 'idle', message: op.stage || '未知阶段', details: extra};
}
function hex(v) { return '0x' + Number(v).toString(16).toUpperCase(); }
function parseNum(s) {
  const text=String(s).trim();
  const n=Number(text.toLowerCase().startsWith('0x') ? parseInt(text,16) : parseInt(text,10));
  if (!Number.isFinite(n)) throw new Error(`无效数字: ${s}`);
  return n;
}
function parseData(s) {
  if (!String(s).trim()) return [];
  return String(s).trim().split(/[\s,]+/).map(x => {
    const n=parseInt(x,16);
    if (!Number.isFinite(n) || n<0 || n>255) throw new Error(`无效数据字节: ${x}`);
    return n;
  });
}
function makeKey() { return globalThis.crypto?.randomUUID?.() || `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

let traceNavExpanded = false;
function updateTraceNavigation() {
  const active = $('#trace').classList.contains('active');
  const collapsed = active && !traceNavExpanded;
  document.querySelector('.app-shell').classList.toggle('nav-collapsed', collapsed);
  const button = $('#navToggleBtn');
  button.hidden = !active;
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
}
$('#navToggleBtn').addEventListener('click', () => {
  traceNavExpanded = !traceNavExpanded;
  updateTraceNavigation();
});
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab,.panel').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#' + b.dataset.tab).classList.add('active');
  const label = b.querySelector('span:last-child')?.textContent || b.textContent.trim();
  const pageName = $('#pageName');
  if (pageName) pageName.textContent = label;
  updateTraceNavigation();
  if (b.dataset.tab === 'trace') void refreshTrace(true);
  syncTraceSubscription();
});

function canConfigCard(i) {
  return `<article class="config-card"><div class="section-head"><h3>CAN${i}</h3><label class="switch-line"><input type="checkbox" id="cfgCan${i}Enabled">启用</label></div>
    <div class="config-fields">
      <label>协议<select id="cfgCan${i}Protocol"><option value="canfd">CAN FD</option><option value="can">Classic CAN</option></select></label>
      <label>仲裁波特率 bit/s<input id="cfgCan${i}Arb" type="number" min="40000" max="1000000" step="1000"></label>
      <label>数据波特率 bit/s<input id="cfgCan${i}Data" type="number" min="1000000" max="5000000" step="1000"></label>
      <label>CAN FD 标准<select id="cfgCan${i}Std"><option value="iso">ISO</option><option value="non_iso">Non-ISO</option></select></label>
      <label>工作模式<select id="cfgCan${i}Mode"><option value="normal">正常收发</option><option value="listen_only">只听</option></select></label>
      <label>发送超时 ms<input id="cfgCan${i}Timeout" type="number" min="0" max="10000"></label>
      <label class="switch-line"><input type="checkbox" id="cfgCan${i}Res">接入内置 120Ω</label>
    </div></article>`;
}
function linConfigCard(i) {
  return `<article class="config-card"><div class="section-head"><h3>LIN${i}</h3><label class="switch-line"><input type="checkbox" id="cfgLin${i}Enabled">启用</label></div>
    <div class="config-fields">
      <label>模式<select id="cfgLin${i}Mode"><option value="master">主站</option><option value="slave">从站</option></select></label>
      <label>校验<select id="cfgLin${i}Checksum"><option value="auto">自动</option><option value="classic">经典</option><option value="enhanced">增强</option></select></label>
      <label>波特率 bit/s<input id="cfgLin${i}Baud" type="number" min="2400" max="20000"></label>
    </div></article>`;
}
$('#canConfigCards').innerHTML=[0,1].map(canConfigCard).join('');
$('#linConfigCards').innerHTML=[0,1].map(linConfigCard).join('');

async function loadConfig() {
  config = await api('/api/config');
  syncConfigForm();
  renderChannels();
}
function syncConfigForm() {
  if (!config) return;
  $('#cfgDriver').value=config.driver;
  $('#cfgDeviceType').value=config.device_type;
  $('#cfgDeviceIndex').value=config.device_index;
  config.channels.forEach((c,i) => {
    $(`#cfgCan${i}Enabled`).checked=c.enabled;
    $(`#cfgCan${i}Protocol`).value=c.protocol;
    $(`#cfgCan${i}Arb`).value=c.arbitration_bitrate;
    $(`#cfgCan${i}Data`).value=c.data_bitrate;
    $(`#cfgCan${i}Std`).value=c.canfd_standard;
    $(`#cfgCan${i}Mode`).value=c.mode;
    $(`#cfgCan${i}Timeout`).value=c.tx_timeout_ms;
    $(`#cfgCan${i}Res`).checked=c.resistance_120ohm;
    updateCanConfigState(i);
  });
  config.lin_channels.forEach((c,i) => {
    $(`#cfgLin${i}Enabled`).checked=c.enabled;
    $(`#cfgLin${i}Mode`).value=c.mode;
    $(`#cfgLin${i}Checksum`).value=c.checksum;
    $(`#cfgLin${i}Baud`).value=c.baudrate;
  });
  $('#configJson').value=JSON.stringify(config,null,2);
}
function buildConfigFromForm() {
  const channels=[0,1].map(i => ({
    enabled:$(`#cfgCan${i}Enabled`).checked,
    protocol:$(`#cfgCan${i}Protocol`).value,
    arbitration_bitrate:+$(`#cfgCan${i}Arb`).value,
    data_bitrate:+$(`#cfgCan${i}Data`).value,
    canfd_standard:$(`#cfgCan${i}Protocol`).value==='can' ? 'iso' : $(`#cfgCan${i}Std`).value,
    mode:$(`#cfgCan${i}Mode`).value,
    resistance_120ohm:$(`#cfgCan${i}Res`).checked,
    tx_timeout_ms:+$(`#cfgCan${i}Timeout`).value,
    receive_merge:false
  }));
  const lin_channels=[0,1].map(i => ({
    enabled:$(`#cfgLin${i}Enabled`).checked,
    mode:$(`#cfgLin${i}Mode`).value,
    checksum:$(`#cfgLin${i}Checksum`).value,
    baudrate:+$(`#cfgLin${i}Baud`).value,
    max_length:8
  }));
  return {driver:$('#cfgDriver').value,device_type:+$('#cfgDeviceType').value,device_index:+$('#cfgDeviceIndex').value,channels,lin_channels};
}
function updateCanConfigState(i) {
  const fd=$(`#cfgCan${i}Protocol`).value==='canfd';
  $(`#cfgCan${i}Data`).disabled=!fd;
  $(`#cfgCan${i}Std`).disabled=!fd;
}
[0,1].forEach(i => $(`#cfgCan${i}Protocol`).addEventListener('change',() => updateCanConfigState(i)));
function showConfig() { syncConfigForm(); $('#configDialog').showModal(); }
function copyCan0ToCan1() {
  ['Enabled','Protocol','Arb','Data','Std','Mode','Timeout','Res'].forEach(name => {
    const a=$(`#cfgCan0${name}`), b=$(`#cfgCan1${name}`);
    if (a.type==='checkbox') b.checked=a.checked; else b.value=a.value;
  });
  updateCanConfigState(1);
}
function loadConfigFormFromJson() {
  try { config=JSON.parse($('#configJson').value); syncConfigForm(); toast('JSON 已载入表单'); }
  catch(e) { toast(e.message,true); }
}
async function saveConfig() {
  try {
    const body=buildConfigFromForm();
    config=await api('/api/config',{method:'PUT',body});
    syncConfigForm(); renderChannels(); $('#configDialog').close(); toast('配置已保存，重新打开设备后生效');
  } catch(e) { toast(e.message,true); }
}

async function loadStatus() {
  try {
    const s = await api('/api/device/status');
    const badge = $('#deviceBadge');
    badge.textContent = s.opened ? (s.online ? '已连接' : '已打开/离线') : '未连接';
    badge.className = 'badge ' + (s.opened ? 'on' : 'off');
    $('#openDeviceBtn').disabled = Boolean(s.opened);
    $('#closeDeviceBtn').disabled = !s.opened;
    $('#deviceInfo').innerHTML = Object.entries({
      驱动:s.driver, 动态库:s.library || '-', 硬件:s.device_info?.hardware || '-',
      序列号:s.device_info?.serial || '-', 固件:s.device_info?.firmware_version || '-',
      CAN通道:s.can_started?.join(', ') || '-', LIN通道:s.lin_started?.join(', ') || '-'
    }).map(([k,v]) => `<b>${esc(k)}</b><span title="${esc(v)}">${esc(v)}</span>`).join('');
    $('#capability').textContent=JSON.stringify({capabilities:s.capabilities,probe:s.capability_probe},null,2);
    const op=operationText(s.operation);
    if (op) setDeviceAction(op.state,op.message,op.details);
  } catch(e) { toast(e.message,true); setDeviceAction('failed','状态读取失败',e.message); }
}

async function runPreflight() {
  setDeviceAction('running','正在检查动态库、USB 枚举和设备节点权限');
  try {
    const result=await api('/api/device/preflight',{timeoutMs:8000});
    const out=$('#preflightResult'); out.hidden=false; out.textContent=JSON.stringify(result,null,2);
    const state=result.ready ? 'success' : 'failed';
    setDeviceAction(state,result.usb?.summary || '诊断完成',result.library?.ok ? `动态库：${result.library.path}` : `动态库错误：${result.library?.error || '未知'}`);
    toast(result.ready ? '连接诊断通过' : '连接诊断未通过，请查看设备区详细结果',!result.ready);
  } catch(e) { setDeviceAction('failed','连接诊断失败',e.message); toast(e.message,true); }
}

async function openDevice() {
  const btn=$('#openDeviceBtn');
  btn.disabled=true; btn.dataset.label=btn.textContent; btn.textContent='正在打开…';
  setDeviceAction('running','开始打开设备','正在执行 USB 预检和 VCI_OpenDevice');
  try {
    const result=await api('/api/device/open',{method:'POST',timeoutMs:18000});
    const failures=(result.hardware_periodic_sync || []).filter(x => !x.ok);
    const msg=failures.length ? `设备已打开；${failures.length} 条硬件周期报文下发失败` : '设备已打开';
    setDeviceAction(failures.length ? 'failed' : 'success',msg,`设备类型 ${result.device_type}；CAN 通道 ${(result.can_started||[]).join(', ')}`);
    toast(msg, failures.length>0);
  } catch(e) {
    setDeviceAction('failed','打开设备失败',e.message);
    const out=$('#preflightResult'); out.hidden=false;
    try { out.textContent=JSON.stringify(await api('/api/device/preflight',{timeoutMs:5000}),null,2); } catch {}
    toast(e.message,true);
  } finally {
    btn.disabled=false; btn.textContent=btn.dataset.label || '打开设备';
    await loadStatus();
  }
}
async function closeDevice() {
  const btn=$('#closeDeviceBtn'); btn.disabled=true;
  try { await api('/api/device/close',{method:'POST',timeoutMs:8000}); setDeviceAction('idle','设备已关闭'); toast('设备已关闭'); await loadStatus(); }
  catch(e) { setDeviceAction('failed','关闭设备失败',e.message); toast(e.message,true); }
  finally { btn.disabled=false; }
}

function renderChannels() {
  if (!config) return;
  $('#channelCards').innerHTML=config.channels.map((c,i) => `<article class="channel-card"><div class="section-head"><div><div class="eyebrow">BUS INTERFACE</div><h2>CAN${i}</h2></div><span class="tag ${c.enabled ? 'tag-online' : 'tag-muted'}">${c.enabled ? esc(c.protocol.toUpperCase()) : '禁用'}</span></div><div class="kv"><b>仲裁速率</b><span>${Number(c.arbitration_bitrate).toLocaleString()} bit/s</span><b>数据速率</b><span>${c.protocol==='canfd' ? Number(c.data_bitrate).toLocaleString()+' bit/s' : '-'}</span><b>标准</b><span>${esc(c.canfd_standard)}</span><b>模式</b><span>${esc(c.mode)}</span><b>内置 120Ω</b><span>${c.resistance_120ohm ? '开启' : '关闭'}</span></div><div class="actions"><button onclick="diagnose(${i})">诊断</button><button class="secondary" onclick="resetCh(${i})">复位</button><button class="secondary" onclick="clearCh(${i})">清缓冲</button><button class="secondary" onclick="clearHwPeriodic(${i})">清硬件周期</button></div><pre id="diag${i}"></pre></article>`).join('');
}
async function diagnose(i) { try { $(`#diag${i}`).textContent=JSON.stringify(await api(`/api/device/diagnostics/${i}`),null,2); } catch(e) { toast(e.message,true); } }
async function resetCh(i) { try { await api(`/api/device/reset/${i}`,{method:'POST'}); toast(`CAN${i} 已复位`); } catch(e) { toast(e.message,true); } }
async function clearCh(i) { try { await api(`/api/device/clear/${i}`,{method:'POST'}); toast(`CAN${i} 缓冲已清空`); } catch(e) { toast(e.message,true); } }
async function clearHwPeriodic(i) { try { await api(`/api/hardware-periodic/clear/${i}`,{method:'POST'}); toast(`CAN${i} 硬件周期槽位已清空`); } catch(e) { toast(e.message,true); } }

function updateMessageFlags() {
  const fd=$('#msgKind').value==='canfd';
  $('#msgRemote').disabled=fd; if (fd) $('#msgRemote').checked=false;
  $('#msgBrs').disabled=!fd; $('#msgEsi').disabled=!fd;
  if (!fd) { $('#msgBrs').checked=false; $('#msgEsi').checked=false; }
}
$('#msgKind').addEventListener('change',updateMessageFlags);
function resetMessageForm() {
  $('#messageForm').reset();
  $('#msgKey').value=''; $('#msgName').value='测试报文'; $('#msgNode').value='默认节点';
  $('#msgId').value='0x123'; $('#msgData').value='01 02 03 04'; $('#msgPeriod').value='100';
  $('#msgHwIndex').value='0'; $('#msgHwDelay').value='0'; updateMessageFlags();
}
$('#messageForm').onsubmit=async e => {
  e.preventDefault();
  try {
    const body={
      key:$('#msgKey').value || makeKey(), name:$('#msgName').value, node:$('#msgNode').value,
      channel:+$('#msgChannel').value, frame_kind:$('#msgKind').value, can_id:parseNum($('#msgId').value),
      extended:$('#msgExtended').checked, remote:$('#msgRemote').checked, brs:$('#msgBrs').checked,
      esi:$('#msgEsi').checked, tx_mode:$('#msgTxMode').value, data:parseData($('#msgData').value),
      enabled:$('#msgEnabled').checked, period_ms:$('#msgPeriod').value ? +$('#msgPeriod').value : null,
      scheduler:$('#msgScheduler').value,
      hardware_index:$('#msgScheduler').value==='hardware' ? +$('#msgHwIndex').value : null,
      hardware_start_delay_ms:+$('#msgHwDelay').value || 0
    };
    const saved=await api('/api/messages',{method:'POST',body});
    toast(saved._hardware_warning || '报文已保存',Boolean(saved._hardware_warning)); await loadMessages();
  } catch(e) { toast(e.message,true); }
};
async function loadMessages() {
  messages=await api('/api/messages');
  const nodes=[...new Set(messages.map(x => x.node))];
  $('#nodeActions').innerHTML='<div class="nodebar">'+nodes.map(n => `<span class="tag">${esc(n)}</span><button onclick='nodeEnable(${JSON.stringify(n)},true)'>启用</button><button class="secondary" onclick='nodeEnable(${JSON.stringify(n)},false)'>停用</button>`).join('')+'</div>';
  $('#messageRows').innerHTML=messages.map(m => `<tr><td><b>${esc(m.node)}</b> / ${esc(m.name)}</td><td>CAN${m.channel}</td><td>${hex(m.can_id)}</td><td>${esc(m.frame_kind)}${m.extended?' EXT':''}${m.brs?' BRS':''}${m.esi?' ESI':''}</td><td>${(m.data||[]).map(x => x.toString(16).padStart(2,'0')).join(' ').toUpperCase()}</td><td>${m.enabled ? `${m.period_ms} ms / ${esc(m.scheduler)}${m.scheduler==='hardware' ? ` #${m.hardware_index}`:''}` : '关闭'}</td><td><button onclick='sendSaved(${JSON.stringify(m.key)})'>发送</button> <button class="secondary" onclick='editMsg(${JSON.stringify(m.key)})'>编辑</button> <button class="danger" onclick='delMsg(${JSON.stringify(m.key)})'>删除</button></td></tr>`).join('');
}
function editMsg(k) {
  const m=messages.find(x => x.key===k); if (!m) return;
  $('#msgKey').value=m.key; $('#msgName').value=m.name; $('#msgNode').value=m.node; $('#msgChannel').value=m.channel;
  $('#msgKind').value=m.frame_kind; $('#msgId').value=hex(m.can_id); $('#msgData').value=(m.data||[]).map(x => x.toString(16).padStart(2,'0')).join(' ');
  $('#msgExtended').checked=m.extended; $('#msgRemote').checked=m.remote; $('#msgBrs').checked=m.brs; $('#msgEsi').checked=m.esi;
  $('#msgTxMode').value=m.tx_mode; $('#msgScheduler').value=m.scheduler; $('#msgPeriod').value=m.period_ms ?? '';
  $('#msgHwIndex').value=m.hardware_index ?? 0; $('#msgHwDelay').value=m.hardware_start_delay_ms ?? 0; $('#msgEnabled').checked=m.enabled;
  updateMessageFlags(); window.scrollTo({top:0,behavior:'smooth'});
}
async function sendSaved(k) { try { await api(`/api/messages/${encodeURIComponent(k)}/send`,{method:'POST'}); toast('发送成功'); } catch(e) { toast(e.message,true); } }
async function delMsg(k) { try { const r=await api(`/api/messages/${encodeURIComponent(k)}`,{method:'DELETE'}); toast(r.warning ? `已删除；${r.warning}` : '已删除',Boolean(r.warning)); await loadMessages(); } catch(e) { toast(e.message,true); } }
async function nodeEnable(n,b) { try { await api(`/api/nodes/${encodeURIComponent(n)}/enable/${b}`,{method:'POST'}); await loadMessages(); } catch(e) { toast(e.message,true); } }

async function refreshTrace(force = true) {
  // At most one HTTP snapshot; queue explicit refresh/mode changes only.
  if (traceRefreshing) {
    if (force) traceRefreshQueued = true;
    return;
  }
  traceRefreshing = true;
  const mode = $('#traceMode').value;
  const revision = traceRevision;
  latestDirty = false; // Frames received mid-request still require a later refresh.
  try {
    const rows = await api('/api/trace?mode=' + encodeURIComponent(mode) + '&limit=' + TRACE_RENDER_LIMIT);
    if (revision !== traceRevision || mode !== $('#traceMode').value) return;
    if (mode === 'scroll') liveFrames = rows.slice(-TRACE_SCROLL_LIMIT);
    if (traceIsVisible()) renderTrace(rows);
  } catch (e) {
    if (force) toast(e.message, true);
    else latestDirty = true;
  } finally {
    traceRefreshing = false;
    if (traceRefreshQueued) {
      traceRefreshQueued = false;
      if (traceIsVisible()) void refreshTrace(true);
    }
  }
}

function signalIdentity(frame) {
  if (!frame) return '';
  return [frame.channel, frame.frame_kind, frame.can_id, Boolean(frame.extended)].join(':');
}
function signalMatches(frame, definition) {
  return signalIdentity(frame) === signalIdentity(definition);
}
function formatSignalNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString(undefined, {maximumFractionDigits: 6});
}
function signalDisplayText(signal) {
  return signal.error ? '解析失败' :
    signal.display !== null && signal.display !== undefined
      ? String(signal.display) : formatSignalNumber(signal.value);
}
function isActiveBitfield(signal) {
  return signal.display_mode === 'bitfield' && Array.isArray(signal.active_flags) && signal.active_flags.length > 0;
}
function traceRowKey(frame) {
  // Latest mode keeps an expanded message open as its sequence increments;
  // scroll mode expands exactly one historical frame.
  return $('#traceMode').value === 'latest'
    ? 'latest:' + [frame.channel, frame.frame_kind, frame.can_id, Boolean(frame.extended),
      frame.direction, Boolean(frame.remote), Boolean(frame.brs)].join(':')
    : 'scroll:' + frame.seq;
}
function decodedSignalSummary(frame) {
  const signals = frame.decoded_signals || [];
  if (!signals.length) return '<span class="signal-summary-empty">—</span>';
  const summary = signals.slice(0, 2).map(s => {
    const value = signalDisplayText(s);
    return '<span class="signal-summary-entry' + (s.error ? ' signal-has-error' : isActiveBitfield(s) ? ' signal-flag-active' : '') + '">' +
      esc(s.name) + '=' + esc(value) + (s.unit ? ' ' + esc(s.unit) : '') + '</span>';
  }).join('');
  const expanded = expandedTraceRowKey === traceRowKey(frame);
  return '<div class="signal-summary-list">' + summary + '</div>' +
    (signals.length > 2
      ? '<button type="button" class="trace-expand-button" data-trace-expand aria-expanded="' +
        (expanded ? 'true' : 'false') + '">' + (expanded ? '收起' : '展开全部') +
        ' ' + signals.length + ' 项 <span aria-hidden="true">' + (expanded ? '▴' : '▾') + '</span></button>'
      : '');
}
function renderExpandedTraceSignals(frame) {
  const signals = frame.decoded_signals || [];
  if (!signals.length) return '';
  const rows = signals.map(s=>{
    const status=s.error ? '解码错误' : isActiveBitfield(s) ? '故障标志' :
      s.display_mode==='enum' ? '枚举' : s.display_mode==='bitfield' ? '无活动故障' : '数值';
    return '<tr class="trace-details-signal'+(s.error?' signal-has-error':'')+
      (isActiveBitfield(s)?' signal-flag-active':'')+'">' +
      '<td>'+esc(s.name)+'</td>' +
      '<td class="trace-detail-value" title="'+esc(signalDisplayText(s))+'">'+esc(signalDisplayText(s))+'</td>' +
      '<td class="cell-mono">'+esc(s.raw ?? '—')+'</td>' +
      '<td class="cell-mono">'+esc(s.raw_hex ?? '—')+'</td>' +
      '<td>'+esc(s.unit || '—')+'</td>' +
      '<td>'+esc(s.error || status)+'</td></tr>';
  }).join('');
  return '<tr class="trace-details-row"><td colspan="'+visibleTraceColumns().length+'">' +
    '<div class="trace-details"><div class="trace-details-head"><strong>CAN'+
    esc(frame.channel)+' / '+hex(frame.can_id)+' · 全部解析信号（'+signals.length+'）</strong>'+
    '<button type="button" class="secondary" data-trace-collapse>收起</button></div>'+
    '<div class="trace-details-table-wrap"><table class="trace-details-table"><thead><tr>'+
    '<th>信号名称</th><th>解析值 / 状态</th><th>Raw</th><th>Hex</th><th>单位</th><th>类型 / 故障</th>'+
    '</tr></thead><tbody>'+rows+'</tbody></table></div></div></td></tr>';
}
function toggleTraceSignalDetails(frame) {
  if (!frame || !(frame.decoded_signals || []).length) return;
  const key = traceRowKey(frame);
  expandedTraceRowKey = expandedTraceRowKey === key ? null : key;
  renderTrace(lastTraceRows);
}
function collapseTraceSignalDetails() {
  if (expandedTraceRowKey === null) return;
  expandedTraceRowKey = null;
  renderTrace(lastTraceRows);
}
function selectTraceFrame(frame) {
  if (!frame) return;
  selectedSignalFrame = frame;
  $('#signalInspector').hidden = false;
  $('#tracePaneDivider').hidden = false;
  renderSignalInspector();
}
function hideSignalInspector() {
  $('#signalInspector').hidden = true;
  $('#tracePaneDivider').hidden = true;
  selectedSignalFrame = null;
}
function renderSignalInspector() {
  if (!selectedSignalFrame || $('#signalInspector').hidden) return;
  const frame = selectedSignalFrame;
  $('#signalInspectorTitle').textContent = 'CAN' + frame.channel + ' / ' + hex(frame.can_id);
  $('#signalInspectorMeta').textContent =
    (frame.frame_kind === 'canfd' ? 'CAN FD' : 'Classic CAN') +
    (frame.extended ? ' / 扩展帧' : ' / 标准帧') +
    ' · Seq ' + frame.seq + ' · 仅显示用户定义的信号';
  const signals = frame.decoded_signals || [];
  const definitions = signalDefinitions.filter(d => signalMatches(frame, d));
  const search = ($('#signalSearch')?.value || '').trim().toLocaleLowerCase();
  const visible = search ? signals.filter(s => s.name.toLocaleLowerCase().includes(search) ||
    (s.unit || '').toLocaleLowerCase().includes(search)) : signals;
  const count = $('#signalInspectorCount');
  if (count) count.textContent = visible.length + ' / ' + signals.length + ' 项信号';
  const container = $('#signalInspectorRows');
  const viewport = $('#signalInspectorViewport');
  const previousScroll = viewport.scrollTop;
  const previousBodyScroll = container.scrollTop;
  container.innerHTML = visible.length
    ? visible.map(s => {
      const status = s.error ? '解码失败' : isActiveBitfield(s) ? '故障标志' :
        s.display_mode === 'enum' ? '枚举' :
        s.display_mode === 'bitfield' ? '无活动故障' : '数值';
      return '<tr class="signal-inspector-row' +
        (s.error ? ' signal-has-error' : isActiveBitfield(s) ? ' signal-flag-active' : '') + '">' +
        '<td class="signal-inspector-name">'+esc(s.name)+'</td>' +
        '<td class="signal-inspector-value" title="'+esc(signalDisplayText(s))+'">'+esc(signalDisplayText(s))+'</td>' +
        '<td class="cell-mono" title="'+esc((s.raw ?? '—')+' / '+(s.raw_hex ?? '—'))+'">'+
        esc(s.raw_hex ?? s.raw ?? '—')+'</td>'+
        '<td>'+esc(s.unit || '—')+'</td>'+
        '<td class="signal-inspector-status" title="'+esc(s.error || status)+'">'+esc(s.error || status)+'</td></tr>';
    }).join('')
    : '<tr><td colspan="5" class="signal-empty">' +
      (search && signals.length ? '未找到匹配的信号。' :
        definitions.length ? '正在等待解码数据；收到新帧后自动更新。' :
        '尚未定义信号。点击“+ 定义信号”，选择起始位、长度和数据类型。') + '</td></tr>';
  // Keep the current place while values update.
  viewport.scrollTop = previousScroll;
  container.scrollTop = previousBodyScroll;
}
function refreshSelectedSignalFrame(rows) {
  if (!selectedSignalFrame || $('#signalInspector').hidden) return;
  const identity = signalIdentity(selectedSignalFrame);
  const latest = rows.slice().reverse().find(f => signalIdentity(f) === identity);
  if (latest) selectedSignalFrame = latest;
  renderSignalInspector();
}
function signalFrameForRow(row) {
  return row ? lastTraceRows.find(f => String(f.seq) === row.dataset.seq) || null : null;
}
function closeSignalContextMenu() {
  const menu = $('#signalContextMenu');
  if (menu) menu.hidden = true;
}
function showSignalContextMenu(e, frame) {
  if (!frame) return;
  e.preventDefault();
  signalContextFrame = frame;
  selectTraceFrame(frame);
  const menu = $('#signalContextMenu');
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - 245)) + 'px';
  menu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - 105)) + 'px';
}
function newSignalForSelected() {
  if (selectedSignalFrame) startSignalEditor(selectedSignalFrame);
}
function newSignalFromContext() {
  closeSignalContextMenu();
  startSignalEditor(signalContextFrame);
}
function viewSignalsFromContext() {
  closeSignalContextMenu();
  selectTraceFrame(signalContextFrame);
}
async function loadSignalDefinitions() {
  signalDefinitions = await api('/api/signals');
  renderSignalLibrary();
  renderSignalInspector();
}
async function openSignalLibrary() {
  $('#signalLibraryDialog').showModal();
  try { await loadSignalDefinitions(); }
  catch (e) { toast(e.message, true); }
}
function renderSignalLibrary() {
  const element = $('#signalLibraryRows');
  if (!element) return;
  element.innerHTML = signalDefinitions.length
    ? signalDefinitions.map(d =>
      '<tr><td class="cell-mono">CAN' + d.channel + ' / ' + hex(d.can_id) + ' ' +
      esc(d.frame_kind.toUpperCase()) + (d.extended ? ' EXT' : '') + '</td>' +
      '<td><b>' + esc(d.name) + '</b>' + (d.unit ? ' · ' + esc(d.unit) : '') + '</td>' +
      '<td class="cell-mono">' + d.start_bit + ' : ' + d.bit_length + '</td>' +
      '<td>' + esc(d.display_mode || 'number') + ' / ' + esc(d.value_type) + ' / ' +
      (d.byte_order === 'little_endian' ? 'Intel' : 'Motorola') + '</td>' +
      '<td class="cell-mono">' + d.factor + ' / ' + d.offset + '</td>' +
      '<td><button type="button" class="secondary" data-signal-edit="' + esc(d.key) + '">编辑</button>' +
      '<button type="button" class="danger" data-signal-delete="' + esc(d.key) + '">删除</button></td></tr>').join('')
    : '<tr><td colspan="6">暂无信号定义。右键 Trace 报文，或点击“新建信号”。</td></tr>';
}

async function importSignalLibraryFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const result = $('#signalImportResult');
  try {
    if (file.size > 1024 * 1024) throw new Error('文件超过 1 MiB，请使用 CANopy 导出的信号库 JSON。');
    const parsed = JSON.parse(await file.text());
    const definitions = Array.isArray(parsed) ? parsed :
      (parsed && (parsed.signals || parsed.definitions));
    if (!Array.isArray(definitions) || definitions.length > 512)
      throw new Error('导入文件必须是信号数组（最多 512 项），支持 CANopy 导出的 JSON。');
    const conflict = $('#signalImportConflict').value;
    if (conflict === 'overwrite' &&
      !window.confirm('覆盖模式：同一报文内同名信号将被导入内容替换。确定继续？')) return;
    result.textContent = '正在校验并导入 ' + definitions.length + ' 个信号…';
    const summary = await api('/api/signals/import',
      {method: 'POST', body: {definitions, conflict}, timeoutMs: 20000});
    await loadSignalDefinitions();
    const message = '导入完成：新增 ' + summary.added + '，覆盖 ' + summary.overwritten +
      '，跳过 ' + summary.skipped + '，库中共 ' + summary.total + ' 个信号。';
    result.textContent = message;
    toast(message);
    if (traceIsVisible()) await refreshTrace(true);
  } catch (e) {
    const message = '导入失败：' + e.message;
    result.textContent = message;
    toast(message, true);
  } finally { input.value = ''; }
}
function choiceLines(choices) {
  return Object.entries(choices || {}).map(([code, label]) => code + '=' + label).join('\n');
}
function parseChoiceLines(text) {
  const choices = {};
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(0[xX][0-9a-fA-F]+|\d+)\s*=\s*(.+?)\s*$/);
    if (!match) throw new Error('映射格式为“数值=名称”，例如 0x04=运行');
    const code = match[1].toLowerCase().startsWith('0x')
      ? parseInt(match[1], 16) : Number(match[1]);
    if (!Number.isSafeInteger(code) || code < 0 || seen.has(code))
      throw new Error('映射数值必须唯一、非负，并在安全整数范围内');
    seen.add(code);
    choices[String(code)] = match[2];
  }
  return choices;
}
function updateSignalDisplayMode() {
  const mode = $('#signalDisplayMode').value;
  $('#signalChoicesGroup').hidden = mode === 'number';
  $('#signalChoicesHelp').textContent = mode === 'enum'
    ? '每行一个“原始数值=名称”，如 4=运行、0x05=错误。匹配原始整数，不做比例换算。'
    : '每行一个“位序号=名称”，位序号从字段最低有效位 0 开始；如 0=驱动芯片故障、4=编码器故障。可同时触发多个标志。';
  const numeric = mode === 'number';
  $('#signalValueType').disabled = !numeric;
  $('#signalFactor').disabled = !numeric;
  $('#signalOffset').disabled = !numeric;
  if (!numeric) {
    $('#signalValueType').value = 'unsigned';
    $('#signalFactor').value = 1;
    $('#signalOffset').value = 0;
  }
}

function startSignalEditor(frame = null, definition = null) {
  closeSignalContextMenu();
  $('#signalEditorForm').reset();
  $('#signalKey').value = definition?.key || '';
  $('#signalName').value = definition?.name || '';
  $('#signalChannel').value = definition?.channel ?? frame?.channel ?? 0;
  $('#signalFrameKind').value = definition?.frame_kind || frame?.frame_kind || 'canfd';
  $('#signalCanId').value = hex(definition?.can_id ?? frame?.can_id ?? 0x123);
  $('#signalExtended').checked = definition?.extended ?? Boolean(frame?.extended);
  $('#signalStartBit').value = definition?.start_bit ?? 0;
  $('#signalBitLength').value = definition?.bit_length ?? 16;
  $('#signalByteOrder').value = definition?.byte_order || 'little_endian';
  $('#signalValueType').value = definition?.value_type || 'unsigned';
  $('#signalFactor').value = definition?.factor ?? 1;
  $('#signalOffset').value = definition?.offset ?? 0;
  $('#signalUnit').value = definition?.unit || '';
  $('#signalNotes').value = definition?.notes || '';
  $('#signalDisplayMode').value = definition?.display_mode || 'number';
  $('#signalChoices').value = choiceLines(definition?.choices);
  updateSignalDisplayMode();
  signalEditorFrame = frame || lastTraceRows.slice().reverse().find(f => signalMatches(f, definition)) || null;
  $('#signalEditorSource').textContent = signalEditorFrame
    ? '样本：CAN' + signalEditorFrame.channel + ' / ' + hex(signalEditorFrame.can_id) +
      ' · ' + signalEditorFrame.data.length + ' 字节。编辑参数可实时预览。'
    : '暂无样本帧。可手动定义并保存，收到匹配 CAN ID 的报文后自动解析。';
  $('#signalEditorTitle').textContent = definition ? '编辑信号 · ' + definition.name : '定义新信号';
  $('#signalEditorDialog').showModal();
  updateSignalBitMap();
  scheduleSignalPreview();
  $('#signalName').focus();
}
function collectSignalForm() {
  const parseInteger = (selector) => {
    const value = Number($(selector).value);
    if (!Number.isInteger(value)) throw new Error('起始位和位宽必须为整数');
    return value;
  };
  return {
    key: $('#signalKey').value,
    name: $('#signalName').value.trim(),
    channel: Number($('#signalChannel').value),
    frame_kind: $('#signalFrameKind').value,
    can_id: parseNum($('#signalCanId').value),
    extended: $('#signalExtended').checked,
    start_bit: parseInteger('#signalStartBit'),
    bit_length: parseInteger('#signalBitLength'),
    byte_order: $('#signalByteOrder').value,
    value_type: $('#signalValueType').value,
    factor: Number($('#signalFactor').value),
    offset: Number($('#signalOffset').value),
    unit: $('#signalUnit').value.trim(),
    notes: $('#signalNotes').value.trim(),
    display_mode: $('#signalDisplayMode').value,
    choices: $('#signalDisplayMode').value === 'number' ? {} :
      parseChoiceLines($('#signalChoices').value),
  };
}
function signalBitIndices(start, size, order) {
  const bits = [];
  if (!Number.isInteger(start) || !Number.isInteger(size) || size < 1 || size > 64) return bits;
  let bit = start;
  for (let i = 0; i < size; ++i) {
    if (bit >= 0 && bit < 512) bits.push(bit);
    bit = order === 'little_endian' ? bit + 1 : bit % 8 === 0 ? bit + 15 : bit - 1;
  }
  return bits;
}
function currentSignalScope() {
  // Bit-map highlighting must not disappear while the user is editing
  // an incomplete signal name, enum mapping or scaling expression.
  try {
    const text = $('#signalCanId').value.trim();
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/i.test(text)) return null;
    return {
      key: $('#signalKey').value,
      channel: Number($('#signalChannel').value),
      frame_kind: $('#signalFrameKind').value,
      can_id: parseNum(text),
      extended: $('#signalExtended').checked,
      start_bit: Number($('#signalStartBit').value),
      bit_length: Number($('#signalBitLength').value),
      byte_order: $('#signalByteOrder').value,
    };
  } catch { return null; }
}
function occupiedSignalBits(candidate) {
  if (!candidate) return {others: [], owners: new Map(), overlaps: []};
  const others = signalDefinitions.filter(d => signalMatches(d, candidate) &&
    d.key !== candidate.key);
  const owners = new Map();
  for (const definition of others) {
    for (const bit of signalBitIndices(definition.start_bit, definition.bit_length, definition.byte_order)) {
      if (!owners.has(bit)) owners.set(bit, []);
      owners.get(bit).push(definition.name);
    }
  }
  const current = signalBitIndices(candidate.start_bit, candidate.bit_length, candidate.byte_order);
  const overlaps = [...new Set(current.flatMap(bit => owners.get(bit) || []))];
  return {others, owners, overlaps};
}
function updateSignalBitMap() {
  const root = $('#signalBitMap');
  if (!root) return;
  const candidate = currentSignalScope();
  const {others, owners, overlaps} = occupiedSignalBits(candidate);
  const start = Number($('#signalStartBit').value);
  const current = signalBitIndices(start, Number($('#signalBitLength').value),
    $('#signalByteOrder').value);
  const currentSet = new Set(current);
  const frame = signalEditorFrame && candidate && signalMatches(candidate, signalEditorFrame)
    ? signalEditorFrame : null;
  const limit = candidate?.frame_kind === 'can' ? 8 : 64;
  const highest = Math.max(7, ...current, ...owners.keys());
  const byteCount = Math.min(limit,
    Math.max(8, frame?.data?.length || 0, Math.ceil((highest + 1) / 8)));
  root.innerHTML = Array.from({length: byteCount}, (_, i) => {
    const value = frame?.data?.[i];
    const byteBits = Array.from({length: 8}, (_, j) => {
      const bit = 7 - j, index = i * 8 + bit;
      const selected = currentSet.has(index), occupied = owners.has(index);
      const names = owners.get(index) || [];
      const classes = (selected ? ' is-signal' : '') +
        (occupied ? ' is-defined' : '') +
        (selected && occupied ? ' is-overlap' : '') +
        (selected && index === start ? ' is-start' : '');
      const hint = 'Byte ' + i + ' · bit' + bit +
        (names.length ? ' · 已定义：' + names.join('、') : '') +
        (selected ? ' · 当前正在编辑' : '');
      return '<button type="button" class="signal-byte-bit' + classes + '" data-bit="' +
        index + '" title="' + esc(hint) + '" aria-label="' + esc(hint) + '">' + bit + '</button>';
    }).join('');
    return '<div class="signal-byte-row"><span class="signal-byte-label">B' + i +
      ' · ' + (value === undefined ? '—' :
        Number(value).toString(16).padStart(2,'0').toUpperCase()) +
      '</span>' + byteBits + '</div>';
  }).join('');
  const summary = $('#signalOccupiedSummary');
  summary.textContent = candidate
    ? '此报文已定义 ' + others.length + ' 个其他信号。' +
      (overlaps.length ? ' 当前字段与 ' + overlaps.join('、') + ' 重叠（可用于故障位拆分）。' :
      ' 当前字段与已有定义无重叠。')
    : '请输入有效的 CAN ID，显示该报文已有的信号占位。';
  summary.classList.toggle('has-overlap', overlaps.length > 0);
  $('#signalExistingList').innerHTML = others.map(d =>
    '<button type="button" class="signal-existing-chip" data-existing-signal="' + esc(d.key) +
    '" title="点击编辑 ' + esc(d.name) + '">' + esc(d.name) + ' · B' +
    Math.floor(d.start_bit / 8) + '/bit' + (d.start_bit % 8) +
    ' · ' + d.bit_length + '位</button>').join('');
}
function scheduleSignalPreview() {
  clearTimeout(signalPreviewTimer);
  const generation = ++signalPreviewGeneration;
  const output = $('#signalPreview');
  if (!signalEditorFrame?.data?.length) {
    output.textContent = '尚无样本数据。保存后将在实时 Trace 中显示解析结果。';
    return;
  }
  let signal;
  try { signal = collectSignalForm(); }
  catch (e) { output.textContent = e.message; return; }
  if (!signal.name || !Number.isInteger(signal.start_bit) || !Number.isInteger(signal.bit_length)) {
    output.textContent = '填写名称、起始位和位宽后显示预览。';
    return;
  }
  if (!signalMatches(signal, signalEditorFrame)) {
    output.textContent = '当前编辑的报文与选中的样本不同，请从 Trace 选择相同 ID 的报文。';
    return;
  }
  output.textContent = '正在预览…';
  const data = signalEditorFrame.data;
  signalPreviewTimer = setTimeout(async () => {
    try {
      const result = await api('/api/signals/preview',
        {method: 'POST', body: {signal, data}, timeoutMs: 5000});
      if (generation !== signalPreviewGeneration) return;
      output.innerHTML = result.error
        ? '<span>' + esc(result.error) + '</span>'
        : '解析结果 <strong>' + esc(signalDisplayText(result)) + '</strong> ' +
          esc(result.unit) + ' · 原始值：' + esc(result.raw) + ' (' + esc(result.raw_hex) + ')';
    } catch (e) {
      if (generation === signalPreviewGeneration) output.textContent = e.message;
    }
  }, 200);
}
async function saveSignalDefinition(event) {
  event.preventDefault();
  const button = $('#saveSignalBtn');
  button.disabled = true;
  try {
    const saved = await api('/api/signals', {method: 'POST', body: collectSignalForm()});
    await loadSignalDefinitions();
    $('#signalEditorDialog').close();
    toast('已保存信号 ' + saved.name + '，Trace 将实时解析');
    await refreshTrace(true);
  } catch (e) { toast(e.message, true); }
  finally { button.disabled = false; }
}
async function deleteSignalDefinition(key) {
  const definition = signalDefinitions.find(d => d.key === key);
  if (!definition || !window.confirm('删除信号“' + definition.name + '”？')) return;
  try {
    await api('/api/signals/' + encodeURIComponent(key), {method: 'DELETE'});
    await loadSignalDefinitions();
    toast('已删除信号 ' + definition.name);
    await refreshTrace(true);
  } catch (e) { toast(e.message, true); }
}
let traceInspectorHeight = 220;
function setTraceInspectorHeight(height, save = false) {
  const limit = Math.max(140, Math.min(500, Math.floor((Number(globalThis.innerHeight) || 900) * 0.42)));
  traceInspectorHeight = Math.max(140, Math.min(limit, Math.round(height)));
  $('#trace').style.setProperty('--trace-inspector-height', traceInspectorHeight + 'px');
  $('#tracePaneDivider').setAttribute('aria-valuemax', String(limit));
  $('#tracePaneDivider').setAttribute('aria-valuenow', String(traceInspectorHeight));
  if (save) {
    try { localStorage.setItem(TRACE_INSPECTOR_HEIGHT_KEY, String(traceInspectorHeight)); }
    catch { /* Layout still works when storage is unavailable. */ }
  }
}
function initTraceInspectorDivider() {
  let saved = 220;
  try { saved = Number(localStorage.getItem(TRACE_INSPECTOR_HEIGHT_KEY)) || saved; }
  catch { /* Private browsing mode. */ }
  setTraceInspectorHeight(saved);
  const divider = $('#tracePaneDivider');
  divider.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const initialY = e.clientY;
    const initialHeight = traceInspectorHeight;
    const move = event => setTraceInspectorHeight(initialHeight + initialY - event.clientY);
    const stop = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      setTraceInspectorHeight(traceInspectorHeight, true);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
  });
  divider.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setTraceInspectorHeight(traceInspectorHeight + (e.key === 'ArrowUp' ? 24 : -24), true);
  });
  divider.addEventListener('dblclick', () => setTraceInspectorHeight(220, true));
}

function initializeSignalUI() {
  initTraceLayoutControls();
  initTraceInspectorDivider();
  const rows = $('#traceRows');
  rows.addEventListener('click', e => {
    if (e.target.closest('[data-trace-collapse]')) {
      collapseTraceSignalDetails();
      return;
    }
    const row = e.target.closest('tr[data-seq]');
    if (!row) return;
    if (e.target.closest('[data-trace-expand]')) toggleTraceSignalDetails(signalFrameForRow(row));
    else if (e.target.closest('.trace-id-button')) {
      selectTraceFrame(signalFrameForRow(row));
      renderTrace(lastTraceRows);
    }
  });
  rows.addEventListener('contextmenu', e => {
    const row = e.target.closest('tr[data-seq]');
    if (row) showSignalContextMenu(e, signalFrameForRow(row));
  });
  $('#signalLibraryRows').addEventListener('click', e => {
    const editor = e.target.closest('[data-signal-edit]');
    const deletion = e.target.closest('[data-signal-delete]');
    if (editor) {
      const definition = signalDefinitions.find(d => d.key === editor.dataset.signalEdit);
      if (definition) startSignalEditor(null, definition);
    }
    if (deletion) void deleteSignalDefinition(deletion.dataset.signalDelete);
  });
  $('#signalBitMap').addEventListener('click', e => {
    const cell = e.target.closest('[data-bit]');
    if (!cell) return;
    $('#signalStartBit').value = cell.dataset.bit;
    updateSignalBitMap();
    scheduleSignalPreview();
  });
  $('#signalEditorForm').addEventListener('input', () => {
    updateSignalBitMap();
    scheduleSignalPreview();
  });
  $('#signalEditorForm').addEventListener('change', () => {
    updateSignalBitMap();
    scheduleSignalPreview();
  });
  $('#signalEditorForm').addEventListener('submit', saveSignalDefinition);
  $('#signalImportFile').addEventListener('change', event => void importSignalLibraryFile(event.target));
  $('#signalDisplayMode').addEventListener('change', () => {
    updateSignalDisplayMode();
    updateSignalBitMap();
    scheduleSignalPreview();
  });
  $('#signalExistingList').addEventListener('click', event => {
    const chip = event.target.closest('[data-existing-signal]');
    if (!chip) return;
    const definition = signalDefinitions.find(s => s.key === chip.dataset.existingSignal);
    if (definition) startSignalEditor(signalEditorFrame, definition);
  });
  $('#signalSearch').addEventListener('input', renderSignalInspector);
  document.addEventListener('click', e => {
    if (!e.target.closest('#signalContextMenu')) closeSignalContextMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSignalContextMenu();
  });
}

const traceClock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
});
function traceCell(frame,key,flags,data,title) {
  const cell = (content,cls='',tip='') =>
    '<td class="trace-cell trace-cell-'+key+(cls?' '+cls:'')+'"'+
    (tip?' title="'+esc(tip)+'"':'')+'>'+content+'</td>';
  switch (key) {
    case 'seq': return cell(esc(frame.seq),'cell-mono');
    case 'time': return cell(traceClock.format(Math.floor(Number(frame.timestamp_ns)/1e6)),'cell-mono');
    case 'direction': return cell('<span class="frame-direction '+esc(frame.direction)+'">'+
      esc(frame.direction)+'</span>');
    case 'channel': return cell(esc(frame.frame_kind==='lin'?'LIN'+frame.channel:'CAN'+frame.channel));
    case 'kind': return cell(esc(frame.frame_kind));
    case 'id': return cell('<button class="trace-id-button" type="button" title="点击查看解析，右键定义信号">'+
      hex(frame.can_id)+'</button>');
    case 'signals': return cell(decodedSignalSummary(frame),'signal-summary',title);
    case 'flags': return cell(esc(flags));
    case 'data': return cell(esc(data),'cell-data',data);
    case 'frequency': return cell(frame.frequency_hz?
      Number(frame.frequency_hz).toFixed(1)+' Hz / '+Number(frame.period_ms).toFixed(2)+' ms' : '—',
      'cell-frequency');
    default: return '';
  }
}
function renderTrace(rows) {
  lastTraceRows = rows.slice(-TRACE_RENDER_LIMIT);
  renderTraceHeader();
  const {visible,filterInvalid} = filteredSortedTraceFrames(lastTraceRows);
  const columns=visibleTraceColumns();
  if (expandedTraceRowKey !== null &&
      !visible.some(f=>traceRowKey(f)===expandedTraceRowKey)) {
    expandedTraceRowKey=null;
  }
  $('#traceRows').innerHTML = visible.map(f=>{
    const flags = [f.extended?'EXT':'',f.remote?'RTR':'',f.brs?'BRS':'',f.esi?'ESI':'']
      .filter(Boolean).join(' ')||'—';
    const data=f.data_hex||(f.data||[]).map(x=>x.toString(16).padStart(2,'0')).join(' ').toUpperCase();
    const title=(f.decoded_signals||[]).map(s=>s.name+': '+(s.error||signalDisplayText(s))+' '+s.unit).join(' | ');
    const open=expandedTraceRowKey===traceRowKey(f)&&(f.decoded_signals||[]).length>0;
    const selected=selectedSignalFrame&&signalIdentity(f)===signalIdentity(selectedSignalFrame);
    return '<tr data-seq="'+esc(f.seq)+'"'+
      (open?' class="trace-expanded-parent"':selected?' class="trace-selected-row"':'')+'>'+
      columns.map(c=>traceCell(f,c.key,flags,data,title)).join('')+'</tr>'+
      (open?renderExpandedTraceSignals(f):'');
  }).join('');
  const count=$('#traceVisibleCount');
  if (count) count.textContent=String(visible.length);
  const stats=$('#traceFilterStats');
  if (stats) stats.textContent=filterInvalid?'CAN ID 格式无效':
    visible.length===lastTraceRows.length?'全部报文':
      '筛选 '+visible.length+' / '+lastTraceRows.length+' 帧';
  refreshSelectedSignalFrame(lastTraceRows);
}
function scheduleScrollRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => {
    renderPending = false;
    if (traceIsVisible() && $('#traceMode').value === 'scroll') renderTrace(liveFrames);
  }, 250);
}
async function clearTrace() {
  ++traceRevision; // Ignore pre-clear in-flight snapshots.
  try {
    await api('/api/trace', {method: 'DELETE'});
    liveFrames = [];
    $('#traceRows').replaceChildren();
    lastTraceRows = [];
    expandedTraceRowKey = null;
    $('#traceVisibleCount').textContent = '0';
    hideSignalInspector();
    await refreshTrace(true);
  } catch (e) { toast(e.message, true); }
}
function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/trace');
  ws = socket;
  wsSubscribed = false;
  socket.onmessage = e => {
    if (!traceIsVisible()) return;
    // Latest mode only needs to know there are changes, not parse frame arrays.
    if ($('#traceMode').value === 'latest') {
      latestDirty = true;
      return;
    }
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'frames' || !Array.isArray(msg.frames)) return;
    const frames = msg.frames;
    if (frames.length >= TRACE_SCROLL_LIMIT) {
      liveFrames = frames.slice(-TRACE_SCROLL_LIMIT);
    } else {
      liveFrames.push(...frames);
      if (liveFrames.length > TRACE_SCROLL_LIMIT) liveFrames.splice(0, liveFrames.length - TRACE_SCROLL_LIMIT);
    }
    scheduleScrollRender();
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    wsSubscribed = false;
    if (wsReconnectTimer === null) {
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWs();
      }, 1000);
    }
  };
  socket.onopen = () => syncTraceSubscription();
}
async function loadMetrics() {
  try {
    const m=await api('/api/metrics');
    $('#metrics').innerHTML=Object.entries(m).map(([ch,x]) => `<div class="stat"><b>CAN${ch} / BUS LOAD</b><strong>${x.load_1s_pct}%</strong><span>${x.frames_1s} 帧/s · 10 秒均值 ${x.load_10s_avg_pct}%</span></div>`).join('');
  } catch {}
}
async function applyFilters() { try { const channel=+$('#filterChannel').value, filters=JSON.parse($('#filterJson').value); toast(JSON.stringify(await api('/api/filters',{method:'PUT',body:{channel,filters}}))); } catch(e) { toast(e.message,true); } }
async function sendQueue() { try { toast(JSON.stringify(await api('/api/tx-queue',{method:'POST',body:JSON.parse($('#queueJson').value)}))); } catch(e) { toast(e.message,true); } }
async function clearQueue(ch) { try { toast(JSON.stringify(await api(`/api/tx-queue/${ch}`,{method:'DELETE'}))); } catch(e) { toast(e.message,true); } }
async function setProp() { try { $('#propResult').textContent=JSON.stringify(await api('/api/property/set',{method:'POST',body:{path:$('#propPath').value,value:$('#propValue').value}}),null,2); } catch(e) { toast(e.message,true); } }
async function getProp() { try { $('#propResult').textContent=JSON.stringify(await api('/api/property/get',{method:'POST',body:{path:$('#propPath').value}}),null,2); } catch(e) { toast(e.message,true); } }
async function linSend() { try { await api('/api/lin/transmit',{method:'POST',body:{channel:+$('#linChannel').value,pid:parseNum($('#linPid').value),data:parseData($('#linData').value),checksum:$('#linChecksum').value,direction:'publish'}}); toast('LIN 发送成功'); } catch(e) { toast(e.message,true); } }
async function linSubscribe() { try { const pids=JSON.parse($('#linSubJson').value); toast(JSON.stringify(await api('/api/lin/subscribe',{method:'PUT',body:{channel:+$('#linChannel').value,pids}}))); } catch(e) { toast(e.message,true); } }
async function linPublish() { try { const frames=JSON.parse($('#linPubJson').value); toast(JSON.stringify(await api('/api/lin/publish',{method:'PUT',body:{channel:+$('#linChannel').value,frames}}))); } catch(e) { toast(e.message,true); } }
async function linSchedule() { try { toast(JSON.stringify(await api('/api/lin/schedule',{method:'PUT',body:JSON.parse($('#linScheduleJson').value)}))); } catch(e) { toast(e.message,true); } }

(async () => {
  updateMessageFlags();
  initializeSignalUI();
  await loadConfig(); await loadStatus(); await loadMessages();
  try { await loadSignalDefinitions(); } catch (e) { toast('信号库读取失败：' + e.message, true); }
  connectWs(); loadMetrics();
  setInterval(() => { loadStatus(); loadMetrics(); },2000);
  setInterval(() => {
    if (latestDirty && traceIsVisible() && $('#traceMode').value === 'latest') void refreshTrace(false);
  }, 500);
})();
