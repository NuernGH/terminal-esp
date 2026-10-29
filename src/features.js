// Day-to-day extras around a session: text encoding, plotting, logging, search, macros, file sending.
import { SearchAddon } from '@xterm/addon-search';

let X; // shared helpers handed over by main.js
export const init = (ctx) => (X = ctx);

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// ------------------------------------------------------------------ text encoding
export const ENCODINGS = [
  ['utf-8', 'UTF-8'],
  ['windows-1252', 'Windows-1252 (Western)'],
  ['iso-8859-1', 'ISO-8859-1 (Latin-1)'],
  ['ascii', 'ASCII (7-bit)'],
];

let cp1252Rev;
/** Text typed or sent from a macro, as bytes in the session's encoding. */
export function encodeText(enc, text) {
  if (!enc || enc === 'utf-8') return new TextEncoder().encode(text);
  if (!cp1252Rev) {
    cp1252Rev = new Map();
    const dec = new TextDecoder('windows-1252');
    for (let i = 0; i < 256; i++) cp1252Rev.set(dec.decode(Uint8Array.of(i)), i);
  }
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (enc === 'ascii') out.push(code < 128 ? code : 63);
    else if (enc === 'iso-8859-1') out.push(code < 256 ? code : 63);
    else out.push(cp1252Rev.get(ch) ?? (code < 128 ? code : 63));
  }
  return Uint8Array.from(out);
}

/** Incoming bytes in the form xterm should get: raw bytes for UTF-8, otherwise converted text. */
export function forTerminal(enc, bytes) {
  if (!enc || enc === 'utf-8') return bytes;
  if (enc === 'ascii') return bytes.map((b) => (b < 128 ? b : 63));
  return new TextDecoder(enc === 'iso-8859-1' ? 'iso-8859-1' : enc).decode(bytes);
}

export const textOf = (enc, bytes) =>
  new TextDecoder(!enc || enc === 'ascii' ? 'utf-8' : enc).decode(bytes);

// ------------------------------------------------------------------ plotting
const COLOURS = ['#4da3ff', '#ff7a7a', '#4cd694', '#ffc857', '#c792ea', '#5fd7d7', '#ff9f68', '#9aa7b8'];
const MAX_POINTS = 400;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const LABELLED = /([A-Za-z_][\w.\-]{0,23})\s*[=:]\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g;
const BARE = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

/** Numbers found in one line of text: `name=value` pairs when present, otherwise every number as v1, v2, … */
export function parsePlotLine(line) {
  const text = line.replace(ANSI, '');
  const out = [];
  for (const m of text.matchAll(LABELLED)) out.push([m[1].trim(), parseFloat(m[2])]);
  if (out.length) return out;
  const nums = text.match(BARE) ?? [];
  return nums.slice(0, 8).map((n, i) => [`v${i + 1}`, parseFloat(n)]);
}

export function plotFeed(s, text) {
  const p = s.plot;
  if (!p || p.paused) return;
  if (p.digits > 0) return plotDigits(s, text);
  p.carry += text;
  const lines = p.carry.split(/\r?\n|\r/);
  p.carry = lines.pop().slice(-512);
  plotLines(s, lines);
  // Data without a line ending would otherwise wait forever: plot what is left once the line goes quiet.
  clearTimeout(p.idle);
  if (p.carry) p.idle = setTimeout(() => {
    const rest = p.carry;
    p.carry = '';
    plotLines(s, [rest]);
  }, 300);
}

/** Fixed-width mode: every `digits` digits in the stream make one value, so 22222222 with 2 digits gives 22, 22, 22, 22. */
function plotDigits(s, text) {
  const p = s.plot;
  p.dcarry = (p.dcarry || '') + text.replace(ANSI, '').replace(/\D/g, '');
  const n = p.digits;
  const vals = [];
  while (p.dcarry.length >= n) {
    vals.push(`value=${parseInt(p.dcarry.slice(0, n), 10)}`);
    p.dcarry = p.dcarry.slice(n);
  }
  if (vals.length) plotLines(s, vals);
}

const seriesOpts = (s) => X.store.get('plotseries:' + s.id, {});
const seriesName = (ser) => ser.label || ser.name;
function saveSeriesOpts(s) {
  const o = {};
  for (const ser of s.plot.series.values()) if (ser.hidden || ser.label) o[ser.name] = { hidden: ser.hidden || undefined, label: ser.label || undefined };
  X.store.set('plotseries:' + s.id, o);
}

