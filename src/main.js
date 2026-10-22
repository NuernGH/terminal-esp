import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { call, onSession, onFlash, b64ToBytes, inTauri } from './api.js';

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

// ------------------------------------------------------------------ helpers
const get = (id) => S.sessions.get(id);
const cur = () => get(S.active);
const idOf = (el) => el.closest('[data-id]')?.dataset.id;
const stateClass = (s) => (s.state === 'on' ? 'on' : s.state === 'connecting' ? 'connecting' : '');
const stateTip = (s) =>
  s.state === 'off' ? 'Disconnected. Click to connect' : s.state === 'connecting' ? 'Connecting. Click to cancel' : 'Connected. Click to disconnect';
const addrOf = (c) =>
  c.kind === 'serial' ? `${c.port} · ${c.baud}` : c.kind === 'tcp' ? `${c.host}:${c.port}` : `udp://${c.host}:${c.port}`;
const typeOf = (c) => (c.kind === 'serial' ? 'Serial' : c.kind === 'tcp' ? (c.protocol === 'telnet' ? 'Telnet' : 'TCP') : 'UDP');

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
    [...S.sessions.values()].map(({ id, name, config, lineEnd }) => ({ id, name, config, lineEnd })),
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
    foreground: css.getPropertyValue('--termfg').trim(),
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
    convertEol: true,
    theme: termTheme(),
  });
  s.fit = new FitAddon();
  s.term.loadAddon(s.fit);
  s.pane = document.createElement('div');
  s.pane.className = 'pane';
  s.pane.dataset.id = s.id;
  s.pane.innerHTML = '<header></header><div class="slot"></div>';
  s.slot = $('.slot', s.pane);
  $('#panes').append(s.pane);
  s.term.open(s.slot);
  new ResizeObserver(() => fitOne(s)).observe(s.slot);
  s.pane.addEventListener('mousedown', () => {
    if (S.layout === 'grid') select(s.id);
  });
  s.term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key === 'c' && s.term.hasSelection()) {
      navigator.clipboard?.writeText(s.term.getSelection()).catch(() => {});
      return false;
    }
    return true;
  });
  s.term.onData((d) => {
    const eol = EOL[s.lineEnd] || '\r';
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
    if (b64) s.term.write(b64ToBytes(b64));
  } catch {
    /* no backlog */
  }
}

