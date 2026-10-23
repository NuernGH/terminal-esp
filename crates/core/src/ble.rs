//! Bluetooth LE serial: a "UART over GATT" service (Nordic UART by default, HM-10 style
//! boards use one characteristic for both directions). Runs on its own thread because
//! btleplug is async.

use crate::chan::{ChanReader, ChanWriter, Chunk};
use btleplug::api::{Central, CharPropFlags, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use futures::stream::StreamExt;
use serde::Serialize;
use std::io;
use std::sync::mpsc;
use std::time::Duration;
use uuid::Uuid;

pub const NORDIC_SERVICE: &str = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
pub const NORDIC_WRITE: &str = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
pub const NORDIC_NOTIFY: &str = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct BleDevice {
    pub name: String,
    pub id: String,
    pub rssi: Option<i16>,
}

pub struct BleParams {
    /// Device id (or exact name) as found by a scan.
    pub id: String,
    pub notify_char: String,
    pub write_char: String,
}

pub struct BleIo {
    pub reader: ChanReader,
    pub writer: ChanWriter,
}

/// Accepts full UUIDs and the 16-bit short form (`FFE1`).
pub fn parse_uuid(text: &str) -> Result<Uuid, String> {
    let t = text.trim();
    if t.len() == 4 || t.len() == 8 {
        if let Ok(n) = u32::from_str_radix(t, 16) {
            return Ok(Uuid::from_u128(((n as u128) << 96) | 0x0000_1000_8000_0080_5F9B_34FB));
        }
    }
    Uuid::parse_str(t).map_err(|_| format!("“{text}” is not a valid Bluetooth UUID"))
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())
}

async fn first_adapter() -> Result<btleplug::platform::Adapter, String> {
    let manager = Manager::new().await.map_err(|e| format!("Bluetooth is not available: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("Bluetooth is not available: {e}"))?;
    adapters.into_iter().next().ok_or_else(|| "No Bluetooth adapter found. Turn Bluetooth on in Windows settings.".to_string())
}

/// Lists LE devices that advertise during a few seconds.
pub fn scan(secs: u64) -> Result<Vec<BleDevice>, String> {
    let rt = runtime()?;
    rt.block_on(async {
        let adapter = first_adapter().await?;
        adapter.start_scan(ScanFilter::default()).await.map_err(|e| format!("Cannot scan: {e}"))?;
        tokio::time::sleep(Duration::from_secs(secs)).await;
        let mut out = Vec::new();
        for p in adapter.peripherals().await.map_err(|e| e.to_string())? {
            let props = p.properties().await.ok().flatten();
            let name = props.as_ref().and_then(|x| x.local_name.clone()).unwrap_or_default();
            out.push(BleDevice { name, id: p.id().to_string(), rssi: props.and_then(|x| x.rssi) });
        }
        let _ = adapter.stop_scan().await;
        out.sort_by(|a, b| (a.name.is_empty(), &a.name, &a.id).cmp(&(b.name.is_empty(), &b.name, &b.id)));
        Ok(out)
    })
}

enum Cmd {
    Data(Vec<u8>),
}

pub fn connect(p: BleParams, poll: Duration) -> Result<BleIo, String> {
    let notify = parse_uuid(&p.notify_char)?;
    let write = parse_uuid(&p.write_char)?;
    let (out_tx, out_rx) = mpsc::channel::<Chunk>();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<Cmd>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let ready = ready_tx.clone();
        let result = runtime().and_then(|rt| rt.block_on(run(p, notify, write, out_tx, cmd_rx, ready_tx)));
        if let Err(e) = result {
            let _ = ready.send(Err(e));
        }
    });
    match ready_rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("The Bluetooth device did not answer in time".into()),
    }
    let writer = ChanWriter {
        send: Box::new(move |d| cmd_tx.send(Cmd::Data(d.to_vec())).map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))),
    };
    Ok(BleIo { reader: ChanReader { rx: out_rx, pending: Vec::new(), poll }, writer })
}

async fn find(adapter: &btleplug::platform::Adapter, id: &str) -> Result<Peripheral, String> {
    adapter.start_scan(ScanFilter::default()).await.map_err(|e| format!("Cannot scan: {e}"))?;
    for _ in 0..16 {
        for p in adapter.peripherals().await.map_err(|e| e.to_string())? {
            let name = p.properties().await.ok().flatten().and_then(|x| x.local_name).unwrap_or_default();
            if p.id().to_string() == id || (!name.is_empty() && name == id) {
                let _ = adapter.stop_scan().await;
                return Ok(p);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let _ = adapter.stop_scan().await;
    Err(format!("Bluetooth device “{id}” was not found. Is it switched on and in range, and not connected to another program?"))
}

async fn run(
    p: BleParams,
    notify: Uuid,
    write: Uuid,
    out: mpsc::Sender<Chunk>,
    mut cmds: tokio::sync::mpsc::UnboundedReceiver<Cmd>,
    ready: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let adapter = first_adapter().await?;
    let dev = find(&adapter, &p.id).await?;
    dev.connect().await.map_err(|e| format!("Cannot connect: {e}"))?;
    dev.discover_services().await.map_err(|e| format!("Cannot read the device's services: {e}"))?;
    let chars = dev.characteristics();
    let nc = chars.iter().find(|c| c.uuid == notify).ok_or("The device has no characteristic for receiving (check the UUIDs)")?.clone();
    let wc = chars.iter().find(|c| c.uuid == write).ok_or("The device has no characteristic for sending (check the UUIDs)")?.clone();
    dev.subscribe(&nc).await.map_err(|e| format!("Cannot subscribe to notifications: {e}"))?;
    let mut notes = dev.notifications().await.map_err(|e| e.to_string())?;
    let kind = if wc.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) { WriteType::WithoutResponse } else { WriteType::WithResponse };
    let _ = ready.send(Ok(()));
    loop {
        tokio::select! {
            n = notes.next() => match n {
                Some(n) if n.uuid == notify => { if out.send(Ok(n.value)).is_err() { break; } }
                Some(_) => {}
                None => break,
            },
            cmd = cmds.recv() => match cmd {
                Some(Cmd::Data(d)) => {
                    // Without a negotiated MTU a packet is at most 20 bytes.
                    for chunk in d.chunks(20) {
                        if let Err(e) = dev.write(&wc, chunk, kind).await {
                            let _ = out.send(Err(io::Error::other(format!("Bluetooth write failed: {e}"))));
                            let _ = dev.disconnect().await;
                            return Ok(());
                        }
                    }
                }
                None => break,
            },
        }
    }
    let _ = dev.disconnect().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_and_long_uuids() {
        assert_eq!(parse_uuid("FFE1").unwrap().to_string(), "0000ffe1-0000-1000-8000-00805f9b34fb");
        assert_eq!(parse_uuid(NORDIC_WRITE).unwrap().to_string(), "6e400002-b5a3-f393-e0a9-e50e24dcca9e");
        assert!(parse_uuid("zz").is_err());
    }
}
