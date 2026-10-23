//! SSH client session: password or key login, an interactive shell with a pty, and
//! trust-on-first-use host key checking. russh is async, so it runs on its own thread
//! and talks to the rest of the engine through channels.

use crate::chan::{ChanReader, ChanWriter, Chunk};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, load_secret_key};
use russh::{ChannelMsg, Disconnect, client};
use std::io;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Path of a private key; empty means password login.
    pub key_path: String,
    /// The password, or the passphrase of the key.
    pub secret: Option<String>,
    pub term: String,
    pub cols: u16,
    pub rows: u16,
    /// File that remembers host key fingerprints (`host:port SHA256:…` per line).
    pub known_hosts: Option<PathBuf>,
}

pub struct SshIo {
    pub reader: ChanReader,
    pub writer: ChanWriter,
    pub resize: Box<dyn Fn(u16, u16) + Send + Sync>,
}

enum Cmd {
    Data(Vec<u8>),
    Resize(u16, u16),
}

struct Client {
    id: String,
    known_hosts: Option<PathBuf>,
    /// Why the host key was refused, or a notice about a newly trusted one.
    note: Arc<Mutex<Option<String>>>,
    rejected: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            *self.rejected.lock().unwrap() = Some("The server presented a certificate, which is not supported".into());
            return Ok(false);
        };
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        let known = self.known_hosts.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
        let saved = known.lines().find_map(|l| l.strip_prefix(&format!("{} ", self.id)));
        match saved {
            Some(old) if old.trim() == fp => Ok(true),
            Some(old) => {
                *self.rejected.lock().unwrap() = Some(format!(
                    "The host key of {} has changed (was {}, now {fp}). Someone may be intercepting the connection. If you reinstalled the server, remove the line for {} from the known_hosts file.",
                    self.id,
                    old.trim(),
                    self.id
                ));
                Ok(false)
            }
            None => {
                if let Some(path) = &self.known_hosts {
                    use std::io::Write;
                    if let Some(dir) = path.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                        let _ = writeln!(f, "{} {fp}", self.id);
                    }
                }
                *self.note.lock().unwrap() = Some(format!("New host key for {} saved: {fp}", self.id));
                Ok(true)
            }
        }
    }
}

pub fn connect(p: SshParams, poll: Duration) -> Result<SshIo, String> {
    let (out_tx, out_rx) = mpsc::channel::<Chunk>();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<Cmd>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => return drop(ready_tx.send(Err(e.to_string()))),
        };
        let ready = ready_tx.clone();
        let result = rt.block_on(run(p, out_tx, cmd_rx, ready_tx));
        if let Err(e) = result {
            let _ = ready.send(Err(e));
        }
    });
    match ready_rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("The SSH server did not answer in time".into()),
    }
    let data_tx = cmd_tx.clone();
    let writer = ChanWriter {
        send: Box::new(move |d| data_tx.send(Cmd::Data(d.to_vec())).map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))),
    };
    let resize = Box::new(move |c, r| {
        let _ = cmd_tx.send(Cmd::Resize(c, r));
    });
    Ok(SshIo { reader: ChanReader { rx: out_rx, pending: Vec::new(), poll }, writer, resize })
}

