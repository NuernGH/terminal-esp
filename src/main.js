import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { call, onSession, onFlash, b64ToBytes, inTauri } from './api.js';
import { FORMATS, formatBytes, hexToRgb } from './decode.js';
import * as F from './features.js';

const params = new URLSearchParams(location.search);
const popId = params.get('session');

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const EOL = { CR: '\r', LF: '\n', CRLF: '\r\n', None: '' };

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('esp-terminal.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('esp-terminal.' + k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

const S = {
  sessions: new Map(),
  active: null,
  layout: popId ? 'single' : store.get('layout', 'tabs'),
  note: null,
  pendingRemove: null,
};

// ------------------------------------------------------------------ display settings
// Colours for incoming/outgoing text and the decoded view. null = follow the theme.
const DISPLAY_DEFAULTS = { rx: null, tx: null, echo: true, arrow: true, ts: true, fmt: 'hex', split: 'h', swap: false, ratio: 0.5 };
let D = { ...DISPLAY_DEFAULTS, ...store.get('display', {}) };
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rxColour = () => D.rx || cssVar('--termfg');
const txColour = () => D.tx || cssVar('--cyan');

// ------------------------------------------------------------------ helpers
const get = (id) => S.sessions.get(id);
const cur = () => get(S.active);
const idOf = (el) => el.closest('[data-id]')?.dataset.id;
const stateClass = (s) => (s.state === 'on' ? 'on' : s.state === 'connecting' ? 'connecting' : '');
const stateTip = (s) =>
  s.state === 'off' ? 'Disconnected. Click to connect' : s.state === 'connecting' ? 'Connecting. Click to cancel' : 'Connected. Click to disconnect';
const addrOf = (c) =>
  c.kind === 'serial' ? `${c.port} · ${c.baud}` : c.kind === 'tcp' ? `${c.host}:${c.port}` : c.kind === 'ws' ? c.url : `udp://${c.host}:${c.port}`;
const typeOf = (c) => (c.kind === 'serial' ? 'Serial' : c.kind === 'ws' ? 'WebSocket' : c.kind === 'tcp' ? (c.protocol === 'telnet' ? 'Telnet' : 'TCP') : 'UDP');

const leds = (s, full) =>
  `<span class="io"><i class="led rx" data-led="rx" data-sid="${s.id}"></i>RX${full ? ` <b data-cnt="rx" data-sid="${s.id}"></b>` : ''}<i class="led tx" data-led="tx" data-sid="${s.id}"></i>TX${full ? ` <b data-cnt="tx" data-sid="${s.id}"></b>` : ''}</span>`;

function note(msg, isErr = false) {
  S.note = { msg, isErr };
  renderStatus();
  clearTimeout(note.t);
  note.t = setTimeout(() => {
    S.note = null;
    renderStatus();
  }, 6000);
}

function persist() {
  if (popId) return;
  store.set(
    'sessions',
    [...S.sessions.values()].map(({ id, name, config, lineEnd, autoReconnect, view, cell, enc, localEcho }) => ({ id, name, config, lineEnd, autoReconnect, view, cell, enc, localEcho })),
  );
}

// ------------------------------------------------------------------ terminal theme
const PALETTE = {
  light: { black: '#1b2430', red: '#c62839', green: '#14934a', yellow: '#9a6b00', blue: '#0a64d0', magenta: '#9b3fb5', cyan: '#0b7f98', white: '#8593a6',
    brightBlack: '#667487', brightRed: '#d6334a', brightGreen: '#1fae5c', brightYellow: '#b7791f', brightBlue: '#2f86f0', brightMagenta: '#b455d0', brightCyan: '#13a0be', brightWhite: '#d9dee5' },
  dark: { black: '#232c38', red: '#ff6b81', green: '#3ddc84', yellow: '#f0b64a', blue: '#4da3ff', magenta: '#d28bf0', cyan: '#4fd1e8', white: '#d5dde8',
    brightBlack: '#5b6a7e', brightRed: '#ff8a9b', brightGreen: '#6df0a4', brightYellow: '#ffd27a', brightBlue: '#7dbcff', brightMagenta: '#e3aaf7', brightCyan: '#85e2f2', brightWhite: '#ffffff' },
};
const scheme = window.matchMedia('(prefers-color-scheme: dark)');
function termTheme() {
  const css = getComputedStyle(document.documentElement);
  return {
    ...PALETTE[scheme.matches ? 'dark' : 'light'],
    background: css.getPropertyValue('--term').trim(),
    foreground: rxColour(),
    cursor: css.getPropertyValue('--accent').trim(),
    selectionBackground: scheme.matches ? '#2b4a73' : '#b3d4ff',
  };
}
scheme.addEventListener('change', () => S.sessions.forEach((s) => (s.term.options.theme = termTheme())));

// ------------------------------------------------------------------ sessions
function addSession(info) {
  const s = {
    id: info.id,
    name: info.name,
    config: info.config,
    lineEnd: info.lineEnd || 'CRLF',
    autoReconnect: info.autoReconnect ?? info.auto_reconnect ?? true,
    view: info.view ?? (info.decode ? 'split' : 'raw'),
    cell: info.cell ?? null,
    enc: info.enc ?? 'utf-8',
    localEcho: !!info.localEcho,
    decode: (info.view ?? (info.decode ? 'split' : 'raw')) !== 'raw',
    rec: [],
    state: info.state || 'off',
    rx: info.rx || 0,
    tx: info.tx || 0,
    rxAt: 0,
    txAt: 0,
    history: [],
    hpos: 0,
  };
  s.term = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'IBM Plex Mono', monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 20000,
    allowProposedApi: true,
    convertEol: true,
    theme: termTheme(),
  });
  s.fit = new FitAddon();
  s.term.loadAddon(s.fit);
  s.pane = document.createElement('div');
  s.pane.className = 'pane';
  s.pane.dataset.id = s.id;
  s.pane.innerHTML = `<header></header><div class="split">
    <div class="col rawcol"><div class="subhdr"><b>Raw</b></div><div class="slot"></div></div>
    <div class="divider" role="separator" title="Drag to resize, double-click to reset"><button type="button" class="swapbtn" title="Swap raw and decoded" aria-label="Swap raw and decoded">⇄</button></div>
    <div class="col deccol"><div class="subhdr"><b class="dectitle">Decoded</b><select class="decfmt" aria-label="Decode as">${FORMATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><button type="button" class="btn ghost sm decclear">Clear</button></div><div class="dec-head"><span>time</span><span></span><span></span><span>Raw</span><span class="decfmtname">Decoded</span></div><div class="dec" tabindex="0"></div></div>
  </div>`;
  s.slot = $('.slot', s.pane);
  s.dec = $('.dec', s.pane);
  $('.decfmt', s.pane).value = D.fmt;
  s.pane.classList.add('view-' + s.view);
  s.pane.classList.toggle('swap', D.swap);
  s.pane.style.setProperty('--decw', D.ratio * 100 + '%');
  s.pane.classList.toggle('split-v', D.split === 'v');
  s.pane.insertAdjacentHTML('beforeend', '<i class="gh gh-r" title="Drag to resize, double-click to reset"></i><i class="gh gh-b" title="Drag to resize, double-click to reset"></i>');
  $('#panes').append(s.pane);
  s.term.open(s.slot);
  new ResizeObserver(() => fitOne(s)).observe(s.slot);
  s.pane.addEventListener('mousedown', () => {
    if (S.layout === 'grid') select(s.id);
  });
  F.attachSearch(s);
  s.term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key === 'f') {
      F.openSearch(s);
      return false;
    }
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key === 'c' && s.term.hasSelection()) {
      navigator.clipboard?.writeText(s.term.getSelection()).catch(() => {});
      return false;
    }
    return true;
  });
  s.term.onData((d) => {
    const eol = EOL[s.lineEnd] || '\r';
    if (s.localEcho && s.state === 'on') s.term.write(d.replace(/\r/g, '\r\n').replace(/\x7f/g, '\b \b'));
    sendText(s, d.replace(/\r/g, eol));
  });
  S.sessions.set(s.id, s);
  return s;
}

function fitOne(s) {
  if (!s.slot.clientWidth || !s.slot.clientHeight) return;
  try {
    s.fit.fit();
  } catch {
    /* terminal not ready yet */
  }
}
const fitAll = () => S.sessions.forEach(fitOne);

async function replayBacklog(s) {
  try {
    const b64 = await call('session_backlog', { id: s.id });
    if (b64) {
      const bytes = b64ToBytes(b64);
      s.term.write(bytes);
      addRecord(s, 'rx', bytes.slice(-4096));
    }
  } catch {
    /* no backlog */
  }
}

