#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use esp_core::{scan, Config, Event, Manager, PortInfo, SessionInfo};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State, WebviewUrl, WebviewWindowBuilder};
use tauri::Manager as _;

struct Core(Manager);

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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let mgr = Manager::new(move |e| {
                let _ = handle.emit("session", payload(e));
            });
            app.manage(Core(mgr));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running ESP Terminal");
}