/** The "Series" list: tick to show or hide a series, edit its name to rename it. */
function renderSeriesPanel(s) {
  const p = s.plot;
  if (!p.panel) return;
  const focused = p.panel.contains(document.activeElement) ? document.activeElement : null;
  if (focused && focused.tagName === 'INPUT' && focused.type === 'text') return; // do not rebuild while typing
  const rows = [...p.series.values()];
  p.panel.innerHTML = rows.length
    ? rows.map((ser, i) => `<label class="srow"><input type="checkbox" data-i="${i}" ${ser.hidden ? '' : 'checked'} title="Show on the plot"><i style="background:${ser.colour}"></i><input type="text" data-n="${i}" value="${X.esc(seriesName(ser))}" placeholder="${X.esc(ser.name)}" title="Name shown on the plot. Clear it to go back to ${X.esc(ser.name)}." spellcheck="false"></label>`).join('')
    : '<span class="hint">No series yet. They appear when numbers arrive.</span>';
  p.panel.onchange = (e) => {
    const t = e.target;
    const ser = rows[+(t.dataset.i ?? t.dataset.n)];
    if (!ser) return;
    if (t.dataset.i !== undefined) ser.hidden = !t.checked;
    else ser.label = t.value.trim() === ser.name ? '' : t.value.trim();
    saveSeriesOpts(s);
    drawPlot(s);
  };
}

/** Remembers when a plotted value arrived and where it is in the terminal, so a click can find it again. */
function markPoint(s) {
  const slot = { t: Date.now(), mk: null };
  try {
    s.term.write('', () => {
      const b = s.term.buffer.active;
      slot.mk = s.term.registerMarker(b.cursorX === 0 ? -1 : 0) ?? null;
    });
  } catch {
    /* terminal not ready */
  }
  return slot;
}

function plotLines(s, lines) {
  const p = s.plot;
  let any = false;
  for (const line of lines) {
    for (const [name, value] of parsePlotLine(line)) {
      if (!Number.isFinite(value)) continue;
      let ser = p.series.get(name);
      if (!ser) {
        if (p.series.size >= 8) continue;
        const o = seriesOpts(s)[name] || {};
        ser = { name, colour: COLOURS[p.series.size % COLOURS.length], pts: [], meta: [], hidden: !!o.hidden, label: o.label || '' };
        p.series.set(name, ser);
      }
      ser.pts.push(value);
      ser.meta.push(markPoint(s));
      if (ser.pts.length > MAX_POINTS) {
        ser.pts.shift();
        ser.meta.shift()?.mk?.dispose();
      }
      any = true;
    }
  }
  if (any && p.panel) renderSeriesPanel(s);
  if (any && !p.raf)
    p.raf = requestAnimationFrame(() => {
      p.raf = 0;
      drawPlot(s);
    });
}

function nearestPoint(s, ev) {
  const p = s.plot;
  const geo = p?.geo;
  if (!geo) return null;
  const rect = p.canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  let best = null;
  for (const ser of geo.series) {
    const i = Math.round(geo.n <= 1 ? 0 : ((mx - geo.X0) / (geo.X1 - geo.X0)) * (geo.n - 1)) - (geo.n - ser.pts.length);
    for (const j of [i - 1, i, i + 1]) {
      if (j < 0 || j >= ser.pts.length) continue;
      const x = geo.X0 + (geo.n <= 1 ? 0 : ((j + geo.n - ser.pts.length) / (geo.n - 1)) * (geo.X1 - geo.X0));
      const d = Math.hypot(x - mx, geo.yOf(ser.pts[j], ser) - my);
      if (d < 16 && (!best || d < best.d)) best = { ser, i: j, d };
    }
  }
  return best;
}

function wirePlotPointer(s) {
  const p = s.plot;
  const tip = s.plotEl.querySelector('.plot-tip');
  p.canvas.addEventListener('mousemove', (ev) => {
    const hit = nearestPoint(s, ev);
    const prev = p.hover;
    p.hover = hit && { ser: hit.ser, i: hit.i };
    p.canvas.style.cursor = hit ? 'pointer' : '';
    if (!hit) {
      tip.hidden = true;
    } else {
      const m = hit.ser.meta[hit.i];
      tip.innerHTML = `<b style="color:${hit.ser.colour}">${X.esc(seriesName(hit.ser))}</b> ${hit.ser.pts[hit.i]}<br><small>${stamp(new Date(m.t)).slice(11)} · click to find it in the terminal</small>`;
      tip.hidden = false;
      const r = p.canvas.getBoundingClientRect();
      const host = s.plotEl.getBoundingClientRect();
      const x = Math.min(ev.clientX - host.left + 12, host.width - tip.offsetWidth - 6);
      tip.style.left = Math.max(4, x) + 'px';
      tip.style.top = Math.max(4, ev.clientY - host.top - tip.offsetHeight - 10) + 'px';
      void r;
    }
    if (prev?.i !== p.hover?.i || prev?.ser !== p.hover?.ser) drawPlot(s);
  });
  p.canvas.addEventListener('mouseleave', () => {
    tip.hidden = true;
    if (p.hover) {
      p.hover = null;
      drawPlot(s);
    }
  });
  p.canvas.addEventListener('click', (ev) => {
    const hit = nearestPoint(s, ev);
    if (hit) jumpToPoint(s, hit.ser.meta[hit.i]);
  });
}

