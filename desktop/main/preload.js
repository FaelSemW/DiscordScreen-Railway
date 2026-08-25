import { contextBridge, ipcRenderer } from 'electron';

console.log('[PRELOAD] Initializing Discord Screen Railway preload script...');

const api = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  validateCredentials: (data) => ipcRenderer.invoke('validate-credentials', data),
  checkDiscordEntryPoint: (clientId, clientSecret) =>
    ipcRenderer.invoke('check-discord-entry-point', clientId, clientSecret),
  startServices: () => ipcRenderer.invoke('start-services'),
  stopServices: () => ipcRenderer.invoke('stop-services'),
  getState: () => ipcRenderer.invoke('get-state'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openCapturePage: (url) => ipcRenderer.invoke('open-capture-page', url),
  openDiscord: () => ipcRenderer.invoke('open-discord'),
  confirmDiscordConfig: (origin) => ipcRenderer.invoke('confirm-discord-config', origin),
  getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  getRecentLogs: () => ipcRenderer.invoke('get-recent-logs'),
  validateDiscordConfig: () => ipcRenderer.invoke('validate-discord-config'),
  resetConfig: (preservePreferences) =>
    ipcRenderer.invoke('reset-config', preservePreferences),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  onStateChange: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state-change', handler);
    return () => ipcRenderer.removeListener('state-change', handler);
  },
  onLogLine: (callback) => {
    const handler = (_event, line) => callback(line);
    ipcRenderer.on('log-line', handler);
    return () => ipcRenderer.removeListener('log-line', handler);
  },
};

// Expose canonical namespace and compatibility alias
contextBridge.exposeInMainWorld('discordScreenRailway', api);
contextBridge.exposeInMainWorld('electronAPI', api);

console.log('[PRELOAD] Bridge exposed successfully on window.discordScreenRailway and window.electronAPI');
