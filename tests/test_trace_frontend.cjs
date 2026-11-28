const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

function harness() {
  let source = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');
  // Exclude the asynchronous app bootstrap from isolated Trace tests.
  const bootstrap = source.lastIndexOf('\n(async () => {');
  if (bootstrap >= 0) source = source.slice(0, bootstrap);
  const elements = new Map();
  const visible = {active: true};
  const pendingRequests = [], sockets = [], sent = [];
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', value: 'latest', textContent: '',
      style: {setProperty(name,value) { this[name]=value; }}, setAttribute(name,value) { this[name]=value; },
      classList: {contains(name) { return name === 'active' && visible.active; },
        add() {}, remove() {}, toggle() {}},
      addEventListener() {}, replaceChildren() { this.innerHTML = ''; },
    });
    return elements.get(selector);
  }
  element('#traceMode').value = 'latest';
  element('#traceFilterId').value = '';
  element('#traceFilterChannel').value = 'all';
  element('#traceFilterDirection').value = 'all';
  element('#traceDensity').value = 'compact';
  element('#signalSearch').value = '';
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = FakeSocket.OPEN; sockets.push(this); }
    send(message) { sent.push(message); }
  }
  const ctx = vm.createContext({
    document: {hidden: false, querySelector: element, querySelectorAll: () => [], addEventListener() {}},
    location: {protocol: 'http:', host: 'localhost:8000'},
    WebSocket: FakeSocket,
    AbortController,
    fetch: url => new Promise(resolve => pendingRequests.push({url, resolve})),
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval() {},
    console,
  });
  vm.runInContext(source, ctx);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const reply = (request, data) => request.resolve({ok: true, json: async () => ({ok: true, data})});
  return {ctx, elements, visible, sockets, sent, pendingRequests, settle, reply};
}

test('Trace snapshot requests never overlap while polling', async () => {
  const h = harness();
  const first = h.ctx.refreshTrace(false);
  await h.ctx.refreshTrace(false);
  assert.equal(h.pendingRequests.length, 1);
  h.reply(h.pendingRequests.shift(), []);
  await first;
  assert.equal(h.pendingRequests.length, 0);
});

test('Mode changes queue a new snapshot without rendering the stale response', async () => {
  const h = harness();
  const first = h.ctx.refreshTrace(false);
  h.elements.get('#traceMode').value = 'scroll';
  await h.ctx.refreshTrace(true);
  assert.equal(h.pendingRequests.length, 1);
  h.reply(h.pendingRequests.shift(), [{seq: 1, timestamp_ns: 1800000000000000000,
    direction: 'rx', frame_kind: 'can', channel: 0, can_id: 1}]);
  await first;
  await h.settle();
  assert.equal(h.pendingRequests.length, 1);
  assert.equal(h.elements.has('#traceRows'), false);
  h.reply(h.pendingRequests.shift(), []);
  await h.settle();
});

test('WebSocket pauses when hidden and rolling buffer is bounded', () => {
  const h = harness();
  h.ctx.connectWs();
  const socket = h.sockets[0];
  socket.onopen();
  assert.deepEqual(h.sent, ['subscribe']);
  h.elements.get('#traceMode').value = 'scroll';
  for (let i = 0; i < 20; ++i) {
    const frames = Array.from({length: 256}, (_, j) => ({seq: i * 256 + j}));
    socket.onmessage({data: JSON.stringify({type: 'frames', frames})});
  }
  assert.equal(vm.runInContext('liveFrames.length', h.ctx), 3000);
  h.visible.active = false;
  h.ctx.syncTraceSubscription();
  assert.deepEqual(h.sent, ['subscribe', 'unsubscribe']);
  socket.onmessage({data: JSON.stringify({type: 'frames', frames: [{seq: 99999}]})});
  assert.equal(vm.runInContext('liveFrames.length', h.ctx), 3000);
});

test('Rendered Trace row count is bounded', () => {
  const h = harness();
  const frames = Array.from({length: 5000}, (_, i) => ({
    seq: i, timestamp_ns: 1800000000000000000, direction: 'rx',
    frame_kind: 'can', channel: 0, can_id: i, data_hex: '',
  }));
  h.ctx.renderTrace(frames);
  assert.equal((h.elements.get('#traceRows').innerHTML.match(/<tr\b/g) || []).length, 1000);
});

