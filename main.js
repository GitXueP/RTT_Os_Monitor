const { app, BrowserWindow, dialog, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let backendProcess = null;
const startupLogs = [];
const MAX_STARTUP_LOGS = 300;

let lastBackendStatus = {
  backend: { level: 'warn', text: 'not started' },
  jlink: { level: 'warn', text: 'unknown' },
  rtt: { level: 'warn', text: 'unknown' },
  ports: {}
};

function getResourcePath(...parts) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...parts);
  }

  return path.join(__dirname, ...parts);
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  const def = {
    jlinkPath: '',
    windowBounds: {
      width: 1800,
      height: 1000
    },
    openDevTools: false
  };

  try {
    const p = getSettingsPath();

    if (fs.existsSync(p)) {
      return {
        ...def,
        ...JSON.parse(fs.readFileSync(p, 'utf8'))
      };
    }
  } catch (e) {
    console.error('[main] Load settings failed:', e);
  }

  return def;
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(getSettingsPath()), {
      recursive: true
    });

    fs.writeFileSync(
      getSettingsPath(),
      JSON.stringify(settings, null, 2),
      'utf8'
    );
  } catch (e) {
    console.error('[main] Save settings failed:', e);
  }
}

function patchSettings(patch) {
  const s = loadSettings();
  const ns = {
    ...s,
    ...patch
  };

  saveSettings(ns);
  return ns;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendBackendStatus() {
  sendToRenderer('backend-status', lastBackendStatus);
}

function pushStartupLog(source, text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());

  for (const line of lines) {
    const item = {
      ts: Date.now(),
      source,
      line
    };

    startupLogs.push(item);

    if (startupLogs.length > MAX_STARTUP_LOGS) {
      startupLogs.shift();
    }

    sendToRenderer('backend-log', item);
  }
}

function getBackendEnv() {
  const settings = loadSettings();

  const env = {
    ...process.env,

    /*
     * Python stdout/stderr 使用 UTF-8。
     * Windows 命令输出由 Python 后端内部使用 mbcs + errors=replace 处理。
     */
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  };

  if (settings.jlinkPath) {
    env.JLINK_GDBSERVER_EXE = settings.jlinkPath;
  }

  return env;
}

function decodeBuffer(data) {
  try {
    return Buffer.from(data).toString('utf8');
  } catch (e) {
    return '<decode failed>';
  }
}

function updateStatusFromBackendLine(line) {
  const s = lastBackendStatus;

  if (line.includes('WebSocket server started')) {
    s.backend = {
      level: 'ok',
      text: 'running'
    };
  }

  if (line.includes('Backend exited')) {
    s.backend = {
      level: 'bad',
      text: 'exited'
    };
  }

  if (line.includes('Starting J-Link GDB Server')) {
    s.jlink = {
      level: 'warn',
      text: 'starting'
    };
  }

  if (line.includes('J-Link GDBServer process started')) {
    s.jlink = {
      level: 'ok',
      text: 'gdbserver'
    };
  }

  if (line.includes('JLinkGDBServerCL.exe not found')) {
    s.jlink = {
      level: 'bad',
      text: 'not found'
    };
  }

  if (line.includes('Failed to start J-Link GDB Server')) {
    s.jlink = {
      level: 'bad',
      text: 'start failed'
    };
  }

  if (line.includes('GDBServer monitor halt/reset/go sent')) {
    s.jlink = {
      level: 'ok',
      text: 'running'
    };
  }

  if (line.includes('RTT Telnet connected')) {
    s.rtt = {
      level: 'ok',
      text: 'connected'
    };
  }

  if (
    line.includes('RTT Telnet connection refused') ||
    line.includes('RTT Telnet connection error')
  ) {
    s.rtt = {
      level: 'bad',
      text: 'not connected'
    };
  }

  if (line.includes('Frontend connected')) {
    s.frontend = {
      level: 'ok',
      text: 'connected'
    };
  }

  sendBackendStatus();
}

