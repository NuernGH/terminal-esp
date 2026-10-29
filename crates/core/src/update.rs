//! In-place updates: downloads the installer of a newer release and checks it before it is run.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// Only installers published on this repository's releases may be downloaded.
pub const ALLOWED_PREFIX: &str = "https://github.com/NuernGH/terminal-esp/releases/download/";

pub fn url_allowed(url: &str) -> bool {
    url.starts_with(ALLOWED_PREFIX) && !url.contains("..")
}

/// Downloads `url` to `dest`, reporting (bytes so far, total when known). When `expected_sha256` is given
/// (hex, optionally prefixed with `sha256:`) the file is deleted again if its hash differs.
pub fn download(url: &str, expected_sha256: Option<&str>, dest: &Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(), String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| format!("TLS setup failed: {e}"))?;
    let agent = ureq::AgentBuilder::new().tls_connector(Arc::new(tls)).timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(30)).redirects(5).build();
    let resp = agent.get(url).call().map_err(|e| format!("Download failed: {e}"))?;
    let total = resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok());
    let mut reader = resp.into_reader();
    if let Some(dir) = dest.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut file = std::fs::File::create(dest).map_err(|e| format!("Cannot write {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut done = 0u64;
    let mut last_report = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| format!("Cannot write {}: {e}", dest.display()))?;
        done += n as u64;
        if done - last_report >= 256 * 1024 {
            last_report = done;
            progress(done, total);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    progress(done, total.or(Some(done)));
    if let Some(total) = total {
        if total != done {
            let _ = std::fs::remove_file(dest);
            return Err(format!("Download incomplete ({done} of {total} bytes)"));
        }
    }
    if let Some(expected) = expected_sha256 {
        let want = expected.trim().trim_start_matches("sha256:").to_ascii_lowercase();
        let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !want.is_empty() && got != want {
            let _ = std::fs::remove_file(dest);
            return Err("The downloaded installer does not match the published checksum, so it was discarded".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    fn serve(body: Vec<u8>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                while r.read_line(&mut line).unwrap_or(0) > 2 {
                    line.clear();
                }
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(&body);
            }
        });
        format!("http://{addr}/setup.exe")
    }

    fn sha(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn downloads_and_checks_hash() {
        let body: Vec<u8> = (0..600_000u32).map(|i| (i % 251) as u8).collect();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.exe");
        let mut last = (0, None);
        download(&serve(body.clone()), Some(&format!("sha256:{}", sha(&body))), &dest, |d, t| last = (d, t)).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(last, (600_000, Some(600_000)));
    }

    #[test]
    fn wrong_hash_discards_the_file() {
        let body = vec![7u8; 1000];
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("b.exe");
        let err = download(&serve(body), Some("sha256:00"), &dest, |_, _| {}).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!dest.exists());
    }

    #[test]
    fn only_release_urls_of_this_repo() {
        assert!(url_allowed("https://github.com/NuernGH/terminal-esp/releases/download/v0.1.40/NuTerm_0.1.40_x64-setup.exe"));
        assert!(!url_allowed("https://evil.example/NuNuTerm.exe"));
        assert!(!url_allowed("https://github.com/Other/repo/releases/download/v1/x.exe"));
        assert!(!url_allowed("https://github.com/NuernGH/terminal-esp/releases/download/../../x"));
    }
}
