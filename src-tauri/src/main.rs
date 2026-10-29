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
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

struct Core(Manager);
/// Cancel flag of the flash job in progress (only one at a time).
struct FlashJob(Mutex<Option<Arc<AtomicBool>>>);

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "lowercase")]
enum FlashRequest {
    Serial { file: String, port: String, baud: u32, address: String, erase: bool, session_id: Option<String> },
    Ota { file: String, host: String, port: u16, password: String, filesystem: bool, session_id: Option<String> },
    Avr { file: String, port: String, mcu: String, programmer: String, baud: u32, session_id: Option<String> },
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
fn session_create(eng: State<Core>, id: String, name: String, config: Config, auto_reconnect: Option<bool>) {
    eng.0.create(&id, &name, config, auto_reconnect.unwrap_or(true));
}

#[tauri::command]
fn session_set_baud(eng: State<Core>, id: String, baud: u32) -> Result<(), String> {
    eng.0.set_baud(&id, baud)
}

#[tauri::command]
fn session_set_auto_reconnect(eng: State<Core>, id: String, on: bool) -> Result<(), String> {
    eng.0.set_auto_reconnect(&id, on)
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

/// Password or key passphrase for SSH / MQTT; held in memory only.
#[tauri::command]
fn session_set_secret(eng: State<Core>, id: String, secret: Option<String>) -> Result<(), String> {
    eng.0.set_secret(&id, secret)
}

/// Opens the project's release page in the default browser. Only this project's GitHub URLs are allowed.
#[tauri::command]
fn open_release_page(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/NuernGH/terminal-esp/") {
        return Err("Not an allowed address".into());
    }
    #[cfg(windows)]
    std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// True for a copy installed by the setup program, which can update itself. The unzipped portable copy cannot.
#[tauri::command]
fn can_self_update() -> bool {
    #[cfg(windows)]
    {
        std::env::current_exe()
            .map(|p| {
                let s = p.to_string_lossy().to_ascii_lowercase();
                s.contains("\\appdata\\local\\") || s.contains("\\program files")
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    false
}

/// Downloads the installer of a newer release, then runs it (it replaces the installed files and restarts the app).
/// Progress arrives as `update` events: download (done, total), install, error.
#[tauri::command]
fn start_update(app: AppHandle, url: String, sha256: Option<String>) -> Result<(), String> {
    if !esp_core::update::url_allowed(&url) {
        return Err("Not an allowed address".into());
    }
    std::thread::spawn(move || {
        let emit = |v: Value| {
            let _ = app.emit("update", v);
        };
        let dest = std::env::temp_dir().join("NuTerm-update").join("NuTerm-setup.exe");
        emit(serde_json::json!({"phase": "download", "done": 0, "total": null}));
        let result = esp_core::update::download(&url, sha256.as_deref(), &dest, |done, total| emit(serde_json::json!({"phase": "download", "done": done, "total": total})));
        match result {
            Err(e) => emit(serde_json::json!({"phase": "error", "message": e})),
            Ok(()) => {
                emit(serde_json::json!({"phase": "install"}));
                #[cfg(windows)]
                match std::process::Command::new(&dest).args(["/P", "/R", "/UPDATE"]).spawn() {
                    Ok(_) => {
                        std::thread::sleep(std::time::Duration::from_millis(800));
                        app.exit(0);
                    }
                    Err(e) => emit(serde_json::json!({"phase": "error", "message": format!("Could not start the installer: {e}")})),
                }
                #[cfg(not(windows))]
                emit(serde_json::json!({"phase": "error", "message": "Automatic updates work on Windows only"}));
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn session_resize(eng: State<Core>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    eng.0.resize(&id, cols, rows)
}

#[tauri::command]
fn session_send_bytes(eng: State<Core>, id: String, data: String) -> Result<(), String> {
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    eng.0.send(&id, &bytes)
}

/// Reads a whole file for sending to a board (base64, so binary survives).
#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
    std::fs::read(&path).map(|b| STANDARD.encode(b)).map_err(|e| format!("Cannot read {path}: {e}"))
}

/// Writes (replaces) a file, creating its folder when needed. `data` is base64.
#[tauri::command]
fn write_file(path: String, data: String) -> Result<(), String> {
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, bytes).map_err(|e| format!("Cannot write {path}: {e}"))
}

/// Appends data to a log file, creating it (and its folder) when needed.
#[tauri::command]
fn append_file(path: String, data: String) -> Result<(), String> {
    use std::io::Write;
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(&bytes))
        .map_err(|e| format!("Cannot write {path}: {e}"))
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
async fn ble_scan() -> Result<Vec<esp_core::ble::BleDevice>, String> {
    tauri::async_runtime::spawn_blocking(|| esp_core::ble::scan(4)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hid_list() -> Result<Vec<esp_core::hid::HidDeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(esp_core::hid::list).await.map_err(|e| e.to_string())?
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
    open_pop(&app, &session_id, &title)
}

/// Opens (or focuses) the pop-out window of one session.
fn open_pop(app: &AppHandle, session_id: &str, title: &str) -> Result<(), String> {
    let label = format!("pop-{session_id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("index.html?session={session_id}").into()))
        .title(title)
        .inner_size(900.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[derive(Deserialize, Clone)]
struct TraySession {
    id: String,
    name: String,
}

struct TrayNames(Mutex<Vec<TraySession>>);

fn tray_menu(app: &AppHandle, sessions: &[TraySession]) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "Show NuTerm", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    if sessions.is_empty() {
        return Menu::with_items(app, &[&show, &sep, &quit]);
    }
    let sub = Submenu::with_id(app, "sessions", "Open session in new window", true)?;
    for s in sessions {
        sub.append(&MenuItem::with_id(app, format!("open:{}", s.id), &s.name, true, None::<&str>)?)?;
    }
    Menu::with_items(app, &[&show, &sub, &sep, &quit])
}

/// The window sends its session names so the tray menu can list them.
#[tauri::command]
fn tray_set_sessions(app: AppHandle, names: State<TrayNames>, sessions: Vec<TraySession>) -> Result<(), String> {
    *names.0.lock().unwrap() = sessions.clone();
    if let Some(tray) = app.tray_by_id("main") {
        let menu = tray_menu(&app, &sessions).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
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

/// Path of the avrdude used for Arduino AVR uploads, if one can be found.
#[tauri::command]
fn avrdude_path(app: AppHandle) -> Option<String> {
    flash::find_avrdude(&esptool_dirs(&app)).map(|p| p.display().to_string())
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
            FlashRequest::Serial { session_id, .. } | FlashRequest::Avr { session_id, .. } => (true, session_id.clone()),
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
                core.0.wait_released(id, Duration::from_secs(3));
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
            FlashRequest::Avr { file, port, mcu, programmer, baud, .. } => {
                let path = std::path::Path::new(file);
                if !path.is_file() {
                    Err(format!("File not found: {file}"))
                } else {
                    match flash::find_avrdude(&esptool_dirs(&app)) {
                        None => Err("avrdude was not found. The installer bundles it; for a local build put avrdude.exe (and avrdude.conf) in src-tauri/resources/avrdude or on PATH.".to_string()),
                        Some(tool) => flash::flash_avr(
                            &flash::AvrFlash { avrdude: &tool, mcu, programmer, port, baud: *baud, file: path },
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
        .on_window_event(|window, event| {
            // Closing the main window keeps the app (and its connections) running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let mgr = Manager::new(move |e| {
                let _ = handle.emit("session", payload(e));
            });
            if let Ok(dir) = app.path().app_data_dir() {
                esp_core::set_data_dir(dir);
            }
            app.manage(Core(mgr));
            app.manage(FlashJob(Mutex::new(None)));
            app.manage(TrayNames(Mutex::new(Vec::new())));
            let menu = tray_menu(app.handle(), &[])?;
            let mut tray = TrayIconBuilder::with_id("main").tooltip("NuTerm").menu(&menu).show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == "show" {
                    show_main(app);
                } else if id == "quit" {
                    app.exit(0);
                } else if let Some(sid) = id.strip_prefix("open:") {
                    let name = app.state::<TrayNames>().0.lock().unwrap().iter().find(|s| s.id == sid).map(|s| s.name.clone()).unwrap_or_default();
                    let _ = open_pop(app, sid, &format!("{name} — NuTerm"));
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            session_create,
            session_set_baud,
            session_set_auto_reconnect,
            session_rename,
            session_remove,
            session_list,
            session_connect,
            session_disconnect,
            session_send,
            session_send_bytes,
            session_resize,
            open_release_page,
            tray_set_sessions,
            session_set_secret,
            read_file_b64,
            append_file,
            write_file,
            can_self_update,
            start_update,
            session_backlog,
            session_clear,
            scan_network,
            ble_scan,
            hid_list,
            open_window,
            esptool_path,
            avrdude_path,
            flash_start,
            flash_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NuTerm");
}
