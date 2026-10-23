// Thin wrapper over the Tauri backend. When the page runs in a plain browser
// (npm run dev, tests) a small simulator stands in so the UI can be exercised.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const inTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

export const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const strToB64 = (s) => btoa(unescape(encodeURIComponent(s)));

const listeners = new Set();
const emit = (ev) => listeners.forEach((cb) => cb(ev));

/** Subscribe to backend session events. Returns a promise of an unlisten function. */
export async function onSession(cb) {
  if (inTauri) return listen('session', (e) => cb(e.payload));
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const flashListeners = new Set();
/** Subscribe to firmware upload events (log, progress, done, error). */
export async function onFlash(cb) {
  if (inTauri) return listen('flash', (e) => cb(e.payload));
  flashListeners.add(cb);
  return () => flashListeners.delete(cb);
}

export async function call(cmd, args = {}) {
  return inTauri ? invoke(cmd, args) : mockCall(cmd, args);
}

// ---------------------------------------------------------------- simulator
const sim = { sessions: new Map(), timers: new Map() };
const lines = ['temp=22.4C hum=41%', 'soil=312 pump=OFF', 'heap=48212 rssi=-58', 'MQTT publish ok'];

function mockCall(cmd, a) {
  switch (cmd) {
    case 'list_serial_ports':
      return Promise.resolve([
        { name: 'COM5', description: 'Silicon Labs CP210x' },
        { name: 'COM3', description: 'wch.cn USB-SERIAL CH340' },
      ]);
    case 'session_create':
      sim.sessions.set(a.id, { id: a.id, name: a.name, config: a.config, auto_reconnect: !!a.autoReconnect, state: 'off', rx: 0, tx: 0 });
      return Promise.resolve();
    case 'session_set_baud': {
      const s = sim.sessions.get(a.id);
      if (s.config.kind !== 'serial') return Promise.reject('Baud rate applies to serial sessions only.');
      s.config = { ...s.config, baud: a.baud };
      emit({ type: 'settings', id: a.id, config: s.config, auto_reconnect: s.auto_reconnect });
      return Promise.resolve();
    }
    case 'session_set_auto_reconnect': {
      const s = sim.sessions.get(a.id);
      s.auto_reconnect = a.on;
      emit({ type: 'settings', id: a.id, config: s.config, auto_reconnect: a.on });
      return Promise.resolve();
    }
    case 'session_rename': {
      sim.sessions.get(a.id).name = a.name;
      emit({ type: 'meta', id: a.id, name: a.name });
      return Promise.resolve();
    }
    case 'session_remove':
      clearInterval(sim.timers.get(a.id));
      sim.sessions.delete(a.id);
      return Promise.resolve();
    case 'session_list':
      return Promise.resolve([...sim.sessions.values()]);
    case 'session_connect': {
      const s = sim.sessions.get(a.id);
      emit({ type: 'state', id: a.id, state: 'connecting', message: null });
      setTimeout(() => {
        if (s.config.host === 'fail.local') {
          emit({ type: 'state', id: a.id, state: 'off', message: 'Cannot connect to fail.local: timed out' });
          return;
        }
        s.state = 'on';
        emit({ type: 'state', id: a.id, state: 'on', message: null });
        sim.timers.set(
          a.id,
          setInterval(() => {
            const text = lines[Math.floor(Math.random() * lines.length)] + '\r\n';
            s.rx += text.length;
            emit({ type: 'data', id: a.id, data: strToB64(text) });
            emit({ type: 'stats', rows: [{ id: a.id, rx: s.rx, tx: s.tx }] });
          }, 700),
        );
      }, 400);
      return Promise.resolve();
    }
    case 'session_disconnect': {
      clearInterval(sim.timers.get(a.id));
      sim.sessions.get(a.id).state = 'off';
      emit({ type: 'state', id: a.id, state: 'off', message: null });
      return Promise.resolve();
    }
    case 'session_send': {
      const s = sim.sessions.get(a.id);
      if (s.state !== 'on') return Promise.reject('Not connected');
      if (a.data.startsWith('!drop')) {
        clearInterval(sim.timers.get(a.id));
        s.state = 'off';
        if (s.auto_reconnect) {
          emit({ type: 'state', id: a.id, state: 'connecting', message: 'Connection lost: simulated drop. Reconnecting…' });
          setTimeout(() => mockCall('session_connect', { id: a.id }), 600);
        } else emit({ type: 'state', id: a.id, state: 'off', message: 'Connection lost: simulated drop' });
        return Promise.resolve();
      }
      s.tx += a.data.length;
      emit({ type: 'data', id: a.id, data: strToB64(a.data.replace(/\r/g, '\r\n')) });
      emit({ type: 'stats', rows: [{ id: a.id, rx: s.rx, tx: s.tx }] });
      return Promise.resolve();
    }
    case 'session_send_bytes': {
      const s = sim.sessions.get(a.id);
      if (s.state !== 'on') return Promise.reject('Not connected');
      s.tx += atob(a.data).length;
      emit({ type: 'stats', rows: [{ id: a.id, rx: s.rx, tx: s.tx }] });
      (window.__sentBytes ??= []).push(a.data);
      return Promise.resolve();
    }
    case 'read_file_b64':
      return a.path.includes('missing') ? Promise.reject(`Cannot read ${a.path}`) : Promise.resolve(strToB64('line one\nline two\nline three\n'));
    case 'append_file':
      (window.__logged ??= []).push([a.path, a.data]);
      return Promise.resolve();
    case 'session_backlog':
      return Promise.resolve('');
    case 'session_clear':
      return Promise.resolve();
    case 'scan_network':
      return new Promise((r) =>
        setTimeout(
          () =>
            r([
              { name: 'esp32-a4c2f0', host: '192.168.1.58', port: 23, protocol: 'telnet', source: 'mdns' },
              { name: '192.168.1.63', host: '192.168.1.63', port: 8266, protocol: 'raw', source: 'scan' },
            ]),
          800,
        ),
      );
    case 'esptool_path':
      return Promise.resolve('C:\\Program Files\\ESP Terminal\\esptool\\esptool.exe');
    case 'flash_start': {
      const fe = (ev) => flashListeners.forEach((cb) => cb(ev));
      sim.flashTimer && clearInterval(sim.flashTimer);
      if (a.req.file.includes('missing')) {
        setTimeout(() => fe({ type: 'error', message: `File not found: ${a.req.file}` }), 200);
        return Promise.resolve();
      }
      let pct = 0;
      fe({ type: 'log', line: a.req.method === 'ota' ? `Inviting ${a.req.host}:${a.req.port}…` : 'Connecting....' });
      sim.flashTimer = setInterval(() => {
        pct += 12.5;
        fe({ type: 'progress', pct });
        if (pct >= 100) {
          clearInterval(sim.flashTimer);
          fe({ type: 'log', line: 'Hard resetting via RTS pin...' });
          fe({ type: 'done' });
        }
      }, 150);
      return Promise.resolve();
    }
    case 'flash_cancel':
      clearInterval(sim.flashTimer);
      flashListeners.forEach((cb) => cb({ type: 'error', message: 'Cancelled' }));
      return Promise.resolve();
    case 'open_window':
      window.open(`?session=${a.sessionId}`, '_blank');
      return Promise.resolve();
    default:
      return Promise.reject(`unknown command ${cmd}`);
  }
}
