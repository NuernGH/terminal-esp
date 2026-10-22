//! Firmware upload: serial flashing by driving a bundled `esptool`, and WiFi
//! flashing with the Arduino OTA protocol (the one espota.py speaks).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq)]
pub enum FlashEvent {
    Log(String),
    /// 0.0 to 100.0
    Progress(f32),
}

fn md5_hex(data: &[u8]) -> String {
    format!("{:x}", md5::compute(data))
}

/// Pulls the last "NN.N%" figure out of an esptool output line.
pub fn parse_percent(line: &str) -> Option<f32> {
    let end = line.rfind('%')?;
    let head = &line[..end];
    let start = head.rfind(|c: char| !(c.is_ascii_digit() || c == '.')).map_or(0, |i| i + 1);
    head[start..].parse().ok()
}

// ------------------------------------------------------------------ esptool

/// Looks for the esptool executable in the given folders (up to 3 levels deep),
/// then on PATH.
pub fn find_esptool(dirs: &[PathBuf]) -> Option<PathBuf> {
    fn is_esptool(name: &str) -> bool {
        matches!(name, "esptool" | "esptool.exe" | "esptool.py")
    }
    fn walk(dir: &Path, depth: u32) -> Option<PathBuf> {
        for e in std::fs::read_dir(dir).ok()?.flatten() {
            let p = e.path();
            if p.is_file() && is_esptool(&e.file_name().to_string_lossy()) {
                return Some(p);
            }
        }
        if depth > 0 {
            for e in std::fs::read_dir(dir).ok()?.flatten() {
                if e.path().is_dir() {
                    if let Some(f) = walk(&e.path(), depth - 1) {
                        return Some(f);
                    }
                }
            }
        }
        None
    }
    dirs.iter()
        .filter_map(|d| walk(d, 3))
        .next()
        .or_else(|| {
            let path = std::env::var_os("PATH")?;
            std::env::split_paths(&path)
                .flat_map(|d| ["esptool.exe", "esptool", "esptool.py"].map(|n| d.join(n)))
                .find(|p| p.is_file())
        })
}

pub struct SerialFlash<'a> {
    pub esptool: &'a Path,
    pub port: &'a str,
    pub baud: u32,
    pub address: &'a str,
    pub file: &'a Path,
    pub erase_all: bool,
}

pub fn parse_address(s: &str) -> Result<u64, String> {
    let t = s.trim();
    let v = match t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        Some(h) => u64::from_str_radix(h, 16),
        None => t.parse(),
    };
    v.map_err(|_| format!("'{s}' is not a valid address. Use a number like 0x10000."))
}

pub fn flash_serial(
    job: &SerialFlash,
    on_event: &mut dyn FnMut(FlashEvent),
    cancel: &AtomicBool,
) -> Result<(), String> {
    let addr = parse_address(job.address)?;
    let mut cmd = Command::new(job.esptool);
    cmd.arg("--port").arg(job.port).arg("--baud").arg(job.baud.to_string()).arg("write-flash");
    if job.erase_all {
        cmd.arg("--erase-all");
    }
    cmd.arg(format!("0x{addr:x}")).arg(job.file);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    on_event(FlashEvent::Log(format!("esptool: {}", job.esptool.display())));
    let mut child = cmd.spawn().map_err(|e| format!("Cannot start esptool: {e}"))?;

    let (tx, rx) = mpsc::channel::<String>();
    let mut readers = Vec::new();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        readers.push(thread::spawn(move || {
            // esptool redraws its progress line with \r, so split on both \r and \n.
            let mut cur = Vec::new();
            for b in stream.bytes().map_while(Result::ok) {
                if b == b'\r' || b == b'\n' {
                    if !cur.is_empty() {
                        let _ = tx.send(String::from_utf8_lossy(&cur).into_owned());
                        cur.clear();
                    }
                } else {
                    cur.push(b);
                }
            }
            if !cur.is_empty() {
                let _ = tx.send(String::from_utf8_lossy(&cur).into_owned());
            }
        }));
    }
    drop(tx);

    let mut tail: Vec<String> = Vec::new();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cancelled".into());
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if let Some(p) = parse_percent(&line) {
                    on_event(FlashEvent::Progress(p));
                }
                // Keep progress redraws out of the log, they only repeat the bar.
                if !line.contains("Writing at") || line.contains("100.0%") {
                    on_event(FlashEvent::Log(line.clone()));
                }
                tail.push(line);
                if tail.len() > 6 {
                    tail.remove(0);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    for r in readers {
        let _ = r.join();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        on_event(FlashEvent::Progress(100.0));
        Ok(())
    } else {
        let hint = tail.iter().rev().find(|l| !l.trim().is_empty()).cloned().unwrap_or_default();
        Err(format!("esptool failed ({status}). {hint}"))
    }
}

