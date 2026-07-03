const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 接收 Electron 菜单命令
   *
   * 命令包括：
   * - import-task-map
   * - import-runnable-map
   * - capture-snapshot
   * - export-report
   * - clear-data
   * - toggle-sidebar
   * - toggle-log-panel
   * - reset-layout
   */
  onMenuCommand(callback) {
    if (typeof callback !== 'function') {
      return;
    }

    ipcRenderer.on('menu-command', (_event, command) => {
      callback(command);
    });
  },

  /**
   * 接收主进程读取到的 Task / Runnable 映射文件内容
   */
  onObjectMapFile(callback) {
    if (typeof callback !== 'function') {
      return;
    }

    ipcRenderer.on('object-map-file', (_event, payload) => {
      callback(payload);
    });
  },

  /**
   * 接收后端状态更新
   *
   * 状态格式：
   * {
   *   backend: { level: 'ok'|'warn'|'bad', text: 'running' },
   *   jlink:   { level: 'ok'|'warn'|'bad', text: 'running' },
   *   rtt:     { level: 'ok'|'warn'|'bad', text: 'connected' },
   *   ports:   { 8765: [...], 19021: [...], 2331: [...] }
   * }
   */
  onBackendStatus(callback) {
    if (typeof callback !== 'function') {
      return;
    }

    ipcRenderer.on('backend-status', (_event, status) => {
      callback(status);
    });
  },

  /**
   * 接收后端启动/连接日志
   */
  onBackendLog(callback) {
    if (typeof callback !== 'function') {
      return;
    }

    ipcRenderer.on('backend-log', (_event, item) => {
      callback(item);
    });
  },

  /**
   * 接收页面加载前已经产生的启动日志
   */
  onBackendLogHistory(callback) {
    if (typeof callback !== 'function') {
      return;
    }

    ipcRenderer.on('backend-log-history', (_event, items) => {
      callback(items || []);
    });
  },

  /**
   * 接收主进程下发的设置
   */
  onSettings(callback) {
    if (typeof callback !== 'function') {
      return;
    }

    ipcRenderer.on('settings', (_event, settings) => {
      callback(settings);
    });
  },

  /**
   * 重启 Python 后端
   */
  restartBackend() {
    return ipcRenderer.invoke('backend:restart');
  },

  /**
   * 检查端口：
   * - 8765 WebSocket
   * - 19021 RTT Telnet
   * - 2331 GDBServer
   */
  checkPorts() {
    return ipcRenderer.invoke('backend:checkPorts');
  },

  /**
   * 通过 Electron 原生文件选择框导入对象映射
   */
  selectObjectMapFile(kind) {
    return ipcRenderer.invoke('objectMap:select', kind);
  },

  /**
   * 获取 Electron 用户配置
   */
  getSettings() {
    return ipcRenderer.invoke('settings:get');
  },

  /**
   * 保存 Electron 用户配置
   */
  setSettings(patch) {
    return ipcRenderer.invoke('settings:set', patch || {});
  },

  /**
   * 弹出文件选择框，选择 JLinkGDBServerCL.exe 路径
   */
  selectJLinkPath() {
    return ipcRenderer.invoke('settings:selectJLinkPath');
  }
});
