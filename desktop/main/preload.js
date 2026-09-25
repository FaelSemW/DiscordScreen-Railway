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
  getMediaSources: () => ipcRenderer.invoke('picker-get-sources'),
  selectMediaSource: (data) => ipcRenderer.invoke('picker-select-source', data),
  cancelMediaSource: () => ipcRenderer.invoke('picker-cancel'),
  getAudioExclusionStatus: () => ipcRenderer.invoke('audio-exclusion-status'),
  startAudioExclusion: (params) => ipcRenderer.invoke('audio-exclusion-start', params),
  stopAudioExclusion: () => ipcRenderer.invoke('audio-exclusion-stop'),
  getDiscordProcessStatus: () => ipcRenderer.invoke('discord-process-status'),
  onAudioPcmChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on('audio-pcm-chunk', handler);
    return () => ipcRenderer.removeListener('audio-pcm-chunk', handler);
  },
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

  restartTunnel: () => ipcRenderer.invoke('restart-tunnel'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),

  // ── Native Broadcaster ──────────────────────────────────────────────────
  openBroadcaster: () => ipcRenderer.invoke('broadcaster-open'),
  openMainWindow: () => ipcRenderer.invoke('open-main-window'),
  broadcasterEnumerateSources: () => ipcRenderer.invoke('broadcaster-enumerate-sources'),
  broadcasterStart: (opts) => ipcRenderer.invoke('broadcaster-start', opts),
  broadcasterStop: () => ipcRenderer.invoke('broadcaster-stop'),
  broadcasterGetState: () => ipcRenderer.invoke('broadcaster-get-state'),
  broadcasterChangeSource: (opts) => ipcRenderer.invoke('broadcaster-change-source', opts),
  onBroadcasterState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('broadcaster-state', handler);
    return () => ipcRenderer.removeListener('broadcaster-state', handler);
  },
  onBroadcasterStats: (callback) => {
    const handler = (_event, stats) => callback(stats);
    ipcRenderer.on('broadcaster-stats', handler);
    return () => ipcRenderer.removeListener('broadcaster-stats', handler);
  },
};

// Expose canonical namespaces and compatibility alias
contextBridge.exposeInMainWorld('dcScreenSharing', api);
contextBridge.exposeInMainWorld('discordScreenRailway', api);
contextBridge.exposeInMainWorld('electronAPI', api);

console.log('[PRELOAD] Bridge exposed successfully on window.dcScreenSharing, window.discordScreenRailway and window.electronAPI');
