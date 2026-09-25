/**
 * Preload script for the hidden capture BrowserWindow.
 *
 * This window has show:false and backgroundThrottling:false.
 * It runs MediaStreamTrackProcessor (push-based frame delivery from OS)
 * and sends encoded chunks to the main process via IPC.
 *
 * Security: contextIsolation:true, nodeIntegration:false.
 * Only the minimal surface needed for capture is exposed.
 */
import { contextBridge, ipcRenderer } from 'electron';

const captureAPI = {
  /** Receive commands from main process (start, stop, keyframe) */
  onCommand: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('capture-cmd', handler);
    return () => ipcRenderer.removeListener('capture-cmd', handler);
  },

  /** Receive raw PCM audio chunks from DCSS.AudioCapture.exe (via main → IPC) */
  onAudioPcmChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on('audio-pcm-chunk', handler);
    return () => ipcRenderer.removeListener('audio-pcm-chunk', handler);
  },

  /** Send encoded video/audio chunk (binary) to main process */
  sendChunk: (buffer) => ipcRenderer.send('broadcaster-chunk', buffer),

  /** Send JSON control/status message to main process */
  sendMessage: (msg) => ipcRenderer.send('broadcaster-message', msg),

  /** Notify main that capture window is ready */
  ready: () => ipcRenderer.send('broadcaster-message', { type: 'capture-ready' }),
};

contextBridge.exposeInMainWorld('captureAPI', captureAPI);
console.log('[CAPTURE-PRELOAD] captureAPI exposed.');
