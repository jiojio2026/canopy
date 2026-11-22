const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

function harness() {
  let source = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');
  // Exclude the asynchronous app bootstrap from isolated Trace tests.
  source = source.replace(/\(async \(\) => \{[\s\S]*\}\)\(\);\s*$/, '');
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
  assert.equal(h.elements.get('#traceRows').innerHTML, '');
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
  assert.equal((h.elements.get('#traceRows').innerHTML.match(/<tr>/g) || []).length, 1000);
});