// ------------------------------------------------------------------ Arduino OTA

pub struct Ota<'a> {
    pub host: &'a str,
    pub port: u16,
    pub password: &'a str,
    pub firmware: &'a [u8],
    /// Flash the filesystem image instead of the program.
    pub filesystem: bool,
}

const OTA_FLASH: u32 = 0;
const OTA_FS: u32 = 100;
const OTA_AUTH: u32 = 200;
const CHUNK: usize = 1460;

pub fn flash_ota(job: &Ota, on_event: &mut dyn FnMut(FlashEvent), cancel: &AtomicBool) -> Result<(), String> {
    let size = job.firmware.len();
    if size == 0 {
        return Err("The firmware file is empty.".into());
    }
    let file_md5 = md5_hex(job.firmware);
    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| format!("Cannot open a listening port: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let udp = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    udp.connect((job.host, job.port)).map_err(|e| format!("Cannot reach {}:{}: {e}", job.host, job.port))?;
    udp.set_read_timeout(Some(Duration::from_secs(1))).map_err(|e| e.to_string())?;
    let command = if job.filesystem { OTA_FS } else { OTA_FLASH };
    let invite = format!("{command} {local_port} {size} {file_md5}\n");
    on_event(FlashEvent::Log(format!("Inviting {}:{} ({size} bytes)…", job.host, job.port)));

    // The device may be busy for a few seconds, so repeat the invitation.
    let mut reply = String::new();
    for attempt in 0..10 {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        udp.send(invite.as_bytes()).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 64];
        match udp.recv(&mut buf) {
            Ok(n) => {
                reply = String::from_utf8_lossy(&buf[..n]).trim().to_string();
                break;
            }
            Err(_) if attempt < 9 => continue,
            Err(_) => {
                return Err(format!(
                    "No answer from {}:{}. Check the address and port (ESP32 uses 3232, ESP8266 uses 8266) and that the sketch runs ArduinoOTA.",
                    job.host, job.port
                ));
            }
        }
    }
    if reply.starts_with("AUTH") {
        if job.password.is_empty() {
            return Err("The board asks for an OTA password.".into());
        }
        let nonce = reply.split_whitespace().nth(1).unwrap_or("");
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let cnonce = md5_hex(format!("{size}{file_md5}{}{seed}", job.host).as_bytes());
        let result = md5_hex(format!("{}:{nonce}:{cnonce}", md5_hex(job.password.as_bytes())).as_bytes());
        udp.send(format!("{OTA_AUTH} {cnonce} {result}\n").as_bytes()).map_err(|e| e.to_string())?;
        udp.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let mut buf = [0u8; 64];
        let n = udp.recv(&mut buf).map_err(|_| "No answer after sending the password.".to_string())?;
        reply = String::from_utf8_lossy(&buf[..n]).trim().to_string();
        if reply != "OK" {
            return Err("The board rejected the password.".into());
        }
    } else if reply != "OK" {
        return Err(format!("Unexpected answer from the board: {reply}"));
    }
    on_event(FlashEvent::Log("Board accepted the invitation, waiting for it to connect…".into()));

    let start = Instant::now();
    let mut stream: TcpStream = loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if start.elapsed() > Duration::from_secs(15) {
                    return Err("The board did not connect back. A firewall may be blocking incoming connections: allow ESP Terminal on private networks.".into());
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    stream.set_nonblocking(false).ok();
    stream.set_nodelay(true).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();

    // The board acknowledges chunks with small text replies; collect them on the side.
    let replies = Arc::new(Mutex::new(String::new()));
    {
        let mut r = stream.try_clone().map_err(|e| e.to_string())?;
        let replies = replies.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 64];
            while let Ok(n) = r.read(&mut buf) {
                if n == 0 {
                    break;
                }
                replies.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
    }

    let mut sent = 0usize;
    for chunk in job.firmware.chunks(CHUNK) {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        stream.write_all(chunk).map_err(|e| format!("Upload interrupted: {e}"))?;
        sent += chunk.len();
        on_event(FlashEvent::Progress(sent as f32 * 100.0 / size as f32));
    }
    on_event(FlashEvent::Log("Upload finished, waiting for the board to confirm…".into()));
    let end = Instant::now() + Duration::from_secs(60);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        let text = replies.lock().unwrap().clone();
        if text.contains("OK") {
            on_event(FlashEvent::Log("Board confirmed the update and is rebooting.".into()));
            return Ok(());
        }
        if text.contains("ERR") || text.to_lowercase().contains("error") {
            return Err(format!("The board reported an error: {}", text.trim()));
        }
        if Instant::now() > end {
            return Err("The board did not confirm the update.".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    #[test]
    fn parses_esptool_percentages() {
        assert_eq!(parse_percent("Writing at 0x00010000 [=====>   ]  45.3% 12345/27184 bytes..."), Some(45.3));
        assert_eq!(parse_percent("Wrote 27184 bytes (100%)"), Some(100.0));
        assert_eq!(parse_percent("Connecting...."), None);
    }

    #[test]
    fn parses_addresses() {
        assert_eq!(parse_address("0x10000"), Ok(0x10000));
        assert_eq!(parse_address(" 4096 "), Ok(4096));
        assert!(parse_address("zz").is_err());
    }

    /// Plays the ESP side of ArduinoOTA. Returns the bytes it received.
    fn fake_device(password: Option<&'static str>) -> (SocketAddr, thread::JoinHandle<Vec<u8>>) {
        let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
        udp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let addr = udp.local_addr().unwrap();
        let h = thread::spawn(move || {
            let mut buf = [0u8; 256];
            let (n, from) = udp.recv_from(&mut buf).unwrap();
            let msg = String::from_utf8_lossy(&buf[..n]).to_string();
            let parts: Vec<&str> = msg.split_whitespace().collect();
            let (port, size): (u16, usize) = (parts[1].parse().unwrap(), parts[2].parse().unwrap());
            if let Some(pw) = password {
                udp.send_to(b"AUTH 1234nonce", from).unwrap();
                let (n, _) = udp.recv_from(&mut buf).unwrap();
                let m = String::from_utf8_lossy(&buf[..n]).to_string();
                let p: Vec<&str> = m.split_whitespace().collect();
                assert_eq!(p[0], "200");
                let want = md5_hex(format!("{}:1234nonce:{}", md5_hex(pw.as_bytes()), p[1]).as_bytes());
                assert_eq!(p[2], want, "password hash must match");
            }
            udp.send_to(b"OK", from).unwrap();
            let mut tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let mut got = vec![0u8; size];
            tcp.read_exact(&mut got).unwrap();
            assert_eq!(md5_hex(&got), parts[3]);
            tcp.write_all(b"OK").unwrap();
            got
        });
        (addr, h)
    }

    #[test]
    fn ota_uploads_and_reports_progress() {
        let (addr, dev) = fake_device(None);
        let fw: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let mut last = 0.0;
        let r = flash_ota(
            &Ota { host: "127.0.0.1", port: addr.port(), password: "", firmware: &fw, filesystem: false },
            &mut |e| {
                if let FlashEvent::Progress(p) = e {
                    last = p;
                }
            },
            &AtomicBool::new(false),
        );
        assert_eq!(r, Ok(()));
        assert_eq!(dev.join().unwrap(), fw);
        assert_eq!(last, 100.0);
    }

    #[test]
    fn ota_authenticates_with_password() {
        let (addr, dev) = fake_device(Some("secret"));
        let fw = vec![7u8; 3000];
        let r = flash_ota(
            &Ota { host: "127.0.0.1", port: addr.port(), password: "secret", firmware: &fw, filesystem: false },
            &mut |_| {},
            &AtomicBool::new(false),
        );
        assert_eq!(r, Ok(()));
        dev.join().unwrap();
    }

    #[test]
    fn ota_without_password_when_required_fails_clearly() {
        let (addr, _dev) = fake_device(Some("secret"));
        let r = flash_ota(
            &Ota { host: "127.0.0.1", port: addr.port(), password: "", firmware: &[1, 2, 3], filesystem: false },
            &mut |_| {},
            &AtomicBool::new(false),
        );
        assert!(r.unwrap_err().contains("password"));
    }

    #[cfg(unix)]
    fn script(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("esptool");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn serial_flash_streams_progress_and_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let tool = script(
            dir.path(),
            r#"echo "Connecting...."; printf 'Writing at 0x00010000 [==>   ]  25.0%% 1/4 bytes...\rWriting at 0x00010000 [=====>]  75.0%% 3/4 bytes...\r'; echo "Hard resetting"; echo "args: $@" >&2"#,
        );
        let fw = dir.path().join("fw.bin");
        std::fs::write(&fw, [0u8; 8]).unwrap();
        let (mut progress, mut logs) = (Vec::new(), Vec::new());
        let r = flash_serial(
            &SerialFlash { esptool: &tool, port: "COM5", baud: 460800, address: "0x10000", file: &fw, erase_all: true },
            &mut |e| match e {
                FlashEvent::Progress(p) => progress.push(p),
                FlashEvent::Log(l) => logs.push(l),
            },
            &AtomicBool::new(false),
        );
        assert_eq!(r, Ok(()));
        assert!(progress.contains(&25.0) && progress.contains(&75.0) && progress.last() == Some(&100.0));
        let args = logs.iter().find(|l| l.starts_with("args:")).unwrap();
        assert!(args.contains("--port COM5") && args.contains("--baud 460800") && args.contains("write-flash --erase-all 0x10000"));
    }

    #[cfg(unix)]
    #[test]
    fn serial_flash_failure_reports_last_line() {
        let dir = tempfile::tempdir().unwrap();
        let tool = script(dir.path(), r#"echo "A fatal error occurred: Failed to connect" >&2; exit 2"#);
        let fw = dir.path().join("fw.bin");
        std::fs::write(&fw, [0u8; 8]).unwrap();
        let r = flash_serial(
            &SerialFlash { esptool: &tool, port: "COM5", baud: 115200, address: "0x0", file: &fw, erase_all: false },
            &mut |_| {},
            &AtomicBool::new(false),
        );
        assert!(r.unwrap_err().contains("Failed to connect"));
    }

    #[cfg(unix)]
    #[test]
    fn serial_flash_can_be_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let tool = script(dir.path(), "sleep 30");
        let fw = dir.path().join("fw.bin");
        std::fs::write(&fw, [0u8; 8]).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let c = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            c.store(true, Ordering::SeqCst);
        });
        let t = Instant::now();
        let r = flash_serial(
            &SerialFlash { esptool: &tool, port: "COM5", baud: 115200, address: "0x0", file: &fw, erase_all: false },
            &mut |_| {},
            &cancel,
        );
        assert_eq!(r, Err("Cancelled".to_string()));
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn finds_esptool_in_nested_folder() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("esptool-windows-amd64");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("esptool.exe"), b"x").unwrap();
        assert_eq!(find_esptool(&[dir.path().to_path_buf()]), Some(nested.join("esptool.exe")));
    }
}
