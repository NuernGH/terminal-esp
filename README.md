# ESP Terminal

A Windows terminal for ESP boards, in the spirit of Tera Term and CoolTerm: open several
named sessions over **serial (COM)**, **TCP/Telnet** (WiFi serial bridges) or **UDP**, watch RX/TX
activity per board, and switch between Tabs, Rail and Grid layouts. Built with Tauri 2 (Rust
backend) and xterm.js.

## What works now

- Connection types: Serial (baud, data bits, parity, stop bits, flow control, optional reset pulse),
  TCP with Telnet or raw mode, UDP.
- Named sessions. Double-click a name to rename. Sessions and layout are remembered.
- A new session is added **disconnected**. The status dot (and the Connect button) connects and disconnects.
- RX/TX LEDs and byte counters on every session.
- Scan network: mDNS (`_telnet._tcp`) plus a TCP port probe of the local /24 subnet.
- Layouts: Tabs, Rail, Grid. Any session can pop out into its own window.
- **Flash .bin** (toolbar button): over a serial cable with the bundled esptool (any ESP chip,
  chosen start address, optional full erase), or over WiFi with the Arduino OTA protocol
  (ESP32 port 3232, ESP8266 port 8266, optional password, firmware or filesystem image).
  A serial upload releases the COM port and reconnects the session afterwards.
- Typing in the terminal sends keystrokes (Enter uses the session's line ending); there is also a
  send box with history (Up/Down).

## Not done yet

- HTTP uploads to a web updater (`/update`), as used by Tasmota and ESPHome.
- RFC 2217, log-to-file, macros and highlight rules: step 4.

## Build on Windows

Requirements: [Rust](https://rustup.rs), Node 20+, and the WebView2 runtime (already on Windows 11).

```
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # installer in target/release/bundle/nsis/
```

Serial flashing needs esptool. The installer bundles it; for `tauri dev` put Espressif's
`esptool.exe` into `src-tauri/resources/esptool/` or install esptool so it is on PATH.

Pushing to GitHub also builds the installer in Actions (`.github/workflows/build.yml`).

## Layout

- `crates/core`: connection engine (no GUI). `cargo test -p esp_core` runs its tests.
- `src-tauri`: the Tauri shell exposing the engine as commands and events.
- `src`: the UI. In a plain browser (`npm run dev`) a simulator replaces the backend, which is handy for UI work.
