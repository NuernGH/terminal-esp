# NuTerm

A Windows terminal for ESP boards, in the spirit of Tera Term and CoolTerm: open several
named sessions over **serial (COM)**, **TCP/Telnet** (WiFi serial bridges), **UDP**, **WebSocket**, **SSH**, **MQTT**, **Bluetooth LE** or **USB HID**, watch RX/TX
activity per board, and switch between Tabs, Rail and Grid layouts. Built with Tauri 2 (Rust
backend) and xterm.js.

## What works now

- Connection types: Serial (baud, data bits, parity, stop bits, flow control, optional reset pulse),
  TCP with Telnet or raw mode (Telnet announces a terminal type, VT100 by default, and the window size), UDP, plus the types listed below.
- Named sessions. Double-click a name to rename. Sessions and layout are remembered.
- A new session is added **disconnected**. The status dot (and the Connect button) connects and disconnects.
- RX/TX LEDs and byte counters on every session.
- Scan network: mDNS (`_telnet._tcp`) plus a TCP port probe of the local /24 subnet.
- Layouts: Tabs, Rail, Grid. Drag grid blocks (by their header), tabs or rail cards to reorder them; the Grid layout also has a column count, blocks can be pinned to empty cells, and the divider lines between cells can be dragged to resize rows and columns (the last row and column cannot be resized).
- Baud rate dropdown on every serial session: changes apply immediately, without reconnecting.
- Auto-reconnect (per session, on by default): if the connection drops, or the board is not there yet, the app keeps retrying every 2 seconds until you click the status dot. Any session can pop out into its own window.
- **SSH** (password or key file; host keys saved on first use, a changed key is refused; the password is asked once per run and never saved) and **MQTT** (subscribe to topics, messages show as `[topic] payload`, send `topic message` to publish).
- **Bluetooth LE** (UART-over-GATT boards: Nordic UART, HM-10 style or custom UUIDs, with a device scan) and **USB HID** (raw input and output reports). Both are untested on real hardware. Classic Bluetooth serial adapters show up as COM ports after pairing in Windows, so use Serial for them.
- **WebSocket** connections (`ws://` and `wss://`) next to Serial, TCP/Telnet and UDP.
- **Search** (Ctrl+F or the Search button), **Log…** to a file (timestamped text or raw bytes), **command buttons** (text or hex, shown above the input line), **Send file…** (raw blocks or line by line with a pause), per-connection **text encoding** and **local echo**, and a live **Plot** panel that graphs numbers in the incoming text (`temp=22.4 hum=41` gives two named series).
- **Arduino upload** (Flash dialog, Arduino tab): AVR boards (Uno, Nano, Pro Mini, Mega, custom) via the bundled avrdude. Needs a compiled `.hex` (Arduino IDE: Sketch → Export Compiled Binary); `.ino` sources are not compiled by this app.
- **Flash .bin** (toolbar button): over a serial cable with the bundled esptool (any ESP chip,
  chosen start address, optional full erase), or over WiFi with the Arduino OTA protocol
  (ESP32 port 3232, ESP8266 port 8266, optional password, firmware or filesystem image).
  A serial upload releases the COM port and reconnects the session afterwards.
- Traffic colours: incoming text uses the RX colour, commands you send show on their own line in the TX colour (optional → marker). Both colours are yours to change under **Display…**.
- **View: Raw / Split / Decoded / Aligned** (per session, toolbar): raw terminal, raw and decoded together (side by side or stacked, draggable divider, ⇄ swaps which comes first), or decoded only. Aligned shows raw and decoded side by side, one row per message. The decoded part lists every received (RX) and sent (TX) chunk with a timestamp, as Hex, ASCII (escaped), Decimal, Binary or Hex + ASCII dump.
- **Themes** (drop-down in the toolbar): System (follows Windows), Light, Dark, Midnight blue, Nord, Dracula, Solarized dark and light, Green screen, Amber retro and High contrast. The terminal colours follow the theme. The choice is remembered and shared with pop-out windows.
- Typing in the terminal sends keystrokes (Enter uses the session's line ending); there is also a
  send box with history (Up/Down).

## Not done yet

- HTTP uploads to a web updater (`/update`), as used by Tasmota and ESPHome.
- RFC 2217 (serial over TCP) and highlight rules.
- Self-installing updates (the app only tells you a new version exists).
- Not tested on real hardware or on Windows by the developer: Bluetooth LE, USB HID, the system tray and the portable zip.

## Build on Windows

Requirements: [Rust](https://rustup.rs), Node 20+, and the WebView2 runtime (already on Windows 11).

```
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # installer in target/release/bundle/nsis/
```

Serial flashing needs esptool. The installer bundles it; for `tauri dev` put Espressif's
`esptool.exe` into `src-tauri/resources/esptool/` or install esptool so it is on PATH.

Pushing to GitHub also builds the installer and portable zip in Actions (`.github/workflows/build.yml`).

## Layout

- `crates/core`: connection engine (no GUI). `cargo test -p esp_core` runs its tests.
- `src-tauri`: the Tauri shell exposing the engine as commands and events.
- `src`: the UI. In a plain browser (`npm run dev`) a simulator replaces the backend, which is handy for UI work.

## Portable version

Every build also makes `NuTerm-<version>-portable.zip` (Actions artifact `esp-terminal-windows-portable`): unzip anywhere and run `NuTerm.exe`, no installation. esptool and avrdude are included.

## Updates

Every push to `main` publishes a GitHub Release (`v0.1.<run number>`) with the installer and the portable zip. The app checks the latest release a few seconds after starting and shows "⬆ Version x available" in the status bar; click the version number at the right of the status bar to check by hand. The link opens the release page, the update is not installed automatically.

## Tray

Closing the main window hides it to the system tray and keeps all connections running. Click the tray icon to bring it back. Right-click for a menu with "Open session in new window" for each session, and Quit. Every window has a "Stay on top" button. Pop-out windows also have a Minimal button (not in the main window) that hides the toolbar, command buttons, status bar and Send file button, plus a separate button to hide the input line.