/** Scrolls the terminal (and the decoded list) to where a plotted value came from and highlights it for a moment. */
function jumpToPoint(s, slot) {
  if (s.pane.classList.contains('plot-full')) {
    s.pane.classList.remove('plot-full');
    s.plotEl.querySelector('[data-p=full]').textContent = 'Plot only';
    X.fitAll();
  }
  const mk = slot.mk;
  if (mk && !mk.isDisposed && mk.line >= 0) {
    s.term.scrollToLine(Math.max(0, mk.line - Math.floor(s.term.rows / 2)));
    const dec = s.term.registerDecoration({ marker: mk, x: 0, width: s.term.cols, height: 1, backgroundColor: '#b8860b', layer: 'top' });
    if (dec) setTimeout(() => dec.dispose(), 2500);
  } else {
    X.note('That line has scrolled out of the terminal history.');
  }
  const rec = [...(s.rec || [])].reverse().find((r) => r.t <= slot.t + 50 && r.dir === 'rx' && r.el);
  if (rec) {
    rec.el.scrollIntoView({ block: 'center' });
    rec.el.classList.add('flash');
    setTimeout(() => rec.el.classList.remove('flash'), 2500);
  }
}

export function drawPlot(s) {
  const p = s.plot;
  if (!p || !p.canvas.clientWidth) return;
  const c = p.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const mute = css.getPropertyValue('--mute').trim() || '#8a94a6';
  const line = css.getPropertyValue('--line').trim() || '#2a3340';
  g.clearRect(0, 0, w, h);
  const all = [...p.series.values()];
  const series = all.filter((x) => !x.hidden);
  const left = 46;
  const top = 8;
  const bottom = 16;
  const right = 8;
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (const ser of series) {
    n = Math.max(n, ser.pts.length);
    for (const v of ser.pts) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  g.font = '11px ui-monospace, Consolas, monospace';
  if (!series.length || !Number.isFinite(lo)) {
    g.fillStyle = mute;
    g.fillText(all.length ? 'All series are hidden. Tick one under Series.' : 'Waiting for numbers in the incoming text (for example temp=22.4 hum=41)…', left, h / 2);
    p.geo = null;
    p.legend.innerHTML = '';
    return;
  }
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const X0 = left;
  const X1 = w - right;
  const Y0 = h - bottom;
  const Y1 = top;
  const yOf = (v, ser) => {
    if (p.each && ser) {
      const a = Math.min(...ser.pts);
      const b = Math.max(...ser.pts);
      return Y0 - (b === a ? 0.5 : (v - a) / (b - a)) * (Y0 - Y1) * 0.88 - (Y0 - Y1) * 0.06;
    }
    return Y0 - ((v - lo) / (hi - lo)) * (Y0 - Y1);
  };
  g.strokeStyle = line;
  g.fillStyle = mute;
  g.lineWidth = 1;
  g.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = Math.round(Y0 - ((Y0 - Y1) * i) / 4) + 0.5;
    g.beginPath();
    g.moveTo(X0, y);
    g.lineTo(X1, y);
    g.stroke();
    if (!p.each) g.fillText(Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 10 ? 2 : 1), X0 - 5, y + 4);
  }
  g.textAlign = 'left';
  g.fillText(`last ${n} samples`, X0, h - 3);
  p.geo = { X0, X1, n, yOf, series };
  for (const ser of series) {
    g.strokeStyle = ser.colour;
    g.lineWidth = 1.6;
    g.beginPath();
    ser.pts.forEach((v, i) => {
      const x = X0 + (n <= 1 ? 0 : ((i + n - ser.pts.length) / (n - 1)) * (X1 - X0));
      if (i === 0) g.moveTo(x, yOf(v, ser));
      else g.lineTo(x, yOf(v, ser));
    });
    g.stroke();
  }
  if (p.hover) {
    const { ser, i } = p.hover;
    if (p.series.get(ser.name) === ser && i < ser.pts.length) {
      const x = X0 + (n <= 1 ? 0 : ((i + n - ser.pts.length) / (n - 1)) * (X1 - X0));
      g.fillStyle = ser.colour;
      g.beginPath();
      g.arc(x, yOf(ser.pts[i], ser), 4.5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = css.getPropertyValue('--fg').trim() || '#fff';
      g.lineWidth = 1.5;
      g.stroke();
    }
  }
  p.legend.innerHTML = series
    .map((ser) => `<span><i style="background:${ser.colour}"></i>${X.esc(seriesName(ser))} <b>${ser.pts[ser.pts.length - 1]}</b></span>`)
    .join('');
}