async fn run(
    p: SshParams,
    out: mpsc::Sender<Chunk>,
    mut cmds: tokio::sync::mpsc::UnboundedReceiver<Cmd>,
    ready: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let id = format!("{}:{}", p.host, p.port);
    let note = Arc::new(Mutex::new(None));
    let rejected = Arc::new(Mutex::new(None));
    let handler = Client { id: id.clone(), known_hosts: p.known_hosts.clone(), note: note.clone(), rejected: rejected.clone() };
    let config = Arc::new(client::Config { inactivity_timeout: None, keepalive_interval: Some(Duration::from_secs(20)), ..Default::default() });
    let connect = tokio::time::timeout(Duration::from_secs(15), client::connect(config, (p.host.as_str(), p.port), handler));
    let mut session = match connect.await {
        Err(_) => return Err(format!("Cannot connect to {id}: timed out")),
        Ok(Err(e)) => {
            let why = rejected.lock().unwrap().take();
            return Err(why.unwrap_or_else(|| format!("Cannot connect to {id}: {e}")));
        }
        Ok(Ok(s)) => s,
    };
    let secret = p.secret.clone().unwrap_or_default();
    let auth = if p.key_path.is_empty() {
        session.authenticate_password(p.user.clone(), secret).await
    } else {
        let key = load_secret_key(&p.key_path, if secret.is_empty() { None } else { Some(secret.as_str()) })
            .map_err(|e| format!("Cannot read the key {}: {e}", p.key_path))?;
        let hash = session.best_supported_rsa_hash().await.map_err(|e| e.to_string())?.flatten();
        session.authenticate_publickey(p.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
    }
    .map_err(|e| format!("Login failed: {e}"))?;
    if !auth.success() {
        return Err(format!("Login failed for {}@{id}: wrong {} or the account is not allowed", p.user, if p.key_path.is_empty() { "password" } else { "key or passphrase" }));
    }
    let mut channel = session.channel_open_session().await.map_err(|e| format!("Cannot open a session: {e}"))?;
    channel
        .request_pty(false, &p.term, p.cols as u32, p.rows as u32, 0, 0, &[])
        .await
        .map_err(|e| format!("The server refused a terminal: {e}"))?;
    channel.request_shell(false).await.map_err(|e| format!("The server refused a shell: {e}"))?;
    if let Some(n) = note.lock().unwrap().take() {
        let _ = out.send(Ok(format!("{n}\r\n").into_bytes()));
    }
    let _ = ready.send(Ok(()));
    loop {
        tokio::select! {
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => { if out.send(Ok(data.to_vec())).is_err() { break; } }
                Some(ChannelMsg::ExtendedData { data, .. }) => { if out.send(Ok(data.to_vec())).is_err() { break; } }
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            cmd = cmds.recv() => match cmd {
                Some(Cmd::Data(d)) => { if channel.data(&d[..]).await.is_err() { break; } }
                Some(Cmd::Resize(c, r)) => { let _ = channel.window_change(c as u32, r as u32, 0, 0).await; }
                None => break,
            },
        }
    }
    let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server::{self, Auth, Msg, Server as _, Session};
    use russh::{Channel, ChannelId};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[derive(Clone)]
    struct Echo;

    impl server::Server for Echo {
        type Handler = Echo;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Echo {
            Echo
        }
    }

    impl server::Handler for Echo {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            Ok(if user == "pi" && password == "raspberry" { Auth::Accept } else { Auth::reject() })
        }

        async fn channel_open_session(&mut self, _c: Channel<Msg>, reply: server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn pty_request(
            &mut self,
            channel: ChannelId,
            _term: &str,
            _c: u32,
            _r: u32,
            _pw: u32,
            _ph: u32,
            _modes: &[(russh::Pty, u32)],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            session.data(channel, b"Welcome\r\n".to_vec())?;
            Ok(())
        }

        async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
            session.data(channel, data.to_vec())?;
            Ok(())
        }
    }

    fn start_server() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async move {
                let config = Arc::new(server::Config {
                    keys: vec![russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap()],
                    auth_rejection_time: Duration::from_millis(10),
                    auth_rejection_time_initial: Some(Duration::from_millis(0)),
                    ..Default::default()
                });
                let sock = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
                let _ = Echo.run_on_socket(config, &sock).await;
            });
        });
        std::thread::sleep(Duration::from_millis(300));
        port
    }

    fn params(port: u16, secret: &str, known: PathBuf) -> SshParams {
        SshParams {
            host: "127.0.0.1".into(),
            port,
            user: "pi".into(),
            key_path: String::new(),
            secret: Some(secret.into()),
            term: "xterm".into(),
            cols: 80,
            rows: 24,
            known_hosts: Some(known),
        }
    }

    fn read_some(io: &mut SshIo, want: &str) -> String {
        let mut got = String::new();
        let mut buf = [0u8; 256];
        let t = std::time::Instant::now();
        while !got.contains(want) && t.elapsed() < Duration::from_secs(10) {
            match io.reader.read(&mut buf) {
                Ok(n) if n > 0 => got.push_str(&String::from_utf8_lossy(&buf[..n])),
                _ => {}
            }
        }
        got
    }

    #[test]
    fn logs_in_with_password_and_echoes() {
        let port = start_server();
        let dir = tempfile::tempdir().unwrap();
        let known = dir.path().join("known_hosts");
        let mut io = connect(params(port, "raspberry", known.clone()), Duration::from_millis(100)).unwrap();
        let got = read_some(&mut io, "Welcome");
        assert!(got.contains("New host key"), "first connection reports the new key: {got}");
        assert!(got.contains("Welcome"));
        io.writer.write_all(b"ls\r").unwrap();
        assert!(read_some(&mut io, "ls\r").contains("ls\r"));
        (io.resize)(100, 40);
        assert!(std::fs::read_to_string(&known).unwrap().contains(&format!("127.0.0.1:{port} SHA256:")));
        // The second connection finds the key already known.
        let mut io2 = connect(params(port, "raspberry", known), Duration::from_millis(100)).unwrap();
        assert!(!read_some(&mut io2, "Welcome").contains("New host key"));
    }

    #[test]
    fn wrong_password_is_reported() {
        let port = start_server();
        let dir = tempfile::tempdir().unwrap();
        let err = connect(params(port, "nope", dir.path().join("kh")), Duration::from_millis(100)).err().unwrap();
        assert!(err.contains("Login failed"), "{err}");
    }

    #[test]
    fn changed_host_key_is_refused() {
        let port = start_server();
        let dir = tempfile::tempdir().unwrap();
        let known = dir.path().join("known_hosts");
        std::fs::write(&known, format!("127.0.0.1:{port} SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n")).unwrap();
        let err = connect(params(port, "raspberry", known), Duration::from_millis(100)).err().unwrap();
        assert!(err.contains("has changed"), "{err}");
    }
}
