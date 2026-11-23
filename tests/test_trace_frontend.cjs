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
      classList: {contains(name) { return name === 'active' && visible.active; },
        add() {}, remove() {}},
      addEventListener() {}, replaceChildren() { this.innerHTML = ''; },
    });
    return elements.get(selector);
  }
  element('#traceMode').value = 'latest';
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
  assert.equal((html.match(/class="trace-details-item/g) || []).length, 24);
  assert.equal((html.match(/class="trace-details-row"/g) || []).length, 1);
  assert.equal((html.match(/<tr\b/g) || []).length, 2);
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