async function sendText(s, text) {
  if (!text) return true;
  if (s.state !== 'on') {
    note('Not connected. Click the status dot to connect.', true);
    return false;
  }
  try {
    await call('session_send', { id: s.id, data: text });
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
    s.term.write(b64ToBytes(ev.data));
    s.rxAt = Date.now();
  } else if (ev.type === 'meta') {
    s.name = ev.name;
    persist();
    renderAll();
  } else if (ev.type === 'state') {
    const was = s.state;
    s.state = ev.state;
    if (ev.state === 'on') s.term.write('\x1b[32m-- connected --\x1b[0m\r\n');
    else if (ev.state === 'off') {
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
      <span class="chip" id="t-addr"></span>
      <button class="btn ghost sm" id="t-conn"></button>
      <button class="btn ghost sm" id="t-settings">Port settings…</button>
      <button class="btn ghost sm" id="t-rename">Rename</button>
      <button class="btn ghost sm only-multi" id="t-win"${multi}>New window</button>
      <button class="btn ghost sm" id="t-clear">Clear</button>
      <button class="btn sm" id="t-flash">Flash .bin…</button>
    </div>
    <div class="main">
      <aside class="rail" id="rail"></aside>
      <section class="stage">
        <div class="tabs" id="tabs" role="tablist"></div>
        <div class="panes" id="panes"><div class="empty" id="empty"><h2>No connections yet</h2>Add a board by serial port, TCP/Telnet or UDP. Give it a name so you can tell your boards apart.<br><br><button class="btn" id="b-new2">+ New connection</button></div></div>
        <form class="sendbar" id="sendbar"><input id="send-in" placeholder="Type a command and press Enter…" autocomplete="off" spellcheck="false" aria-label="Send to board"><button class="btn sm">Send</button></form>
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
  $('#rail').innerHTML =
    [...S.sessions.values()]
      .map(
        (s) => `<div class="card" role="button" tabindex="0" data-id="${s.id}" aria-selected="${s.id === S.active}">
          <span class="r1"><span class="st ${stateClass(s)}" data-tog title="${stateTip(s)}"></span><span data-rename>${esc(s.name)}</span>
          <span class="x" data-remove style="margin-left:auto;opacity:.6;cursor:pointer">${S.pendingRemove === s.id ? 'Remove?' : '✕'}</span></span>
          <span class="r2">${typeOf(s.config)} · ${esc(addrOf(s.config))}</span><span class="r2" style="margin-left:-7px">${leds(s, true)}</span></div>`,
      )
      .join('') + '<button class="btn ghost" id="b-new4">+ New connection</button>';
}

function renderPaneHeaders() {
  for (const s of S.sessions.values()) {
    $('header', s.pane).innerHTML = `<span class="st ${stateClass(s)}" data-tog title="${stateTip(s)}"></span><span data-rename>${esc(s.name)}</span>${leds(s, true)}<span class="chip">${esc(addrOf(s.config))}</span>`;
    s.pane.dataset.id = s.id;
    s.pane.classList.toggle('active', s.id === S.active);
  }
}

function renderToolbar() {
  const s = cur();
  $$('#lay button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.l === S.layout)));
  for (const id of ['t-addr', 't-conn', 't-settings', 't-rename', 't-clear']) $('#' + id).hidden = !s;
  $('#t-win').hidden = !s || !!popId;
  $('#t-flash').hidden = !!popId;
  if (!s) return;
  $('#t-addr').textContent = `${typeOf(s.config)} · ${addrOf(s.config)}`;
  const c = $('#t-conn');
  c.textContent = s.state === 'off' ? 'Connect' : s.state === 'connecting' ? 'Cancel' : 'Disconnect';
  c.className = 'btn sm' + (s.state === 'on' ? ' ghost' : '');
}

function renderStatus() {
  const s = cur();
  const n = S.note;
  $('#status').innerHTML = s
    ? `<span>${s.state === 'on' ? '● Connected' : s.state === 'connecting' ? '◌ Connecting…' : '○ Disconnected'} · ${esc(s.name)}</span>${leds(s, true)}<span>${esc(s.lineEnd)}</span>${n ? `<span class="msg ${n.isErr ? 'err' : ''}">${esc(n.msg)}</span>` : ''}`
    : `<span>Ready</span>${n ? `<span class="msg ${n.isErr ? 'err' : ''}">${esc(n.msg)}</span>` : ''}`;
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
  $('#panes').style.display = ''; // keep grid/flex rules from CSS
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
const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600, 1500000];
const HINTS = {
  serial: 'A board plugged in by USB. Type a port name such as COM5 if it is not listed.',
  tcp: 'Telnet or raw TCP to a WiFi serial bridge (ESP-Link, ESP3D, ser2net or your own sketch).',
  udp: 'Connectionless datagrams. Use the same local port in the board firmware.',
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
    <div class="scanbox" id="d-scanbox">
      <div class="top"><button type="button" class="btn ghost sm" id="d-scan">Scan network</button>
        <label style="display:flex;gap:5px;align-items:center;font-size:11.5px;color:var(--mute)">Ports <input id="d-sports" value="23, 8266"></label>
        <span id="d-scanmsg">Looks for boards via mDNS and probes your local /24 subnet.</span></div>
      <div class="found" id="d-found"></div>
    </div>
    <div class="frm"><label>Line ending when you press Enter<select id="d-eol">${opt(['CR', 'LF', 'CRLF'], editing?.lineEnd ?? 'CRLF')}</select></label></div>
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
    q('#d-scanbox').hidden = t === 'serial';
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
    close();
    if (editing) {
      const wasOn = editing.state !== 'off';
      editing.name = name;
      editing.config = config;
      editing.lineEnd = lineEnd;
      await call('session_create', { id: editing.id, name, config });
      persist();
      renderAll();
      if (wasOn) {
        await call('session_disconnect', { id: editing.id });
        await call('session_connect', { id: editing.id });
      }
    } else {
      const id = 's' + Date.now().toString(36);
      await call('session_create', { id, name, config });
      addSession({ id, name, config, lineEnd });
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
  let method = last.method || (sc && sc.kind !== 'serial' ? 'ota' : 'serial');
  let running = false;
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<form class="dlg" role="dialog" aria-label="Flash firmware">
    <h3>Flash firmware${s ? ` to ${esc(s.name)}` : ''}</h3>
    <div class="frm"><label class="full">Firmware file (.bin)
      <span class="row"><input id="f-file" value="${esc(last.file || '')}" placeholder="C:\\firmware\\app.bin" autocomplete="off"><button type="button" class="btn ghost sm" id="f-browse">Browse…</button></span></label></div>
    <div class="seg two" id="f-method">
      <button type="button" data-m="serial">Serial cable<small>esptool over COM port</small></button>
      <button type="button" data-m="ota">WiFi (OTA)<small>Arduino OTA protocol</small></button>
    </div>
    <div class="frm" data-for="serial">
      <label class="full">Port<input id="f-port" list="f-ports" value="${esc(sc?.kind === 'serial' ? sc.port : last.port || ports[0]?.name || '')}" autocomplete="off"><datalist id="f-ports">${ports.map((p) => `<option value="${esc(p.name)}">${esc(p.description)}</option>`).join('')}</datalist></label>
      <label>Flash speed<select id="f-baud">${[115200, 230400, 460800, 921600].map((b) => `<option${b === (last.baud || 460800) ? ' selected' : ''}>${b}</option>`).join('')}</select></label>
      <label>Start address<input id="f-addr" list="f-addrs" value="${esc(last.address || '0x10000')}" autocomplete="off"><datalist id="f-addrs"><option value="0x10000">app image</option><option value="0x0">merged image / ESP8266</option><option value="0x1000">ESP32 bootloader</option></datalist></label>
      <label class="chk full"><input type="checkbox" id="f-erase"> Erase the whole flash first (also wipes saved WiFi settings)</label>
      <p class="hint full">${tool ? 'Uses esptool: ' + esc(tool) : '<span class="err-text">esptool was not found. The installer bundles it; a local build needs esptool on PATH.</span>'}<br>Typical addresses: 0x10000 for an app .bin from Arduino or PlatformIO, 0x0 for a merged image or an ESP8266 firmware.</p>
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
  q('#f-close').onclick = () => !running && close();
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && !running && close());
  q('#f-file').focus();
  q('#f-browse').onclick = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const f = await open({ multiple: false, filters: [{ name: 'Firmware', extensions: ['bin'] }, { name: 'All files', extensions: ['*'] }] });
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
    if (method === 'serial') {
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
  $('#t-conn').onclick = () => toggle(S.active);
  $('#t-settings').onclick = () => openDialog(S.active);
  $('#t-rename').onclick = () => startRename(S.active, visibleName(S.active));
  $('#t-clear').onclick = () => {
    const s = cur();
    if (s) {
      s.term.clear();
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
    if (await sendText(s, text + (EOL[s.lineEnd] ?? '\r\n'))) {
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
    await call('session_create', { id: info.id, name: info.name, config: info.config });
    const live = (await call('session_list')).find((x) => x.id === info.id);
    const s = addSession({ ...info, ...(live ? { state: live.state, rx: live.rx, tx: live.tx } : {}) });
    await replayBacklog(s);
  }
  const saved = store.get('active', null);
  S.active = popId ? popId : S.sessions.has(saved) ? saved : [...S.sessions.keys()][0] ?? null;
  renderAll();
  const s = cur();
  if (s) requestAnimationFrame(() => (fitOne(s), s.term.focus()));
}

start();