/** Shows or hides the plot panel of a session. */
export function togglePlot(s, on = !s.plot) {
  if (!on) {
    s.plotEl?.remove();
    s.plotEl = null;
    s.plot = null;
    s.pane.classList.remove('has-plot', 'plot-full');
  } else {
    const el = document.createElement('div');
    el.className = 'plot';
    el.innerHTML = `<div class="plot-bar"><b>Plot</b><span class="legend"></span><button type="button" class="btn ghost sm" data-p="scale" title="Scale every series to its own range, useful when values differ a lot">Scale: shared</button><label class="plot-dig" title="Split the incoming digits into values of this many digits (for example 2: 22222222 becomes 22, 22, 22, 22). 0 = off, read normal text"><span>Digits per value</span><input type="number" min="0" max="9" value="0" data-p="digits"></label><button type="button" class="btn ghost sm" data-p="series" title="Choose which series to show and rename them">Series…</button><button type="button" class="btn ghost sm" data-p="full" title="Show only the plot, hiding the terminal">Plot only</button><button type="button" class="btn ghost sm" data-p="pause">Pause</button><button type="button" class="btn ghost sm" data-p="clear">Clear</button><button type="button" class="btn ghost sm" data-p="close" aria-label="Close plot">✕</button></div><canvas></canvas><div class="plot-tip" hidden></div><div class="plot-series" hidden></div>`;
    s.pane.querySelector('.split').after(el);
    s.plotEl = el;
    s.plot = { series: new Map(), carry: '', paused: false, raf: 0, canvas: el.querySelector('canvas'), legend: el.querySelector('.legend') };
    s.pane.classList.add('has-plot');
    const dig = el.querySelector('[data-p=digits]');
    try { dig.value = localStorage.getItem('esp-terminal.plotdigits:' + s.id) || '0'; } catch {}
    s.plot.digits = +dig.value || 0;
    dig.addEventListener('input', () => {
      s.plot.digits = Math.max(0, Math.min(9, parseInt(dig.value, 10) || 0));
      s.plot.dcarry = '';
      s.plot.carry = '';
      try { localStorage.setItem('esp-terminal.plotdigits:' + s.id, String(s.plot.digits)); } catch {}
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      if (b.dataset.p === 'close') {
        togglePlot(s, false);
        X.renderToolbar();
      }
      else if (b.dataset.p === 'clear') {
        s.plot.series.clear();
        s.plot.legend.innerHTML = '';
        drawPlot(s);
      } else if (b.dataset.p === 'series') {
        const panel = s.plotEl.querySelector('.plot-series');
        panel.hidden = !panel.hidden;
        s.plot.panel = panel.hidden ? null : panel;
        if (s.plot.panel) renderSeriesPanel(s);
      } else if (b.dataset.p === 'full') {
        const on = !s.pane.classList.contains('plot-full');
        s.pane.classList.toggle('plot-full', on);
        b.textContent = on ? 'Show terminal' : 'Plot only';
        requestAnimationFrame(() => { drawPlot(s); X.fitAll(); });
      } else if (b.dataset.p === 'scale') {
        s.plot.each = !s.plot.each;
        b.textContent = s.plot.each ? 'Scale: each' : 'Scale: shared';
        drawPlot(s);
      } else {
        s.plot.paused = !s.plot.paused;
        b.textContent = s.plot.paused ? 'Resume' : 'Pause';
      }
    });
    wirePlotPointer(s);
    new ResizeObserver(() => drawPlot(s)).observe(s.plot.canvas);
    requestAnimationFrame(() => drawPlot(s));
  }
  requestAnimationFrame(X.fitAll);
}

