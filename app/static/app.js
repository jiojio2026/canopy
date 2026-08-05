const $ = (s) => document.querySelector(s);
let config = null;
let messages = [];
let ws = null;
let liveFrames = [];
let renderPending = false;
let latestDirty = false;

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
  if (b.dataset.tab === 'trace') refreshTrace();
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
  $('#channelCards').innerHTML=config.channels.map((c,i) => `<article class="channel-card"><div class="section-head"><h2>CAN${i}</h2><span class="tag">${c.enabled ? esc(c.protocol.toUpperCase()) : '禁用'}</span></div><div class="kv"><b>仲裁速率</b><span>${Number(c.arbitration_bitrate).toLocaleString()} bit/s</span><b>数据速率</b><span>${c.protocol==='canfd' ? Number(c.data_bitrate).toLocaleString()+' bit/s' : '-'}</span><b>标准</b><span>${esc(c.canfd_standard)}</span><b>模式</b><span>${esc(c.mode)}</span><b>内置 120Ω</b><span>${c.resistance_120ohm ? '开启' : '关闭'}</span></div><div class="actions"><button onclick="diagnose(${i})">诊断</button><button class="secondary" onclick="resetCh(${i})">复位</button><button class="secondary" onclick="clearCh(${i})">清缓冲</button><button class="secondary" onclick="clearHwPeriodic(${i})">清硬件周期</button></div><pre id="diag${i}"></pre></article>`).join('');
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

async function refreshTrace() {
  try {
    const mode=$('#traceMode').value;
    const rows=await api(`/api/trace?mode=${mode}&limit=1000`);
    if (mode==='scroll') liveFrames=rows.slice(-3000);
    renderTrace(rows); latestDirty=false;
  } catch(e) { toast(e.message,true); }
}
function renderTrace(rows) {
  $('#traceRows').innerHTML=rows.slice(-1000).reverse().map(f => `<tr><td>${f.seq}</td><td>${new Date(Number(f.timestamp_ns)/1e6).toLocaleTimeString()}</td><td>${esc(f.direction)}</td><td>${esc(f.frame_kind==='lin'?'LIN'+f.channel:'CAN'+f.channel)}</td><td>${esc(f.frame_kind)}</td><td>${hex(f.can_id)}</td><td>${[f.extended?'EXT':'',f.remote?'RTR':'',f.brs?'BRS':'',f.esi?'ESI':''].filter(Boolean).join(' ')}</td><td>${esc(f.data_hex || (f.data||[]).map(x => x.toString(16).padStart(2,'0')).join(' ').toUpperCase())}</td><td>${f.frequency_hz ? `${Number(f.frequency_hz).toFixed(1)} Hz / ${Number(f.period_ms).toFixed(2)} ms` : ''}</td></tr>`).join('');
}
function scheduleScrollRender() {
  if (renderPending) return; renderPending=true;
  setTimeout(() => { renderPending=false; if ($('#trace').classList.contains('active') && $('#traceMode').value==='scroll') renderTrace(liveFrames); },100);
}
async function clearTrace() { try { await api('/api/trace',{method:'DELETE'}); liveFrames=[]; await refreshTrace(); } catch(e) { toast(e.message,true); } }
function connectWs() {
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws/trace');
  ws.onmessage=e => {
    let msg; try { msg=JSON.parse(e.data); } catch { return; }
    const frames=msg.type==='frames' ? msg.frames : [msg]; latestDirty=true;
    if ($('#traceMode').value==='scroll') {
      liveFrames.push(...frames); if (liveFrames.length>3000) liveFrames.splice(0,liveFrames.length-3000); scheduleScrollRender();
    }
  };
  ws.onclose=() => setTimeout(connectWs,1000);
  ws.onopen=() => ws.send('subscribe');
}
async function loadMetrics() {
  try {
    const m=await api('/api/metrics');
    $('#metrics').innerHTML=Object.entries(m).map(([ch,x]) => `<div class="stat"><b>CAN${ch}</b><strong>${x.load_1s_pct}%</strong><span>${x.frames_1s} 帧/s · 10s ${x.load_10s_avg_pct}%</span></div>`).join('');
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
  await loadConfig(); await loadStatus(); await loadMessages(); await refreshTrace();
  connectWs(); loadMetrics();
  setInterval(() => { loadStatus(); loadMetrics(); },2000);
  setInterval(() => { if (latestDirty && $('#trace').classList.contains('active') && $('#traceMode').value==='latest') refreshTrace(); },250);
})();