// Decoded view: every chunk that arrives or is sent becomes a record (RX/TX, time, bytes).
// Chunks of the same direction less than 120 ms apart are merged into one record.
const MAX_REC = 1500;
const clock = (t) => {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

/** Plain-text form of received or sent bytes, control characters shown as escapes. */
const rawText = (bytes) =>
  new TextDecoder('utf-8').decode(bytes).replace(/[\x00-\x1f\x7f]/g, (c) =>
    c === '\r' ? '\\r' : c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\x1b' ? '\\e' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );

function paintRecord(s, r) {
  const stick = s.dec.scrollTop + s.dec.clientHeight >= s.dec.scrollHeight - 24;
  if (!r.el) {
    r.el = document.createElement('div');
    r.el.className = `rec ${r.dir}`;
    r.el.innerHTML = '<span class="ts"></span><span class="tag"></span><span class="len"></span><pre class="rawtxt"></pre><pre class="dectxt"></pre>';
    $('.tag', r.el).textContent = r.dir.toUpperCase();
    s.dec.append(r.el);
  }
  const ts = $('.ts', r.el);
  ts.textContent = clock(r.t);
  ts.hidden = !D.ts;
  $('.len', r.el).textContent = `${r.bytes.length} B`;
  $('.dectxt', r.el).textContent = formatBytes(r.bytes, D.fmt);
  if (s.view === 'aligned') $('.rawtxt', r.el).textContent = rawText(r.bytes);
  if (stick) s.dec.scrollTop = s.dec.scrollHeight;
}

function renderAllRecords(s) {
  s.dec.replaceChildren();
  for (const r of s.rec) {
    r.el = null;
    paintRecord(s, r);
  }
}

function addRecord(s, dir, bytes) {
  const now = Date.now();
  const last = s.rec[s.rec.length - 1];
  if (last && last.dir === dir && now - last.last < 120 && last.bytes.length + bytes.length <= 4096) {
    const merged = new Uint8Array(last.bytes.length + bytes.length);
    merged.set(last.bytes);
    merged.set(bytes, last.bytes.length);
    last.bytes = merged;
    last.last = now;
    if (s.decode) paintRecord(s, last);
    return;
  }
  const r = { dir, t: now, last: now, bytes: bytes.slice() };
  s.rec.push(r);
  if (s.rec.length > MAX_REC) s.rec.shift().el?.remove();
  if (s.decode) paintRecord(s, r);
}

function setView(s, view) {
  s.view = view;
  s.decode = view !== 'raw';
  s.pane.classList.remove('view-raw', 'view-split', 'view-decoded', 'view-aligned');
  s.pane.classList.add('view-' + view);
  if (s.decode) renderAllRecords(s);
  persist();
  renderToolbar();
  requestAnimationFrame(fitAll);
}

/** Shows a command you sent, in the TX colour, on its own line. */
function echoTx(s, text) {
  if (!D.echo) return;
  const [r, g, b] = hexToRgb(txColour());
  const body = text.replace(/[\r\n]+$/, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  // Wait for pending output to be parsed so we know whether the cursor is mid-line.
  s.term.write('', () => {
    const lead = s.term.buffer.active.cursorX > 0 ? '\r\n' : '';
    s.term.write(`${lead}\x1b[38;2;${r};${g};${b}m${D.arrow ? '→ ' : ''}${body}\x1b[39m\r\n`);
  });
}

function applyDisplay() {
  const root = document.documentElement.style;
  if (D.rx) root.setProperty('--rx', D.rx);
  else root.removeProperty('--rx');
  if (D.tx) root.setProperty('--tx', D.tx);
  else root.removeProperty('--tx');
  for (const s of S.sessions.values()) {
    s.term.options.theme = termTheme();
    s.pane.classList.toggle('split-v', D.split === 'v');
    s.pane.classList.toggle('swap', D.swap);
    s.pane.style.setProperty('--decw', D.ratio * 100 + '%');
    $('.decfmt', s.pane).value = D.fmt;
    if (s.decode) renderAllRecords(s);
  }
  requestAnimationFrame(fitAll);
}

const bytesToB64 = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** Sends raw bytes (hex macros, files). Throws on failure when `quiet`, otherwise shows a note. */
async function sendBytes(s, bytes, quiet) {
  if (s.state !== 'on') {
    if (quiet) throw new Error('Not connected');
    note('Not connected. Click the status dot to connect.', true);
    return false;
  }
  try {
    await call('session_send_bytes', { id: s.id, data: bytesToB64(bytes) });
    addRecord(s, 'tx', bytes);
    if (!quiet && s.log) F.logWrite(s, 'tx', bytes);
    return true;
  } catch (e) {
    if (quiet) throw e;
    note(String(e), true);
    return false;
  }
}

async function sendText(s, text, echo) {
  if (!text) return true;
  if (s.state !== 'on') {
    note('Not connected. Click the status dot to connect.', true);
    return false;
  }
  try {
    let sent;
    if (s.enc && s.enc !== 'utf-8') {
      sent = F.encodeText(s.enc, text);
      await call('session_send_bytes', { id: s.id, data: bytesToB64(sent) });
    } else {
      await call('session_send', { id: s.id, data: text });
      sent = new TextEncoder().encode(text);
    }
    addRecord(s, 'tx', sent);
    if (s.log) F.logWrite(s, 'tx', sent);
    if (echo !== undefined) echoTx(s, echo);
    return true;
  } catch (e) {
    note(String(e), true);
    return false;
  }
}

async function toggle(id) {
  const s = get(id);
  if (!s) return;
  try {
    await call(s.state === 'off' ? 'session_connect' : 'session_disconnect', { id });
  } catch (e) {
    note(String(e), true);
  }
}

async function removeSession(id) {
  const s = get(id);
  if (!s) return;
  await call('session_remove', { id });
  s.term.dispose();
  s.pane.remove();
  S.sessions.delete(id);
  clearCells();
  if (S.active === id) S.active = [...S.sessions.keys()].pop() ?? null;
  persist();
  renderAll();
}

function select(id) {
  if (S.active === id) {
    cur()?.term.focus();
    return;
  }
  S.active = id;
  store.set('active', id);
  // Update in place (no rebuild) so a double-click on a tab can still start a rename.
  for (const el of $$('.tab[data-id], .card[data-id]')) el.setAttribute('aria-selected', String(el.dataset.id === id));
  for (const p of S.sessions.values()) p.pane.classList.toggle('active', p.id === id);
  renderToolbar();
  renderStatus();
  updateTitle();
  const s = cur();
  if (s) {
    requestAnimationFrame(() => {
      fitOne(s);
      if (!$('.ren')) s.term.focus();
    });
  }
}

function setLayout(l) {
  S.layout = l;
  store.set('layout', l);
  renderAll();
  requestAnimationFrame(fitAll);
}

// ------------------------------------------------------------------ backend events
function onEvent(ev) {
  if (ev.type === 'stats') {
    for (const r of ev.rows) {
      const s = get(r.id);
      if (!s) continue;
      if (r.tx > s.tx) s.txAt = Date.now();
      s.rx = r.rx;
      s.tx = r.tx;
    }
    return;
  }
  const s = get(ev.id);
  if (!s) return;
  if (ev.type === 'data') {
    const bytes = b64ToBytes(ev.data);
    s.term.write(F.forTerminal(s.enc, bytes));
    addRecord(s, 'rx', bytes);
    if (s.log) F.logWrite(s, 'rx', bytes);
    if (s.plot) F.plotFeed(s, F.textOf(s.enc, bytes));
    s.rxAt = Date.now();
  } else if (ev.type === 'meta') {
    s.name = ev.name;
    persist();
    renderAll();
  } else if (ev.type === 'settings') {
    s.config = ev.config;
    s.autoReconnect = ev.auto_reconnect;
    persist();
    renderAll();
  } else if (ev.type === 'state') {
    const was = s.state;
    s.state = ev.state;
    if (ev.state === 'on') s.term.write('\x1b[32m-- connected --\x1b[0m\r\n');
    else if (ev.state === 'connecting') {
      if (ev.message) s.term.write(`\x1b[33m-- ${ev.message} --\x1b[0m\r\n`);
    } else if (ev.state === 'off') {
      if (ev.message) {
        s.term.write(`\x1b[31m-- ${ev.message} --\x1b[0m\r\n`);
        if (s.id === S.active) note(ev.message, true);
      } else if (was !== 'off') s.term.write('\x1b[33m-- disconnected --\x1b[0m\r\n');
    }
    renderAll();
  }
}

// ------------------------------------------------------------------ rendering
function mountShell() {
  const multi = popId ? ' hidden' : '';
  $('#app').innerHTML = `
    <div class="toolbar">
      <button class="btn only-multi" id="b-new"${multi}>+ New connection</button>
      <div class="seg only-multi" id="lay"${multi}>
        <button data-l="tabs">Tabs</button><button data-l="rail">Rail</button><button data-l="grid">Grid</button>
      </div>
      <span class="sp"></span>
      <label class="only-grid" id="cols-wrap" hidden>Columns <select id="grid-cols"><option value="auto">Auto</option><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
      <span class="chip" id="t-addr"></span>
      <select class="baud" id="t-baud" title="Baud rate. Changes apply immediately." aria-label="Baud rate"></select>
      <button class="btn ghost sm" id="t-auto" title="Reconnect automatically when the connection drops"></button>
      <button class="btn ghost sm" id="t-conn"></button>
      <button class="btn ghost sm" id="t-settings">Port settings…</button>
      <button class="btn ghost sm" id="t-rename">Rename</button>
      <button class="btn ghost sm only-multi" id="t-win"${multi}>New window</button>
      <div class="seg" id="t-view" title="Raw terminal, raw and decoded side by side, or decoded only"><button data-v="raw">Raw</button><button data-v="split">Split</button><button data-v="decoded">Decoded</button><button data-v="aligned" title="Raw and decoded side by side, one row per message">Aligned</button></div>
      <button class="btn ghost sm" id="t-swap" title="Swap the raw and decoded sections">⇄ Swap</button>
      <button class="btn ghost sm" id="t-disp" title="Colours and decoding options">Display…</button>
      <button class="btn ghost sm" id="t-find" title="Search the terminal (Ctrl+F)">Search</button>
      <button class="btn ghost sm" id="t-plot" title="Plot numbers found in the incoming text">Plot</button>
      <button class="btn ghost sm" id="t-log" title="Save everything to a log file"></button>
      <button class="btn ghost sm" id="t-clear">Clear</button>
      <button class="btn sm" id="t-flash">Flash .bin…</button>
    </div>
    <div class="main">
      <aside class="rail" id="rail"></aside>
      <section class="stage">
        <div class="tabs" id="tabs" role="tablist"></div>
        <div class="panes" id="panes"><div class="empty" id="empty"><h2>No connections yet</h2>Add a board by serial port, TCP/Telnet or UDP. Give it a name so you can tell your boards apart.<br><br><button class="btn" id="b-new2">+ New connection</button></div></div>
        <div class="macros" id="macros"></div>
        <form class="sendbar" id="sendbar"><input id="send-in" placeholder="Type a command and press Enter…" autocomplete="off" spellcheck="false" aria-label="Send to board"><button class="btn sm">Send</button><button type="button" class="btn ghost sm" id="b-file" title="Send a file to the board">Send file…</button></form>
      </section>
    </div>
    <div class="status" id="status"></div>`;
}

function renderTabs() {
  $('#tabs').innerHTML =
    [...S.sessions.values()]
      .map(
        (s) => `<div class="tab" role="tab" tabindex="0" data-id="${s.id}" aria-selected="${s.id === S.active}">
          <span class="st ${stateClass(s)}" data-tog title="${stateTip(s)}"></span><span class="nm" data-rename>${esc(s.name)}</span>${leds(s)}
          <span class="x" data-remove title="Remove this connection">${S.pendingRemove === s.id ? 'Remove?' : '✕'}</span></div>`,
      )
      .join('') + '<button class="tab plus" id="b-new3" aria-label="New connection">+</button>';
}

function renderRail() {
  // Rebuilding would close a baud dropdown that is open; catch up once it loses focus.
  if (document.activeElement?.matches?.('#rail select')) {
    S.railDirty = true;
    return;
  }
  S.railDirty = false;
  $('#rail').innerHTML =
    [...S.sessions.values()]
      .map(
        (s) => `<div class="card" role="button" tabindex="0" data-id="${s.id}" aria-selected="${s.id === S.active}">
          <span class="r1"><span class="st ${stateClass(s)}" data-tog title="${stateTip(s)}"></span><span data-rename>${esc(s.name)}</span>
          <span class="x" data-remove style="margin-left:auto;opacity:.6;cursor:pointer">${S.pendingRemove === s.id ? 'Remove?' : '✕'}</span></span>
          <span class="r2">${s.config.kind === 'serial' ? `${typeOf(s.config)} · ${esc(s.config.port)} · <select class="baud" aria-label="Baud rate" title="Baud rate. Changes apply immediately.">${baudOptions(s.config.baud)}</select>` : `${typeOf(s.config)} · ${esc(addrOf(s.config))}`}</span><span class="r2" style="margin-left:-7px">${leds(s, true)}</span></div>`,
      )
      .join('') + '<button class="btn ghost" id="b-new4">+ New connection</button>';
}

function renderPaneHeaders() {
  for (const s of S.sessions.values()) {
    $('header', s.pane).innerHTML = `<span class="st ${stateClass(s)}" data-tog title="${stateTip(s)}"></span><span data-rename>${esc(s.name)}</span>${leds(s, true)}<span class="rt">${s.config.kind === 'serial' ? `<span class="chip">${esc(s.config.port)}</span><select class="baud" aria-label="Baud rate" title="Baud rate. Changes apply immediately.">${baudOptions(s.config.baud)}</select>` : `<span class="chip">${esc(addrOf(s.config))}</span>`}</span>`;
    s.pane.dataset.id = s.id;
    s.pane.classList.toggle('active', s.id === S.active);
  }
}

function renderToolbar() {
  const s = cur();
  $$('#lay button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.l === S.layout)));
  for (const id of ['t-addr', 't-conn', 't-settings', 't-rename', 't-clear', 't-auto', 't-view', 't-find', 't-plot', 't-log']) $('#' + id).hidden = !s;
  $('#t-swap').hidden = !s || s.view !== 'split';
  $('#cols-wrap').hidden = S.layout !== 'grid';
  $('#grid-cols').value = String(store.get('cols', 'auto'));
  const serial = s?.config.kind === 'serial';
  $('#t-baud').hidden = !serial;
  if (serial) $('#t-baud').innerHTML = baudOptions(s.config.baud);
  if (s) {
    const a = $('#t-auto');
    a.textContent = `Reconnect: ${s.autoReconnect ? 'On' : 'Off'}`;
    a.setAttribute('aria-pressed', String(!!s.autoReconnect));
    $$('#t-view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s.view)));
    $('#t-plot').setAttribute('aria-pressed', String(!!s.plot));
    $('#t-log').textContent = s.log ? '● Logging' : 'Log…';
    $('#t-log').setAttribute('aria-pressed', String(!!s.log));
  }
  $('#t-win').hidden = !s || !!popId;
  $('#t-flash').hidden = !!popId;
  if (!s) return;
  $('#t-addr').textContent = serial ? `Serial · ${s.config.port}` : `${typeOf(s.config)} · ${addrOf(s.config)}`;
  const c = $('#t-conn');
  c.textContent = s.state === 'off' ? 'Connect' : s.state === 'connecting' ? 'Cancel' : 'Disconnect';
  c.className = 'btn sm' + (s.state === 'on' ? ' ghost' : '');
}

let VERSION = '';
if (inTauri) import('@tauri-apps/api/app').then((m) => m.getVersion()).then((v) => ((VERSION = v), renderStatus())).catch(() => {});

function renderStatus() {
  const s = cur();
  const n = S.note;
  $('#status').innerHTML = s
    ? `<span>${s.state === 'on' ? '● Connected' : s.state === 'connecting' ? '◌ Connecting…' : '○ Disconnected'} · ${esc(s.name)}</span>${leds(s, true)}<span>${esc(s.lineEnd)}</span>${n ? `<span class="msg ${n.isErr ? 'err' : ''}">${esc(n.msg)}</span>` : ''}`
    : `<span>Ready</span>${n ? `<span class="msg ${n.isErr ? 'err' : ''}">${esc(n.msg)}</span>` : ''}`;
  if (VERSION) $('#status').insertAdjacentHTML('beforeend', `<span class="ver" title="App version">v${esc(VERSION)}</span>`);
}

function updateTitle() {
  const s = cur();
  document.title = s ? `${s.name} — ESP Terminal` : 'ESP Terminal';
  if (inTauri) import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().setTitle(document.title)).catch(() => {});
}

function renderAll() {
  const app = $('#app');
  app.className = 'layout-' + S.layout;
  renderTabs();
  renderRail();
  renderPaneHeaders();
  renderToolbar();
  renderStatus();
  const none = S.sessions.size === 0;
  $('#empty').hidden = !none;
  $('#sendbar').hidden = none;
  const cols = store.get('cols', 'auto');
  $('#panes').style.gridTemplateColumns = S.layout === 'grid' && cols !== 'auto' ? `repeat(${cols}, minmax(0, 1fr))` : '';
  applyGridSizes();
  for (const x of S.sessions.values()) {
    x.pane.style.gridColumn = S.layout === 'grid' && x.cell ? String(x.cell.c + 1) : '';
    x.pane.style.gridRow = S.layout === 'grid' && x.cell ? String(x.cell.r + 1) : '';
  }
  updateTitle();
  requestAnimationFrame(fitAll);
}

// LEDs and counters refresh on a timer so traffic never forces a re-render.
setInterval(() => {
  const now = Date.now();
  for (const el of $$('[data-led]')) {
    const s = get(el.dataset.sid);
    el.classList.toggle('lit', !!s && now - (s[el.dataset.led + 'At'] || 0) < 220);
  }
  for (const el of $$('[data-cnt]')) {
    const s = get(el.dataset.sid);
    const t = s ? fmt(s[el.dataset.cnt] || 0) : '';
    if (el.textContent !== t) el.textContent = t;
  }
}, 120);

// ------------------------------------------------------------------ rename
function startRename(id, el) {
  const s = get(id);
  if (!s || !el) return;
  const input = document.createElement('input');
  input.className = 'ren';
  input.value = s.name;
  input.setAttribute('aria-label', 'Session name');
  el.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (ok && name && name !== s.name) {
      s.name = name;
      await call('session_rename', { id, name });
      persist();
    }
    renderAll();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}
const visibleName = (id) => $$(`[data-id="${id}"] [data-rename]`).find((e) => e.offsetParent !== null);

// ------------------------------------------------------------------ connection dialog
const BOARDS = [
  { name: 'Arduino Uno', mcu: 'atmega328p', programmer: 'arduino', baud: 115200 },
  { name: 'Arduino Nano (new bootloader)', mcu: 'atmega328p', programmer: 'arduino', baud: 115200 },
  { name: 'Arduino Nano (old bootloader)', mcu: 'atmega328p', programmer: 'arduino', baud: 57600 },
  { name: 'Pro Mini / Duemilanove (16 MHz)', mcu: 'atmega328p', programmer: 'arduino', baud: 57600 },
  { name: 'Arduino Mega 2560', mcu: 'atmega2560', programmer: 'wiring', baud: 115200 },
  { name: 'Custom AVR board', mcu: '', programmer: 'arduino', baud: 115200 },
];
const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600, 1500000];
const baudOptions = (cur) =>
  [...new Set([...BAUDS, cur])].sort((a, b) => a - b).map((b) => `<option${b === cur ? ' selected' : ''}>${b}</option>`).join('');
const HINTS = {
  serial: 'A board plugged in by USB. Type a port name such as COM5 if it is not listed.',
  tcp: 'Telnet or raw TCP to a WiFi serial bridge (ESP-Link, ESP3D, ser2net or your own sketch).',
  udp: 'Connectionless datagrams. Use the same local port in the board firmware.',
  ws: 'A WebSocket endpoint, for example the one an ESP32 web server or a browser tool exposes. Text and binary messages are shown as a stream.',
};

async function openDialog(editId) {
  const editing = editId ? get(editId) : null;
  const c = editing?.config ?? { kind: 'tcp', host: '', port: 23, protocol: 'telnet' };
  let type = c.kind;
  const ports = await call('list_serial_ports').catch(() => []);
  const opt = (vals, sel) => vals.map((v) => `<option${String(v) === String(sel) ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Connection">
    <h3>${editing ? 'Connection settings' : 'New connection'}</h3>
    <div class="frm"><label class="full">Session name<input id="d-name" value="${esc(editing?.name ?? `Board ${S.sessions.size + 1}`)}" autocomplete="off"></label></div>
    <div class="seg" id="d-type">
      <button type="button" data-t="serial">Serial<small>COM port (USB)</small></button>
      <button type="button" data-t="tcp">TCP / Telnet<small>WiFi serial bridge</small></button>
      <button type="button" data-t="udp">UDP<small>Datagrams</small></button>
      <button type="button" data-t="ws">WebSocket<small>ws:// or wss://</small></button>
    </div>
    <div class="frm" data-for="serial">
      <label class="full">Port<input id="d-port" list="d-ports" value="${esc(c.kind === 'serial' ? c.port : ports[0]?.name ?? '')}" autocomplete="off"><datalist id="d-ports">${ports.map((p) => `<option value="${esc(p.name)}">${esc(p.description)}</option>`).join('')}</datalist></label>
      <label>Baud rate<select id="d-baud">${opt(BAUDS, c.kind === 'serial' ? c.baud : 115200)}</select></label>
      <label>Data bits<select id="d-bits">${opt([8, 7, 6, 5], c.kind === 'serial' ? c.data_bits : 8)}</select></label>
      <label>Parity<select id="d-par">${opt(['none', 'even', 'odd'], c.kind === 'serial' ? c.parity : 'none')}</select></label>
      <label>Stop bits<select id="d-stop">${opt([1, 2], c.kind === 'serial' ? c.stop_bits : 1)}</select></label>
      <label class="full">Flow control<select id="d-flow">${opt(['none', 'rtscts', 'xonxoff'], c.kind === 'serial' ? c.flow : 'none')}</select></label>
      <label class="chk full"><input type="checkbox" id="d-reset"${c.kind === 'serial' && c.reset_on_connect ? ' checked' : ''}> Reset the board when connecting (pulses RTS)</label>
    </div>
    <div class="frm" data-for="tcp">
      <label>Host or IP<input id="d-host" value="${esc(c.kind === 'tcp' ? c.host : '')}" placeholder="192.168.1.60" autocomplete="off"></label>
      <label>Port<input id="d-tport" value="${c.kind === 'tcp' ? c.port : 23}" inputmode="numeric"></label>
      <label class="full">Protocol<select id="d-proto"><option value="telnet"${c.kind === 'tcp' && c.protocol === 'raw' ? '' : ' selected'}>Telnet (strips negotiation bytes)</option><option value="raw"${c.kind === 'tcp' && c.protocol === 'raw' ? ' selected' : ''}>Raw TCP</option></select></label>
    </div>
    <div class="frm" data-for="udp">
      <label>Remote host<input id="d-uhost" value="${esc(c.kind === 'udp' ? c.host : '')}" placeholder="192.168.1.60" autocomplete="off"></label>
      <label>Remote port<input id="d-uport" value="${c.kind === 'udp' ? c.port : 4210}" inputmode="numeric"></label>
      <label>Local listen port (0 = automatic)<input id="d-ulocal" value="${c.kind === 'udp' ? c.local_port : 4210}" inputmode="numeric"></label>
    </div>
    <div class="frm" data-for="ws">
      <label class="full">URL<input id="d-wsurl" value="${esc(c.kind === 'ws' ? c.url : '')}" placeholder="ws://192.168.1.60:81/" autocomplete="off" spellcheck="false"></label>
    </div>
    <div class="scanbox" id="d-scanbox">
      <div class="top"><button type="button" class="btn ghost sm" id="d-scan">Scan network</button>
        <label style="display:flex;gap:5px;align-items:center;font-size:11.5px;color:var(--mute)">Ports <input id="d-sports" value="23, 8266"></label>
        <span id="d-scanmsg">Looks for boards via mDNS and probes your local /24 subnet.</span></div>
      <div class="found" id="d-found"></div>
    </div>
    <div class="frm"><label>Line ending when you press Enter<select id="d-eol">${opt(['CR', 'LF', 'CRLF'], editing?.lineEnd ?? 'CRLF')}</select></label>
      <label>Text encoding<select id="d-enc">${F.ENCODINGS.map(([v, l]) => `<option value="${v}"${(editing?.enc ?? 'utf-8') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="chk full"><input type="checkbox" id="d-echo"${editing?.localEcho ? ' checked' : ''}> Local echo: show what I type (for boards that do not echo it back)</label>
      <label class="chk full"><input type="checkbox" id="d-auto"${editing?.autoReconnect ?? true ? ' checked' : ''}> Reconnect automatically when the connection drops (and keep trying until the board is back)</label></div>
    <p class="hint" id="d-hint"></p><p class="err-text" id="d-err" hidden></p>
    <div class="acts"><button type="button" class="btn ghost" id="d-cancel">Cancel</button><button class="btn">${editing ? 'Save' : 'Add session'}</button></div>
  </form>`;
  document.body.append(ov);
  const q = (s) => $(s, ov);
  const close = () => ov.remove();
  const setType = (t) => {
    type = t;
    $$('#d-type button', ov).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
    $$('[data-for]', ov).forEach((f) => (f.hidden = f.dataset.for !== t));
    q('#d-scanbox').hidden = t === 'serial' || t === 'ws';
    q('#d-hint').textContent = HINTS[t];
  };
  setType(type);
  $$('#d-type button', ov).forEach((b) => (b.onclick = () => setType(b.dataset.t)));
  q('#d-cancel').onclick = close;
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  q('#d-name').focus();

  q('#d-scan').onclick = async () => {
    const btn = q('#d-scan');
    const msg = q('#d-scanmsg');
    const list = q('#d-found');
    const sp = q('#d-sports')
      .value.split(/[ ,]+/)
      .map(Number)
      .filter((n) => n > 0 && n < 65536);
    btn.disabled = true;
    list.innerHTML = '';
    msg.textContent = 'Scanning your network…';
    try {
      const found = await call('scan_network', { ports: sp.length ? sp : [23] });
      msg.textContent = found.length ? `${found.length} found. Click one to fill the form.` : 'Nothing found. Check the ports, or enter the address by hand.';
      list.innerHTML = found
        .map((f, i) => `<button type="button" data-f="${i}"><span>${esc(f.name)}<br><small>${esc(f.host)}:${f.port} · ${f.source === 'mdns' ? 'mDNS' : 'port scan'}</small></span><span class="tag">${f.protocol === 'telnet' ? 'Telnet' : 'Raw TCP'}</span></button>`)
        .join('');
      $$('#d-found button', ov).forEach(
        (b) =>
          (b.onclick = () => {
            const f = found[+b.dataset.f];
            if (f.name !== f.host) q('#d-name').value = f.name;
            if (type === 'udp') q('#d-uhost').value = f.host;
            else {
              q('#d-host').value = f.host;
              q('#d-tport').value = f.port;
              q('#d-proto').value = f.protocol;
            }
          }),
      );
    } catch (e) {
      msg.textContent = `Scan failed: ${e}`;
    }
    btn.disabled = false;
  };

  q('form').onsubmit = async (e) => {
    e.preventDefault();
    const err = (m) => {
      const p = q('#d-err');
      p.textContent = m;
      p.hidden = false;
    };
    const port = (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n < 65536 ? n : NaN;
    };
    let config;
    if (type === 'serial') {
      const p = q('#d-port').value.trim();
      if (!p) return err('Enter a serial port, for example COM5.');
      config = { kind: 'serial', port: p, baud: +q('#d-baud').value, data_bits: +q('#d-bits').value, parity: q('#d-par').value, stop_bits: +q('#d-stop').value, flow: q('#d-flow').value, reset_on_connect: q('#d-reset').checked };
    } else if (type === 'tcp') {
      const host = q('#d-host').value.trim();
      const pn = port(q('#d-tport').value);
      if (!host) return err('Enter the board’s host name or IP address.');
      if (!(pn > 0)) return err('Enter a port between 1 and 65535.');
      config = { kind: 'tcp', host, port: pn, protocol: q('#d-proto').value };
    } else if (type === 'ws') {
      const url = q('#d-wsurl').value.trim();
      if (!/^wss?:\/\/\S+$/i.test(url)) return err('Enter a URL that starts with ws:// or wss://');
      config = { kind: 'ws', url };
    } else {
      const host = q('#d-uhost').value.trim();
      const pn = port(q('#d-uport').value);
      const ln = port(q('#d-ulocal').value);
      if (!host) return err('Enter the board’s host name or IP address.');
      if (!(pn > 0)) return err('Enter a remote port between 1 and 65535.');
      if (Number.isNaN(ln)) return err('Enter a local port between 0 and 65535.');
      config = { kind: 'udp', host, port: pn, local_port: ln };
    }
    const name = q('#d-name').value.trim() || `Board ${S.sessions.size + 1}`;
    const lineEnd = q('#d-eol').value;
    const enc = q('#d-enc').value;
    const localEcho = q('#d-echo').checked;
    const autoReconnect = q('#d-auto').checked;
    close();
    if (editing) {
      const wasOn = editing.state !== 'off';
      editing.name = name;
      editing.config = config;
      editing.lineEnd = lineEnd;
      editing.enc = enc;
      editing.localEcho = localEcho;
      editing.autoReconnect = autoReconnect;
      await call('session_create', { id: editing.id, name, config, autoReconnect });
      persist();
      renderAll();
      if (wasOn) {
        await call('session_disconnect', { id: editing.id });
        await call('session_connect', { id: editing.id });
      }
    } else {
      const id = 's' + Date.now().toString(36);
      await call('session_create', { id, name, config, autoReconnect });
      addSession({ id, name, config, lineEnd, autoReconnect, enc, localEcho });
      persist();
      renderAll();
      select(id); // added disconnected: the user connects explicitly
    }
  };
}

// ------------------------------------------------------------------ firmware upload dialog
async function openFlashDialog() {
  const s = cur();
  const last = store.get('flash', {});
  const sc = s?.config;
  const ports = await call('list_serial_ports').catch(() => []);
  const tool = await call('esptool_path').catch(() => null);
  const avr = await call('avrdude_path').catch(() => null);
  let method = last.method || (sc && sc.kind !== 'serial' ? 'ota' : 'serial');
  let running = false;
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Flash firmware">
    <h3>Flash firmware${s ? ` to ${esc(s.name)}` : ''}</h3>
    <div class="frm"><label class="full">Firmware file (.bin)
      <span class="row"><input id="f-file" value="${esc(last.file || '')}" placeholder="C:\\firmware\\app.bin" autocomplete="off"><button type="button" class="btn ghost sm" id="f-browse">Browse…</button></span></label></div>
    <div class="seg" id="f-method">
      <button type="button" data-m="serial">ESP · cable<small>esptool, COM port</small></button>
      <button type="button" data-m="ota">ESP · WiFi<small>Arduino OTA</small></button>
      <button type="button" data-m="avr">Arduino<small>AVR boards, .hex</small></button>
    </div>
    <div class="frm" data-for="serial">
      <label class="full">Port<input id="f-port" list="f-ports" value="${esc(sc?.kind === 'serial' ? sc.port : last.port || ports[0]?.name || '')}" autocomplete="off"><datalist id="f-ports">${ports.map((p) => `<option value="${esc(p.name)}">${esc(p.description)}</option>`).join('')}</datalist></label>
      <label>Flash speed<select id="f-baud">${[115200, 230400, 460800, 921600].map((b) => `<option${b === (last.baud || 460800) ? ' selected' : ''}>${b}</option>`).join('')}</select></label>
      <label>Start address<input id="f-addr" list="f-addrs" value="${esc(last.address || '0x10000')}" autocomplete="off"><datalist id="f-addrs"><option value="0x10000">app image</option><option value="0x0">merged image / ESP8266</option><option value="0x1000">ESP32 bootloader</option></datalist></label>
      <label class="chk full"><input type="checkbox" id="f-erase"> Erase the whole flash first (also wipes saved WiFi settings)</label>
      <p class="hint full">${tool ? 'Uses esptool: ' + esc(tool) : '<span class="err-text">esptool was not found. The installer bundles it; a local build needs esptool on PATH.</span>'}<br>Typical addresses: 0x10000 for an app .bin from Arduino or PlatformIO, 0x0 for a merged image or an ESP8266 firmware.</p>
    </div>
    <div class="frm" data-for="avr">
      <label class="full">Board<select id="f-board">${BOARDS.map((b, i) => `<option value="${i}"${i === (last.board ?? 0) ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <label class="full">Port<input id="f-aport" list="f-ports" value="${esc(sc?.kind === 'serial' ? sc.port : last.aport || ports[0]?.name || '')}" autocomplete="off"></label>
      <label>Programmer<select id="f-prog">${['arduino', 'wiring', 'stk500v1', 'stk500v2'].map((x) => `<option>${x}</option>`).join('')}</select></label>
      <label>Chip<input id="f-mcu" autocomplete="off"></label>
      <label>Speed<select id="f-abaud">${[19200, 57600, 115200, 230400].map((x) => `<option>${x}</option>`).join('')}</select></label>
      <p class="hint full">${avr ? 'Uses avrdude: ' + esc(avr) : '<span class="err-text">avrdude was not found. The installer bundles it; a local build needs avrdude on PATH.</span>'}<br>Needs a compiled <b>.hex</b> file. In the Arduino IDE use Sketch → Export Compiled Binary, then pick the .hex without “with_bootloader” in its name. A .ino source file has to be compiled first.</p>
    </div>
    <div class="frm" data-for="ota">
      <label>Board address<input id="f-host" value="${esc(sc && sc.kind !== 'serial' ? sc.host : last.host || '')}" placeholder="192.168.1.60" autocomplete="off"></label>
      <label>OTA port<input id="f-oport" list="f-oports" value="${last.oport || 3232}" inputmode="numeric"><datalist id="f-oports"><option value="3232">ESP32</option><option value="8266">ESP8266</option></datalist></label>
      <label>OTA password (if set)<input id="f-pass" type="password" autocomplete="off"></label>
      <label>Target<select id="f-target"><option value="fw">Firmware</option><option value="fs">Filesystem image</option></select></label>
      <p class="hint full">The sketch must include ArduinoOTA. Allow ESP Terminal through the Windows firewall on private networks, because the board connects back to this PC to fetch the file.</p>
    </div>
    <div id="f-run" hidden><div class="prog"><i id="f-bar"></i></div><p class="hint" id="f-msg"></p><pre class="log" id="f-log"></pre></div>
    <p class="err-text" id="f-err" hidden></p>
    <div class="acts"><button type="button" class="btn ghost" id="f-close">Close</button><button class="btn" id="f-go">Flash</button></div>
  </form>`;
  document.body.append(ov);
  const q = (x) => $(x, ov);
  let off = () => {};
  const close = () => {
    off();
    ov.remove();
  };
  const setMethod = (m) => {
    method = m;
    $$('#f-method button', ov).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
    $$('[data-for]', ov).forEach((f) => (f.hidden = f.dataset.for !== m));
  };
  setMethod(method);
  $$('#f-method button', ov).forEach((b) => (b.onclick = () => !running && setMethod(b.dataset.m)));
  const fillBoard = () => {
    const b = BOARDS[+q('#f-board').value];
    if (!b.mcu) return; // custom: keep what is typed
    q('#f-prog').value = b.programmer;
    q('#f-mcu').value = b.mcu;
    q('#f-abaud').value = String(b.baud);
  };
  q('#f-board').onchange = fillBoard;
  fillBoard();
  q('#f-close').onclick = () => !running && close();
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && !running && close());
  q('#f-file').focus();
  q('#f-browse').onclick = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const f = await open({ multiple: false, filters: [{ name: 'Firmware', extensions: ['bin', 'hex'] }, { name: 'All files', extensions: ['*'] }] });
      if (f) q('#f-file').value = f;
    } catch {
      q('#f-msg').textContent = 'The file picker is only available in the desktop app. Paste the path instead.';
      q('#f-run').hidden = false;
    }
  };

  const busy = (b) => {
    running = b;
    $$('input, select, #f-browse, #f-method button', ov).forEach((e) => (e.disabled = b));
    q('#f-close').disabled = false;
    q('#f-close').textContent = b ? 'Cancel upload' : 'Close';
    q('#f-close').onclick = b ? () => call('flash_cancel').catch(() => {}) : close;
    q('#f-go').disabled = b;
  };
  const log = q('#f-log');
  off = await onFlash((ev) => {
    if (ev.type === 'log') {
      log.textContent += ev.line + '\n';
      log.scrollTop = log.scrollHeight;
    } else if (ev.type === 'progress') {
      q('#f-bar').style.width = Math.min(100, ev.pct) + '%';
      q('#f-msg').textContent = `Uploading… ${ev.pct.toFixed(0)}%`;
    } else if (ev.type === 'done') {
      q('#f-bar').style.width = '100%';
      q('#f-msg').innerHTML = '<span class="ok-text">Done. The board restarted with the new firmware.</span>';
      busy(false);
    } else if (ev.type === 'error') {
      q('#f-msg').innerHTML = `<span class="err-text">${esc(ev.message)}</span>`;
      busy(false);
    }
  });

  q('form').onsubmit = async (e) => {
    e.preventDefault();
    if (running) return;
    const err = (m) => {
      const p = q('#f-err');
      p.textContent = m;
      p.hidden = false;
    };
    q('#f-err').hidden = true;
    const file = q('#f-file').value.trim().replace(/^"|"$/g, '');
    if (!file) return err('Choose the .bin file to upload.');
    let req;
    if (method === 'avr') {
      const port = q('#f-aport').value.trim();
      const mcu = q('#f-mcu').value.trim();
      if (!port) return err('Enter the board’s serial port, for example COM3.');
      if (!mcu) return err('Enter the chip type, for example atmega328p.');
      if (!/\.hex$/i.test(file)) return err('Arduino uploads need a compiled .hex file (Sketch → Export Compiled Binary in the Arduino IDE).');
      req = { method: 'avr', file, port, mcu, programmer: q('#f-prog').value, baud: +q('#f-abaud').value, session_id: sc?.kind === 'serial' && sc.port === port ? s.id : null };
      store.set('flash', { ...last, method, file, aport: port, board: +q('#f-board').value });
    } else if (method === 'serial') {
      const port = q('#f-port').value.trim();
      if (!port) return err('Enter the serial port, for example COM5.');
      const address = q('#f-addr').value.trim();
      if (!/^(0x[0-9a-f]+|\d+)$/i.test(address)) return err('The start address must be a number such as 0x10000.');
      req = { method: 'serial', file, port, baud: +q('#f-baud').value, address, erase: q('#f-erase').checked, session_id: sc?.kind === 'serial' && sc.port === port ? s.id : null };
      store.set('flash', { ...last, method, file, port, baud: req.baud, address });
    } else {
      const host = q('#f-host').value.trim();
      const port = Number(q('#f-oport').value);
      if (!host) return err('Enter the board’s IP address or host name.');
      if (!(port > 0 && port < 65536)) return err('Enter the OTA port (3232 for ESP32, 8266 for ESP8266).');
      req = { method: 'ota', file, host, port, password: q('#f-pass').value, filesystem: q('#f-target').value === 'fs', session_id: sc && sc.kind !== 'serial' && sc.host === host ? s.id : null };
      store.set('flash', { ...last, method, file, host, oport: port });
    }
    q('#f-run').hidden = false;
    q('#f-bar').style.width = '0';
    q('#f-msg').textContent = 'Starting…';
    log.textContent = '';
    busy(true);
    try {
      await call('flash_start', { req });
    } catch (e2) {
      q('#f-msg').innerHTML = `<span class="err-text">${esc(String(e2))}</span>`;
      busy(false);
    }
  };
}

// ------------------------------------------------------------------ drag to reorder
// Works on grid panes (drag the header), tabs and rail cards. The order is shared by
// all three layouts and remembered.
/** Forget pinned grid cells so every block flows in order again. */
function clearCells() {
  for (const x of S.sessions.values()) x.cell = null;
  persist();
}

/** Pins a block to the empty grid cell under the pointer. Returns false when the pointer is not over a cell. */
function placeInCell(id, clientX, clientY) {
  const panes = $('#panes');
  const cs = getComputedStyle(panes);
  const sizes = (css) => css.split(' ').map(parseFloat).filter((n) => !isNaN(n));
  const cols = sizes(cs.gridTemplateColumns);
  const rows = sizes(cs.gridTemplateRows);
  const r = panes.getBoundingClientRect();
  const find = (list, pos) => {
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
      acc += list[i];
      if (pos < acc) return i;
    }
    return -1;
  };
  const c = find(cols, clientX - r.left + panes.scrollLeft);
  const row = find(rows, clientY - r.top + panes.scrollTop);
  if (c < 0 || row < 0) return false;
  // Pin the other blocks where they sit now so only the dragged one moves.
  for (const x of S.sessions.values()) {
    if (x.id === id) continue;
    const i = find(cols, x.pane.offsetLeft + 2);
    const j = find(rows, x.pane.offsetTop + 2);
    x.cell = i >= 0 && j >= 0 ? { c: i, r: j } : null;
  }
  get(id).cell = { c, r: row };
  persist();
  renderAll();
  return true;
}

function moveSession(dragId, targetId, before) {
  if (dragId === targetId || !get(dragId) || !get(targetId)) return;
  const ids = [...S.sessions.keys()].filter((i) => i !== dragId);
  ids.splice(ids.indexOf(targetId) + (before ? 0 : 1), 0, dragId);
  for (const x of S.sessions.values()) x.cell = null;
  const old = new Map(S.sessions);
  S.sessions.clear();
  for (const i of ids) {
    S.sessions.set(i, old.get(i));
    $('#panes').append(old.get(i).pane);
  }
  persist();
  renderAll();
}

/** Manual grid sizes: fr weights for columns and rows, dropped when the pane count or column setting changes. */
let G = store.get('gridsize', null);
function applyGridSizes() {
  const panes = $('#panes');
  if (G && (G.n !== S.sessions.size || G.cols !== store.get('cols', 'auto'))) G = null;
  if (S.layout !== 'grid' || !G) {
    if (S.layout === 'grid') panes.style.gridTemplateRows = '';
    return;
  }
  if (G.c) panes.style.gridTemplateColumns = G.c.map((f) => `minmax(0, ${f}fr)`).join(' ');
  if (G.r) panes.style.gridTemplateRows = G.r.map((f) => `minmax(140px, ${f}fr)`).join(' ');
}

function wireGridResize() {
  let d = null;
  const tracks = (css) => css.split(' ').map(parseFloat).filter((n) => !isNaN(n));
  const index = (sizes, start) => {
    let acc = 0;
    for (let i = 0; i < sizes.length; i++) {
      if (Math.abs(acc - start) < 3) return i;
      acc += sizes[i];
    }
    return -1;
  };
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest?.('.gh');
    if (!h || S.layout !== 'grid') return;
    e.preventDefault();
    e.stopPropagation();
    const panes = $('#panes');
    const cs = getComputedStyle(panes);
    const pane = h.closest('.pane');
    const col = h.classList.contains('gh-r');
    const sizes = tracks(col ? cs.gridTemplateColumns : cs.gridTemplateRows);
    const i = index(sizes, col ? pane.offsetLeft : pane.offsetTop);
    if (i < 0 || i + 1 >= sizes.length) return;
    d = { col, i, sizes, start: col ? e.clientX : e.clientY, other: tracks(col ? cs.gridTemplateRows : cs.gridTemplateColumns) };
    document.body.classList.add('reordering');
  });
  document.addEventListener('pointermove', (e) => {
    if (!d) return;
    const delta = (d.col ? e.clientX : e.clientY) - d.start;
    const min = d.col ? 220 : 140;
    const pair = d.sizes[d.i] + d.sizes[d.i + 1];
    const a = Math.min(pair - min, Math.max(min, d.sizes[d.i] + delta));
    const sizes = d.sizes.slice();
    sizes[d.i] = a;
    sizes[d.i + 1] = pair - a;
    G = { ...(G ?? {}), n: S.sessions.size, cols: store.get('cols', 'auto') };
    // Keep the other axis as it currently is so it does not jump when explicit sizes take over.
    G[d.col ? 'c' : 'r'] = sizes;
    G[d.col ? 'r' : 'c'] ??= d.other;
    applyGridSizes();
  });
  document.addEventListener('pointerup', () => {
    if (!d) return;
    d = null;
    document.body.classList.remove('reordering');
    store.set('gridsize', G);
    requestAnimationFrame(fitAll);
  });
  document.addEventListener('dblclick', (e) => {
    if (!e.target.closest?.('.gh')) return;
    G = null;
    store.set('gridsize', null);
    $('#panes').style.gridTemplateRows = '';
    renderAll();
  });
}

function wireDragAndDrop() {
  // Pointer events instead of HTML5 drag and drop: the webview on Windows can swallow
  // native drag events, pointer events always work.
  let st = null;
  let justDragged = false;
  const clear = () =>
    $$('.drop-before, .drop-after, .dragging, .drop-end').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'dragging', 'drop-end'));
  const before = (e, t) => {
    const r = t.getBoundingClientRect();
    return t.classList.contains('card') ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const src = e.target.closest?.('.tab[data-id], .card[data-id], .pane > header');
    if (!src || e.target.closest('select, input, button, .st, [data-remove], .ren, .gh')) return;
    st = { id: idOf(src), src, x0: e.clientX, y0: e.clientY, active: false, target: null, before: true };
  });
  document.addEventListener('pointermove', (e) => {
    if (!st) return;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 6) return;
      st.active = true;
      document.body.classList.add('reordering');
      (st.src.closest('.pane') ?? st.src).classList.add('dragging');
    }
    $$('.drop-before, .drop-after, .drop-end').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-end'));
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pane[data-id], .tab[data-id], .card[data-id]');
    if (t && t.dataset.id !== st.id) {
      st.target = t.dataset.id;
      st.before = before(e, t);
      t.classList.add(st.before ? 'drop-before' : 'drop-after');
    } else if (!t && S.layout === 'grid' && document.elementFromPoint(e.clientX, e.clientY)?.id === 'panes') {
      // Empty space in the grid: drop at the end.
      const ids = [...S.sessions.keys()].filter((i) => i !== st.id);
      st.target = ids[ids.length - 1] ?? null;
      st.before = false;
      st.cellAt = [e.clientX, e.clientY];
      $('#panes').classList.add('drop-end');
    } else (st.target = null), (st.cellAt = null);
  });
  const end = (apply) => {
    if (!st) return;
    const d = st;
    st = null;
    document.body.classList.remove('reordering');
    clear();
    if (d.active) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
      if (apply && d.cellAt && placeInCell(d.id, ...d.cellAt)) return;
      if (apply && d.target) moveSession(d.id, d.target, d.before);
    }
  };
  document.addEventListener('pointerup', () => end(true));
  document.addEventListener('pointercancel', () => end(false));
  // A drag must not also count as a click on the tab or card it started from.
  document.addEventListener(
    'click',
    (e) => {
      if (justDragged) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
}

/** The divider between the raw and decoded sections: drag to resize, double-click to reset. */
function wireDivider() {
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const d = e.target.closest?.('.divider');
    if (!d || e.target.closest('.swapbtn')) return;
    e.preventDefault();
    drag = d.closest('.pane');
    document.body.classList.add('reordering');
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = $('.split', drag).getBoundingClientRect();
    const horizontal = !drag.classList.contains('split-v');
    const pos = horizontal ? e.clientX : e.clientY;
    const start = horizontal ? r.left : r.top;
    const size = horizontal ? r.width : r.height;
    // Fraction taken by the decoded section, which sits at the end unless swapped.
    const frac = D.swap ? (pos - start) / size : 1 - (pos - start) / size;
    D.ratio = Math.min(0.85, Math.max(0.15, frac));
    S.sessions.forEach((x) => x.pane.style.setProperty('--decw', D.ratio * 100 + '%'));
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('reordering');
    store.set('display', D);
    requestAnimationFrame(fitAll);
  });
  document.addEventListener('dblclick', (e) => {
    if (!e.target.closest?.('.divider')) return;
    D.ratio = 0.5;
    store.set('display', D);
    applyDisplay();
  });
}

// ------------------------------------------------------------------ display dialog
function openDisplayDialog() {
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Display settings">
    <h3>Display</h3>
    <div class="frm">
      <label>Incoming (RX) colour<span class="row"><input type="color" id="x-rx"><button type="button" class="btn ghost sm" data-reset="rx">Default</button></span></label>
      <label>Outgoing (TX) colour<span class="row"><input type="color" id="x-tx"><button type="button" class="btn ghost sm" data-reset="tx">Default</button></span></label>
      <label class="chk full"><input type="checkbox" id="x-echo"> Show commands you send in the terminal, in the TX colour</label>
      <label class="chk full"><input type="checkbox" id="x-arrow"> Mark sent lines with →</label>
      <label>Decode as<select id="x-fmt">${FORMATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label>Split layout<select id="x-split"><option value="h">Side by side</option><option value="v">Stacked</option></select></label>
      <label class="chk full"><input type="checkbox" id="x-swap"> Decoded first (left or top) instead of raw</label>
      <label class="chk full"><input type="checkbox" id="x-ts"> Show timestamps in the decoded view</label>
    </div>
    <p class="hint">Use the <b>Raw / Split / Decoded</b> switch in the toolbar to show the raw terminal, both, or only the decoded view (drag the divider to resize). The decoded part lists every chunk received (RX) and sent (TX). Changes apply right away.</p>
    <div class="acts"><button type="button" class="btn ghost" id="x-reset">Reset all</button><button type="button" class="btn" id="x-close">Done</button></div>
  </form>`;
  document.body.append(ov);
  const q = (x) => $(x, ov);
  const fill = () => {
    q('#x-rx').value = rxColour();
    q('#x-tx').value = txColour();
    q('#x-echo').checked = D.echo;
    q('#x-arrow').checked = D.arrow;
    q('#x-fmt').value = D.fmt;
    q('#x-split').value = D.split;
    q('#x-swap').checked = D.swap;
    q('#x-ts').checked = D.ts;
  };
  const save = () => {
    store.set('display', D);
    applyDisplay();
  };
  fill();
  q('#x-rx').oninput = (e) => ((D.rx = e.target.value), save());
  q('#x-tx').oninput = (e) => ((D.tx = e.target.value), save());
  q('#x-echo').onchange = (e) => ((D.echo = e.target.checked), save());
  q('#x-arrow').onchange = (e) => ((D.arrow = e.target.checked), save());
  q('#x-fmt').onchange = (e) => ((D.fmt = e.target.value), save());
  q('#x-split').onchange = (e) => ((D.split = e.target.value), save());
  q('#x-swap').onchange = (e) => ((D.swap = e.target.checked), save());
  q('#x-ts').onchange = (e) => ((D.ts = e.target.checked), save());
  $$('[data-reset]', ov).forEach((b) => (b.onclick = () => ((D[b.dataset.reset] = null), save(), fill())));
  q('#x-reset').onclick = () => ((D = { ...DISPLAY_DEFAULTS }), save(), fill());
  const close = () => ov.remove();
  q('#x-close').onclick = close;
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  q('#x-close').focus();
}

// ------------------------------------------------------------------ wiring
function wire() {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#b-new, #b-new2, #b-new3, #b-new4')) return openDialog();
    const tog = t.closest('[data-tog]');
    if (tog) return e.stopPropagation(), toggle(idOf(tog));
    const rm = t.closest('[data-remove]');
    if (rm) {
      e.stopPropagation();
      const id = idOf(rm);
      if (S.pendingRemove === id) {
        S.pendingRemove = null;
        return removeSession(id);
      }
      S.pendingRemove = id;
      clearTimeout(wire.t);
      wire.t = setTimeout(() => ((S.pendingRemove = null), renderAll()), 3000);
      return renderAll();
    }
    const lay = t.closest('#lay button');
    if (lay) return setLayout(lay.dataset.l);
    if (t.closest('select')) return;
    const item = t.closest('.tab[data-id], .card[data-id]');
    if (item) return select(item.dataset.id);
  });
  document.addEventListener('dblclick', (e) => {
    const r = e.target.closest('[data-rename]');
    if (r) startRename(idOf(r), r);
  });
  document.addEventListener('keydown', (e) => {
    const item = e.target.closest?.('.tab[data-id], .card[data-id]');
    if (item && (e.key === 'Enter' || e.key === ' ') && e.target === item) {
      e.preventDefault();
      select(item.dataset.id);
    }
  });
  $('#t-flash').onclick = () => openFlashDialog();
  document.addEventListener('focusout', (e) => e.target.matches?.('#rail select') && S.railDirty && setTimeout(renderRail, 0));
  document.addEventListener('change', async (e) => {
    const sel = e.target.closest?.('select.baud');
    if (!sel) return;
    const s = get(idOf(sel) ?? S.active);
    if (!s) return;
    const baud = Number(sel.value);
    sel.blur();
    try {
      await call('session_set_baud', { id: s.id, baud });
      if (s.state === 'on') s.term.write(`\x1b[36m-- baud rate set to ${baud} --\x1b[0m\r\n`);
    } catch (err) {
      note(String(err), true);
    }
    renderAll();
  });
  $('#t-auto').onclick = async () => {
    const s = cur();
    if (!s) return;
    s.autoReconnect = !s.autoReconnect;
    persist();
    renderToolbar();
    await call('session_set_auto_reconnect', { id: s.id, on: s.autoReconnect }).catch((e) => note(String(e), true));
  };
  $('#grid-cols').onchange = (e) => {
    store.set('cols', e.target.value);
    clearCells();
    renderAll();
  };
  wireDragAndDrop();
  $$('#t-view button').forEach((b) => (b.onclick = () => cur() && setView(cur(), b.dataset.v)));
  const swap = () => {
    D.swap = !D.swap;
    store.set('display', D);
    applyDisplay();
  };
  $('#t-swap').onclick = swap;
  document.addEventListener('click', (e) => e.target.closest?.('.swapbtn') && swap());
  wireDivider();
  wireGridResize();
  F.init({ S, get, cur, call, note, esc, $, $$, store, EOL, sendText, sendBytes, renderToolbar, fitAll });
  F.renderMacros();
  $('#macros').addEventListener('click', (e) => {
    if (e.target.closest('#m-edit')) return F.openMacroDialog();
    const m = e.target.closest('[data-m]');
    if (m) F.runMacro(m.dataset.m);
  });
  $('#t-find').onclick = () => cur() && F.openSearch(cur());
  $('#t-plot').onclick = () => {
    if (!cur()) return;
    F.togglePlot(cur());
    renderToolbar();
  };
  $('#t-log').onclick = () => cur() && F.openLogDialog(cur());
  $('#b-file').onclick = () => F.openSendFileDialog();
  $('#t-disp').onclick = openDisplayDialog;
  document.addEventListener('change', (e) => {
    const sel = e.target.closest?.('select.decfmt');
    if (!sel) return;
    D.fmt = sel.value;
    store.set('display', D);
    applyDisplay();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('.decclear');
    const s = b && get(idOf(b));
    if (s) {
      s.rec = [];
      s.dec.replaceChildren();
    }
  });
  $('#t-conn').onclick = () => toggle(S.active);
  $('#t-settings').onclick = () => openDialog(S.active);
  $('#t-rename').onclick = () => startRename(S.active, visibleName(S.active));
  $('#t-clear').onclick = () => {
    const s = cur();
    if (s) {
      s.term.clear();
      s.rec = [];
      s.dec.replaceChildren();
      call('session_clear', { id: s.id }).catch(() => {});
    }
  };
  $('#t-win').onclick = () => {
    const s = cur();
    if (s) call('open_window', { sessionId: s.id, title: `${s.name} — ESP Terminal` }).catch((e) => note(String(e), true));
  };
  const input = $('#send-in');
  $('#sendbar').onsubmit = async (e) => {
    e.preventDefault();
    const s = cur();
    if (!s || !input.value) return;
    const text = input.value;
    if (await sendText(s, text + (EOL[s.lineEnd] ?? '\r\n'), text)) {
      s.history.push(text);
      s.hpos = s.history.length;
      input.value = '';
    }
  };
  input.addEventListener('keydown', (e) => {
    const s = cur();
    if (!s || !s.history.length || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    s.hpos = Math.max(0, Math.min(s.history.length, s.hpos + (e.key === 'ArrowUp' ? -1 : 1)));
    input.value = s.history[s.hpos] ?? '';
  });
}

// ------------------------------------------------------------------ startup
async function start() {
  mountShell();
  wire();
  await onSession(onEvent);

  let list = [];
  if (popId) {
    const all = await call('session_list');
    const info = all.find((s) => s.id === popId);
    if (!info) {
      $('#empty').innerHTML = '<h2>Session not found</h2>It may have been removed in the main window.';
    } else list = [info];
  } else {
    list = store.get('sessions', []);
    if (!inTauri && !list.length) {
      list = [
        { id: 'sdemo1', name: 'Kitchen sensor', config: { kind: 'tcp', host: '192.168.1.42', port: 23, protocol: 'telnet' } },
        { id: 'sdemo2', name: 'Greenhouse', config: { kind: 'tcp', host: '10.0.0.17', port: 8266, protocol: 'raw' } },
        { id: 'sdemo3', name: 'Test rig', config: { kind: 'serial', port: 'COM5', baud: 115200, data_bits: 8, parity: 'none', stop_bits: 1, flow: 'none', reset_on_connect: false } },
      ];
    }
  }
  for (const info of list) {
    const auto = info.autoReconnect ?? info.auto_reconnect ?? true;
    await call('session_create', { id: info.id, name: info.name, config: info.config, autoReconnect: auto });
    const live = (await call('session_list')).find((x) => x.id === info.id);
    const s = addSession({ ...info, ...(live ? { state: live.state, rx: live.rx, tx: live.tx } : {}) });
    await replayBacklog(s);
  }
  applyDisplay();
  const saved = store.get('active', null);
  S.active = popId ? popId : S.sessions.has(saved) ? saved : [...S.sessions.keys()][0] ?? null;
  renderAll();
  const s = cur();
  if (s) requestAnimationFrame(() => (fitOne(s), s.term.focus()));
}

start();
