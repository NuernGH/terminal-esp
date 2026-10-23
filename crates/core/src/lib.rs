//! Connection engine for the ESP terminal: sessions over serial, TCP/Telnet and
//! UDP, with RX/TX counters, a scrollback backlog and network discovery.
//! It has no GUI dependency; the Tauri shell feeds it an event callback.

pub mod flash;
pub mod scan;
pub mod telnet;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use telnet::TelnetFilter;

const BACKLOG_MAX: usize = 512 * 1024;
const POLL: Duration = Duration::from_millis(100);

fn d_baud() -> u32 {
    115_200
}
fn d_8() -> u8 {
    8
}
fn d_1() -> u8 {
    1
}
fn d_none() -> String {
    "none".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Config {
    Serial {
        port: String,
        #[serde(default = "d_baud")]
        baud: u32,
        #[serde(default = "d_8")]
        data_bits: u8,
        #[serde(default = "d_none")]
        parity: String,
        #[serde(default = "d_1")]
        stop_bits: u8,
        #[serde(default = "d_none")]
        flow: String,
        #[serde(default)]
        reset_on_connect: bool,
    },
    Tcp {
        host: String,
        port: u16,
        /// "telnet" or "raw"
        #[serde(default = "d_none")]
        protocol: String,
    },
    Udp {
        host: String,
        port: u16,
        #[serde(default)]
        local_port: u16,
    },
}

impl Config {
    /// Short address text for display, e.g. `192.168.1.42:23` or `COM5 · 115200`.
    pub fn address(&self) -> String {
        match self {
            Config::Serial { port, baud, .. } => format!("{port} · {baud}"),
            Config::Tcp { host, port, .. } => format!("{host}:{port}"),
            Config::Udp { host, port, .. } => format!("udp://{host}:{port}"),
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnState {
    Off,
    Connecting,
    On,
}

#[derive(Serialize, Clone, Debug)]
pub struct StatRow {
    pub id: String,
    pub rx: u64,
    pub tx: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    Data { id: String, bytes: Vec<u8> },
    State { id: String, state: ConnState, message: Option<String> },
    Stats { rows: Vec<StatRow> },
    Meta { id: String, name: String },
    /// Settings that changed while the session exists (baud rate, auto-reconnect).
    Settings { id: String, config: Config, auto_reconnect: bool },
}

#[derive(Serialize, Clone, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub config: Config,
    pub auto_reconnect: bool,
    pub state: ConnState,
    pub rx: u64,
    pub tx: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct PortInfo {
    pub name: String,
    pub description: String,
}

pub fn list_serial_ports() -> Vec<PortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let description = match p.port_type {
                serialport::SerialPortType::UsbPort(u) => [u.manufacturer, u.product]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" "),
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                serialport::SerialPortType::PciPort => "PCI".into(),
                serialport::SerialPortType::Unknown => String::new(),
            };
            PortInfo { name: p.port_name, description }
        })
        .collect()
}

struct Conn {
    tx: Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    telnet: bool,
    /// Handle to the open serial port, used to change settings while connected.
    serial: Option<Mutex<Box<dyn serialport::SerialPort>>>,
}

struct Meta {
    name: String,
    config: Config,
    auto_reconnect: bool,
}

struct Session {
    meta: Mutex<Meta>,
    state: Mutex<ConnState>,
    generation: AtomicU64,
    conn: Mutex<Option<Conn>>,
    rx: AtomicU64,
    tx: AtomicU64,
    backlog: Mutex<VecDeque<u8>>,
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    emit: Box<dyn Fn(Event) + Send + Sync>,
    retry_delay: Mutex<Duration>,
}

#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}

struct Opened {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    telnet: bool,
    /// A zero-length read means the peer closed (true for TCP, not for UDP).
    eof_on_zero: bool,
    control: Option<Box<dyn serialport::SerialPort>>,
}

struct UdpIo(UdpSocket);

impl Read for UdpIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.recv(buf)
    }
}