// ------------------------------------------------------------------ search
export function attachSearch(s) {
  s.search = new SearchAddon();
  s.term.loadAddon(s.search);
  const bar = document.createElement('div');
  bar.className = 'findbar';
  bar.hidden = true;
  bar.innerHTML = `<input placeholder="Find in terminal" aria-label="Find in terminal" spellcheck="false"><button type="button" data-f="prev" title="Previous (Shift+Enter)">↑</button><button type="button" data-f="next" title="Next (Enter)">↓</button><button type="button" data-f="case" title="Match case" aria-pressed="false">Aa</button><button type="button" data-f="close" title="Close (Esc)">✕</button>`;
  s.pane.append(bar);
  s.findBar = bar;
  const input = bar.querySelector('input');
  const opts = () => ({ caseSensitive: bar.querySelector('[data-f=case]').getAttribute('aria-pressed') === 'true', decorations: { matchOverviewRuler: '#4da3ff', activeMatchColorOverviewRuler: '#ffc857', matchBorder: '#4da3ff', activeMatchBorder: '#ffc857' } });
  const run = (dir) => (dir === 'prev' ? s.search.findPrevious(input.value, opts()) : s.search.findNext(input.value, opts()));
  input.addEventListener('input', () => {
    s.search.clearDecorations();
    if (input.value) s.search.findNext(input.value, { ...opts(), incremental: true });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') closeSearch(s);
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    const f = b.dataset.f;
    if (f === 'close') closeSearch(s);
    else if (f === 'case') {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      run('next');
    } else run(f);
  });
}

export function openSearch(s) {
  s.findBar.hidden = false;
  const input = s.findBar.querySelector('input');
  const sel = s.term.getSelection();
  if (sel && !sel.includes('\n')) input.value = sel;
  input.focus();
  input.select();
}

export function closeSearch(s) {
  s.findBar.hidden = true;
  s.search.clearDecorations();
  s.term.focus();
}

// ------------------------------------------------------------------ logging
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

export function logWrite(s, dir, bytes) {
  const l = s.log;
  if (!l) return;
  if (l.format === 'raw') {
    if (dir === 'rx') l.chunks.push(bytes.slice());
    return;
  }
  // Timestamped text: a time stamp at the start of every line, TX lines marked.
  const text = textOf(s.enc, bytes).replace(/\r\n?/g, '\n');
  let out = '';
  if (l.lastDir !== dir && !l.atLineStart) {
    out += '\n';
    l.atLineStart = true;
  }
  l.lastDir = dir;
  for (const part of text.split(/(?<=\n)/)) {
    if (l.atLineStart) out += `[${stamp()}] ${dir === 'tx' ? '→ ' : ''}`;
    out += part;
    l.atLineStart = part.endsWith('\n');
  }
  l.chunks.push(new TextEncoder().encode(out));
}

async function flushLog(s) {
  const l = s.log;
  if (!l || !l.chunks.length) return;
  const parts = l.chunks.splice(0);
  const all = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of parts) (all.set(c, o), (o += c.length));
  try {
    await X.call('append_file', { path: l.path, data: b64(all) });
    l.written += all.length;
  } catch (e) {
    X.note(String(e), true);
    stopLog(s);
  }
}

export function stopLog(s) {
  if (!s.log) return;
  clearInterval(s.log.timer);
  flushLog(s);
  X.note(`Logging stopped: ${s.log.path}`);
  s.log = null;
  X.renderToolbar();
}

