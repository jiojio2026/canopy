const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

function harness(history = []) {
  const source = fs.readFileSync(path.join(__dirname, '../app/static/plot.js'), 'utf8');
  const elements = new Map();
  const drawing = {setTransform() {},clearRect() {},beginPath() {},
    moveTo() {},lineTo() {},stroke() {},fillText() {}};
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', hidden: id === 'tracePlot', innerHTML: '', textContent: '',
      listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; },
      getBoundingClientRect() { return {width:850,height:190}; },
      getContext() { return drawing; },
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    document: {getElementById:el},
    console,
    devicePixelRatio: 1,
    addEventListener() {},
  });
  vm.runInContext(source, context);
  const plot = context.CanopyPlot;
  plot.init({history: () => history});
  return {plot, elements, el};
}
function definition(key, canId = 0x706, unit = '°', channel = 1) {
  return {key,name:key,frame_kind:'canfd',channel,can_id:canId,extended:false,
    display_mode:'number',unit};
}
function frame(seq, timeMs, canId = 0x706, values = {}, channel = 1) {
  return {seq,timestamp_ns:Math.round(timeMs*1e6),frame_kind:'canfd',channel,
    can_id:canId,extended:false,decoded_signals:Object.entries(values)
      .map(([key,value])=>({key,value,unit:'°',error:null}))};
}
const ORIGIN = 1700000000000;

test('Selected physical values overlay with the same device timestamps and dedupe seq', () => {
  const h=harness();
  h.plot.setDefinitions([definition('actual'),definition('target')]);
  h.plot.show();
  assert.ok(h.plot.add('actual'));
  assert.ok(h.plot.add('target'));
  const row=frame(1,ORIGIN,0x706,{actual:12,target:10});
  h.plot.ingest([row,row]);
  const series=h.plot.getSnapshot();
  assert.equal(series.length,2);
  assert.equal(series[0].points,1);
  assert.equal(series[1].points,1);
  assert.equal(series[0].last.value,12);
  assert.match(h.el('plotStatus').textContent,/A−B ≈ 2/);
  assert.match(h.el('plotStatus').textContent,/同帧解码/);
});

test('Asynchronous CAN IDs only report error when latest samples are within 5 ms', () => {
  const h=harness();
  h.plot.setDefinitions([definition('actual',0x706),definition('target',0x705)]);
  h.plot.show(); h.plot.add('actual'); h.plot.add('target');
  h.plot.ingest([frame(1,ORIGIN,0x706,{actual:10}),
    frame(2,ORIGIN+2,0x705,{target:9})]);
  assert.match(h.el('plotStatus').textContent,/A−B ≈ 1/);
  assert.match(h.el('plotStatus').textContent,/跨报文近邻采样/);
  h.plot.ingest([frame(3,ORIGIN+25,0x705,{target:11})]);
  assert.match(h.el('plotStatus').textContent,/超过 5 ms/);
  assert.doesNotMatch(h.el('plotStatus').textContent,/A−B/);
});

test('Rejects incompatible units and channels so the shared Y/time axes remain meaningful', () => {
  const h=harness();
  h.plot.setDefinitions([definition('actual'),definition('radians',0x705,'rad'),
    definition('otherChannel',0x505,'°',0)]);
  h.plot.show(); assert.equal(h.plot.add('actual'),true);
  assert.equal(h.plot.add('radians'),false);
  assert.match(h.el('plotStatus').textContent,/单位不一致/);
  assert.equal(h.plot.add('otherChannel'),false);
  assert.match(h.el('plotStatus').textContent,/跨 CAN 通道/);
  assert.equal(h.plot.getSnapshot().length,1);
});

test('Bounds 250 Hz history, pauses, clears and releases it when closed', () => {
  const h=harness();
  h.plot.setDefinitions([definition('actual')]);
  h.plot.show(); h.plot.add('actual');
  const frames=Array.from({length:8100},(_,i)=>
    frame(i+1,ORIGIN+i*4,0x706,{actual:i}));
  h.el('plotWindow').listeners.change({target:{value:'30'}});
  h.plot.ingest(frames);
  assert.ok(h.plot.getSnapshot()[0].points<=h.plot.limits.MAX_POINTS);
  const length=h.plot.getSnapshot()[0].points;
  h.el('plotPause').listeners.click();
  assert.equal(h.plot.isRecording(),false);
  h.plot.ingest([frame(8200,ORIGIN+40000,0x706,{actual:8200})]);
  assert.equal(h.plot.getSnapshot()[0].points,length);
  h.plot.hide();
  assert.equal(h.plot.isOpen(),false);
  assert.equal(h.plot.getSnapshot()[0].points,0);
});
