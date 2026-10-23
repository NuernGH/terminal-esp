//! MQTT as a text stream: every received message becomes a line `[topic] payload`,
//! and a line you send is published (`topic payload`, or just the payload when a
//! publish topic is configured).

use crate::chan::{ChanReader, ChanWriter, Chunk};
use rumqttc::{Client, Event, MqttOptions, Packet, QoS, Transport};
use std::io;
use std::sync::mpsc;
use std::time::Duration;

pub struct MqttParams {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub user: String,
    pub password: Option<String>,
    pub client_id: String,
    pub subscribe: Vec<String>,
    pub publish_topic: String,
}

pub struct MqttIo {
    pub reader: ChanReader,
    pub writer: ChanWriter,
}

/// Splits a typed line into `(topic, payload)`.
pub fn split_line(line: &str, default_topic: &str) -> Option<(String, String)> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() {
        return None;
    }
    if !default_topic.is_empty() {
        return Some((default_topic.to_string(), line.to_string()));
    }
    let line = line.trim_start();
    let (topic, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    Some((topic.to_string(), rest.trim_start().to_string()))
}

pub fn connect(p: MqttParams, poll: Duration) -> Result<MqttIo, String> {
    let id = if p.client_id.is_empty() { format!("esp-terminal-{:x}", std::process::id()) } else { p.client_id.clone() };
    let mut opts = MqttOptions::new(id, p.host.clone(), p.port);
    opts.set_keep_alive(Duration::from_secs(5));
    if !p.user.is_empty() {
        opts.set_credentials(p.user.clone(), p.password.clone().unwrap_or_default());
    }
    if p.tls {
        opts.set_transport(Transport::tls_with_config(rumqttc::TlsConfiguration::Native));
    }
    let (client, mut conn) = Client::new(opts, 64);
    for t in p.subscribe.iter().filter(|t| !t.is_empty()) {
        client.subscribe(t.clone(), QoS::AtMostOnce).map_err(|e| e.to_string())?;
    }
    let (out_tx, out_rx) = mpsc::channel::<Chunk>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let target = format!("{}:{}", p.host, p.port);
    std::thread::spawn(move || {
        let mut ready = Some(ready_tx);
        for ev in conn.iter() {
            match ev {
                Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                    if let Some(r) = ready.take() {
                        let _ = r.send(if format!("{:?}", ack.code) == "Success" { Ok(()) } else { Err(format!("The broker refused the login: {:?}", ack.code)) });
                    }
                }
                Ok(Event::Incoming(Packet::Publish(m))) => {
                    let line = format!("[{}] {}\r\n", m.topic, String::from_utf8_lossy(&m.payload));
                    if out_tx.send(Ok(line.into_bytes())).is_err() {
                        break;
                    }
                }
                Ok(_) => {
                    // Outgoing keep-alives let this loop notice that the session was closed.
                    if ready.is_none() && out_tx.send(Ok(Vec::new())).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    match ready.take() {
                        Some(r) => drop(r.send(Err(format!("Cannot connect to {target}: {e}")))),
                        None => drop(out_tx.send(Err(io::Error::other(format!("MQTT connection lost: {e}"))))),
                    }
                    break;
                }
            }
        }
    });
    match ready_rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("The MQTT broker did not answer in time".into()),
    }
    let default_topic = p.publish_topic.clone();
    let mut line = String::new();
    let writer = ChanWriter {
        send: Box::new(move |d| {
            line.push_str(&String::from_utf8_lossy(d));
            while let Some(i) = line.find(['\r', '\n']) {
                let one: String = line.drain(..=i).collect();
                if let Some((topic, payload)) = split_line(&one, &default_topic) {
                    client.publish(topic, QoS::AtMostOnce, false, payload.into_bytes()).map_err(io::Error::other)?;
                }
            }
            Ok(())
        }),
    };
    Ok(MqttIo { reader: ChanReader { rx: out_rx, pending: Vec::new(), poll }, writer })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_topic_and_payload() {
        assert_eq!(split_line("home/led on\r\n", ""), Some(("home/led".into(), "on".into())));
        assert_eq!(split_line("home/led\n", ""), Some(("home/led".into(), "".into())));
        assert_eq!(split_line("hello world\n", "cmd"), Some(("cmd".into(), "hello world".into())));
        assert_eq!(split_line("\r\n", "cmd"), None);
    }

    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn packet(s: &mut TcpStream) -> (u8, Vec<u8>) {
        let mut h = [0u8; 1];
        s.read_exact(&mut h).unwrap();
        let (mut len, mut shift) = (0usize, 0);
        loop {
            let mut b = [0u8; 1];
            s.read_exact(&mut b).unwrap();
            len |= ((b[0] & 0x7f) as usize) << shift;
            if b[0] & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        let mut body = vec![0u8; len];
        s.read_exact(&mut body).unwrap();
        (h[0], body)
    }

    #[test]
    fn receives_and_publishes_through_a_broker() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (got_tx, got_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            assert_eq!(packet(&mut s).0, 0x10); // CONNECT
            s.write_all(&[0x20, 2, 0, 0]).unwrap();
            let (t, body) = packet(&mut s);
            assert_eq!(t, 0x82); // SUBSCRIBE
            s.write_all(&[0x90, 3, body[0], body[1], 0]).unwrap();
            let topic = b"home/temp";
            let payload = b"21.5";
            let mut p = vec![0x30, (2 + topic.len() + payload.len()) as u8, 0, topic.len() as u8];
            p.extend_from_slice(topic);
            p.extend_from_slice(payload);
            s.write_all(&p).unwrap();
            loop {
                let (t, body) = packet(&mut s);
                if t & 0xf0 == 0x30 {
                    let tl = ((body[0] as usize) << 8) | body[1] as usize;
                    got_tx.send((String::from_utf8_lossy(&body[2..2 + tl]).to_string(), String::from_utf8_lossy(&body[2 + tl..]).to_string())).unwrap();
                    break;
                }
            }
        });
        let mut io = connect(
            MqttParams { host: "127.0.0.1".into(), port, tls: false, user: String::new(), password: None, client_id: "t".into(), subscribe: vec!["home/#".into()], publish_topic: String::new() },
            Duration::from_millis(100),
        )
        .unwrap();
        let mut buf = [0u8; 128];
        let mut text = String::new();
        let t = std::time::Instant::now();
        while !text.contains("21.5") && t.elapsed() < Duration::from_secs(5) {
            if let Ok(n) = io.reader.read(&mut buf) {
                text.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        }
        assert_eq!(text, "[home/temp] 21.5\r\n");
        io.writer.write_all(b"home/led on\r").unwrap();
        assert_eq!(got_rx.recv_timeout(Duration::from_secs(5)).unwrap(), ("home/led".to_string(), "on".to_string()));
    }
}
