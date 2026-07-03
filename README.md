# Runtime Observer

Runtime Observer is an Electron desktop tool for observing J-Link RTT RuntimeOnce timing and CPU load.

## Features

- Real-time RTT RuntimeOnce acquisition through a Python WebSocket backend.
- Task and Runnable runtime curves with zoom, follow-latest, and measurement markers.
- CPU load sliding-window analysis.
- Optional Task/Runnable enum mapping import.
- Startup connection precheck and connection logs.
- Snapshot and test report export.
- Hidden J-Link GDB Server startup for a cleaner desktop workflow.

## Tech Stack

- Electron
- HTML5
- Chart.js
- Python WebSocket backend
- SEGGER J-Link RTT / GDB Server

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

## Notes

- `node_modules` and build output are intentionally not committed.
- The app expects the required SEGGER J-Link tooling to be installed locally.
- Runtime settings and imported mapping memory are stored locally by the desktop app.