function startBackend() {
  const exePath = getResourcePath('tools', 'Websocket_Server.exe');
  const pyPath = getResourcePath('backend', 'Websocket_Server.py');
  const backendEnv = getBackendEnv();

  lastBackendStatus.backend = {
    level: 'warn',
    text: 'starting'
  };
  pushStartupLog('main', 'Backend startup requested.');

  lastBackendStatus.jlink = {
    level: 'warn',
    text: 'unknown'
  };

  lastBackendStatus.rtt = {
    level: 'warn',
    text: 'unknown'
  };

  sendBackendStatus();

  try {
    if (fs.existsSync(exePath)) {
      console.log(`[main] Start backend exe: ${exePath}`);
      pushStartupLog('main', `Start backend exe: ${exePath}`);

      backendProcess = spawn(exePath, [], {
        cwd: path.dirname(exePath),
        windowsHide: true,
        env: backendEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } else if (fs.existsSync(pyPath)) {
      console.log(`[main] Start backend python: ${pyPath}`);
      pushStartupLog('main', `Start backend python: ${pyPath}`);

      backendProcess = spawn('python', ['-X', 'utf8', '-u', pyPath], {
        cwd: path.dirname(pyPath),
        windowsHide: true,
        env: backendEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } else {
      lastBackendStatus.backend = {
        level: 'bad',
        text: 'file missing'
      };

      sendBackendStatus();

      dialog.showErrorBox(
        '后端启动失败',
        `未找到后端程序：\n${exePath}\n${pyPath}`
      );
      return;
    }
  } catch (e) {
    lastBackendStatus.backend = {
      level: 'bad',
      text: 'spawn failed'
    };

    sendBackendStatus();

    dialog.showErrorBox(
      '后端启动异常',
      String(e && e.stack ? e.stack : e)
    );
    return;
  }

  backendProcess.stdout.on('data', (data) => {
    const text = decodeBuffer(data);
    process.stdout.write(`[backend] ${text}`);
    pushStartupLog('backend', text);

    text.split(/\r?\n/).forEach((line) => {
      if (line.trim()) {
        updateStatusFromBackendLine(line);
      }
    });
  });

  backendProcess.stderr.on('data', (data) => {
    const text = decodeBuffer(data);
    process.stderr.write(`[backend error] ${text}`);
    pushStartupLog('backend-error', text);

    text.split(/\r?\n/).forEach((line) => {
      if (line.trim()) {
        updateStatusFromBackendLine(line);
      }
    });
  });

  backendProcess.on('error', (err) => {
    console.error('[main] Backend process error:', err);
    pushStartupLog('main-error', `Backend process error: ${String(err && err.message ? err.message : err)}`);

    lastBackendStatus.backend = {
      level: 'bad',
      text: 'error'
    };

    sendBackendStatus();

    dialog.showErrorBox(
      '后端进程启动失败',
      String(err && err.stack ? err.stack : err)
    );
  });

  backendProcess.on('exit', (code, signal) => {
    console.log(`[main] Backend exited. code=${code}, signal=${signal}`);
    pushStartupLog('main', `Backend exited. code=${code}, signal=${signal}`);

    backendProcess = null;

    lastBackendStatus.backend = {
      level: 'bad',
      text: 'exited'
    };

    sendBackendStatus();
  });
}

function stopBackend() {
  const pid = backendProcess && backendProcess.pid;

  if (backendProcess) {
    try {
      console.log('[main] Stop backend process...');

      if (process.platform === 'win32' && pid) {
        execFile(
          'taskkill',
          ['/T', '/F', '/PID', String(pid)],
          { windowsHide: true },
          () => {}
        );
      } else {
        backendProcess.kill();
      }
    } catch (e) {
      console.error('[main] Stop backend failed:', e);
    }

    backendProcess = null;
  }

  cleanupRelatedProcesses();
}

function restartBackend() {
  stopBackend();

  lastBackendStatus.backend = {
    level: 'warn',
    text: 'restarting'
  };

  sendBackendStatus();
  pushStartupLog('main', 'Backend restart requested.');

  setTimeout(() => {
    startBackend();
  }, 800);
}

function cleanupRelatedProcesses() {
  if (process.platform !== 'win32') {
    return;
  }

  const images = [
    'JLinkGDBServerCL.exe',
    'JLinkGDBServer.exe',
    'Websocket_Server.exe'
  ];

  images.forEach((image) => {
    execFile(
      'taskkill',
      ['/F', '/IM', image],
      { windowsHide: true },
      () => {}
    );
  });
}

function checkPorts() {
  pushStartupLog('main', 'Checking ports 8765 / 19021 / 2331 ...');

  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      const result = {
        8765: 'unknown',
        19021: 'unknown',
        2331: 'unknown'
      };

      lastBackendStatus.ports = result;
      sendBackendStatus();
      resolve(result);
      return;
    }

    execFile(
      'netstat',
      ['-ano', '-p', 'tcp'],
      {
        windowsHide: true
      },
      (err, stdout) => {
        const ports = {
          8765: [],
          19021: [],
          2331: []
        };

        const text = String(stdout || '');

        text.split(/\r?\n/).forEach((line) => {
          Object.keys(ports).forEach((p) => {
            if (line.includes(`:${p}`)) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[parts.length - 1] || '';
              const state = parts.length >= 4 ? parts[3] : '';

              ports[p].push({
                line: line.trim(),
                pid,
                state
              });
            }
          });
        });

        const result = {};

        Object.keys(ports).forEach((p) => {
          result[p] = ports[p].length ? ports[p] : [];
        });

        lastBackendStatus.ports = result;

        console.log('[main] Port check:', JSON.stringify(result));
        pushStartupLog('main', `Port check result: ${JSON.stringify(result)}`);

        sendBackendStatus();
        resolve(result);
      }
    );
  });
}