impl Write for UdpIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.send(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn open(cfg: &Config) -> Result<Opened, String> {
    match cfg {
        Config::Serial { port, baud, data_bits, parity, stop_bits, flow, reset_on_connect } => {
            use serialport::{DataBits, FlowControl, Parity, StopBits};
            let mut p = serialport::new(port, *baud)
                .timeout(POLL)
                .data_bits(match data_bits {
                    5 => DataBits::Five,
                    6 => DataBits::Six,
                    7 => DataBits::Seven,
                    _ => DataBits::Eight,
                })
                .parity(match parity.as_str() {
                    "even" => Parity::Even,
                    "odd" => Parity::Odd,
                    _ => Parity::None,
                })
                .stop_bits(if *stop_bits == 2 { StopBits::Two } else { StopBits::One })
                .flow_control(match flow.as_str() {
                    "rtscts" => FlowControl::Hardware,
                    "xonxoff" => FlowControl::Software,
                    _ => FlowControl::None,
                })
                .open()
                .map_err(|e| format!("Cannot open {port}: {e}"))?;
            if *reset_on_connect {
                // Pulse EN via RTS with GPIO0 released (DTR low): a normal run reset.
                let _ = p.write_data_terminal_ready(false);
                let _ = p.write_request_to_send(true);
                thread::sleep(Duration::from_millis(100));
                let _ = p.write_request_to_send(false);
            }
            let writer = p.try_clone().map_err(|e| e.to_string())?;
            let control = p.try_clone().map_err(|e| e.to_string())?;
            Ok(Opened { reader: Box::new(p), writer: Box::new(writer), telnet: false, eof_on_zero: false, control: Some(control) })
        }
        Config::Tcp { host, port, protocol } => {
            let addrs = (host.as_str(), *port)
                .to_socket_addrs()
                .map_err(|e| format!("Cannot resolve {host}: {e}"))?;
            let mut last = format!("No address for {host}");
            for a in addrs {
                match TcpStream::connect_timeout(&a, Duration::from_secs(4)) {
                    Ok(s) => {
                        let _ = s.set_nodelay(true);
                        s.set_read_timeout(Some(POLL)).map_err(|e| e.to_string())?;
                        let w = s.try_clone().map_err(|e| e.to_string())?;
                        return Ok(Opened {
                            reader: Box::new(s),
                            writer: Box::new(w),
                            telnet: protocol == "telnet",
                            eof_on_zero: true,
                            control: None,
                        });
                    }
                    Err(e) => last = format!("Cannot connect to {a}: {e}"),
                }
            }
            Err(last)
        }
        Config::Udp { host, port, local_port } => {
            let sock = UdpSocket::bind(("0.0.0.0", *local_port))
                .map_err(|e| format!("Cannot listen on UDP {local_port}: {e}"))?;
            sock.connect((host.as_str(), *port))
                .map_err(|e| format!("Cannot reach {host}:{port}: {e}"))?;
            sock.set_read_timeout(Some(POLL)).map_err(|e| e.to_string())?;
            let w = sock.try_clone().map_err(|e| e.to_string())?;
            Ok(Opened { reader: Box::new(UdpIo(sock)), writer: Box::new(UdpIo(w)), telnet: false, eof_on_zero: false, control: None })
        }
    }
}

impl Manager {
    pub fn new(emit: impl Fn(Event) + Send + Sync + 'static) -> Self {
        let m = Manager {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                emit: Box::new(emit),
                retry_delay: Mutex::new(Duration::from_secs(2)),
            }),
        };
        let weak = Arc::downgrade(&m.inner);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(250));
            let Some(inner) = weak.upgrade() else { break };
            let rows: Vec<StatRow> = inner
                .sessions
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, s)| *s.state.lock().unwrap() == ConnState::On)
                .map(|(id, s)| StatRow { id: id.clone(), rx: s.rx.load(Ordering::Relaxed), tx: s.tx.load(Ordering::Relaxed) })
                .collect();
            if !rows.is_empty() {
                (inner.emit)(Event::Stats { rows });
            }
        });
        m
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.inner.sessions.lock().unwrap().get(id).cloned().ok_or_else(|| format!("Unknown session {id}"))
    }

    fn set_state(&self, id: &str, s: &Session, state: ConnState, message: Option<String>) {
        *s.state.lock().unwrap() = state;
        (self.inner.emit)(Event::State { id: id.to_string(), state, message });
    }

    /// Registers a session (disconnected). Re-creating an existing id only updates it.
    pub fn create(&self, id: &str, name: &str, config: Config, auto_reconnect: bool) {
        let mut map = self.inner.sessions.lock().unwrap();
        if let Some(s) = map.get(id) {
            *s.meta.lock().unwrap() = Meta { name: name.to_string(), config, auto_reconnect };
            return;
        }
        map.insert(
            id.to_string(),
            Arc::new(Session {
                meta: Mutex::new(Meta { name: name.to_string(), config, auto_reconnect }),
                state: Mutex::new(ConnState::Off),
                generation: AtomicU64::new(0),
                conn: Mutex::new(None),
                rx: AtomicU64::new(0),
                tx: AtomicU64::new(0),
                backlog: Mutex::new(VecDeque::new()),
            }),
        );
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let s = self.get(id)?;
        s.meta.lock().unwrap().name = name.to_string();
        (self.inner.emit)(Event::Meta { id: id.to_string(), name: name.to_string() });
        Ok(())
    }

    pub fn remove(&self, id: &str) {
        let _ = self.disconnect(id);
        self.inner.sessions.lock().unwrap().remove(id);
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let map = self.inner.sessions.lock().unwrap();
        let mut v: Vec<_> = map
            .iter()
            .map(|(id, s)| {
                let m = s.meta.lock().unwrap();
                SessionInfo {
                    id: id.clone(),
                    name: m.name.clone(),
                    config: m.config.clone(),
                    auto_reconnect: m.auto_reconnect,
                    state: *s.state.lock().unwrap(),
                    rx: s.rx.load(Ordering::Relaxed),
                    tx: s.tx.load(Ordering::Relaxed),
                }
            })
            .collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn backlog(&self, id: &str) -> Result<Vec<u8>, String> {
        Ok(self.get(id)?.backlog.lock().unwrap().iter().copied().collect())
    }

    pub fn clear_backlog(&self, id: &str) -> Result<(), String> {
        self.get(id)?.backlog.lock().unwrap().clear();
        Ok(())
    }

    /// Starts connecting in the background; progress arrives as `State` events.
    pub fn connect(&self, id: &str) -> Result<(), String> {
        let s = self.get(id)?;
        let generation = s.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(old) = s.conn.lock().unwrap().take() {
            old.stop.store(true, Ordering::SeqCst);
        }
        self.set_state(id, &s, ConnState::Connecting, None);
        self.spawn_connect(id, s, generation);
        Ok(())
    }

    /// Tries to open the transport. With auto-reconnect on, keeps trying until it
    /// works or the user disconnects; otherwise reports the first failure.
    fn spawn_connect(&self, id: &str, s: Arc<Session>, generation: u64) {
        let m = self.clone();
        let id = id.to_string();
        thread::spawn(move || loop {
            let cfg = s.meta.lock().unwrap().config.clone();
            match open(&cfg) {
                Ok(opened) => {
                    if s.generation.load(Ordering::SeqCst) == generation {
                        m.start_io(&id, &s, generation, opened);
                    }
                    return;
                }
                Err(e) => {
                    if s.generation.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    if !s.meta.lock().unwrap().auto_reconnect {
                        m.set_state(&id, &s, ConnState::Off, Some(e));
                        return;
                    }
                    let delay = *m.inner.retry_delay.lock().unwrap();
                    let until = std::time::Instant::now() + delay;
                    while std::time::Instant::now() < until {
                        if s.generation.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                }
            }
        });
    }

    /// Lets tests shorten the wait between reconnect attempts.
    pub fn set_retry_delay(&self, d: Duration) {
        *self.inner.retry_delay.lock().unwrap() = d;
    }

    /// Changes the baud rate; applies immediately to an open port.
    pub fn set_baud(&self, id: &str, baud: u32) -> Result<(), String> {
        let s = self.get(id)?;
        if !matches!(s.meta.lock().unwrap().config, Config::Serial { .. }) {
            return Err("Baud rate applies to serial sessions only.".into());
        }
        if let Some(Conn { serial: Some(port), .. }) = s.conn.lock().unwrap().as_ref() {
            port.lock().unwrap().set_baud_rate(baud).map_err(|e| format!("Cannot change the baud rate: {e}"))?;
        }
        let mut meta = s.meta.lock().unwrap();
        if let Config::Serial { baud: b, .. } = &mut meta.config {
            *b = baud;
        }
        (self.inner.emit)(Event::Settings { id: id.to_string(), config: meta.config.clone(), auto_reconnect: meta.auto_reconnect });
        Ok(())
    }

    pub fn set_auto_reconnect(&self, id: &str, on: bool) -> Result<(), String> {
        let s = self.get(id)?;
        let mut meta = s.meta.lock().unwrap();
        meta.auto_reconnect = on;
        (self.inner.emit)(Event::Settings { id: id.to_string(), config: meta.config.clone(), auto_reconnect: on });
        Ok(())
    }

    fn start_io(&self, id: &str, s: &Arc<Session>, generation: u64, opened: Opened) {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        *s.conn.lock().unwrap() = Some(Conn {
            tx: tx.clone(),
            stop: stop.clone(),
            telnet: opened.telnet,
            serial: opened.control.map(Mutex::new),
        });
        self.set_state(id, s, ConnState::On, None);

        // Writer
        {
            let (stop, s) = (stop.clone(), s.clone());
            let mut writer = opened.writer;
            thread::spawn(move || loop {
                match rx.recv_timeout(POLL) {
                    Ok(data) => {
                        if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                            break;
                        }
                        s.tx.fetch_add(data.len() as u64, Ordering::Relaxed);
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            });
        }

        // Reader
        let (m, id, s) = (self.clone(), id.to_string(), s.clone());
        let mut reader = opened.reader;
        let (telnet, eof_on_zero) = (opened.telnet, opened.eof_on_zero);
        thread::spawn(move || {
            let mut filter = TelnetFilter::default();
            let mut buf = [0u8; 8192];
            let mut message = None;
            while !stop.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) if eof_on_zero => {
                        message = Some("Connection closed by the board".to_string());
                        break;
                    }
                    Ok(0) => {}
                    Ok(n) => {
                        let bytes = if telnet {
                            let mut reply = Vec::new();
                            let out = filter.process(&buf[..n], &mut reply);
                            if !reply.is_empty() {
                                let _ = tx.send(reply);
                            }
                            out
                        } else {
                            buf[..n].to_vec()
                        };
                        if bytes.is_empty() {
                            continue;
                        }
                        s.rx.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                        {
                            let mut log = s.backlog.lock().unwrap();
                            log.extend(bytes.iter().copied());
                            let excess = log.len().saturating_sub(BACKLOG_MAX);
                            if excess > 0 {
                                log.drain(..excess);
                            }
                        }
                        (m.inner.emit)(Event::Data { id: id.clone(), bytes });
                    }
                    Err(e) => match e.kind() {
                        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => {}
                        // Windows reports ICMP "port unreachable" on connected UDP sockets this way.
                        io::ErrorKind::ConnectionReset if !eof_on_zero => {}
                        _ => {
                            message = Some(format!("Connection lost: {e}"));
                            break;
                        }
                    },
                }
            }
            stop.store(true, Ordering::SeqCst);
            if s.generation.load(Ordering::SeqCst) == generation {
                *s.conn.lock().unwrap() = None;
                let auto = s.meta.lock().unwrap().auto_reconnect;
                match message {
                    Some(msg) if auto => {
                        m.set_state(&id, &s, ConnState::Connecting, Some(format!("{msg}. Reconnecting…")));
                        m.spawn_connect(&id, s.clone(), generation);
                    }
                    other => m.set_state(&id, &s, ConnState::Off, other),
                }
            }
        });
    }

    pub fn disconnect(&self, id: &str) -> Result<(), String> {
        let s = self.get(id)?;
        s.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(c) = s.conn.lock().unwrap().take() {
            c.stop.store(true, Ordering::SeqCst);
        }
        self.set_state(id, &s, ConnState::Off, None);
        Ok(())
    }

    pub fn send(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let s = self.get(id)?;
        let conn = s.conn.lock().unwrap();
        let c = conn.as_ref().ok_or("Not connected")?;
        let payload = if c.telnet { TelnetFilter::escape(data) } else { data.to_vec() };
        c.tx.send(payload).map_err(|_| "Not connected".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::time::Instant;

    fn wait_for(cond: impl Fn() -> bool) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) {
            if cond() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn tcp_telnet_roundtrip_counts_bytes_and_disconnects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            // Telnet negotiation noise followed by text; then echo what we receive.
            c.write_all(&[255, 253, 1]).unwrap();
            c.write_all(b"hello\r\n").unwrap();
            let mut buf = [0u8; 64];
            let mut got = Vec::new();
            while got.len() < 8 {
                let n = c.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
            got
        });

        let events = Arc::new(Mutex::new(Vec::<Event>::new()));
        let sink = events.clone();
        let m = Manager::new(move |e| sink.lock().unwrap().push(e));
        m.create("a", "Test", Config::Tcp { host: "127.0.0.1".into(), port, protocol: "telnet".into() }, false);
        m.connect("a").unwrap();
        assert!(wait_for(|| m.list()[0].state == ConnState::On));
        assert!(wait_for(|| m.backlog("a").unwrap() == b"hello\r\n"));
        m.send("a", b"ping\n").unwrap();
        let got = server.join().unwrap();
        assert_eq!(got, [&[255u8, 252, 1][..], b"ping\n"].concat());
        assert!(wait_for(|| m.list()[0].tx == 5 + 3)); // payload + IAC WONT reply
        assert_eq!(m.list()[0].rx, 7);
        m.disconnect("a").unwrap();
        assert_eq!(m.list()[0].state, ConnState::Off);
        assert!(m.send("a", b"x").is_err());
    }

    #[test]
    fn connection_failure_reports_message() {
        let events = Arc::new(Mutex::new(Vec::<Event>::new()));
        let sink = events.clone();
        let m = Manager::new(move |e| sink.lock().unwrap().push(e));
        // Port 1 on localhost is closed.
        m.create("b", "Bad", Config::Tcp { host: "127.0.0.1".into(), port: 1, protocol: "raw".into() }, false);
        m.connect("b").unwrap();
        assert!(wait_for(|| events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, Event::State { state: ConnState::Off, message: Some(_), .. }))));
    }

    #[test]
    fn udp_receives_and_sends() {
        let peer = UdpSocket::bind("127.0.0.1:0").unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let peer_port = peer.local_addr().unwrap().port();
        let m = Manager::new(|_| {});
        m.create("u", "Udp", Config::Udp { host: "127.0.0.1".into(), port: peer_port, local_port: 0 }, false);
        m.connect("u").unwrap();
        assert!(wait_for(|| m.list()[0].state == ConnState::On));
        m.send("u", b"hi").unwrap();
        let mut buf = [0u8; 16];
        let (n, from) = peer.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"hi");
        peer.send_to(b"reply", from).unwrap();
        assert!(wait_for(|| m.backlog("u").unwrap() == b"reply"));
    }

    #[test]
    fn config_parses_with_defaults() {
        let c: Config = serde_json::from_str(r#"{"kind":"serial","port":"COM5"}"#).unwrap();
        assert!(matches!(c, Config::Serial { baud: 115200, data_bits: 8, .. }));
    }

    #[test]
    fn auto_reconnects_after_the_board_drops_the_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            c.write_all(b"first\n").unwrap();
            drop(c); // board reboots
            let (mut c, _) = listener.accept().unwrap();
            c.write_all(b"second\n").unwrap();
            thread::sleep(Duration::from_millis(500));
        });
        let events = Arc::new(Mutex::new(Vec::<Event>::new()));
        let sink = events.clone();
        let m = Manager::new(move |e| sink.lock().unwrap().push(e));
        m.set_retry_delay(Duration::from_millis(50));
        m.create("r", "Reboot", Config::Tcp { host: "127.0.0.1".into(), port, protocol: "raw".into() }, true);
        m.connect("r").unwrap();
        assert!(wait_for(|| m.backlog("r").unwrap().ends_with(b"second\n")));
        assert_eq!(m.list()[0].state, ConnState::On);
        let ev = events.lock().unwrap();
        assert!(ev.iter().any(|e| matches!(e, Event::State { state: ConnState::Connecting, message: Some(m), .. } if m.contains("Reconnecting"))));
        drop(ev);
        server.join().unwrap();
    }

    #[test]
    fn auto_connect_keeps_trying_until_the_board_appears() {
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe); // nothing listens yet
        let m = Manager::new(|_| {});
        m.set_retry_delay(Duration::from_millis(50));
        m.create("w", "Late", Config::Tcp { host: "127.0.0.1".into(), port, protocol: "raw".into() }, true);
        m.connect("w").unwrap();
        thread::sleep(Duration::from_millis(300));
        assert_eq!(m.list()[0].state, ConnState::Connecting);
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        let _srv = thread::spawn(move || {
            let (_c, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_secs(1));
        });
        assert!(wait_for(|| m.list()[0].state == ConnState::On));
    }

    #[test]
    fn disconnect_stops_the_retry_loop() {
        let m = Manager::new(|_| {});
        m.set_retry_delay(Duration::from_millis(30));
        m.create("x", "Gone", Config::Tcp { host: "127.0.0.1".into(), port: 1, protocol: "raw".into() }, true);
        m.connect("x").unwrap();
        thread::sleep(Duration::from_millis(150));
        m.disconnect("x").unwrap();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(m.list()[0].state, ConnState::Off);
    }

    #[test]
    fn without_auto_reconnect_a_dropped_connection_stays_off() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let _srv = thread::spawn(move || {
            let (c, _) = listener.accept().unwrap();
            drop(c);
        });
        let m = Manager::new(|_| {});
        m.create("n", "Once", Config::Tcp { host: "127.0.0.1".into(), port, protocol: "raw".into() }, false);
        m.connect("n").unwrap();
        thread::sleep(Duration::from_millis(400));
        assert_eq!(m.list()[0].state, ConnState::Off);
    }

    #[test]
    fn baud_and_auto_reconnect_settings() {
        let m = Manager::new(|_| {});
        m.create("t", "Tcp", Config::Tcp { host: "h".into(), port: 1, protocol: "raw".into() }, false);
        assert!(m.set_baud("t", 9600).unwrap_err().contains("serial"));
        m.create("s", "Ser", Config::Serial { port: "COM9".into(), baud: 115200, data_bits: 8, parity: "none".into(), stop_bits: 1, flow: "none".into(), reset_on_connect: false }, false);
        m.set_baud("s", 921600).unwrap(); // not connected: just remembered
        let info = m.list().into_iter().find(|i| i.id == "s").unwrap();
        assert!(matches!(info.config, Config::Serial { baud: 921600, .. }));
        m.set_auto_reconnect("s", true).unwrap();
        assert!(m.list().into_iter().find(|i| i.id == "s").unwrap().auto_reconnect);
    }
}
