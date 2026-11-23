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

document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab,.panel').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#' + b.dataset.tab).classList.add('active');
  const label = b.querySelector('span:last-child')?.textContent || b.textContent.trim();
  const pageName = $('#pageName');
  if (pageName) pageName.textContent = label;
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
    const value = s.error ? '错误' : formatSignalNumber(s.value);
    return '<span class="signal-summary-entry' + (s.error ? ' signal-has-error' : '') + '">' +
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
  return '<tr class="trace-details-row"><td colspan="10"><div class="trace-details">' +
    '<div class="trace-details-head"><strong>CAN' + esc(frame.channel) + ' / ' + hex(frame.can_id) +
    ' · 全部解析信号（' + signals.length + '）</strong>' +
    '<button type="button" class="secondary" data-trace-collapse>收起</button></div>' +
    '<div class="trace-details-grid">' + signals.map(s =>
      '<div class="trace-details-item' + (s.error ? ' signal-has-error' : '') + '">' +
      '<span class="trace-details-name">' + esc(s.name) + '</span>' +
      '<strong class="trace-details-value">' + (s.error ? '解析失败' : esc(formatSignalNumber(s.value))) +
      (s.unit && !s.error ? ' <small>' + esc(s.unit) + '</small>' : '') + '</strong>' +
      '<span class="trace-details-raw">' +
        esc(s.error || 'Raw: ' + (s.raw ?? '—') + ' · ' + (s.raw_hex ?? '—')) +
      '</span></div>').join('') + '</div></div></td></tr>';
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
  renderSignalInspector();
}
function hideSignalInspector() {
  $('#signalInspector').hidden = true;
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
  const previousScroll = container.scrollTop;
  container.innerHTML = visible.length
    ? visible.map(s => '<div class="signal-value"><div class="signal-name">' + esc(s.name) + '</div>' +
      '<div class="signal-number">' + (s.error ? '—' : esc(formatSignalNumber(s.value))) +
      ' <small>' + esc(s.unit) + '</small></div><div class="signal-raw">' +
      esc(s.error || 'Raw: ' + (s.raw ?? '—') + ' / ' + (s.raw_hex ?? '—')) + '</div></div>').join('')
    : '<p class="signal-empty">' + (search && signals.length ? '未找到匹配的信号。' :
      definitions.length ? '正在等待解码数据；收到新帧后自动更新。' :
      '尚未定义信号。点击“+ 定义信号”，选择起始位、长度和数据类型。') + '</p>';
  // Do not jump to the top of a long signal list on every live update.
  container.scrollTop = previousScroll;
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
      '<td>' + esc(d.value_type) + ' / ' + (d.byte_order === 'little_endian' ? 'Intel' : 'Motorola') + '</td>' +
      '<td class="cell-mono">' + d.factor + ' / ' + d.offset + '</td>' +
      '<td><button type="button" class="secondary" data-signal-edit="' + esc(d.key) + '">编辑</button>' +
      '<button type="button" class="danger" data-signal-delete="' + esc(d.key) + '">删除</button></td></tr>').join('')
    : '<tr><td colspan="6">暂无信号定义。右键 Trace 报文，或点击“新建信号”。</td></tr>';
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
function updateSignalBitMap() {
  const root = $('#signalBitMap');
  const frame = signalEditorFrame;
  if (!root) return;
  if (!frame?.data?.length) {
    root.textContent = '暂无样本数据。选择 Trace 中的 CAN ID 后，可点击位格设置起始位。';
    return;
  }
  const start = Number($('#signalStartBit').value);
  const bits = new Set(signalBitIndices(start, Number($('#signalBitLength').value), $('#signalByteOrder').value));
  root.innerHTML = frame.data.slice(0,64).map((value, i) => {
    const byteBits = Array.from({length: 8}, (_, j) => {
      const bit = 7 - j, index = i * 8 + bit;
      const active = bits.has(index) ? ' is-signal' : '';
      const first = index === start ? ' is-start' : '';
      return '<button type="button" class="signal-byte-bit' + active + first + '" data-bit="' +
        index + '" title="Byte ' + i + ' · bit' + bit + ' · Start Bit ' + index + '">' + bit + '</button>';
    }).join('');
    return '<div class="signal-byte-row"><span class="signal-byte-label">B' + i + ' · ' +
      Number(value).toString(16).padStart(2,'0').toUpperCase() + '</span>' + byteBits + '</div>';
  }).join('');
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
        : '解析值 <strong>' + esc(formatSignalNumber(result.value)) + '</strong> ' +
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
function initializeSignalUI() {
  const rows = $('#traceRows');
  rows.addEventListener('click', e => {
    if (e.target.closest('[data-trace-collapse]')) {
      collapseTraceSignalDetails();
      return;
    }
    const row = e.target.closest('tr[data-seq]');
    if (!row) return;
    if (e.target.closest('[data-trace-expand]')) toggleTraceSignalDetails(signalFrameForRow(row));
    else if (e.target.closest('.trace-id-button')) selectTraceFrame(signalFrameForRow(row));
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
function renderTrace(rows) {
  lastTraceRows = rows.slice(-TRACE_RENDER_LIMIT);
  if (expandedTraceRowKey !== null &&
      !lastTraceRows.some(f => traceRowKey(f) === expandedTraceRowKey)) {
    expandedTraceRowKey = null;
  }
  $('#traceRows').innerHTML = lastTraceRows.slice().reverse().map(f => {
    const flags = [f.extended?'EXT':'', f.remote?'RTR':'', f.brs?'BRS':'', f.esi?'ESI':''].filter(Boolean).join(' ') || '—';
    const data = f.data_hex || (f.data||[]).map(x => x.toString(16).padStart(2,'0')).join(' ').toUpperCase();
    const title = (f.decoded_signals||[]).map(s =>
      s.name + ': ' + (s.error || formatSignalNumber(s.value)) + ' ' + s.unit).join(' | ');
    const open = expandedTraceRowKey === traceRowKey(f) && (f.decoded_signals || []).length > 0;
    return '<tr data-seq="' + esc(f.seq) + '"' + (open ? ' class="trace-expanded-parent"' : '') + '>' +
      '<td>' + esc(f.seq) + '</td>' +
      '<td class="cell-mono">' + traceClock.format(Math.floor(Number(f.timestamp_ns)/1e6)) + '</td>' +
      '<td><span class="frame-direction ' + esc(f.direction) + '">' + esc(f.direction) + '</span></td>' +
      '<td>' + esc(f.frame_kind==='lin'?'LIN'+f.channel:'CAN'+f.channel) + '</td>' +
      '<td>' + esc(f.frame_kind) + '</td>' +
      '<td><button class="trace-id-button" type="button" title="点击查看解析，右键定义信号">' + hex(f.can_id) + '</button></td>' +
      '<td class="signal-summary" title="' + esc(title) + '">' + decodedSignalSummary(f) + '</td>' +
      '<td>' + esc(flags) + '</td>' +
      '<td class="cell-data">' + esc(data) + '</td>' +
      '<td class="cell-frequency">' + (f.frequency_hz ? Number(f.frequency_hz).toFixed(1) + ' Hz / ' +
        Number(f.period_ms).toFixed(2) + ' ms' : '—') + '</td></tr>' +
      (open ? renderExpandedTraceSignals(f) : '');
  }).join('');
  const count = $('#traceVisibleCount');
  if (count) count.textContent = String(lastTraceRows.length);
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