function sendMenuCommand(cmd) {
  sendToRenderer('menu-command', cmd);
}

async function selectObjectMapFile(kind) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const isTask = kind === 'task';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isTask ? '导入 Task 映射文件' : '导入 Runnable 映射文件',
    properties: ['openFile'],
    filters: [
      {
        name: isTask ? 'RTE_TestTask.h' : 'RTE_TestRunnable.h',
        extensions: ['h', 'hpp', 'txt']
      },
      {
        name: 'All Files',
        extensions: ['*']
      }
    ]
  });

  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return null;
  }

  const filePath = result.filePaths[0];

  try {
    const payload = {
      kind: isTask ? 'task' : 'runnable',
      fileName: path.basename(filePath),
      text: fs.readFileSync(filePath, 'utf8')
    };

    sendToRenderer('object-map-file', payload);
    return {
      kind: payload.kind,
      fileName: payload.fileName,
      ok: true
    };
  } catch (error) {
    dialog.showErrorBox(
      '映射文件读取失败',
      `无法读取文件：\n${filePath}\n\n${error.message || error}`
    );
    return {
      kind: isTask ? 'task' : 'runnable',
      fileName: path.basename(filePath),
      ok: false,
      error: error.message || String(error)
    };
  }
}

function menuIcon(kind) {
  const color = '#2f6f89';
  const common = 'fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const icons = {
    import: `<path ${common} d="M4 3.5h5l3 3V13a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 13z"/><path ${common} d="M9 3.5v3h3M8 8.5v4M6.5 11 8 12.5 9.5 11"/>`,
    snapshot: `<path ${common} d="M4.5 5.5h1.7l.8-1.2h3l.8 1.2h1.7A1.5 1.5 0 0 1 14 7v5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 3 12V7a1.5 1.5 0 0 1 1.5-1.5z"/><circle ${common} cx="8.5" cy="9.7" r="2"/>`,
    report: `<path ${common} d="M4 3.5h8v11H4z"/><path ${common} d="M6 6h4M6 8.5h4M6 11h2.5"/>`,
    clear: `<path ${common} d="M5 5h7M6 5l.5 8h4L11 5M7 5l.5-1.5h2L10 5"/>`,
    power: `<path ${common} d="M8.5 3.5v5"/><path ${common} d="M5.2 5.8a5 5 0 1 0 6.6 0"/>`,
    backend: `<path ${common} d="M4 5h9v7H4z"/><path ${common} d="M6 8h.1M8 8h.1M10 8h.1M5.5 13.5h6"/>`,
    port: `<path ${common} d="M5 8h6M4 6h3v4H4zM10 6h3v4h-3z"/>`,
    folder: `<path ${common} d="M3.5 6h4l1 1.3h4V13a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2.5 13V7.5A1.5 1.5 0 0 1 4 6z"/>`,
    view: `<path ${common} d="M2.8 8.8s2-3.3 5.7-3.3 5.7 3.3 5.7 3.3-2 3.3-5.7 3.3-5.7-3.3-5.7-3.3z"/><circle ${common} cx="8.5" cy="8.8" r="1.6"/>`,
    layout: `<path ${common} d="M3.5 4h10v10h-10zM7 4v10M3.5 8h10"/>`,
    zoom: `<circle ${common} cx="7.2" cy="7.2" r="3.4"/><path ${common} d="M9.8 9.8 13 13"/>`,
    info: `<circle ${common} cx="8.5" cy="8.5" r="6"/><path ${common} d="M8.5 8v4M8.5 5.5h.1"/>`
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${icons[kind] || icons.info}</svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function showAboutWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#eef3f5;color:#1f2d38;font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif}
  .wrap{padding:26px 30px 24px}
  .title{display:flex;align-items:center;gap:14px;margin-bottom:18px}
  .mark{width:42px;height:42px;border-radius:12px;background:#2f6f89;color:white;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800}
  h1{font-size:24px;line-height:1;margin:0;color:#1f2d38}
  .sub{font-size:13px;color:#62727f;margin-top:6px}
  .grid{display:grid;grid-template-columns:92px minmax(0,1fr);gap:10px 18px;border-top:1px solid #ccd7df;border-bottom:1px solid #ccd7df;padding:18px 0;margin:18px 0}
  .k{color:#5e6e7c;font-weight:700;text-align:right}
  .v{color:#1f2d38;line-height:1.45}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{padding:5px 9px;border:1px solid #bfd0da;border-radius:999px;background:#f8fbfc;color:#2d5468;font-size:12px;font-weight:700}
  .footer{display:flex;align-items:center;justify-content:space-between;color:#6b7b88;font-size:12px}
  button{height:32px;min-width:86px;border:1px solid #8aa1b0;border-radius:8px;background:#fff;color:#1f2d38;font:inherit;cursor:pointer}
  button:hover{background:#f4f8fa}
</style>
</head>
<body>
  <div class="wrap">
    <div class="title">
      <div class="mark">RO</div>
      <div>
        <h1>Runtime Observer</h1>
        <div class="sub">Runtime and CPU load measurement tool</div>
      </div>
    </div>
    <div class="grid">
      <div class="k">版本</div><div class="v">V1.0</div>
      <div class="k">开发作者</div><div class="v">XPF</div>
      <div class="k">工具定位</div><div class="v">运行时间观察与 CPU 负载测量工具</div>
      <div class="k">主要功能</div><div class="v">RTT RuntimeOnce 实时采集、Task/Runnable 运行时间曲线、CPU 负载滑动窗口分析、快照与测试报告导出</div>
      <div class="k">数据链路</div><div class="v">MCU RTT 二进制帧 -> J-Link RTT Telnet -> Python WebSocket -> Electron 前端</div>
      <div class="k">技术基础</div><div class="v"><div class="chips"><span class="chip">Electron</span><span class="chip">HTML5</span><span class="chip">Chart.js</span><span class="chip">Python WebSocket</span><span class="chip">SEGGER J-Link RTT</span></div></div>
      <div class="k">适用场景</div><div class="v">嵌入式任务、Runnable、调度周期和负载裕量观测</div>
    </div>
    <div class="footer">
      <span>Runtime Observer · V1.0</span>
      <button onclick="window.close()">确定</button>
    </div>
  </div>
</body>
</html>`;

  const about = new BrowserWindow({
    width: 660,
    height: 430,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: true,
    parent: mainWindow,
    title: '关于 Runtime Observer',
    backgroundColor: '#eef3f5',
    icon: getResourcePath('build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  about.setMenu(null);
  about.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function selectJLinkPath() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 JLinkGDBServerCL.exe',
    properties: ['openFile'],
    filters: [
      {
        name: 'J-Link GDB Server',
        extensions: ['exe']
      },
      {
        name: 'All Files',
        extensions: ['*']
      }
    ]
  });

  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return loadSettings();
  }

  const selected = result.filePaths[0];

  const settings = patchSettings({
    jlinkPath: selected
  });

  lastBackendStatus.jlink = {
    level: 'warn',
    text: 'path updated'
  };

  sendBackendStatus();

  const reply = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['重启后端', '稍后手动重启'],
    defaultId: 0,
    cancelId: 1,
    title: 'J-Link 路径已更新',
    message: `已设置：\n${selected}\n\n是否立即重启后端？`
  });

  if (reply.response === 0) {
    restartBackend();
  }

  return settings;
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      icon: menuIcon('report'),
      submenu: [
        {
          label: '导入 Task 映射',
          accelerator: 'Ctrl+T',
          icon: menuIcon('import'),
          click: () => selectObjectMapFile('task')
        },
        {
          label: '导入 Runnable 映射',
          accelerator: 'Ctrl+R',
          icon: menuIcon('import'),
          click: () => selectObjectMapFile('runnable')
        },
        {
          type: 'separator'
        },
        {
          label: '捕获快照',
          accelerator: 'Ctrl+S',
          icon: menuIcon('snapshot'),
          click: () => sendMenuCommand('capture-snapshot')
        },
        {
          label: '导出测试报告',
          accelerator: 'Ctrl+E',
          icon: menuIcon('report'),
          click: () => sendMenuCommand('export-report')
        },
        {
          type: 'separator'
        },
        {
          label: '清空数据',
          icon: menuIcon('clear'),
          click: () => sendMenuCommand('clear-data')
        },
        {
          label: '清除记忆',
          icon: menuIcon('clear'),
          click: () => sendMenuCommand('clear-memory')
        },
        {
          type: 'separator'
        },
        {
          label: '退出',
          icon: menuIcon('power'),
          role: 'quit'
        }
      ]
    },
    {
      label: '后端',
      icon: menuIcon('backend'),
      submenu: [
        {
          label: '重启后端',
          accelerator: 'Ctrl+Shift+R',
          icon: menuIcon('backend'),
          click: () => restartBackend()
        },
        {
          label: '检查端口 8765 / 19021 / 2331',
          icon: menuIcon('port'),
          click: () => checkPorts()
        },
        {
          type: 'separator'
        },
        {
          label: '配置 J-Link GDBServer 路径',
          icon: menuIcon('backend'),
          click: () => selectJLinkPath()
        },
        {
          label: '打开配置目录',
          icon: menuIcon('folder'),
          click: () => shell.openPath(app.getPath('userData'))
        }
      ]
    },
    {
      label: '视图',
      icon: menuIcon('view'),
      submenu: [
        {
          label: '折叠/展开左侧栏',
          accelerator: 'Ctrl+B',
          icon: menuIcon('view'),
          click: () => sendMenuCommand('toggle-sidebar')
        },
        {
          label: '接收日志面板',
          accelerator: 'Ctrl+L',
          icon: menuIcon('view'),
          click: () => sendMenuCommand('toggle-log-panel')
        },
        {
          label: '复位桌面布局',
          icon: menuIcon('layout'),
          click: () => sendMenuCommand('reset-layout')
        },
        {
          type: 'separator'
        },
        {
          role: 'reload',
          label: '重新加载页面',
          icon: menuIcon('layout')
        },
        {
          role: 'toggleDevTools',
          label: '开发者工具',
          icon: menuIcon('backend')
        },
        {
          type: 'separator'
        },
        {
          role: 'resetZoom',
          label: '实际大小',
          icon: menuIcon('zoom')
        },
        {
          role: 'zoomIn',
          label: '放大',
          icon: menuIcon('zoom')
        },
        {
          role: 'zoomOut',
          label: '缩小',
          icon: menuIcon('zoom')
        },
        {
          role: 'togglefullscreen',
          label: '全屏',
          icon: menuIcon('view')
        }
      ]
    },
    {
      label: '帮助',
      icon: menuIcon('info'),
      submenu: [
        {
          label: '关于',
          icon: menuIcon('info'),
          click: () => showAboutWindow()
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const settings = loadSettings();
  const bounds = settings.windowBounds || {};

  mainWindow = new BrowserWindow({
    width: bounds.width || 1800,
    height: bounds.height || 1000,
    minWidth: 1450,
    minHeight: 820,
    backgroundColor: '#0c1224',
    title: 'Runtime Observer',
    icon: getResourcePath('build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  const htmlPath = getResourcePath(
    'app',
    'CPU_Load_Monitor_Runtime_ElectronDesktop.html'
  );

  if (!fs.existsSync(htmlPath)) {
    dialog.showErrorBox(
      '页面文件不存在',
      `未找到前端 HTML：\n${htmlPath}`
    );
    return;
  }

  mainWindow.loadFile(htmlPath);

  mainWindow.webContents.on('did-finish-load', () => {
    sendBackendStatus();
    sendToRenderer('backend-log-history', startupLogs);
    sendToRenderer('settings', loadSettings());
  });

  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const [width, height] = mainWindow.getSize();
    const s = loadSettings();

    saveSettings({
      ...s,
      windowBounds: {
        width,
        height
      }
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('backend:restart', () => {
  restartBackend();
  return true;
});

ipcMain.handle('backend:checkPorts', async () => {
  return await checkPorts();
});

ipcMain.handle('objectMap:select', async (_, kind) => {
  return await selectObjectMapFile(kind);
});

ipcMain.handle('settings:get', () => {
  return loadSettings();
});

ipcMain.handle('settings:selectJLinkPath', async () => {
  return await selectJLinkPath();
});

ipcMain.handle('settings:set', (_, patch) => {
  return patchSettings(patch || {});
});

app.whenReady().then(async () => {
  buildMenu();

  await checkPorts();

  startBackend();

  /*
   * 不使用普通 TCP 探测 8765，避免触发 websockets 非法握手异常。
   * 直接等待后端启动一段时间后打开页面。
   */
  setTimeout(() => {
    createWindow();
  }, 2500);
});

app.on('window-all-closed', () => {
  stopBackend();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
