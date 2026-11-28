/* CANopy signal plot: opt-in, bounded memory, Canvas-only rendering. */
(function (root) {
  'use strict';
  const MAX_SIGNALS = 4;
  const MAX_POINTS = 8000;
  const FRAME_INTERVAL_MS = 100;
  const ERROR_PAIR_TOLERANCE_MS = 5;
  const COLORS = ['#2563eb', '#ef7b24', '#0b9c84', '#9b5de5'];
  const byId = id => document.getElementById(id);
  const html = value => String(value ?? '').replace(/[&<>'"]/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  let definitions = [], selected = [], samples = new Map();
  let initialized = false, open = false, paused = false, windowSeconds = 10;
  let historyProvider = () => [];
  let pendingPaint = 0, paintTimer = 0, freshnessTimer = 0, lastReceiveAt = 0;
  let lastPaint = 0, errorText = '', errorExpiresAt = 0;

  function numericDefinition(d) {
    return d && d.key && (d.display_mode || 'number') === 'number';
  }
  function sameFrame(a, b) {
    return Number(a.channel) === Number(b.channel) &&
      a.frame_kind === b.frame_kind && Number(a.can_id) === Number(b.can_id) &&
      Boolean(a.extended) === Boolean(b.extended);
  }
  function validPoint(frame, signal) {
    if (!frame || !signal || signal.error || signal.value === null ||
        signal.value === undefined) return null;
    const t = Number(frame.timestamp_ns) / 1000000;
    const value = Number(signal.value);
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(value)) return null;
    return {t, value, seq: Number(frame.seq) || 0};
  }
  function nearestPair(a, b, toleranceMs = ERROR_PAIR_TOLERANCE_MS) {
    if (!a.length || !b.length) return null;
    const latestA = a[a.length - 1];
    let lo = 0, hi = b.length;
    while (lo < hi) {
      const middle = (lo + hi) >> 1;
      if (b[middle].t < latestA.t) lo = middle + 1; else hi = middle;
    }
    const candidates = [b[lo - 1], b[lo]].filter(Boolean);
    if (!candidates.length) return null;
    const closest = candidates.reduce((best, next) =>
      Math.abs(next.t - latestA.t) < Math.abs(best.t - latestA.t) ? next : best);
    const skewMs = Math.abs(latestA.t - closest.t);
    const newestSkewMs = Math.abs(latestA.t - b[b.length - 1].t);
    return {a: latestA, b: closest, skewMs, newestSkewMs,
      valid: skewMs <= toleranceMs && newestSkewMs <= toleranceMs,
      delta: latestA.value - closest.value};
  }
  function seriesFor(key) {
    if (!samples.has(key)) samples.set(key, []);
    return samples.get(key);
  }
  function ingest(frames, onlyKey) {
    if (!open || paused || !selected.length || !Array.isArray(frames)) return;
    let changed = false;
    for (const frame of frames) {
      const signals = frame.decoded_signals;
      if (!Array.isArray(signals) || !signals.length) continue;
      for (const definition of selected) {
        if (onlyKey && onlyKey !== definition.key) continue;
        if (!sameFrame(frame, definition)) continue;
        const decoded = signals.find(s => s.key === definition.key);
        const point = validPoint(frame, decoded);
        if (!point) continue;
        const points = seriesFor(definition.key);
        const previous = points[points.length - 1];
        // HTTP snapshots can overlap WebSocket batches; never count a frame twice.
        if (previous && point.seq && previous.seq && point.seq <= previous.seq) continue;
        // Device queue ordering can differ slightly; do not connect time-reversed points.
        if (previous && point.t < previous.t) continue;
        points.push(point);
        if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
        const cutoff = point.t - windowSeconds * 1000 - 1000;
        if (points.length > 250 && points[0].t < cutoff) {
          let trim = 0;
          while (trim < points.length - 1 && points[trim].t < cutoff) trim++;
          if (trim) points.splice(0, trim);
        }
        changed = true;
      }
    }
    if (changed) { lastReceiveAt = Date.now(); queueDraw(); }
  }
  function setDefinitions(value) {
    definitions = (Array.isArray(value) ? value : []).filter(numericDefinition);
    const available = new Map(definitions.map(d => [d.key, d]));
    selected = selected.filter(d => available.has(d.key))
      .map(d => available.get(d.key));
    for (const key of samples.keys()) {
      if (!selected.some(d => d.key === key)) samples.delete(key);
    }
    if (initialized) {
      updateOptions();
      clear(); // Signal definition may have changed its physical scaling.
    }
  }
  function optionLabel(d) {
    return 'CAN' + d.channel + ' / 0x' + Number(d.can_id).toString(16).toUpperCase() +
      ' · ' + d.name + (d.unit ? ' (' + d.unit + ')' : '');
  }
  function updateOptions() {
    const select = byId('plotSignalSelect');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '<option value="">选择已定义的数值信号</option>' +
      definitions.filter(d => !selected.some(x => x.key === d.key))
        .map(d => '<option value="' + html(d.key) + '">' + html(optionLabel(d)) + '</option>').join('');
    if (definitions.some(d => d.key === previous && !selected.some(x => x.key === previous))) {
      select.value = previous;
    }
  }
  function format(value) {
    return Number(value).toLocaleString(undefined, {maximumFractionDigits: 5});
  }
  function updateLegend() {
    const container = byId('plotLegend');
    if (!container) return;
    container.innerHTML = selected.length ? selected.map((d, i) => {
      const points = seriesFor(d.key);
      const last = points[points.length - 1];
      return '<span class="trace-plot-chip"><span class="trace-plot-swatch" style="background:' +
        COLORS[i] + '"></span><b class="trace-plot-order">' + String.fromCharCode(65+i) + '</b><span>' + html(d.name) + '</span><strong>' +
        (last ? html(format(last.value)) : '—') + '</strong><small>' + html(d.unit || '') +
        '</small><button type="button" data-plot-remove="' + html(d.key) +
        '" aria-label="移除曲线 ' + html(d.name) + '" title="移除曲线">×</button></span>';
    }).join('') : '<span class="trace-plot-prompt">选择 2 条信号即可叠加比较，例如「实际位置」和「目标位置」</span>';
    const empty = byId('plotEmpty');
    if (empty) empty.hidden = selected.length > 0;
  }
  function status(message) {
    const element = byId('plotStatus');
    if (element) element.textContent = message;
  }
  function statusForSeries() {
    if (paused) { status('已暂停采样；继续后才记录新数据。'); return; }
    if (errorText && Date.now() < errorExpiresAt) { status(errorText); return; }
    errorText = '';
    if (selected.length && lastReceiveAt && Date.now() - lastReceiveAt > 2500) {
      status('超过 2.5 秒未收到选中信号的新样本；曲线可能已停滞，请检查设备或总线。');
      return;
    }
    if (!selected.length) {
      status('仅绘制已定义的数值信号；数据由设备时间戳对齐，关闭面板即停止曲线缓存。');
      return;
    }
    if (selected.length === 1) {
      status('已选择 1 条曲线 · 添加相同单位/通道的第二条信号，可查看时间对齐和数值差。');
      return;
    }
    const a = seriesFor(selected[0].key), b = seriesFor(selected[1].key);
    const pair = nearestPair(a, b);
    if (!pair) { status('等待两条信号都收到 CAN 报文…'); return; }
    const unit = selected[0].unit || '';
    if (!pair.valid) {
      status('最新采样时间相差 ' + format(pair.newestSkewMs) +
        ' ms（超过 5 ms），不计算误差，避免异步采样产生误判。');
    } else {
      const synchronous = pair.a.seq && pair.a.seq === pair.b.seq;
      status('A−B ≈ ' + format(pair.delta) + (unit ? ' ' + unit : '') +
        ' · 时间差 ' + format(pair.skewMs) + ' ms · ' +
        (synchronous ? '同帧解码' : '跨报文近邻采样，误差仅供参考'));
    }
  }
  function add(key) {
    errorText = '';
    const definition = definitions.find(d => d.key === key);
    if (!definition) { errorText = '请先在信号库中定义数值信号（位宽、缩放系数和单位）。'; errorExpiresAt = Date.now() + 3000; statusForSeries(); return false; }
    if (selected.some(d => d.key === key)) return true;
    if (selected.length >= MAX_SIGNALS) {
      errorText = '最多同时绘制 4 条信号，以控制浏览器资源占用。';
      errorExpiresAt = Date.now() + 3000;
      statusForSeries(); return false;
    }
    if (selected.length && (definition.unit || '').trim() !== (selected[0].unit || '').trim()) {
      errorText = '单位不一致：请先在信号定义中统一单位（例如都为 °，不要混用 ° 与 rad）。';
      errorExpiresAt = Date.now() + 3000;
      statusForSeries(); return false;
    }
    if (selected.length && Number(definition.channel) !== Number(selected[0].channel)) {
      errorText = '暂不跨 CAN 通道叠加：当前设备时间戳按通道分别校准，跨通道对齐未经验证。';
      errorExpiresAt = Date.now() + 3000;
      statusForSeries(); return false;
    }
    selected.push(definition);
    seriesFor(key);
    updateOptions();
    ingest(historyProvider(), key);
    updateLegend();
    queueDraw(true);
    return true;
  }
  function remove(key) {
    selected = selected.filter(d => d.key !== key);
    samples.delete(key);
    errorText = '';
    updateOptions();
    updateLegend();
    queueDraw(true);
  }
  function clear() {
    lastReceiveAt = 0;
    samples = new Map(selected.map(d => [d.key, []]));
    errorText = '';
    updateLegend();
    queueDraw(true);
  }
  function show() {
    if (!initialized) return;
    open = true;
    paused = false;
    errorText = '';
    byId('tracePlot').hidden = false;
    byId('plotPause').textContent = '暂停';
    if (!freshnessTimer && typeof root.setInterval === 'function') {
      freshnessTimer = root.setInterval(() => { if (open && !paused) statusForSeries(); }, 1000);
    }
    clear();
    ingest(historyProvider());
    queueDraw(true);
  }
  function hide() {
    open = false;
    paused = false;
    byId('tracePlot').hidden = true;
    if (pendingPaint) { root.cancelAnimationFrame?.(pendingPaint); pendingPaint = 0; }
    if (paintTimer) { root.clearTimeout?.(paintTimer); paintTimer = 0; }
    if (freshnessTimer) { root.clearInterval?.(freshnessTimer); freshnessTimer = 0; }
    // Drop timestamps when hidden; the background trace still has its own bounded buffer.
    samples = new Map(selected.map(d => [d.key, []]));
  }
  function isOpen() { return open; }
  function isRecording() { return open && !paused && selected.length > 0; }
  function queueDraw(force = false) {
    if (!open || pendingPaint || paintTimer) return;
    const tick = now => {
      pendingPaint = 0;
      if (!open) return;
      const remaining = FRAME_INTERVAL_MS - (now - lastPaint);
      if (!force && remaining > 0 && typeof root.setTimeout === 'function') {
        // Trailing redraw: even a one-off final CAN frame must appear on the plot.
        paintTimer = root.setTimeout(() => {
          paintTimer = 0;
          queueDraw(true);
        }, remaining);
        return;
      }
      lastPaint = now;
      draw();
    };
    if (typeof root.requestAnimationFrame === 'function') {
      pendingPaint = root.requestAnimationFrame(tick);
    } else tick(Date.now());
  }
  function draw() {
    const canvas = byId('plotCanvas');
    if (!canvas || !open) return;
    updateLegend(); // DOM value labels refresh on the same capped cadence as Canvas.
    const context = canvas.getContext?.('2d');
    if (!context) { status('此浏览器不支持 Canvas 2D 绘图。'); return; }
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(250, rect.width || 250), h = Math.max(130, rect.height || 170);
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    const width = Math.round(w * dpr), height = Math.round(h * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, w, h);
    const x0 = 52, x1 = w - 12, y0 = 8, y1 = h - 24;
    const series = selected.map((d, i) => ({d, color:COLORS[i], points:seriesFor(d.key)}));
    const ends = series.map(s => s.points[s.points.length - 1]?.t).filter(Number.isFinite);
    if (!ends.length) { statusForSeries(); return; }
    const end = Math.max(...ends), start = end - windowSeconds * 1000;
    let min = Infinity, max = -Infinity, count = 0;
    for (const s of series) for (const p of s.points) {
      if (p.t < start || p.t > end) continue;
      min = Math.min(min, p.value); max = Math.max(max, p.value); count++;
    }
    if (!count) { statusForSeries(); return; }
    const margin = Math.max(Math.abs(max - min) * .09, Math.max(Math.abs(max),Math.abs(min),1) * .001);
    min -= margin; max += margin;
    const toX = t => x0 + (t - start) / (end - start) * (x1 - x0);
    const toY = v => y1 - (v - min) / (max - min) * (y1 - y0);
    context.font = '11px ui-monospace, Consolas, monospace';
    context.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = y0 + (y1 - y0) * i / 4;
      context.strokeStyle = '#e4ebf3'; context.beginPath();
      context.moveTo(x0, y); context.lineTo(x1, y); context.stroke();
      context.fillStyle = '#60748d'; context.textAlign = 'right';
      context.fillText(format(max - (max-min) * i / 4), x0 - 7, y + 4);
    }
    for (let i = 0; i <= 4; i++) {
      const x = x0 + (x1 - x0) * i / 4;
      context.strokeStyle = '#eef2f7'; context.beginPath();
      context.moveTo(x, y0); context.lineTo(x, y1); context.stroke();
      context.fillStyle = '#60748d'; context.textAlign = 'center';
      context.fillText('-' + format(windowSeconds * (4-i) / 4) + ' s', x, h - 5);
    }
    for (const s of series) {
      // Keep each pixel's min/max envelope so spikes survive downsampling.
      const bins = new Map();
      for (const p of s.points) {
        if (p.t < start || p.t > end) continue;
        const pixel = Math.round(toX(p.t));
        const bin = bins.get(pixel);
        if (bin) {
          bin.min = Math.min(bin.min, p.value);
          bin.max = Math.max(bin.max, p.value);
          bin.last = p.value;
        } else bins.set(pixel, {min:p.value,max:p.value,last:p.value});
      }
      context.strokeStyle = s.color;
      context.lineWidth = 1.5;
      context.beginPath();
      let prior = null;
      for (const [pixel, bin] of bins) {
        const y = toY(bin.last);
        if (!prior || pixel - prior > (x1-x0) * .2) context.moveTo(pixel, y);
        else context.lineTo(pixel, y);
        prior = pixel;
      }
      context.stroke();
      context.globalAlpha = .35;
      context.lineWidth = 1;
      context.beginPath();
      for (const [pixel, bin] of bins) {
        if (bin.max === bin.min) continue;
        context.moveTo(pixel, toY(bin.min));
        context.lineTo(pixel, toY(bin.max));
      }
      context.stroke();
      context.globalAlpha = 1;
    }
    statusForSeries();
  }
  function init(options = {}) {
    if (initialized) return;
    if (!byId('tracePlot')) return;
    initialized = true;
    historyProvider = options.history || (() => []);
    byId('plotAdd').addEventListener('click', () => add(byId('plotSignalSelect').value));
    byId('plotSignalSelect').addEventListener('change', () => { errorText = ''; statusForSeries(); });
    byId('plotWindow').addEventListener('change', e => {
      windowSeconds = [5,10,30].includes(Number(e.target.value)) ? Number(e.target.value) : 10;
      clear();
      ingest(historyProvider());
      queueDraw(true);
    });
    byId('plotPause').addEventListener('click', () => {
      paused = !paused;
      byId('plotPause').textContent = paused ? '继续' : '暂停';
      status(paused ? '已暂停采样；恢复后继续记录，暂停期间的数据不补录。' : '已恢复实时记录。');
      if (!paused) queueDraw(true);
    });
    byId('plotClear').addEventListener('click', clear);
    byId('plotLegend').addEventListener('click', e => {
      const button = e.target.closest('[data-plot-remove]');
      if (button) remove(button.dataset.plotRemove);
    });
    if (typeof root.ResizeObserver === 'function') {
      new root.ResizeObserver(() => queueDraw(true)).observe(byId('plotCanvas'));
    } else root.addEventListener?.('resize', () => queueDraw(true));
    updateOptions();
    updateLegend();
    statusForSeries();
  }
  root.CanopyPlot = {init, show, hide, isOpen, isRecording, setDefinitions,
    add, remove, clear, ingest, nearestPair,
    getSnapshot: () => selected.map(d => ({key:d.key, name:d.name, unit:d.unit,
      points:seriesFor(d.key).length, last:seriesFor(d.key).at(-1) || null})),
    limits: {MAX_SIGNALS,MAX_POINTS,FRAME_INTERVAL_MS,ERROR_PAIR_TOLERANCE_MS}};
})(globalThis);
