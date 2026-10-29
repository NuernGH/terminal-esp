import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { call, onSession, onFlash, onUpdate, b64ToBytes, inTauri } from './api.js';
import { FORMATS, formatBytes } from './decode.js';
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
const DISPLAY_DEFAULTS = { rx: null, tx: null, echo: true, arrow: true, ts: true, rawts: false, fmt: 'hex', split: 'h', swap: false, ratio: 0.5 };
let D = { ...DISPLAY_DEFAULTS, ...store.get('display', {}) };
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const lumOf = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
const contrast = (a, b) => {
  const x = lumOf(a), y = lumOf(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const rxColour = () => D.rx || cssVar('--termfg');
const txColour = () => D.tx || cssVar('--cyan');

// ------------------------------------------------------------------ helpers
const get = (id) => S.sessions.get(id);
const cur = () => get(S.active);
const idOf = (el) => el.closest('[data-id]')?.dataset.id;
const stateClass = (s) => (s.state === 'on' ? 'on' : s.state === 'connecting' ? 'connecting' : '');
const stateTip = (s) =>
  s.state === 'off' ? 'Disconnected. Click to connect' : s.state === 'connecting' ? 'Connecting. Click to cancel' : 'Connected. Click to disconnect';
const hex4 = (n) => Number(n).toString(16).toUpperCase().padStart(4, '0');
const addrOf = (c) =>
  c.kind === 'serial' ? `${c.port} · ${c.baud}` : c.kind === 'tcp' ? `${c.host}:${c.port}` : c.kind === 'ws' ? c.url : c.kind === 'ssh' ? `${c.user}@${c.host}:${c.port}` : c.kind === 'mqtt' ? `mqtt://${c.host}:${c.port}` : c.kind === 'ble' ? c.name || c.id : c.kind === 'hid' ? `HID ${hex4(c.vendor_id)}:${hex4(c.product_id)}` : `udp://${c.host}:${c.port}`;
const typeOf = (c) => (c.kind === 'serial' ? 'Serial' : c.kind === 'ws' ? 'WebSocket' : c.kind === 'ssh' ? 'SSH' : c.kind === 'mqtt' ? 'MQTT' : c.kind === 'ble' ? 'Bluetooth LE' : c.kind === 'hid' ? 'USB HID' : c.kind === 'tcp' ? (c.protocol === 'telnet' ? 'Telnet' : 'TCP') : 'UDP');

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

/** Gives the tray menu the current session names. */
function syncTray() {
  if (popId) return;
  call('tray_set_sessions', { sessions: [...S.sessions.values()].map(({ id, name }) => ({ id, name })) }).catch(() => {});
}

function persist() {
  if (popId) return;
  syncTray();
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

// Colour themes. Each one sets the interface variables; `dark` picks the terminal's ANSI palette.
const th = (dark, bg, panel, panel2, line, fg, mute, accent, term, termfg, ok, warn, err, cyan) => ({ dark, vars: { '--bg': bg, '--panel': panel, '--panel2': panel2, '--line': line, '--fg': fg, '--mute': mute, '--accent': accent, '--term': term, '--termfg': termfg, '--ok': ok, '--warn': warn, '--err': err, '--cyan': cyan } });
const THEMES = {
  system: { label: 'System' },
  light: { label: 'Light', ...th(false, '#eef0f3', '#ffffff', '#f4f6f8', '#d9dee5', '#1b2430', '#667487', '#0a6cdc', '#fbfcfd', '#1b2430', '#0f7a3c', '#8f5d0a', '#d6334a', '#0a6f86') },
  dark: { label: 'Dark', ...th(true, '#0c1016', '#141a22', '#10151c', '#232c38', '#e6ebf2', '#8593a6', '#4da3ff', '#0a0e13', '#d5dde8', '#3ddc84', '#f0b64a', '#ff6b81', '#4fd1e8') },
  midnight: { label: 'Midnight blue', ...th(true, '#070b1a', '#0d1329', '#0a1022', '#1c2547', '#dfe6ff', '#7b88b8', '#6c8cff', '#050816', '#cfd8ff', '#4ee3a0', '#f5c45e', '#ff6e8a', '#5cd6ff') },
  nord: { label: 'Nord', ...th(true, '#272c36', '#2e3440', '#2a303b', '#434c5e', '#eceff4', '#9aa5b8', '#88c0d0', '#2b303b', '#d8dee9', '#a3be8c', '#ebcb8b', '#e0868f', '#8fbcbb') },
  dracula: { label: 'Dracula', ...th(true, '#1e1f29', '#282a36', '#232530', '#44475a', '#f8f8f2', '#8d90a8', '#bd93f9', '#1e1f29', '#f8f8f2', '#50fa7b', '#f1fa8c', '#ff5555', '#8be9fd') },
  solardark: { label: 'Solarized dark', ...th(true, '#00212b', '#002b36', '#00252f', '#0b4452', '#eee8d5', '#7f9a9f', '#2aa198', '#002b36', '#93a1a1', '#859900', '#b58900', '#ff6b66', '#2aa198') },
  solarlight: { label: 'Solarized light', ...th(false, '#f3ecd7', '#fdf6e3', '#f7f0dc', '#e1d9c0', '#3f4f55', '#5f7173', '#268bd2', '#fdf6e3', '#586e75', '#6b7a00', '#8a6900', '#c42b28', '#1f7f78') },
  matrix: { label: 'Green screen', ...th(true, '#020a04', '#06130a', '#040e07', '#123320', '#c7f5d3', '#5f9a73', '#33ff77', '#000000', '#33ff77', '#33ff77', '#d9f24a', '#ff5c5c', '#4dffd2') },
  amber: { label: 'Amber retro', ...th(true, '#0d0800', '#170e00', '#120a00', '#3a2600', '#ffd9a0', '#a37a3b', '#ffb000', '#080500', '#ffb000', '#ffd24a', '#ff9a3c', '#ff5c4a', '#ffcf70') },
  contrast: { label: 'High contrast', ...th(true, '#000000', '#000000', '#0a0a0a', '#6a6a6a', '#ffffff', '#d0d0d0', '#ffeb3b', '#000000', '#ffffff', '#00ff66', '#ffd400', '#ff5050', '#00e5ff') },
};
const themeId = () => (THEMES[store.get('theme', 'system')] ? store.get('theme', 'system') : 'system');
const isDark = () => (themeId() === 'system' ? scheme.matches : THEMES[themeId()].dark);

function applyThemeVars() {
  const root = document.documentElement;
  const t = THEMES[themeId()];
  for (const k of Object.keys(THEMES.dark.vars)) {
    if (t.vars) root.style.setProperty(k, t.vars[k]);
    else root.style.removeProperty(k);
  }
  root.style.colorScheme = themeId() === 'system' ? '' : t.dark ? 'dark' : 'light';
  // Text on accent-coloured buttons: white or near-black, whichever reads better on this theme's accent.
  const acc = cssVar('--accent');
  if (/^#[0-9a-f]{6}$/i.test(acc)) root.style.setProperty('--onaccent', contrast(acc, '#ffffff') >= contrast(acc, '#0b1017') ? '#ffffff' : '#0b1017');
}

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim();
  return {
    ...PALETTE[isDark() ? 'dark' : 'light'],
    background: css.getPropertyValue('--term').trim(),
    foreground: rxColour(),
    // Colour 16 carries sent lines, so changing the TX colour also recolours what is already on screen.
    extendedAnsi: [txColour()],
    cursor: accent,
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? accent + '55' : isDark() ? '#2b4a73' : '#b3d4ff',
  };
}

function applyTheme() {
  applyThemeVars();
  S.sessions.forEach((s) => (s.term.options.theme = termTheme()));
  const sel = $('#t-theme');
  if (sel) sel.value = themeId();
  if ($('#panes')) requestAnimationFrame(() => S.sessions.forEach((s) => s.plot && F.drawPlot(s)));
}
scheme.addEventListener('change', applyTheme);
window.addEventListener('storage', (e) => e.key === 'esp-terminal.theme' && applyTheme());
// Other windows share these settings: pick up their changes so a stale copy here never overwrites them.
window.addEventListener('storage', (e) => {
  if (e.key !== 'esp-terminal.display') return;
  try { D = { ...DISPLAY_DEFAULTS, ...JSON.parse(e.newValue || '{}') }; } catch { return; }
  applyDisplay();
});

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

/** Telnet servers can ask for the window size; keep the core informed when it changes. */
function reportSize(s) {
  if (!(s.config.kind === 'ssh' || (s.config.kind === 'tcp' && s.config.term))) return;
  const key = `${s.term.cols}x${s.term.rows}`;
  if (s.sizeKey === key) return;
  s.sizeKey = key;
  call('session_resize', { id: s.id, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
}

function fitOne(s) {
  if (!s.slot.clientWidth || !s.slot.clientHeight) return;
  try {
    s.fit.fit();
    reportSize(s);
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

/** Paints changed records once per frame instead of once per received chunk, so a fast stream cannot back up the UI. */
function queuePaint(s, r) {
  (s.dirty ??= new Set()).add(r);
  if (s.paintRaf) return;
  s.paintRaf = requestAnimationFrame(() => {
    s.paintRaf = 0;
    const todo = s.dirty;
    s.dirty = new Set();
    if (!s.decode) return;
    const stick = s.dec.scrollTop + s.dec.clientHeight >= s.dec.scrollHeight - 24;
    for (const rec of todo) if (!rec.gone) paintRecord(s, rec, true);
    if (stick) s.dec.scrollTop = s.dec.scrollHeight;
  });
}

function paintRecord(s, r, batched = false) {
  const stick = !batched && s.dec.scrollTop + s.dec.clientHeight >= s.dec.scrollHeight - 24;
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
    if (s.decode) queuePaint(s, last);
    return;
  }
  const r = { dir, t: now, last: now, bytes: bytes.slice() };
  s.rec.push(r);
  if (s.rec.length > MAX_REC) {
    const old = s.rec.shift();
    old.gone = true;
    old.el?.remove();
  }
  if (s.decode) queuePaint(s, r);
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
  const body = text.replace(/[\r\n]+$/, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  // Wait for pending output to be parsed so we know whether the cursor is mid-line.
  s.term.write('', () => {
    const lead = s.term.buffer.active.cursorX > 0 ? '\r\n' : '';
    s.term.write(`${lead}\x1b[38;5;16m${D.arrow ? '→ ' : ''}${body}\x1b[39m\r\n`);
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

/** SSH and MQTT logins: ask for the password once per run (kept in memory, never saved). */
function needsSecret(s) {
  const c = s.config;
  return c.kind === 'ssh' || (c.kind === 'mqtt' && !!c.user);
}

function ensureSecret(s) {
  if (!needsSecret(s) || s.secretSet) return Promise.resolve(true);
  const c = s.config;
  const key = c.kind === 'ssh' && c.key_path;
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'ov';
    ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Login"><h3>${key ? 'Key passphrase' : 'Password'} for ${esc(addrOf(c))}</h3>
      <div class="frm"><label class="full">${key ? 'Passphrase (leave empty if the key has none)' : 'Password'}<input id="p-secret" type="password" autocomplete="off"></label></div>
      <p class="hint">It is kept in memory while the app runs, so reconnecting works, and it is never saved to disk.</p>
      <div class="acts"><button type="button" class="btn ghost" id="p-cancel">Cancel</button><button class="btn">Connect</button></div></form>`;
    document.body.append(ov);
    const done = (v) => (ov.remove(), resolve(v));
    $('#p-cancel', ov).onclick = () => done(false);
    ov.addEventListener('keydown', (e) => e.key === 'Escape' && done(false));
    $('form', ov).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await call('session_set_secret', { id: s.id, secret: $('#p-secret', ov).value });
        s.secretSet = true;
        done(true);
      } catch (err) {
        note(String(err), true);
        done(false);
      }
    };
    $('#p-secret', ov).focus();
  });
}

async function toggle(id) {
  const s = get(id);
  if (!s) return;
  try {
    if (s.state === 'off' && !(await ensureSecret(s))) return;
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
/** Puts the arrival time in front of every new line of received text (Display… → timestamps in the terminal). */
function stampLines(s, data) {
  const text = typeof data === 'string' ? data : (s.tsDec ??= new TextDecoder()).decode(data, { stream: true });
  s.atLineStart ??= true;
  const prefix = `\x1b[90m${clock(Date.now())}\x1b[39m `;
  const parts = text.split('\n');
  let out = '';
  parts.forEach((seg, i) => {
    if (seg !== '' && seg !== '\r' && s.atLineStart) {
      out += prefix;
      s.atLineStart = false;
    }
    out += seg;
    if (i < parts.length - 1) {
      out += '\n';
      s.atLineStart = true;
    }
  });
  return out;
}

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
    const shown = F.forTerminal(s.enc, bytes);
    s.term.write(D.rawts ? stampLines(s, shown) : shown);
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
    s.atLineStart = true;
    if (ev.state === 'on') {
      s.sizeKey = null;
      reportSize(s);
      s.term.write('\x1b[32m-- connected --\x1b[0m\r\n');
    }
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
      <div class="grp"><small>Connections</small><div class="row">
        <button class="btn only-multi" id="b-new"${multi}>+ New connection</button>
        <div class="seg only-multi" id="lay"${multi}>
          <button data-l="tabs">Tabs</button><button data-l="rail">Rail</button><button data-l="grid">Grid</button>
        </div>
        <label class="only-grid" id="cols-wrap" hidden>Columns <select id="grid-cols"><option value="auto">Auto</option><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
      </div></div>
      <span class="sp"></span>
      <div class="grp"><small>This board</small><div class="row">
        <span class="chip" id="t-addr"></span>
        <select class="baud" id="t-baud" title="Baud rate. Changes apply immediately." aria-label="Baud rate"></select>
        <button class="btn ghost sm" id="t-auto"></button>
        <button class="btn ghost sm" id="t-conn"></button>
        <button class="btn ghost sm" id="t-settings">Port settings…</button>
        <button class="btn ghost sm" id="t-rename">Rename</button>
        <button class="btn ghost sm only-multi" id="t-win"${multi}>New window</button>
      </div></div>
      <div class="grp"><small>View</small><div class="row">
        <div class="seg" id="t-view"><button data-v="raw">Raw</button><button data-v="split">Split</button><button data-v="decoded">Decoded</button><button data-v="aligned">Aligned</button></div>
        <button class="btn ghost sm" id="t-swap">⇄ Swap</button>
        <button class="btn ghost sm" id="t-disp">Display…</button>
      </div></div>
      <div class="grp"><small>Tools</small><div class="row">
        <button class="btn ghost sm" id="t-find">Search</button>
        <button class="btn ghost sm" id="t-plot">Plot</button>
        <button class="btn ghost sm" id="t-log"></button>
        <button class="btn ghost sm" id="t-save">Save…</button>
        <button class="btn ghost sm" id="t-clear">Clear</button>
        <button class="btn sm" id="t-flash">Flash .bin…</button>
      </div></div>
      <div class="grp keepgrp"><small>App</small><div class="row">
        <button class="btn ghost sm keep" id="t-top">Stay on top</button>
        <button class="btn ghost sm keep" id="t-min"></button>
        <button class="btn ghost sm keep" id="t-inp"></button>
        <select class="theme" id="t-theme" aria-label="Colour theme">${Object.entries(THEMES).map(([id, t]) => `<option value="${id}">${t.label}</option>`).join('')}</select>
        <button class="btn sm keep helpbtn" id="t-help" aria-label="Help">?</button>
      </div></div>
    </div>
    <div class="main">
      <aside class="rail" id="rail"></aside>
      <section class="stage">
        <div class="tabs" id="tabs" role="tablist"></div>
        <div class="panes" id="panes"><div class="empty" id="empty"><h2>No connections yet</h2><ol class="steps"><li>Click <b>+ New connection</b> and give the board a name.</li><li>Choose <b>Serial</b> and your COM port, or Scan network for WiFi boards.</li><li>Click the dot on its tab to connect. Press <b>?</b> or F1 for help.</li></ol><button class="btn" id="b-new2">+ New connection</button></div></div>
        <div class="macros" id="macros"></div>
        <form class="sendbar" id="sendbar"><input id="send-in" placeholder="Type a command and press Enter…" autocomplete="off" spellcheck="false" aria-label="Send to board"><button class="btn sm">Send</button><button type="button" class="btn ghost sm" id="b-file" title="Send a file to the board">Send file…</button></form>
      </section>
    </div>
    <div class="status" id="status"></div>`;

  const TIPS = {
    'b-new': 'Add a new board. It starts disconnected: click the dot on its tab to connect.',
    'b-new2': 'Add a new board. It starts disconnected: click the dot on its tab to connect.',
    lay: 'Tabs: one board at a time. Rail: all boards in a side list. Grid: all boards on screen at once.',
    't-auto': 'When on, the app keeps retrying every 2 seconds after the board resets or is unplugged.',
    't-conn': 'Connect or disconnect this board. You can also click the dot on its tab.',
    't-settings': 'Port, data bits, parity, stop bits, flow control or address.',
    't-rename': 'Give this board a name so you can tell your boards apart.',
    't-win': 'Open this board in its own window.',
    't-view': 'Raw: normal terminal. Split: raw plus a decoded list. Decoded: only the list. Aligned: raw and decoded side by side, one row per message.',
    't-swap': 'Swap which section comes first (raw or decoded).',
    't-disp': 'Colours of received and sent text, decoding format, timestamps and split direction.',
    't-find': 'Find text in the terminal (Ctrl+F).',
    't-plot': 'Graph numbers found in the incoming text, for example temp=22.4 hum=41.',
    't-log': 'Record everything received to a file while connected.',
    't-save': 'Save what is in the terminal now as .txt, .log with timestamps or .csv.',
    't-clear': 'Clear this terminal. The board is not affected.',
    't-flash': 'Upload firmware: a .bin over USB (esptool) or WiFi (OTA), or a .hex to an Arduino.',
    't-top': 'Keep this window above all other windows.',
    't-min': 'Hide the toolbar for a compact window.',
    't-inp': 'Show or hide the line where you type commands.',
    't-theme': 'Colour theme for the whole app.',
    't-help': 'Help (F1)',
    'b-file': 'Send a text or binary file to the board, in blocks or line by line.',
    'grid-cols': 'How many columns the grid uses.',
  };
  for (const [id, tip] of Object.entries(TIPS)) { const el = document.getElementById(id); if (el) el.title = tip; }
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
  for (const id of ['t-addr', 't-conn', 't-settings', 't-rename', 't-clear', 't-auto', 't-view', 't-find', 't-plot', 't-log', 't-save']) $('#' + id).hidden = !s;
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

let VERSION = inTauri ? '' : '0.1.0';
let UPDATE = null; // { version, url } when a newer release exists
const RELEASES = 'https://api.github.com/repos/NuernGH/terminal-esp/releases/latest';

const newer = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/** Looks at the newest GitHub release. Quiet on startup, reports the result when asked for. */
async function checkUpdate(manual) {
  if (!VERSION) return;
  try {
    const r = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const rel = await r.json();
    const v = String(rel.tag_name || '').replace(/^v/, '');
    if (v && newer(v, VERSION)) {
      const setup = (rel.assets || []).find((a) => /-setup\.exe$/i.test(a.name));
      UPDATE = { version: v, url: rel.html_url, setup: setup?.browser_download_url, digest: setup?.digest, size: setup?.size, notes: rel.name || '' };
      note(`Version ${v} is available.`);
    } else {
      UPDATE = null;
      if (manual) note(`You have the latest version (${VERSION}).`);
    }
  } catch (e) {
    if (manual) note(`Could not check for updates: ${e.message || e}`, true);
  }
  renderStatus();
}

// Browser simulator only: lets the tests pretend a newer release exists.
if (!inTauri) window.__testUpdate = (u) => ((VERSION = '0.1.1'), (UPDATE = u), renderStatus());

if (inTauri)
  import('@tauri-apps/api/app')
    .then((m) => m.getVersion())
    .then((v) => {
      VERSION = v;
      renderStatus();
      if (!popId) setTimeout(() => checkUpdate(false), 3000);
    })
    .catch(() => {});

function renderStatus() {
  const s = cur();
  const n = S.note;
  $('#status').innerHTML = s
    ? `<span>${s.state === 'on' ? '● Connected' : s.state === 'connecting' ? '◌ Connecting…' : '○ Disconnected'} · ${esc(s.name)}</span>${leds(s, true)}<span class="idle" data-idle data-sid="${s.id}"></span><span>${esc(s.lineEnd)}</span>${n ? `<span class="msg ${n.isErr ? 'err' : ''}">${esc(n.msg)}</span>` : ''}`
    : `<span>Ready</span>${n ? `<span class="msg ${n.isErr ? 'err' : ''}">${esc(n.msg)}</span>` : ''}`;
  if (VERSION)
    $('#status').insertAdjacentHTML(
      'beforeend',
      `${UPDATE ? `<a class="upd" href="#" data-update title="Open the download page">⬆ Version ${esc(UPDATE.version)} available</a>` : ''}<span class="ver" data-check title="App version. Click to check for updates.">v${esc(VERSION)}</span>`,
    );
}

/** Offers to download and install the new version in place (installed copies) or opens the release page (portable copy). */
async function openUpdateDialog() {
  if (!UPDATE || $('#upd-ov')) return;
  const canSelf = !!UPDATE.setup && (await call('can_self_update').catch(() => false));
  const mb = UPDATE.size ? ` (${(UPDATE.size / 1048576).toFixed(0)} MB)` : '';
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.id = 'upd-ov';
  ov.innerHTML = `<div class="dlg" role="dialog" aria-label="Update"><h3>Version ${esc(UPDATE.version)} is available</h3>
    <p class="hint">You have ${esc(VERSION)}. ${canSelf
      ? `Update now downloads the new version${mb}, installs it over this one and restarts NuTerm. Your sessions and settings are kept, and connections close briefly while it restarts.`
      : 'This copy cannot update itself (it is the portable version, or not installed with the setup program). Download the new version from the release page.'}</p>
    <div class="prog" id="u-prog" hidden><i id="u-bar"></i></div><p class="hint" id="u-msg"></p>
    <div class="acts"><button type="button" class="btn ghost" id="u-later">Later</button><button type="button" class="btn ghost" id="u-page">Release page</button>${canSelf ? '<button type="button" class="btn" id="u-go">Update now</button>' : ''}</div></div>`;
  document.body.append(ov);
  const q = (x) => $(x, ov);
  let unlisten = null;
  const close = () => (unlisten?.(), ov.remove());
  q('#u-later').onclick = close;
  q('#u-page').onclick = () => call('open_release_page', { url: UPDATE.url }).catch((err) => note(String(err), true));
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  const go = q('#u-go');
  if (go)
    go.onclick = async () => {
      go.disabled = true;
      q('#u-prog').hidden = false;
      q('#u-msg').textContent = 'Downloading…';
      unlisten = await onUpdate((ev) => {
        if (ev.phase === 'download') {
          const pct = ev.total ? Math.min(100, (ev.done / ev.total) * 100) : 0;
          q('#u-bar').style.width = pct + '%';
          q('#u-msg').textContent = `Downloading… ${(ev.done / 1048576).toFixed(1)}${ev.total ? ' of ' + (ev.total / 1048576).toFixed(1) : ''} MB`;
        } else if (ev.phase === 'install') {
          q('#u-bar').style.width = '100%';
          q('#u-msg').textContent = 'Installing. NuTerm will close and reopen by itself.';
        } else if (ev.phase === 'error') {
          q('#u-msg').textContent = ev.message;
          q('#u-msg').classList.add('err-text');
          go.disabled = false;
          go.textContent = 'Try again';
        }
      });
      call('start_update', { url: UPDATE.setup, sha256: UPDATE.digest || null }).catch((err) => {
        q('#u-msg').textContent = String(err);
        go.disabled = false;
      });
    };
}

function updateTitle() {
  const s = cur();
  document.title = s ? `${s.name} — NuTerm` : 'NuTerm';
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

// "No data for N s" next to the counters, so a quiet or dead connection is obvious at a glance.
setInterval(() => {
  const el = $('[data-idle]');
  if (!el) return;
  const s = get(el.dataset.sid);
  const secs = s && s.state === 'on' && s.rxAt ? Math.floor((Date.now() - s.rxAt) / 1000) : 0;
  const t = secs >= 3 ? `no data for ${secs >= 60 ? Math.floor(secs / 60) + ' min' : secs + ' s'}` : '';
  if (el.textContent !== t) el.textContent = t;
}, 1000);

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
  ble: 'A Bluetooth LE board that exposes a serial (UART over GATT) service. Classic Bluetooth serial adapters appear as a COM port after pairing in Windows; use Serial for those. Not yet tested on real hardware.',
  hid: 'A USB device that is not a serial port (custom controller, instrument). Received reports show as bytes; what you send goes out as zero padded output reports. Not yet tested on real hardware.',
  ssh: 'A secure shell on a Linux machine, Raspberry Pi, router or server. New host keys are saved on first use and checked afterwards.',
  mqtt: 'Connects to a broker. Received messages appear as [topic] payload lines; lines you send are published.',
  udp: 'Connectionless datagrams. Use the same local port in the board firmware.',
  ws: 'A WebSocket endpoint, for example the one an ESP32 web server or a browser tool exposes. Text and binary messages are shown as a stream.',
};

async function openDialog(editId) {
  const editing = editId ? get(editId) : null;
  const c = editing?.config ?? { kind: 'tcp', host: '', port: 23, protocol: 'telnet' };
  let type = c.kind;
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
      <button type="button" data-t="ssh">SSH<small>Linux, Pi, routers</small></button>
      <button type="button" data-t="mqtt">MQTT<small>Topics and messages</small></button>
      <button type="button" data-t="ble">Bluetooth LE<small>UART service · untested</small></button>
      <button type="button" data-t="hid">USB HID<small>Raw reports · untested</small></button>
    </div>
    <div class="frm" data-for="serial">
      <div class="full portrow"><label>Port<select id="d-portsel"></select></label><button type="button" class="btn ghost sm" id="d-portref" title="Look for COM ports again">Refresh</button></div>
      <label class="full" id="d-portman" hidden>Port name<input id="d-port" value="${esc(c.kind === 'serial' ? c.port : '')}" autocomplete="off" placeholder="COM5"></label>
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
      <label class="full">Terminal type reported to a Telnet server<select id="d-term">${[['VT100', 'VT100'], ['VT102', 'VT102'], ['ANSI', 'ANSI'], ['XTERM', 'xterm'], ['XTERM-256COLOR', 'xterm-256color'], ['', 'Do not announce one']].map(([v, l]) => `<option value="${v}"${(editing && c.kind === 'tcp' ? c.term ?? '' : 'VT100') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
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
    <div class="frm" data-for="ssh">
      <label>Host or IP<input id="d-shost" value="${esc(c.kind === 'ssh' ? c.host : '')}" placeholder="raspberrypi.local" autocomplete="off" spellcheck="false"></label>
      <label>Port<input id="d-sport" value="${c.kind === 'ssh' ? c.port : 22}" inputmode="numeric"></label>
      <label>User name<input id="d-suser" value="${esc(c.kind === 'ssh' ? c.user : '')}" placeholder="pi" autocomplete="off" spellcheck="false"></label>
      <label>Login with<select id="d-sauth"><option value="password"${c.kind === 'ssh' && c.key_path ? '' : ' selected'}>Password</option><option value="key"${c.kind === 'ssh' && c.key_path ? ' selected' : ''}>Private key file</option></select></label>
      <label class="full" id="d-skeywrap">Private key file<input id="d-skey" value="${esc(c.kind === 'ssh' ? c.key_path : '')}" placeholder="C:\\Users\\me\\.ssh\\id_ed25519" autocomplete="off" spellcheck="false"></label>
      <label class="full">Terminal type<select id="d-sterm">${['xterm-256color', 'xterm', 'vt100', 'linux'].map((t) => `<option${(c.kind === 'ssh' ? c.term : 'xterm-256color') === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    </div>
    <div class="frm" data-for="mqtt">
      <label>Broker host<input id="d-mhost" value="${esc(c.kind === 'mqtt' ? c.host : '')}" placeholder="192.168.1.10" autocomplete="off" spellcheck="false"></label>
      <label>Port<input id="d-mport" value="${c.kind === 'mqtt' ? c.port : 1883}" inputmode="numeric"></label>
      <label>User name (empty for none)<input id="d-muser" value="${esc(c.kind === 'mqtt' ? c.user : '')}" autocomplete="off" spellcheck="false"></label>
      <label>Client id (empty for automatic)<input id="d-mid" value="${esc(c.kind === 'mqtt' ? c.client_id : '')}" autocomplete="off" spellcheck="false"></label>
      <label class="full">Subscribe to (comma separated, # = everything)<input id="d-msub" value="${esc(c.kind === 'mqtt' ? c.subscribe : '#')}" autocomplete="off" spellcheck="false"></label>
      <label class="full">Publish topic (empty: type <code>topic message</code> to publish)<input id="d-mpub" value="${esc(c.kind === 'mqtt' ? c.publish_topic : '')}" autocomplete="off" spellcheck="false"></label>
      <label class="chk full"><input type="checkbox" id="d-mtls"${c.kind === 'mqtt' && c.tls ? ' checked' : ''}> Use TLS (usually port 8883)</label>
    </div>
    <div class="frm" data-for="ble">
      <div class="scanbox full" style="display:block"><div class="top"><button type="button" class="btn ghost sm" id="d-bscan">Scan for devices</button><span id="d-bmsg">Looks for Bluetooth LE devices for a few seconds.</span></div><div class="found" id="d-bfound"></div></div>
      <label class="full">Device (name or id from the scan)<input id="d-bid" value="${esc(c.kind === 'ble' ? c.id : '')}" autocomplete="off" spellcheck="false"></label>
      <label class="full">Serial service<select id="d-bpre"><option value="nordic">Nordic UART (most ESP32 and nRF boards)</option><option value="hm10">HM-10 style (FFE1 for both directions)</option><option value="custom">Custom UUIDs</option></select></label>
      <label class="full" data-bcustom>Receive characteristic (notify)<input id="d-bnotify" value="${esc(c.kind === 'ble' ? c.notify_char : '6E400003-B5A3-F393-E0A9-E50E24DCCA9E')}" autocomplete="off" spellcheck="false"></label>
      <label class="full" data-bcustom>Send characteristic (write)<input id="d-bwrite" value="${esc(c.kind === 'ble' ? c.write_char : '6E400002-B5A3-F393-E0A9-E50E24DCCA9E')}" autocomplete="off" spellcheck="false"></label>
    </div>
    <div class="frm" data-for="hid">
      <div class="scanbox full" style="display:block"><div class="top"><button type="button" class="btn ghost sm" id="d-hscan">List HID devices</button><span id="d-hmsg">Shows the USB HID devices Windows has attached.</span></div><div class="found" id="d-hfound"></div></div>
      <label>Vendor id (hex)<input id="d-hvid" value="${c.kind === 'hid' ? hex4(c.vendor_id) : ''}" placeholder="1209" autocomplete="off" spellcheck="false"></label>
      <label>Product id (hex)<input id="d-hpid" value="${c.kind === 'hid' ? hex4(c.product_id) : ''}" placeholder="C55D" autocomplete="off" spellcheck="false"></label>
      <label>Output report size (bytes)<input id="d-hsize" value="${c.kind === 'hid' ? c.report_size : 64}" inputmode="numeric"></label>
      <input type="hidden" id="d-hpath" value="${esc(c.kind === 'hid' ? c.path : '')}">
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
    q('#d-scanbox').hidden = !(t === 'tcp' || t === 'udp');
    q('#d-hint').textContent = HINTS[t];
  };
  setType(type);
  const fillPorts = async (keep) => {
    const list = await call('list_serial_ports').catch(() => []);
    const cur = keep ?? q('#d-port').value.trim();
    const sel = q('#d-portsel');
    const names = list.map((p) => p.name);
    const opts = list.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.description ? ' — ' + esc(p.description) : ''}</option>`);
    if (cur && !names.includes(cur)) opts.unshift(`<option value="${esc(cur)}">${esc(cur)} (not detected)</option>`);
    if (!opts.length) opts.push('<option value="">No COM ports found. Plug in a board and press Refresh</option>');
    opts.push('<option value="__other">Type a port name…</option>');
    sel.innerHTML = opts.join('');
    const pick = cur || names[0] || '';
    sel.value = pick && [...sel.options].some((o) => o.value === pick) ? pick : sel.options[0].value;
    if (sel.value && sel.value !== '__other') q('#d-port').value = sel.value;
  };
  q('#d-portsel').onchange = (e) => {
    const other = e.target.value === '__other';
    q('#d-portman').hidden = !other;
    if (!other) q('#d-port').value = e.target.value;
    else q('#d-port').focus();
  };
  q('#d-portref').onclick = () => fillPorts();
  fillPorts(c.kind === 'serial' ? c.port : '');
  $$('#d-type button', ov).forEach((b) => (b.onclick = () => (setType(b.dataset.t), b.dataset.t === 'serial' && fillPorts())));
  q('#d-cancel').onclick = close;
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  const syncPre = () => $$('[data-bcustom]', ov).forEach((l) => (l.hidden = q('#d-bpre').value !== 'custom'));
  q('#d-bpre').onchange = syncPre;
  if (c.kind === 'ble') {
    const nordic = c.notify_char?.toUpperCase().startsWith('6E400003') && c.write_char?.toUpperCase().startsWith('6E400002');
    q('#d-bpre').value = nordic ? 'nordic' : c.notify_char?.toUpperCase() === 'FFE1' && c.write_char?.toUpperCase() === 'FFE1' ? 'hm10' : 'custom';
  }
  syncPre();
  const listFound = (box, items, label, pick) => {
    box.innerHTML = items.map((x, i) => `<button type="button" data-f="${i}"><span>${esc(label(x)[0])}<br><small>${esc(label(x)[1])}</small></span></button>`).join('');
    $$('button', box).forEach((b) => (b.onclick = () => pick(items[+b.dataset.f])));
  };
  q('#d-bscan').onclick = async () => {
    const btn = q('#d-bscan');
    btn.disabled = true;
    q('#d-bmsg').textContent = 'Scanning…';
    try {
      const found = await call('ble_scan');
      q('#d-bmsg').textContent = found.length ? `${found.length} found. Click one.` : 'Nothing found. Is the device on, advertising and not connected elsewhere?';
      listFound(q('#d-bfound'), found, (d) => [d.name || '(no name)', `${d.id}${d.rssi != null ? ` · ${d.rssi} dBm` : ''}`], (d) => {
        q('#d-bid').value = d.id;
        q('#d-bid').dataset.name = d.name;
        if (d.name) q('#d-name').value = d.name;
      });
    } catch (e) {
      q('#d-bmsg').textContent = `Scan failed: ${e}`;
    }
    btn.disabled = false;
  };
  q('#d-hscan').onclick = async () => {
    try {
      const found = await call('hid_list');
      q('#d-hmsg').textContent = found.length ? `${found.length} found. Click one.` : 'No HID devices found.';
      listFound(q('#d-hfound'), found, (d) => [d.name || '(unnamed)', `${hex4(d.vendor_id)}:${hex4(d.product_id)} · usage ${hex4(d.usage_page)}/${d.usage}`], (d) => {
        q('#d-hvid').value = hex4(d.vendor_id);
        q('#d-hpid').value = hex4(d.product_id);
        q('#d-hpath').value = d.path;
        if (d.name) q('#d-name').value = d.name;
      });
    } catch (e) {
      q('#d-hmsg').textContent = `Listing failed: ${e}`;
    }
  };
  const syncAuth = () => (q('#d-skeywrap').hidden = q('#d-sauth').value !== 'key');
  q('#d-sauth').onchange = syncAuth;
  syncAuth();
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
      config = { kind: 'tcp', host, port: pn, protocol: q('#d-proto').value, term: q('#d-term').value };
    } else if (type === 'ble') {
      const id = q('#d-bid').value.trim();
      if (!id) return err('Scan for a device and pick it, or enter its name.');
      const pre = q('#d-bpre').value;
      const n = pre === 'nordic' ? '6E400003-B5A3-F393-E0A9-E50E24DCCA9E' : pre === 'hm10' ? 'FFE1' : q('#d-bnotify').value.trim();
      const w = pre === 'nordic' ? '6E400002-B5A3-F393-E0A9-E50E24DCCA9E' : pre === 'hm10' ? 'FFE1' : q('#d-bwrite').value.trim();
      config = { kind: 'ble', id, name: q('#d-bid').dataset.name || (c.kind === 'ble' && c.id === id ? c.name : ''), notify_char: n, write_char: w };
    } else if (type === 'hid') {
      const vid = parseInt(q('#d-hvid').value, 16);
      const pid = parseInt(q('#d-hpid').value, 16);
      const size = Number(q('#d-hsize').value);
      if (!(vid > 0 && vid < 65536) || !(pid >= 0 && pid < 65536)) return err('Enter the vendor and product id as hex numbers, for example 1209 and C55D.');
      if (!(size >= 1 && size <= 1024)) return err('Enter an output report size between 1 and 1024 bytes.');
      config = { kind: 'hid', vendor_id: vid, product_id: pid, path: q('#d-hpath').value, report_size: size };
    } else if (type === 'ssh') {
      const host = q('#d-shost').value.trim();
      const user = q('#d-suser').value.trim();
      const pn = port(q('#d-sport').value);
      const key = q('#d-sauth').value === 'key' ? q('#d-skey').value.trim() : '';
      if (!host) return err('Enter the server’s host name or IP address.');
      if (!user) return err('Enter the user name to log in with.');
      if (!(pn > 0)) return err('Enter a port between 1 and 65535.');
      if (q('#d-sauth').value === 'key' && !key) return err('Enter the path of the private key file.');
      config = { kind: 'ssh', host, port: pn, user, key_path: key, term: q('#d-sterm').value };
    } else if (type === 'mqtt') {
      const host = q('#d-mhost').value.trim();
      const pn = port(q('#d-mport').value);
      if (!host) return err('Enter the broker’s host name or IP address.');
      if (!(pn > 0)) return err('Enter a port between 1 and 65535.');
      config = { kind: 'mqtt', host, port: pn, tls: q('#d-mtls').checked, user: q('#d-muser').value.trim(), client_id: q('#d-mid').value.trim(), subscribe: q('#d-msub').value.trim(), publish_topic: q('#d-mpub').value.trim() };
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
      editing.secretSet = false;
      await call('session_create', { id: editing.id, name, config, autoReconnect });
      persist();
      renderAll();
      if (wasOn) {
        await call('session_disconnect', { id: editing.id });
        if (await ensureSecret(editing)) await call('session_connect', { id: editing.id });
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
      <p class="hint full">The sketch must include ArduinoOTA. Allow NuTerm through the Windows firewall on private networks, because the board connects back to this PC to fetch the file.</p>
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
const SWATCHES = {
  dark: ['#3ddc84', '#4da3ff', '#ffc857', '#ff9f68', '#c792ea', '#5fd7d7', '#e6e6e6', '#7aa2f7'],
  light: ['#0f7a3c', '#0a58b0', '#8f5d0a', '#b04a00', '#7b3fa0', '#0a6f86', '#333333', '#3a56c4'],
};
function colourField(k, label, desc) {
  const sw = SWATCHES[isDark() ? 'dark' : 'light'].map((c) => `<button type="button" class="swatch" data-set="${k}" data-c="${c}" style="background:${c}" title="${c}" aria-label="Use ${c}"></button>`).join('');
  return `<div class="full colfield"><b>${label}</b><span class="hint">${desc}</span>
        <div class="swatches">${sw}</div>
        <span class="row"><input type="color" id="x-${k}" title="Pick any colour"><input class="hex" id="x-${k}-hex" maxlength="7" spellcheck="false" aria-label="${label} as hex" placeholder="#rrggbb"><button type="button" class="btn ghost sm" data-reset="${k}" title="Use the theme's own colour">Default</button><button type="button" class="btn ghost sm" data-fix="${k}" title="Brighten the colour until it is easy to read">Make readable</button></span>
        <div class="cprev" id="x-${k}-prev">I (1572057) pngAux: PNG decoded successfully: 400x225</div>
        <div class="cwarn" id="x-${k}-warn"></div></div>`;
}

const HELP = {
  'Getting started': [
    'Click <b>+ New connection</b>, choose a type, name the board and press Add. New boards start <b>disconnected</b>: click the dot on the board\'s tab (or Connect) to open the port.',
    '<b>Serial</b> uses a COM port and a baud rate (115200 is the usual ESP default). <b>TCP / Telnet</b> is for WiFi serial bridges: Scan network finds them.',
    'Anything you type in the box at the bottom is sent when you press Enter. Up and Down recall earlier commands.',
  ],
  'RX / TX lights': [
    'RX flashes when data arrives from the board, TX when you send something. The numbers beside them count bytes since the connection opened.',
    'The dot on a tab is grey when disconnected, green when connected and amber while connecting or reconnecting. Clicking it connects or disconnects.',
  ],
  Layouts: [
    '<b>Tabs</b> shows one board at a time. <b>Rail</b> lists every board with live RX and TX. <b>Grid</b> shows all boards at once: drag a block\'s header to move it, drag the lines between blocks to resize.',
    '<b>New window</b> opens one board in its own window. In that window, <b>Minimal</b> hides the toolbar.',
  ],
  Views: [
    '<b>Raw</b> is a normal terminal. <b>Split</b> adds a decoded list (hex, ASCII, decimal, binary). <b>Decoded</b> shows only that list. <b>Aligned</b> shows raw and decoded side by side, one row per message.',
    '<b>Display…</b> changes the decoding format, timestamps and the colours of received and sent text.',
  ],
  Plot: [
    '<b>Plot</b> graphs numbers in the incoming text: <code>temp=22.4 hum=41</code> gives two named series, plain numbers become v1, v2…',
    'If values arrive glued together (for example 2222…), set <b>Digits per value</b> so every N digits become one value. 0 turns this off.',
  ],
  Flashing: [
    '<b>Flash .bin…</b> uploads firmware to an ESP over USB with esptool (choose the start address, optionally erase first) or over WiFi (OTA). Arduino boards use a compiled .hex.',
    'If the board does not respond, hold BOOT while connecting, or put it into bootloader mode first.',
  ],
  'Colours & themes': [
    'The <b>theme</b> list changes the whole app. <b>Display…</b> sets the RX and TX text colours: pick a preset swatch, type a hex value, or use the colour picker. A warning appears when a colour is hard to read on the background.',
    'Settings are remembered and shared between windows.',
  ],
  Shortcuts: ['<b>Ctrl+F</b> search · <b>F1</b> this help · <b>Enter</b> send · <b>Up / Down</b> earlier commands.'],
};
function openHelp(topic = 'Getting started') {
  if ($('#help-ov')) return $('#help-ov').remove();
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.id = 'help-ov';
  ov.innerHTML = `<div class="dlg helpdlg" role="dialog" aria-label="Help"><h3>Help</h3><nav class="helpnav"></nav><div class="helpbody"></div><div class="acts"><button type="button" class="btn" id="h-close">Close</button></div></div>`;
  document.body.append(ov);
  const nav = $('.helpnav', ov), body = $('.helpbody', ov);
  const show = (k) => {
    $$('button', nav).forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === k)));
    body.innerHTML = HELP[k].map((t) => `<p>${t}</p>`).join('');
  };
  for (const k of Object.keys(HELP)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost sm';
    b.textContent = k;
    b.onclick = () => show(k);
    nav.append(b);
  }
  show(topic);
  const close = () => ov.remove();
  $('#h-close', ov).onclick = close;
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  $('#h-close', ov).focus();
}

function openDisplayDialog() {
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Display settings">
    <h3>Display</h3>
    <div class="frm">
      ${colourField('rx', 'Incoming (RX) colour', 'Text received from the board.')}
      ${colourField('tx', 'Outgoing (TX) colour', 'Commands you send. Also recolours lines already on screen.')}
      <label class="chk full"><input type="checkbox" id="x-echo"> Show commands you send in the terminal, in the TX colour</label>
      <label class="chk full"><input type="checkbox" id="x-arrow"> Mark sent lines with →</label>
      <label>Decode as<select id="x-fmt">${FORMATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label>Split layout<select id="x-split"><option value="h">Side by side</option><option value="v">Stacked</option></select></label>
      <label class="chk full"><input type="checkbox" id="x-swap"> Decoded first (left or top) instead of raw</label>
      <label class="chk full"><input type="checkbox" id="x-ts"> Show timestamps in the decoded view</label>
      <label class="chk full"><input type="checkbox" id="x-rawts"> Show the arrival time in front of each line in the terminal (Raw view)</label>
    </div>
    <p class="hint">Use the <b>Raw / Split / Decoded</b> switch in the toolbar to show the raw terminal, both, or only the decoded view (drag the divider to resize). The decoded part lists every chunk received (RX) and sent (TX). Changes apply right away.</p>
    <div class="acts"><button type="button" class="btn ghost" id="x-reset">Reset all</button><button type="button" class="btn" id="x-close">Done</button></div>
  </form>`;
  document.body.append(ov);
  const q = (x) => $(x, ov);
  const colourOf = (k) => (k === 'rx' ? rxColour() : txColour());
  const refreshColour = (k) => {
    const v = colourOf(k);
    const bg = cssVar('--term');
    if (document.activeElement !== q(`#x-${k}-hex`)) q(`#x-${k}-hex`).value = v;
    q(`#x-${k}`).value = v;
    const prev = q(`#x-${k}-prev`);
    prev.style.color = v;
    prev.style.background = bg;
    const w = q(`#x-${k}-warn`);
    if (!/^#[0-9a-f]{6}$/i.test(v)) { w.textContent = ''; return; }
    const r = contrast(v, bg);
    w.className = 'cwarn ' + (r < 3 ? 'bad' : r < 4.5 ? 'meh' : 'good');
    w.textContent = r < 3 ? `Hard to read on this background (contrast ${r.toFixed(1)}:1). Pick a lighter colour or press Make readable.` : r < 4.5 ? `Readable, but a little dim (contrast ${r.toFixed(1)}:1).` : `Easy to read (contrast ${r.toFixed(1)}:1).`;
  };
  const setColour = (k, v) => { D[k] = v; save(); refreshColour(k); };
  const fill = () => {
    for (const k of ['rx', 'tx']) refreshColour(k);
    q('#x-echo').checked = D.echo;
    q('#x-arrow').checked = D.arrow;
    q('#x-fmt').value = D.fmt;
    q('#x-split').value = D.split;
    q('#x-swap').checked = D.swap;
    q('#x-ts').checked = D.ts;
    q('#x-rawts').checked = D.rawts;
  };
  const save = () => {
    store.set('display', D);
    applyDisplay();
  };
  fill();
  // The Windows colour picker does not always fire `input` for typed RGB values, so listen for `change` too.
  for (const k of ['rx', 'tx']) {
    for (const ev of ['input', 'change']) q(`#x-${k}`).addEventListener(ev, (e) => setColour(k, e.target.value));
    q(`#x-${k}-hex`).addEventListener('input', (e) => {
      const v = e.target.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) setColour(k, v.toLowerCase());
    });
  }
  $$('[data-set]', ov).forEach((b) => (b.onclick = () => setColour(b.dataset.set, b.dataset.c)));
  $$('[data-fix]', ov).forEach((b) => (b.onclick = () => {
    const k = b.dataset.fix;
    let c = colourOf(k);
    if (!/^#[0-9a-f]{6}$/i.test(c)) return;
    const bg = cssVar('--term');
    const to = lumOf(bg) < 0.4 ? 255 : 0;
    for (let i = 0; i < 40 && contrast(c, bg) < 4.5; i++) c = '#' + [1, 3, 5].map((j) => Math.round(parseInt(c.slice(j, j + 2), 16) * 0.88 + to * 0.12 + (to ? 4 : 0)).toString(16).padStart(2, '0')).join('');
    setColour(k, c);
  }));
  q('#x-echo').onchange = (e) => ((D.echo = e.target.checked), save());
  q('#x-arrow').onchange = (e) => ((D.arrow = e.target.checked), save());
  q('#x-fmt').onchange = (e) => ((D.fmt = e.target.value), save());
  q('#x-split').onchange = (e) => ((D.split = e.target.value), save());
  q('#x-swap').onchange = (e) => ((D.swap = e.target.checked), save());
  q('#x-ts').onchange = (e) => ((D.ts = e.target.checked), save());
  q('#x-rawts').onchange = (e) => ((D.rawts = e.target.checked), save());
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
  $('#t-theme').onchange = (e) => (store.set('theme', e.target.value), applyTheme());
  applyTheme();
  $('#status').addEventListener('click', (e) => {
    if (e.target.closest('[data-update]') && UPDATE) {
      e.preventDefault();
      openUpdateDialog();
    } else if (e.target.closest('[data-check]')) checkUpdate(true);
  });
  $('#macros').addEventListener('click', (e) => {
    if (e.target.closest('#m-edit')) return F.openMacroDialog();
    const m = e.target.closest('[data-m]');
    if (m) F.runMacro(m.dataset.m);
  });
  const view = () => {
    // Minimal mode is for pop-out windows only; the main window always shows everything.
    const min = !!popId && store.get('minimal:pop', false);
    const noInput = !!popId && store.get('noinput:pop', false);
    $('#t-min').hidden = !popId;
    document.body.classList.toggle('minimal', min);
    document.body.classList.toggle('hide-input', noInput);
    $('#t-min').textContent = min ? '☰ Full view' : '▭ Minimal';
    $('#t-inp').textContent = noInput ? 'Show input' : 'Hide input';
    $('#t-inp').hidden = !min;
    $('#t-min').hidden = !popId;
    requestAnimationFrame(fitAll);
  };
  $('#t-min').onclick = () => (store.set('minimal:pop', !store.get('minimal:pop', false)), view());
  $('#t-inp').onclick = () => (store.set('noinput:pop', !store.get('noinput:pop', false)), view());
  view();
  $('#t-top').onclick = async () => {
    const on = $('#t-top').getAttribute('aria-pressed') !== 'true';
    try {
      if (inTauri) await (await import('@tauri-apps/api/window')).getCurrentWindow().setAlwaysOnTop(on);
      $('#t-top').setAttribute('aria-pressed', String(on));
      $('#t-top').textContent = on ? '📌 On top' : 'Stay on top';
    } catch (e) {
      note(`Cannot change stay on top: ${e}`, true);
    }
  };
  $('#t-find').onclick = () => cur() && F.openSearch(cur());
  $('#t-plot').onclick = () => {
    if (!cur()) return;
    F.togglePlot(cur());
    renderToolbar();
  };
  $('#t-log').onclick = () => cur() && F.openLogDialog(cur());
  $('#t-save').onclick = () => cur() && F.openSaveDialog(cur());
  $('#b-file').onclick = () => F.openSendFileDialog();
  $('#t-disp').onclick = openDisplayDialog;
  $('#t-help').onclick = () => openHelp();
  document.addEventListener('keydown', (e) => e.key === 'F1' && (e.preventDefault(), openHelp()));
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
    if (s) call('open_window', { sessionId: s.id, title: `${s.name} — NuTerm` }).catch((e) => note(String(e), true));
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
  syncTray();
  const s = cur();
  if (s) requestAnimationFrame(() => (fitOne(s), s.term.focus()));
}

start();