export async function openLogDialog(s) {
  if (s.log) return stopLog(s);
  const last = X.store.get('log', { format: 'text', dir: '' });
  const safe = s.name.replace(/[^\w.-]+/g, '_');
  const dflt = () => `${last.dir ? last.dir.replace(/[\\/]$/, '') + '\\' : ''}${safe}-${stamp().slice(0, 19).replace(/[: ]/g, '-')}.log`;
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Log to file"><h3>Log ${X.esc(s.name)} to a file</h3>
    <div class="frm"><label class="full">File<span class="row"><input id="l-path" value="${X.esc(dflt())}" autocomplete="off"><button type="button" class="btn ghost sm" id="l-browse">Browse…</button></span></label>
    <label class="full">Format<select id="l-fmt"><option value="text"${last.format === 'text' ? ' selected' : ''}>Text with timestamps (received and sent)</option><option value="raw"${last.format === 'raw' ? ' selected' : ''}>Raw received bytes (exact copy, for binary data)</option></select></label></div>
    <p class="hint">New data is appended to the file while the session is open. The file is created if it does not exist.</p><p class="err-text" id="l-err" hidden></p>
    <div class="acts"><button type="button" class="btn ghost" id="l-cancel">Cancel</button><button class="btn">Start logging</button></div></form>`;
  document.body.append(ov);
  const q = (x) => ov.querySelector(x);
  const close = () => ov.remove();
  q('#l-cancel').onclick = close;
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  q('#l-browse').onclick = async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const p = await save({ defaultPath: q('#l-path').value, filters: [{ name: 'Log', extensions: ['log', 'txt', 'bin'] }] });
      if (p) q('#l-path').value = p;
    } catch {
      /* not in the desktop app */
    }
  };
  q('form').onsubmit = async (e) => {
    e.preventDefault();
    const path = q('#l-path').value.trim();
    if (!path) return;
    const format = q('#l-fmt').value;
    try {
      await X.call('append_file', { path, data: '' });
    } catch (err) {
      const m = q('#l-err');
      m.textContent = String(err);
      m.hidden = false;
      return;
    }
    X.store.set('log', { format, dir: path.replace(/[^\\/]*$/, '') });
    close();
    s.log = { path, format, chunks: [], written: 0, atLineStart: true, lastDir: null, timer: setInterval(() => flushLog(s), 500) };
    X.note(`Logging to ${path}`);
    X.renderToolbar();
  };
  q('#l-path').focus();
}

// ------------------------------------------------------------------ macros
export const getMacros = () => X.store.get('macros', []);
const putMacros = (m) => X.store.set('macros', m);

export function renderMacros() {
  const bar = X.$('#macros');
  const list = getMacros();
  bar.innerHTML = list.map((m) => `<button type="button" class="macro" data-m="${m.id}" title="${X.esc(m.text)}">${X.esc(m.label || m.text)}</button>`).join('') + `<button type="button" class="macro edit" id="m-edit" title="Add or change command buttons">${list.length ? '✎' : '+ Command buttons'}</button>`;
}

/** Parses "41 54 0D" or "4154 0d0a" into bytes; null when it is not valid hex. */
export function parseHex(text) {
  const clean = text.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (!clean || clean.length % 2 || /[^0-9a-f]/i.test(clean)) return null;
  return Uint8Array.from(clean.match(/../g).map((h) => parseInt(h, 16)));
}

export async function runMacro(id) {
  const m = getMacros().find((x) => x.id === id);
  const s = X.cur();
  if (!m || !s) return;
  if (m.hex) {
    const bytes = parseHex(m.text);
    if (!bytes) return X.note(`"${m.label || m.text}" is not valid hex`, true);
    return X.sendBytes(s, bytes);
  }
  const text = m.text.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  X.sendText(s, m.eol === false ? text : text + (X.EOL[s.lineEnd] ?? '\r\n'), m.text);
}

export function openMacroDialog() {
  let list = getMacros().map((m) => ({ ...m }));
  const ov = document.createElement('div');
  ov.className = 'ov';
  const draw = () => {
    ov.querySelector('.mrows').innerHTML = list
      .map(
        (m, i) => `<div class="mrow" data-i="${i}"><input data-k="label" placeholder="Button label" value="${X.esc(m.label)}" aria-label="Label"><input data-k="text" placeholder="${m.hex ? '41 54 0D 0A' : 'Command (\\r \\n \\t \\x1b allowed)'}" value="${X.esc(m.text)}" aria-label="Command"><label class="chk" title="Send as hex bytes"><input type="checkbox" data-k="hex"${m.hex ? ' checked' : ''}> hex</label><label class="chk" title="Add the line ending of this connection"><input type="checkbox" data-k="eol"${m.eol === false || m.hex ? '' : ' checked'}${m.hex ? ' disabled' : ''}> + Enter</label><button type="button" class="btn ghost sm" data-del aria-label="Remove">✕</button></div>`,
      )
      .join('') || '<p class="hint">No command buttons yet. Add one for a command you send often.</p>';
  };
  ov.innerHTML = `<form class="dlg wide" role="dialog" aria-label="Command buttons"><h3>Command buttons</h3><div class="mrows"></div>
    <div class="acts"><button type="button" class="btn ghost" id="m-add">+ Add button</button><span class="sp"></span><button type="button" class="btn ghost" id="m-cancel">Cancel</button><button class="btn">Save</button></div></form>`;
  document.body.append(ov);
  draw();
  const close = () => ov.remove();
  ov.querySelector('#m-cancel').onclick = close;
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  ov.querySelector('#m-add').onclick = () => {
    list.push({ id: 'm' + Date.now().toString(36) + list.length, label: '', text: '', hex: false, eol: true });
    draw();
    ov.querySelector('.mrow:last-child input')?.focus();
  };
  ov.addEventListener('input', (e) => {
    const row = e.target.closest('.mrow');
    if (!row) return;
    const m = list[+row.dataset.i];
    const k = e.target.dataset.k;
    m[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'hex') draw();
  });
  ov.addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]');
    if (!d) return;
    list.splice(+d.closest('.mrow').dataset.i, 1);
    draw();
  });
  ov.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    putMacros(list.filter((m) => m.text.trim()));
    close();
    renderMacros();
  };
}

// ------------------------------------------------------------------ sending a file
export async function openSendFileDialog() {
  const s = X.cur();
  if (!s) return;
  const last = X.store.get('sendfile', { file: '', mode: 'binary', delay: 20 });
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Send file"><h3>Send a file to ${X.esc(s.name)}</h3>
    <div class="frm"><label class="full">File<span class="row"><input id="sf-file" value="${X.esc(last.file)}" placeholder="C:\\data\\config.txt" autocomplete="off"><button type="button" class="btn ghost sm" id="sf-browse">Browse…</button></span></label>
    <label class="full">Send as<select id="sf-mode"><option value="binary"${last.mode === 'binary' ? ' selected' : ''}>Raw bytes, in small blocks</option><option value="lines"${last.mode === 'lines' ? ' selected' : ''}>Text, one line at a time</option></select></label>
    <label class="full">Pause between blocks or lines (ms)<input id="sf-delay" value="${last.delay}" inputmode="numeric"></label></div>
    <div class="bar" id="sf-bar" hidden><i></i></div><p class="hint" id="sf-msg">Slow boards need a longer pause. Received data is not saved to a file here; use Log for that.</p>
    <div class="acts"><button type="button" class="btn ghost" id="sf-cancel">Close</button><button class="btn" id="sf-go">Send</button></div></form>`;
  document.body.append(ov);
  const q = (x) => ov.querySelector(x);
  let cancelled = false;
  let running = false;
  const close = () => {
    cancelled = true;
    ov.remove();
  };
  q('#sf-cancel').onclick = () => (running ? (cancelled = true) : close());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && !running && close());
  q('#sf-browse').onclick = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const p = await open({ multiple: false, directory: false });
      if (typeof p === 'string') q('#sf-file').value = p;
    } catch {
      /* not in the desktop app */
    }
  };
  q('form').onsubmit = async (e) => {
    e.preventDefault();
    const file = q('#sf-file').value.trim();
    const mode = q('#sf-mode').value;
    const delay = Math.max(0, parseInt(q('#sf-delay').value, 10) || 0);
    const msg = q('#sf-msg');
    if (!file) return;
    if (s.state !== 'on') return (msg.textContent = 'Not connected. Connect first, then send.');
    X.store.set('sendfile', { file, mode, delay });
    let bytes;
    try {
      bytes = Uint8Array.from(atob(await X.call('read_file_b64', { path: file })), (c) => c.charCodeAt(0));
    } catch (err) {
      return (msg.textContent = String(err));
    }
    const chunks = [];
    if (mode === 'lines') {
      const eol = X.EOL[s.lineEnd] ?? '\r\n';
      for (const line of textOf(s.enc, bytes).split(/\r?\n/)) chunks.push(encodeText(s.enc, line + eol));
      if (chunks.length && chunks.at(-1).length === eol.length) chunks.pop();
    } else for (let i = 0; i < bytes.length; i += 256) chunks.push(bytes.subarray(i, i + 256));
    running = true;
    cancelled = false;
    q('#sf-go').disabled = true;
    q('#sf-cancel').textContent = 'Cancel';
    const bar = q('#sf-bar');
    bar.hidden = false;
    let sent = 0;
    for (let i = 0; i < chunks.length && !cancelled; i++) {
      try {
        await X.sendBytes(s, chunks[i], true);
      } catch (err) {
        msg.textContent = `Stopped: ${err}`;
        break;
      }
      sent += chunks[i].length;
      bar.firstElementChild.style.width = ((i + 1) / chunks.length) * 100 + '%';
      msg.textContent = `Sent ${sent} of ${bytes.length} bytes…`;
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    running = false;
    if (!ov.isConnected) return;
    q('#sf-go').disabled = false;
    q('#sf-cancel').textContent = 'Close';
    if (!msg.textContent.startsWith('Stopped')) msg.textContent = cancelled ? `Cancelled after ${sent} bytes.` : `Done. Sent ${sent} bytes.`;
  };
}

