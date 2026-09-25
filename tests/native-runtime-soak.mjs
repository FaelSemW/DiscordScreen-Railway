// Run using Electron, not Node. Uses synthetic video only; no screen/audio capture,
// Discord connection, public tunnel, or external network is involved.
// Set DCSS_SOAK_SECONDS=7200 for a two-hour local soak.
import { app, ipcMain, powerSaveBlocker } from 'electron';
import { WebSocketServer } from 'ws';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const seconds = Math.max(75, Number(process.env.DCSS_SOAK_SECONDS) || 75);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
const managerModule = process.env.DCSS_PACKAGED_ROOT
  ? pathToFileURL(path.join(process.env.DCSS_PACKAGED_ROOT, 'desktop/main/broadcaster-manager.js')).href
  : '../desktop/main/broadcaster-manager.js';
const { BroadcasterManager } = await import(managerModule);
const manager = new BroadcasterManager();
let frames = 0;
let bytes = 0;
let connections = 0;
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise(resolve => server.once('listening', resolve));
server.on('connection', ws => {
  connections++;
  ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
  ws.on('message', (data, binary) => {
    if (binary) { frames++; bytes += data.length; }
  });
});
ipcMain.on('broadcaster-message', (event, msg) => {
  if (event.sender === manager._captureWin?.webContents) manager.onCaptureMessage(msg);
});
ipcMain.on('broadcaster-chunk', (event, data) => {
  if (event.sender === manager._captureWin?.webContents) manager.onEncodedChunk(data);
});
const openWindow = manager._openCaptureWindow.bind(manager);
manager._openCaptureWindow = async () => {
  await openWindow();
  // Synthetic moving canvas exercises real MediaStreamTrackProcessor, WebCodecs,
  // renderer IPC and the main-process WebSocket while the window remains hidden.
  await manager._captureWin.webContents.executeJavaScript(`
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      const ctx = canvas.getContext('2d', { alpha: false });
      let frame = 0;
      const paint = () => {
        ctx.fillStyle = '#182838'; ctx.fillRect(0, 0, 1920, 1080);
        ctx.fillStyle = '#50a0ff';
        for (let i = 0; i < 30; i++) ctx.fillRect((frame * 12 + i * 73) % 1920, (i * 89) % 1080, 150, 60);
        frame++;
      };
      paint();
      const timer = setInterval(paint, 16);
      const stream = canvas.captureStream(60);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
    void 0;
  `);
};

const samples = [];
try {
  await manager.startBroadcast({
    sourceId: 'synthetic:test', audio: false, fps: 60, width: 1920, height: 1080,
    bitrate: 8_000_000, wsUrl: `ws://127.0.0.1:${server.address().port}/ws`,
  });
  assert(powerSaveBlocker.isStarted(manager._powerBlockerId));
  let checkpoint = frames;
  for (let elapsed = 5; elapsed <= seconds; elapsed += 5) {
    await delay(5000);
    const sample = {
      elapsed, frames: frames - checkpoint, memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      queue: manager._stats.network.transportQueueBytes, capture: manager._stats.capture.captureFps,
      encoded: manager._stats.capture.encodedFps, quality: manager._stats.capture.qualityLevel,
      state: manager.getState().state,
    };
    console.log('SOAK_SAMPLE:' + JSON.stringify(sample));
    samples.push(sample);
    if (![25, 45, 60].includes(elapsed)) assert(sample.frames > 0, `Video stalled at ${elapsed}s`);
    assert.equal(sample.state, 'streaming');
    assert.equal(manager._captureWin.isVisible(), false);
    checkpoint = frames;
    if (elapsed === 20) manager._captureWin.webContents.forcefullyCrashRenderer();
    if (elapsed === 40) for (const ws of server.clients) ws.terminate();
    if (elapsed === 55) Object.defineProperty(manager._ws, 'bufferedAmount', { configurable: true, get: () => 2_000_000 });
    if (elapsed === 60) delete manager._ws.bufferedAmount;
  }
  assert(connections >= 2, 'WebSocket reconnect did not complete');
  assert(manager._stats.watchdog.captureRecoveries >= 1, 'Capture worker did not recover');
  const blocker = manager._powerBlockerId;
  await manager.stopBroadcast();
  assert(!powerSaveBlocker.isStarted(blocker));
  console.log('SOAK_RESULT:' + JSON.stringify({ ok: true, seconds, frames, bytes, connections, samples }));
  server.close();
  app.exit(0);
} catch (err) {
  console.error('SOAK_FAILED:', err.stack);
  await manager.stopBroadcast().catch(() => {});
  for (const ws of server.clients) ws.terminate();
  server.close();
  app.exit(1);
}
}).catch(err => { console.error(err); app.exit(1); });
