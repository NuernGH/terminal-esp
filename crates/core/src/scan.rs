//! Finds ESP boards that expose serial over the network: mDNS (`_telnet._tcp`)
//! plus a short TCP port probe of the local /24 subnet.

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Found {
    pub name: String,
    pub host: String,
    pub port: u16,
    /// "telnet" or "raw"
    pub protocol: String,
    /// "mdns" or "scan"
    pub source: String,
}

pub fn protocol_for(port: u16) -> &'static str {
    if port == 23 { "telnet" } else { "raw" }
}

/// The IPv4 address of the interface that routes to the internet. No packet is sent.
pub fn local_ipv4() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() => Some(ip),
        _ => None,
    }
}

fn mdns(wait: Duration) -> Vec<Found> {
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else { return Vec::new() };
    let Ok(rx) = daemon.browse("_telnet._tcp.local.") else { return Vec::new() };
    let mut out = Vec::new();
    let end = Instant::now() + wait;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                let name = info.get_fullname().split('.').next().unwrap_or("").to_string();
                let port = info.get_port();
                for addr in info.get_addresses() {
                    let ip = addr.to_ip_addr();
                    if ip.is_ipv4() {
                        out.push(Found {
                            name: name.clone(),
                            host: ip.to_string(),
                            port,
                            protocol: protocol_for(port).into(),
                            source: "mdns".into(),
                        });
                    }
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    out
}

/// Probes every host of `base`/24 on each port; returns open `(ip, port)` pairs.
pub fn probe_subnet(base: [u8; 3], skip: Option<u8>, ports: &[u16], timeout: Duration) -> Vec<(Ipv4Addr, u16)> {
    let targets: Vec<(Ipv4Addr, u16)> = (1..=254u8)
        .filter(|h| Some(*h) != skip)
        .flat_map(|h| ports.iter().map(move |p| (Ipv4Addr::new(base[0], base[1], base[2], h), *p)))
        .collect();
    let targets = Arc::new(targets);
    let next = Arc::new(AtomicUsize::new(0));
    let hits = Arc::new(Mutex::new(Vec::new()));
    let workers: Vec<_> = (0..64)
        .map(|_| {
            let (targets, next, hits) = (targets.clone(), next.clone(), hits.clone());
            thread::spawn(move || loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(&(ip, port)) = targets.get(i) else { break };
                if TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V4(ip), port), timeout).is_ok() {
                    hits.lock().unwrap().push((ip, port));
                }
            })
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
    let mut v = hits.lock().unwrap().clone();
    v.sort();
    v
}

/// Runs both discovery methods and merges the results (mDNS names win).
pub fn scan_network(ports: &[u16]) -> Vec<Found> {
    let mdns_handle = thread::spawn(|| mdns(Duration::from_millis(1500)));
    let mut found: Vec<Found> = Vec::new();
    if let Some(ip) = local_ipv4() {
        let o = ip.octets();
        for (ip, port) in probe_subnet([o[0], o[1], o[2]], Some(o[3]), ports, Duration::from_millis(300)) {
            found.push(Found {
                name: ip.to_string(),
                host: ip.to_string(),
                port,
                protocol: protocol_for(port).into(),
                source: "scan".into(),
            });
        }
    }
    let named = mdns_handle.join().unwrap_or_default();
    for n in named {
        if let Some(existing) = found.iter_mut().find(|f| f.host == n.host && f.port == n.port) {
            existing.name = n.name;
            existing.source = "mdns".into();
        } else {
            found.push(n);
        }
    }
    found.sort_by(|a, b| (&a.host, a.port).cmp(&(&b.host, b.port)));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn probe_finds_open_port_on_loopback_subnet() {
        let l = TcpListener::bind("127.0.0.77:0").or_else(|_| TcpListener::bind("127.0.0.1:0")).unwrap();
        let addr = l.local_addr().unwrap();
        let IpAddr::V4(ip) = addr.ip() else { panic!() };
        let o = ip.octets();
        let hits = probe_subnet([o[0], o[1], o[2]], None, &[addr.port()], Duration::from_millis(200));
        assert!(hits.contains(&(ip, addr.port())));
    }

    #[test]
    fn telnet_port_is_labelled() {
        assert_eq!(protocol_for(23), "telnet");
        assert_eq!(protocol_for(8266), "raw");
    }
}