test('Decoded signal summary is escaped and rendered alongside raw payload', () => {
  const h = harness();
  h.ctx.renderTrace([{
    seq: 42, timestamp_ns: 1800000000000000000, direction: 'rx',
    frame_kind: 'canfd', channel: 1, can_id: 0x706, data: [0x05, 0x05],
    decoded_signals: [{name: '<script>alert(1)</script>', value: 12.85, raw: '1285', unit: 'rad/s'}],
  }]);
  const html = h.elements.get('#traceRows').innerHTML;
  assert.ok(html.includes('0x706'));
  assert.ok(html.includes('05 05'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('12.85'));
  assert.equal(h.elements.get('#traceVisibleCount').textContent, '1');
});

test('Bit positions follow Intel and Motorola conventions', () => {
  const h = harness();
  const intel = Array.from(h.ctx.signalBitIndices(4, 12, 'little_endian'));
  const motorola = Array.from(h.ctx.signalBitIndices(7, 16, 'big_endian'));
  assert.deepEqual(intel, Array.from({length: 12}, (_, i) => i + 4));
  assert.deepEqual(motorola, [7,6,5,4,3,2,1,0,15,14,13,12,11,10,9,8]);
});


function decodedFrame(seq, count, canId = 0x706) {
  return {
    seq, timestamp_ns: 1800000000000000000, direction: 'rx',
    frame_kind: 'canfd', channel: 1, can_id: canId, extended: false,
    data: [5, 5],
    decoded_signals: Array.from({length: count}, (_, i) => ({
      name: 'Signal_' + i, value: i + 0.25, raw: String(i),
      raw_hex: '0x' + i.toString(16).toUpperCase(), unit: 'rpm',
    })),
  };
}

test('Trace keeps the summary compact and expands all decoded signals in one detail row', () => {
  const h = harness();
  const frame = decodedFrame(100, 24);
  h.ctx.renderTrace([frame]);
  let html = h.elements.get('#traceRows').innerHTML;
  assert.ok(html.includes('展开全部 24 项'));
  const compactSummary = html.match(/<div class="signal-summary-list">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.ok(!compactSummary.includes('Signal_23'));
  assert.equal((html.match(/<tr\b/g) || []).length, 1);

  h.ctx.toggleTraceSignalDetails(frame);
  html = h.elements.get('#traceRows').innerHTML;
  assert.ok(html.includes('全部解析信号（24）'));
  assert.ok(html.includes('Signal_23'));
  assert.ok(html.includes('23.25'));
  assert.equal((html.match(/class="trace-details-signal/g) || []).length, 24);
  assert.equal((html.match(/class="trace-details-row"/g) || []).length, 1);
  assert.equal((html.match(/class="trace-details-row"/g) || []).length, 1);
  assert.equal((html.match(/class="trace-details-signal/g) || []).length, 24);
  assert.equal(h.elements.get('#traceVisibleCount').textContent, '1');

  // In latest mode, the same CAN frame should remain expanded as seq changes.
  h.ctx.renderTrace([decodedFrame(101, 24)]);
  html = h.elements.get('#traceRows').innerHTML;
  assert.ok(html.includes('Signal_23'));
  assert.ok(html.includes('data-seq="101"'));
  h.ctx.collapseTraceSignalDetails();
  assert.equal((h.elements.get('#traceRows').innerHTML.match(/class="trace-details-row"/g) || []).length, 0);
});

test('At most one signal detail row is expanded in scroll mode, and removed when evicted', () => {
  const h = harness();
  h.elements.get('#traceMode').value = 'scroll';
  const first = decodedFrame(1, 18);
  const second = decodedFrame(2, 18);
  h.ctx.renderTrace([first, second]);
  h.ctx.toggleTraceSignalDetails(first);
  let html = h.elements.get('#traceRows').innerHTML;
  assert.equal((html.match(/class="trace-details-row"/g) || []).length, 1);
  h.ctx.toggleTraceSignalDetails(second);
  html = h.elements.get('#traceRows').innerHTML;
  assert.equal((html.match(/class="trace-details-row"/g) || []).length, 1);
  // The selected frame has left the bounded scroll window.
  h.ctx.renderTrace([decodedFrame(3, 18)]);
  assert.equal((h.elements.get('#traceRows').innerHTML.match(/class="trace-details-row"/g) || []).length, 0);
});

test('Inspector filters many signals and preserves scroll position across live updates', () => {
  const h = harness();
  const frame = decodedFrame(9, 30);
  frame.decoded_signals[29].name = 'motor_status';
  const scroll = h.ctx.document.querySelector('#signalInspectorRows');
  scroll.scrollTop = 92;
  h.ctx.document.querySelector('#signalSearch').value = 'motor';
  h.ctx.selectTraceFrame(frame);
  assert.equal(h.elements.get('#signalInspectorCount').textContent, '1 / 30 项信号');
  assert.ok(scroll.innerHTML.includes('motor_status'));
  assert.ok(!scroll.innerHTML.includes('Signal_0'));
  assert.equal(scroll.scrollTop, 92);
  h.ctx.renderTrace([{...frame, seq: 10}]);
  assert.equal(scroll.scrollTop, 92);
});

test('Expanded details escape untrusted signal names and error messages', () => {
  const h = harness();
  const frame = decodedFrame(7, 3);
  frame.decoded_signals[2] = {
    name: '<img src=x onerror=alert(1)>', value: null,
    raw: null, raw_hex: null, unit: '', error: '<bad>',
  };
  h.ctx.renderTrace([frame]);
  h.ctx.toggleTraceSignalDetails(frame);
  const html = h.elements.get('#traceRows').innerHTML;
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;bad&gt;'));
  assert.ok(!html.includes('<img src=x'));
});


test('Enum and bitfield labels appear in compact and expanded Trace output', () => {
  const h = harness();
  const frame = decodedFrame(10, 3);
  frame.decoded_signals = [
    {name: 'MotorState', value: 4, display_mode: 'enum', display: '运行', unit: ''},
    {name: 'Fault', value: 17, display_mode: 'bitfield',
     display: '驱动芯片故障、编码器故障', active_flags: ['驱动芯片故障', '编码器故障']},
    {name: 'Position', value: 12.85, display_mode: 'number', display: null, unit: '°'},
  ];
  h.ctx.renderTrace([frame]);
  let html = h.elements.get('#traceRows').innerHTML;
  assert.ok(html.includes('MotorState=运行'));
  assert.ok(html.includes('Fault=驱动芯片故障、编码器故障'));
  h.ctx.toggleTraceSignalDetails(frame);
  html = h.elements.get('#traceRows').innerHTML;
  assert.ok(html.includes('驱动芯片故障、编码器故障'));
  assert.ok(html.includes('12.85'));
});

test('Saved fields are highlighted in the bit map, overlaps are shown, and editing ignores itself', () => {
  const h = harness();
  const el = selector => h.ctx.document.querySelector(selector);
  const existing = {key: 'old', name: 'Position', channel: 1, frame_kind: 'canfd',
    can_id: 0x706, extended: false, start_bit: 0, bit_length: 16, byte_order: 'little_endian'};
  vm.runInContext('signalDefinitions = ' + JSON.stringify([existing]), h.ctx);
  const values = {
    '#signalCanId': '0x706', '#signalChannel': '1', '#signalFrameKind': 'canfd',
    '#signalStartBit': '16', '#signalBitLength': '16', '#signalByteOrder': 'little_endian',
    '#signalDisplayMode': 'number', '#signalValueType': 'unsigned', '#signalFactor': '1',
    '#signalOffset': '0', '#signalName': 'NewSignal',
  };
  for (const [selector,value] of Object.entries(values)) el(selector).value = value;
  h.ctx.updateSignalBitMap();
  let html = el('#signalBitMap').innerHTML;
  assert.ok(html.includes('is-defined'));
  assert.ok(!html.includes('is-overlap'));
  assert.ok(el('#signalExistingList').innerHTML.includes('Position'));
  el('#signalStartBit').value = '8';
  h.ctx.updateSignalBitMap();
  html = el('#signalBitMap').innerHTML;
  assert.ok(html.includes('is-overlap'));
  assert.ok(el('#signalOccupiedSummary').textContent.includes('Position'));
  el('#signalKey').value = 'old';
  h.ctx.updateSignalBitMap();
  html = el('#signalBitMap').innerHTML;
  assert.ok(!html.includes('is-defined'));
  assert.ok(!html.includes('is-overlap'));
});

test('Choice text accepts hexadecimal values and rejects duplicated numeric codes', () => {
  const h = harness();
  const choices = h.ctx.parseChoiceLines('0=初始化\n0x04=运行\n5=错误');
  assert.equal(choices['4'], '运行');
  assert.equal(Object.keys(choices).length, 3);
  assert.throws(() => h.ctx.parseChoiceLines('4=运行\n0x04=重复'));
  assert.throws(() => h.ctx.parseChoiceLines('not_a_key=状态'));
});


test('Import saved JSON merges definitions and refreshes library without hardware', async () => {
  const h = harness();
  const requests = [];
  h.visible.active = false;
  h.ctx.api = async (url, options) => {
    requests.push({url, options});
    if (url === '/api/signals/import')
      return {added: 1, overwritten: 0, skipped: 0, total: 1};
    if (url === '/api/signals')
      return [{key: 'new', name: 'MotorState', channel: 1, frame_kind: 'canfd',
        can_id: 0x706, extended: false, start_bit: 128, bit_length: 8,
        value_type: 'unsigned', byte_order: 'little_endian',
        factor: 1, offset: 0, display_mode: 'enum', choices: {'4':'运行'}}];
    throw new Error('Unexpected request: ' + url);
  };
  const input = {
    value: 'backup.json',
    files: [{size: 200, text: async () => JSON.stringify([{
      key: 'some-old-key', name: 'MotorState', channel: 1, frame_kind: 'canfd',
      can_id: 0x706, start_bit: 128, bit_length: 8,
      display_mode: 'enum', choices: {'4':'运行'},
    }])}],
  };
  h.ctx.document.querySelector('#signalImportConflict').value = 'skip';
  await h.ctx.importSignalLibraryFile(input);
  assert.equal(input.value, '');
  assert.equal(requests[0].url, '/api/signals/import');
  assert.equal(requests[0].options.body.conflict, 'skip');
  assert.equal(requests[0].options.body.definitions.length, 1);
  assert.equal(h.ctx.document.querySelector('#signalImportResult').textContent.includes('新增 1'), true);
  assert.ok(h.ctx.document.querySelector('#signalLibraryRows').innerHTML.includes('MotorState'));
});


test('Wireshark-style Trace filters by numeric CAN ID, channel and direction without mutating history', () => {
  const h = harness();
  const rows = [
    {...decodedFrame(1,2,0x706),channel:1,direction:'rx'},
    {...decodedFrame(2,2,0x705),channel:0,direction:'tx'},
    {...decodedFrame(3,2,0x706),channel:0,direction:'rx'},
    {...decodedFrame(4,2,0x706),channel:1,direction:'tx'},
  ];
  h.ctx.document.querySelector('#traceFilterId').value='0x706';
  h.ctx.document.querySelector('#traceFilterChannel').value='1';
  h.ctx.document.querySelector('#traceFilterDirection').value='rx';
  h.ctx.renderTrace(rows);
  let html=h.elements.get('#traceRows').innerHTML;
  assert.equal((html.match(/data-seq="/g)||[]).length,1);
  assert.ok(html.includes('data-seq="1"'));
  assert.equal(h.elements.get('#traceVisibleCount').textContent,'1');
  assert.equal(vm.runInContext('lastTraceRows.length',h.ctx),4);
  h.ctx.document.querySelector('#traceFilterId').value='';
  h.ctx.document.querySelector('#traceFilterChannel').value='all';
  h.ctx.document.querySelector('#traceFilterDirection').value='all';
  h.ctx.applyTraceFilters();
  html=h.elements.get('#traceRows').innerHTML;
  assert.equal((html.match(/data-seq="/g)||[]).length,4);
  assert.ok(html.indexOf('data-seq="4"')<html.indexOf('data-seq="1"'));
});

test('Trace sort toggles order and does not change the rolling data sequence', () => {
  const h=harness();
  const rows=[decodedFrame(1,1,0x706),decodedFrame(2,1,0x504),
    decodedFrame(3,1,0x705)];
  h.ctx.renderTrace(rows);
  h.ctx.changeTraceSort('id');
  let html=h.elements.get('#traceRows').innerHTML;
  assert.ok(html.indexOf('data-seq="2"')<html.indexOf('data-seq="3"'));
  h.ctx.changeTraceSort('id');
  html=h.elements.get('#traceRows').innerHTML;
  assert.ok(html.indexOf('data-seq="1"')<html.indexOf('data-seq="3"'));
  assert.deepEqual(Array.from(vm.runInContext('lastTraceRows.map(f=>f.seq)',h.ctx)),[1,2,3]);
});

test('Trace columns can be hidden, reordered, resized and persist to browser layout settings', () => {
  const h=harness();
  const data=new Map();
  h.ctx.localStorage={
    getItem:key=>data.has(key)?data.get(key):null,
    setItem:(key,value)=>data.set(key,value),
  };
  const frame=decodedFrame(1,3);
  h.ctx.renderTrace([frame]);
  h.ctx.setTraceColumnVisible('data',false);
  let html=h.elements.get('#traceRows').innerHTML;
  assert.ok(!html.includes('class="trace-cell trace-cell-data"'));
  assert.ok(html.includes('class="trace-cell trace-cell-id"'));
  h.ctx.moveTraceColumn('signals',-1);
  h.ctx.toggleTraceSignalDetails(frame);
  html=h.elements.get('#traceRows').innerHTML;
  const cols=vm.runInContext('visibleTraceColumns()',h.ctx);
  assert.equal(cols.length,9);
  assert.ok(html.includes('colspan="9"'));
  const before=vm.runInContext('traceLayout.columns.find(c=>c.key==="id").width',h.ctx);
  vm.runInContext('traceLayout.columns.find(c=>c.key==="id").width=190',h.ctx);
  h.ctx.traceColumnChanged();
  assert.ok(h.elements.get('#traceColgroup').innerHTML.includes('width:190px'));
  const saved=JSON.parse(data.get('canopy.trace.layout.v1'));
  assert.ok(saved.columns.some(c=>c.key==='data'&&c.visible===false));
  assert.ok(saved.columns.some(c=>c.key==='id'&&c.width===190));
  const loaded=h.ctx.loadTraceLayout();
  assert.equal(loaded.columns.find(c=>c.key==='id').width,190);
  assert.ok(before<190);
  h.ctx.resetTraceLayout();
  assert.equal(h.ctx.loadTraceLayout().columns.filter(c=>c.visible).length,10);
});

test('Trace never allows all columns to be hidden', () => {
  const h=harness();
  for (const key of ['seq','time','direction','channel','kind','signals','flags','data','frequency'])
    h.ctx.setTraceColumnVisible(key,false);
  h.ctx.setTraceColumnVisible('id',false);
  assert.deepEqual(Array.from(vm.runInContext('visibleTraceColumns().map(c=>c.key)',h.ctx)),['id']);
});

test('Signal inspector uses a compact table with raw/enum/bitfield labels', () => {
  const h=harness();
  const frame=decodedFrame(3,3);
  frame.decoded_signals=[
    {name:'Position',value:1.25,display:null,raw:'125',raw_hex:'0x7D',unit:'°'},
    {name:'ControlMode',value:0,display:'MIT',display_mode:'enum',raw:'0',raw_hex:'0x0'},
    {name:'Fault',value:16,display:'编码器故障',display_mode:'bitfield',
      raw:'16',raw_hex:'0x10',active_flags:['编码器故障'],unit:''},
  ];
  h.ctx.selectTraceFrame(frame);
  const html=h.elements.get('#signalInspectorRows').innerHTML;
  assert.equal((html.match(/<tr\b/g)||[]).length,3);
  assert.ok(html.includes('0x10'));
  assert.ok(html.includes('编码器故障'));
  assert.ok(html.includes('MIT'));
  assert.ok(html.includes('Position'));
  assert.ok(!html.includes('class="signal-value"'));
});


test('Old default column widths compact automatically while manual widths survive', () => {
  const h=harness();
  const previous=vm.runInContext('defaultTraceLayout()',h.ctx);
  previous.columns.find(c=>c.key==='seq').width=86;
  previous.columns.find(c=>c.key==='id').width=148;
  h.ctx.localStorage={getItem:()=>JSON.stringify(previous),setItem() {}};
  const migrated=h.ctx.loadTraceLayout();
  assert.equal(migrated.columns.find(c=>c.key==='seq').width,65);
  assert.equal(migrated.columns.find(c=>c.key==='id').width,148);
});

test('Inspector divider is initially hidden and supports compact persisted height', () => {
  const h=harness();
  const saved=new Map();
  h.ctx.localStorage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)};
  h.ctx.initTraceInspectorDivider();
  const inspector=h.elements.get('#trace');
  const divider=h.elements.get('#tracePaneDivider');
  assert.equal(inspector.style['--trace-inspector-height'],'220px');
  h.ctx.setTraceInspectorHeight(276,true);
  assert.equal(saved.get('canopy.trace.inspector.height.v1'),'276');
  assert.equal(divider['aria-valuenow'],'276');
  h.ctx.selectTraceFrame(decodedFrame(4,2));
  assert.equal(divider.hidden,false);
  h.ctx.hideSignalInspector();
  assert.equal(divider.hidden,true);
});
