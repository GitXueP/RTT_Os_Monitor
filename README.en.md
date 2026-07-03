# Runtime Observer

[中文](README.md) | [English](README.en.md)

Runtime Observer is a desktop measurement tool for embedded real-time systems. It collects RuntimeOnce data through SEGGER J-Link RTT and visualizes Task / Runnable execution time and overall CPU load with curves, tables, snapshots, and reports.

It is designed for observing task scheduling behavior, Runnable runtime, CPU load margin, and abnormal runtime fluctuations.

## Overview

Runtime Observer targets runtime observation scenarios in embedded real-time systems. The desktop process starts and manages the Python acquisition backend, J-Link GDB Server, RTT Telnet link, and pushes acquisition data to the frontend through WebSocket.

The frontend provides real-time curves, measurement markers, object statistics, CPU load windows, snapshots, and report export, making it easier to evaluate task or Runnable runtime changes during debugging.

## Features

- Real-time J-Link RTT RuntimeOnce acquisition
- Task / Runnable runtime curve visualization
- Curve zooming, follow-latest mode, reset view, and measurement markers
- Task / Runnable enum mapping import and memory clearing
- CPU load sliding-window analysis
- Startup precheck page with connection steps and backend logs
- Draggable floating receive-log panel
- Snapshot capture and CSV export
- Test report export
- Backend and J-Link process cleanup when the desktop app exits
- Hidden SEGGER J-Link GDB Server startup for a cleaner desktop workflow

## Tech Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Electron |
| Frontend | HTML5 / CSS / JavaScript |
| Charts | Chart.js |
| Acquisition backend | Python WebSocket |
| Debug link | SEGGER J-Link RTT / J-Link GDB Server |
| Packaging | electron-builder |

## Architecture

```mermaid
flowchart LR
  MCU["MCU Firmware<br/>RuntimeOnce binary frames"]
  RTT["SEGGER RTT Buffer"]
  Telnet["J-Link RTT Telnet<br/>127.0.0.1:19021"]
  Backend["Python Backend<br/>Websocket_Server.py"]
  WS["WebSocket<br/>127.0.0.1:8765"]
  Electron["Electron Main Process<br/>main.js"]
  UI["Renderer UI<br/>HTML5 + Chart.js"]
  User["User<br/>Measure / Import Map / Export Report"]

  MCU --> RTT
  RTT --> Telnet
  Telnet --> Backend
  Backend --> WS
  WS --> UI
  Electron --> Backend
  Electron --> UI
  UI --> User
```

## Data Flow

```text
MCU RTT binary frames
  -> J-Link RTT Telnet
  -> Python WebSocket backend
  -> Electron Renderer
  -> Chart.js curves / tables / reports
```

## Development

Install dependencies:

```powershell
npm install
```

Start the desktop app:

```powershell
npm start
```

Build Windows artifacts:

```powershell
npm run dist
```

## Usage

1. Make sure the SEGGER J-Link toolchain is installed locally.
2. Start Runtime Observer.
3. The startup page displays backend, J-Link, RTT, and WebSocket connection steps.
4. After entering the main view, observe Task / Runnable runtime curves and CPU load.
5. Import Task / Runnable mapping files from the menu if object names are needed.
6. Use the memory clearing menu item to restore original object names.

## Notes

- The tool depends on a local SEGGER J-Link environment.
- Mapping memory and layout memory are stored locally by the desktop app.