// ------------------------------------------------------------------ save the session to a file
const bytesToLatin = (u8) => {
  let out = '';
  for (let i = 0; i < u8.length; i += 4096) out += String.fromCharCode(...u8.subarray(i, i + 4096));
  return out;
};
const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
const printable = (u8) => [...u8].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : b === 10 || b === 13 || b === 9 ? ' ' : '.')).join('');

/** Terminal scrollback as plain text, one line per row, wrapped rows joined. */
function terminalText(s) {
  const buf = s.term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const l = buf.getLine(i);
    if (!l) continue;
    const t = l.translateToString(true);
    if (l.isWrapped && lines.length) lines[lines.length - 1] += t;
    else lines.push(t);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\r\n') + '\r\n';
}

const SAVE_FORMATS = {
  txt: { label: 'Plain text: what is in the terminal now (.txt)', ext: 'txt', build: (s) => terminalText(s) },
  log: {
    label: 'Log with timestamps: every received and sent chunk (.log)',
    ext: 'log',
    build: (s) => s.rec.map((r) => `${stamp(new Date(r.t))} ${r.dir.toUpperCase()} ${printable(r.bytes)}`).join('\r\n') + '\r\n',
  },
  csv: {
    label: 'Spreadsheet: time, direction, length, hex, text (.csv)',
    ext: 'csv',
    build: (s) =>
      'time,direction,bytes,hex,text\r\n' +
      s.rec.map((r) => [stamp(new Date(r.t)), r.dir.toUpperCase(), r.bytes.length, [...r.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '), printable(r.bytes)].map(csvCell).join(',')).join('\r\n') + '\r\n',
  },
};

export async function openSaveDialog(s) {
  const last = X.store.get('save', { format: 'txt', dir: '' });
  const safe = s.name.replace(/[^\w.-]+/g, '_');
  const nameFor = (fmt) => `${last.dir ? last.dir.replace(/[\\/]$/, '') + '\\' : ''}${safe}-${stamp().slice(0, 19).replace(/[: ]/g, '-')}.${SAVE_FORMATS[fmt].ext}`;
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Save"><h3>Save ${X.esc(s.name)}</h3>
    <div class="frm"><label class="full">Format<select id="v-fmt">${Object.entries(SAVE_FORMATS).map(([k, v]) => `<option value="${k}"${k === last.format ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
    <label class="full">File<span class="row"><input id="v-path" autocomplete="off"><button type="button" class="btn ghost sm" id="v-browse">Browse…</button></span></label></div>
    <p class="hint">Saves what is currently held in the terminal (up to 20,000 lines) or in the decoded list (the last ${1500} chunks). To record everything continuously, use Log…</p><p class="err-text" id="v-err" hidden></p>
    <div class="acts"><button type="button" class="btn ghost" id="v-cancel">Cancel</button><button class="btn">Save</button></div></form>`;
  document.body.append(ov);
  const q = (x) => ov.querySelector(x);
  const close = () => ov.remove();
  q('#v-path').value = nameFor(q('#v-fmt').value);
  q('#v-fmt').onchange = () => (q('#v-path').value = q('#v-path').value.replace(/\.\w+$/, '.' + SAVE_FORMATS[q('#v-fmt').value].ext));
  q('#v-cancel').onclick = close;
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  q('#v-browse').onclick = async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const p = await save({ defaultPath: q('#v-path').value, filters: [{ name: SAVE_FORMATS[q('#v-fmt').value].label, extensions: [SAVE_FORMATS[q('#v-fmt').value].ext] }] });
      if (p) q('#v-path').value = p;
    } catch {
      /* not in the desktop app */
    }
  };
  q('form').onsubmit = async (e) => {
    e.preventDefault();
    const path = q('#v-path').value.trim();
    if (!path) return;
    const format = q('#v-fmt').value;
    try {
      const text = SAVE_FORMATS[format].build(s);
      const bytes = new TextEncoder().encode(format === 'csv' ? '\ufeff' + text : text);
      await X.call('write_file', { path, data: btoa(bytesToLatin(bytes)) });
    } catch (err) {
      const m = q('#v-err');
      m.textContent = String(err);
      m.hidden = false;
      return;
    }
    X.store.set('save', { format, dir: path.replace(/[^\\/]*$/, '') });
    close();
    X.note(`Saved ${path}`);
  };
  q('#v-path').focus();
}
