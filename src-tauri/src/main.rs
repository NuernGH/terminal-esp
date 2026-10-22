#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use esp_core::{scan, Config, Event, Manager, PortInfo, SessionInfo};
use serde_json::{json, Value};
use esp_core::flash::{self, FlashEvent};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager as _;
use tauri::{AppHandle, Emitter, State, WebviewUrl, WebviewWindowBuilder};

struct Core(Manager);
/// Cancel flag of the flash job in progress (only one at a time).
struct FlashJob(Mutex<Option<Arc<AtomicBool>>>);

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "lowercase")]
enum FlashRequest {
    Serial { file: String, port: String, baud: u32, address: String, erase: bool, session_id: Option<String> },
    Ota { file: String, host: String, port: u16, password: String, filesystem: bool, session_id: Option<String> },
}

/// Data goes to the UI as base64 so binary output survives JSON.
fn payload(e: Event) -> Value {
    match e {
        Event::Data { id, bytes } => json!({ "type": "data", "id": id, "data": STANDARD.encode(bytes) }),
        other => serde_json::to_value(other).unwrap_or(Value::Null),
    }
}

#[tauri::command]
fn list_serial_ports() -> Vec<PortInfo> {
    esp_core::list_serial_ports()
}

#[tauri::command]
fn session_create(eng: State<Core>, id: String, name: String, config: Config) {
    eng.0.create(&id, &name, config);
}

#[tauri::command]
fn session_rename(eng: State<Core>, id: String, name: String) -> Result<(), String> {
    eng.0.rename(&id, &name)
}

#[tauri::command]
fn session_remove(eng: State<Core>, id: String) {
    eng.0.remove(&id);
}

#[tauri::command]
fn session_list(eng: State<Core>) -> Vec<SessionInfo> {
    eng.0.list()
}

#[tauri::command]
fn session_connect(eng: State<Core>, id: String) -> Result<(), String> {
    eng.0.connect(&id)
}

#[tauri::command]
fn session_disconnect(eng: State<Core>, id: String) -> Result<(), String> {
    eng.0.disconnect(&id)
}

#[tauri::command]
fn session_send(eng: State<Core>, id: String, data: String) -> Result<(), String> {
    eng.0.send(&id, data.as_bytes())
}

#[tauri::command]
fn session_backlog(eng: State<Core>, id: String) -> Result<String, String> {
    eng.0.backlog(&id).map(|b| STANDARD.encode(b))
}

#[tauri::command]
fn session_clear(eng: State<Core>, id: String) -> Result<(), String> {
    eng.0.clear_backlog(&id)
}

#[tauri::command]
async fn scan_network(ports: Vec<u16>) -> Result<Vec<scan::Found>, String> {
    tauri::async_runtime::spawn_blocking(move || scan::scan_network(&ports))
        .await
        .map_err(|e| e.to_string())
}

/// Opens (or focuses) a separate window that shows one session.
#[tauri::command]
async fn open_window(app: AppHandle, session_id: String, title: String) -> Result<(), String> {
    let label = format!("pop-{session_id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html?session={session_id}").into()))
        .title(title)
        .inner_size(900.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn esptool_dirs(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(d) = app.path().resource_dir() {
        dirs.push(d);
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        dirs.push(d);
    }
    dirs
}

/// Path of the esptool that serial flashing will use, if one can be found.
#[tauri::command]
fn esptool_path(app: AppHandle) -> Option<String> {
    flash::find_esptool(&esptool_dirs(&app)).map(|p| p.display().to_string())
}

#[tauri::command]
fn flash_cancel(job: State<FlashJob>) {
    if let Some(c) = job.0.lock().unwrap().as_ref() {
        c.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn flash_start(app: AppHandle, job: State<FlashJob>, req: FlashRequest) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = job.0.lock().unwrap();
        if slot.is_some() {
            return Err("A firmware upload is already running.".into());
        }
        *slot = Some(cancel.clone());
    }
    std::thread::spawn(move || {
        let emit = |v: Value| {
            let _ = app.emit("flash", v);
        };
        let core = app.state::<Core>();
        let (is_serial, session_id) = match &req {
            FlashRequest::Serial { session_id, .. } => (true, session_id.clone()),
            FlashRequest::Ota { session_id, .. } => (false, session_id.clone()),
        };
        // A serial upload needs the COM port, so release it first.
        let was_connected = session_id
            .as_ref()
            .and_then(|id| core.0.list().into_iter().find(|s| &s.id == id))
            .map(|s| s.state != esp_core::ConnState::Off)
            .unwrap_or(false);
        if is_serial && was_connected {
            if let Some(id) = &session_id {
                let _ = core.0.disconnect(id);
                std::thread::sleep(Duration::from_millis(300));
            }
        }
        let mut on_event = |e: FlashEvent| match e {
            FlashEvent::Log(line) => emit(json!({ "type": "log", "line": line })),
            FlashEvent::Progress(pct) => emit(json!({ "type": "progress", "pct": pct })),
        };
        let result = match &req {
            FlashRequest::Serial { file, port, baud, address, erase, .. } => {
                let path = std::path::Path::new(file);
                if !path.is_file() {
                    Err(format!("File not found: {file}"))
                } else {
                    match flash::find_esptool(&esptool_dirs(&app)) {
                        None => Err("esptool was not found. The installer bundles it; for a local build put esptool.exe in src-tauri/resources/esptool or on PATH.".to_string()),
                        Some(tool) => flash::flash_serial(
                            &flash::SerialFlash { esptool: &tool, port, baud: *baud, address, file: path, erase_all: *erase },
                            &mut on_event,
                            &cancel,
                        ),
                    }
                }
            }
            FlashRequest::Ota { file, host, port, password, filesystem, .. } => match std::fs::read(file) {
                Err(e) => Err(format!("Cannot read {file}: {e}")),
                Ok(bytes) => flash::flash_ota(
                    &flash::Ota { host, port: *port, password, firmware: &bytes, filesystem: *filesystem },
                    &mut on_event,
                    &cancel,
                ),
            },
        };
        match &result {
            Ok(()) => emit(json!({ "type": "done" })),
            Err(m) => emit(json!({ "type": "error", "message": m })),
        }
        // Reopen the session so the boot log of the new firmware shows up.
        if let (true, Some(id)) = (was_connected, &session_id) {
            let wait = if is_serial { 1500 } else { 6000 };
            std::thread::sleep(Duration::from_millis(if result.is_ok() { wait } else { 500 }));
            let _ = core.0.connect(id);
        }
        *app.state::<FlashJob>().0.lock().unwrap() = None;
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let mgr = Manager::new(move |e| {
                let _ = handle.emit("session", payload(e));
            });
            app.manage(Core(mgr));
            app.manage(FlashJob(Mutex::new(None)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            session_create,
            session_rename,
            session_remove,
            session_list,
            session_connect,
            session_disconnect,
            session_send,
            session_backlog,
            session_clear,
            scan_network,
            open_window,
            esptool_path,
            flash_start,
            flash_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ESP Terminal");
}
