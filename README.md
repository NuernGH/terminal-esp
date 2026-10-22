# ESP Terminal

A Windows terminal for ESP boards, in the spirit of Tera Term and CoolTerm: open several
named sessions over **serial (COM)**, **TCP/Telnet** (WiFi serial bridges) or **UDP**, watch RX/TX
activity per board, and switch between Tabs, Rail and Grid layouts. Built with Tauri 2 (Rust
backend) and xterm.js.

## What works now (step 1 and 2)

- Connection types: Serial (baud, data bits, parity, stop bits, flow control, optional reset pulse),
  TCP with Telnet or raw mode, UDP.
- Named sessions. Double-click a name to rename. Sessions and layout are remembered.
- A new session is added **disconnected**. The status dot (and the Connect button) connects and disconnects.
- RX/TX LEDs and byte counters on every session.
- Scan network: mDNS (`_telnet._tcp`) plus a TCP port probe of the local /24 subnet.
- Layouts: Tabs, Rail, Grid. Any session can pop out into its own window.
- Typing in the terminal sends keystrokes (Enter uses the session's line ending); there is also a
  send box with history (Up/Down).

## Not done yet

- Flashing .bin files (serial via esptool, and OTA over WiFi): step 3.
- RFC 2217, log-to-file, macros and highlight rules: step 4.

## Build on Windows

Requirements: [Rust](https://rustup.rs), Node 20+, and the WebView2 runtime (already on Windows 11).

```
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # installer in target/release/bundle/nsis/
```

Pushing to GitHub also builds the installer in Actions (`.github/workflows/build.yml`).

## Layout

- `crates/core`: connection engine (no GUI). `cargo test -p esp_core` runs its tests.
- `src-tauri`: the Tauri shell exposing the engine as commands and events.
- `src`: the UI. In a plain browser (`npm run dev`) a simulator replaces the backend, which is handy for UI work.
