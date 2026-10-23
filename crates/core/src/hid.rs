//! Raw USB HID: input reports arrive as bytes, bytes you send go out as output reports.

use crate::chan::{ChanReader, ChanWriter, Chunk};
use hidapi::HidApi;
use serde::Serialize;
use std::ffi::CString;
use std::io;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HidDeviceInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    pub name: String,
    pub path: String,
    pub usage_page: u16,
    pub usage: u16,
}

pub struct HidParams {
    pub vendor_id: u16,
    pub product_id: u16,
    /// Exact device path when several identical devices are attached; empty to use the ids.
    pub path: String,
    /// Output report length in bytes, without the report id.
    pub report_size: usize,
}

pub struct HidIo {
    pub reader: ChanReader,
    pub writer: ChanWriter,
}

pub fn list() -> Result<Vec<HidDeviceInfo>, String> {
    let api = HidApi::new().map_err(|e| format!("Cannot list USB HID devices: {e}"))?;
    let mut v: Vec<HidDeviceInfo> = api
        .device_list()
        .map(|d| HidDeviceInfo {
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            name: [d.manufacturer_string().unwrap_or(""), d.product_string().unwrap_or("")].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" "),
            path: d.path().to_string_lossy().into_owned(),
            usage_page: d.usage_page(),
            usage: d.usage(),
        })
        .collect();
    v.sort_by(|a, b| (a.vendor_id, a.product_id, &a.path).cmp(&(b.vendor_id, b.product_id, &b.path)));
    Ok(v)
}

/// Splits what you send into output reports: report id 0, then the data, zero padded.
pub fn reports(data: &[u8], size: usize) -> Vec<Vec<u8>> {
    let size = size.max(1);
    data.chunks(size)
        .map(|c| {
            let mut r = vec![0u8; size + 1];
            r[1..=c.len()].copy_from_slice(c);
            r
        })
        .collect()
}

pub fn connect(p: HidParams, poll: Duration) -> Result<HidIo, String> {
    let api = HidApi::new().map_err(|e| format!("Cannot use USB HID: {e}"))?;
    let dev = if p.path.is_empty() {
        api.open(p.vendor_id, p.product_id)
    } else {
        api.open_path(&CString::new(p.path.clone()).map_err(|e| e.to_string())?)
    }
    .map_err(|e| format!("Cannot open the HID device {:04X}:{:04X}: {e}", p.vendor_id, p.product_id))?;
    let (out_tx, out_rx) = mpsc::channel::<Chunk>();
    let (cmd_tx, cmd_rx) = mpsc::channel::<Vec<u8>>();
    let size = p.report_size;
    std::thread::spawn(move || {
        let _api = api; // keep the library initialised while the device is open
        let mut buf = [0u8; 256];
        loop {
            match dev.read_timeout(&mut buf, 20) {
                Ok(0) => {}
                Ok(n) => {
                    if out_tx.send(Ok(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = out_tx.send(Err(io::Error::other(format!("HID device lost: {e}"))));
                    break;
                }
            }
            while let Ok(data) = cmd_rx.try_recv() {
                for r in reports(&data, size) {
                    if let Err(e) = dev.write(&r) {
                        let _ = out_tx.send(Err(io::Error::other(format!("HID write failed: {e}"))));
                        return;
                    }
                }
            }
        }
    });
    let writer = ChanWriter { send: Box::new(move |d| cmd_tx.send(d.to_vec()).map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))) };
    Ok(HidIo { reader: ChanReader { rx: out_rx, pending: Vec::new(), poll }, writer })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_reports_are_padded() {
        let r = reports(b"abc", 4);
        assert_eq!(r, vec![vec![0, b'a', b'b', b'c', 0]]);
        let r = reports(b"abcde", 4);
        assert_eq!(r.len(), 2);
        assert_eq!(r[1], vec![0, b'e', 0, 0, 0]);
    }
}
