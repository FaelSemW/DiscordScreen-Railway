'use strict';

/**
 * Physical Runtime Validation Harness for DC-ScreenSharing Native Broadcaster
 *
 * Runs inside the REAL Electron runtime on Windows.
 * Creates the hidden capture window with backgroundThrottling: false,
 * captures the primary display at 1080p60 via MediaStreamTrackProcessor + WebCodecs,
 * and records real physical metrics across:
 *   1. Initial capture stabilization
 *   2. Active foreground capture
 *   3. Simulated Alt+Tab / Backgrounded execution
 *   4. Prolonged background operation
 */

const { app, BrowserWindow, desktopCapturer, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { WebSocketServer } = require('ws');

// Disable GPU software fallbacks if possible, test real pipeline
app.commandLine.appendSwitch('enable-features', 'WebCodecs,WebCodecsH264');

app.whenReady().then(async () => {
  console.log('[PHYSICAL-TEST] Electron app ready. Starting physical validation...');

  // 1. Start a local mock WebSocket server to measure sent FPS and network receipt
  let receivedFrames = 0;
  let receivedBytes = 0;
  let firstFrameTime = null;
  let lastFrameTime = null;
  const frameIntervals = [];

  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('[PHYSICAL-TEST] Broadcaster WS connected to local relay.');
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const now = performance.now();
      if (!firstFrameTime) firstFrameTime = now;
      if (lastFrameTime) {
        frameIntervals.push(now - lastFrameTime);
      }
      lastFrameTime = now;
      receivedFrames++;
      receivedBytes += data.length || data.byteLength || 0;
    });
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const localWsUrl = `ws://127.0.0.1:${port}/ws?t=physical-test-token`;
  console.log(`[PHYSICAL-TEST] Mock WebSocket relay listening on port ${port}`);

  // 2. Enumerate screen sources
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 90 } });
  if (!sources || sources.length === 0) {
    console.error('[PHYSICAL-TEST] No screen sources found!');
    app.exit(1);
    return;
  }
  const primarySource = sources[0];
  console.log(`[PHYSICAL-TEST] Selected source: "${primarySource.name}" (ID: ${primarySource.id})`);

  // 3. Create the hidden capture window exactly as BroadcasterManager does
  const captureWin = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      preload: path.join(__dirname, '..', 'desktop', 'main', 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      offscreen: false,
    },
  });

  const capturedStats = [];
  let captureWinReady = false;

  // Setup WS client in main process to relay chunks like broadcaster-manager does
  const WebSocket = require('ws');
  const ws = new WebSocket(localWsUrl);
  await new Promise((res) => ws.on('open', res));

  ipcMain.on('broadcaster-message', (_e, msg) => {
    if (msg.type === 'capture-ready') {
      captureWinReady = true;
    } else if (msg.type === 'capture-stats') {
      capturedStats.push({ ...msg.stats, recordedAt: performance.now() });
    } else if (msg.type === 'capture-error') {
      console.error('[PHYSICAL-TEST] Capture error from worker:', msg.message);
    }
  });

  ipcMain.on('broadcaster-chunk', (_e, buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(buffer);
    }
  });

  await captureWin.loadFile(path.join(__dirname, '..', 'desktop', 'ui', 'capture-worker.html'));

  // Wait for capture-ready
  const readyTimeout = Date.now() + 5000;
  while (!captureWinReady && Date.now() < readyTimeout) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!captureWinReady) {
    console.error('[PHYSICAL-TEST] Timeout waiting for capture window ready');
    app.exit(1);
    return;
  }
  console.log('[PHYSICAL-TEST] Capture window initialized with backgroundThrottling: false.');

  // 4. Send capture-start at 1080p60
  captureWin.webContents.send('capture-cmd', {
    type: 'capture-start',
    sourceId: primarySource.id,
    fps: 60,
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    preset: 'maxima',
    audio: false,
  });

  console.log('[PHYSICAL-TEST] Capture started. Running physical test phases:');
  console.log('  -> Phase 1: Foreground baseline (8 seconds)...');
  await new Promise((r) => setTimeout(r, 8000));

  console.log('  -> Phase 2: Simulating backgrounded/unfocused operation (10 seconds)...');
  // Create another visible window to steal focus and leave the app/capture in background
  const dummyWin = new BrowserWindow({ show: false, width: 400, height: 300 });
  dummyWin.show();
  dummyWin.focus();
  dummyWin.minimize(); // minimized focus state
  await new Promise((r) => setTimeout(r, 10000));

  console.log('  -> Phase 3: Prolonged background operation (12 seconds)...');
  await new Promise((r) => setTimeout(r, 12000));

  // Stop capture
  captureWin.webContents.send('capture-cmd', { type: 'capture-stop' });
  await new Promise((r) => setTimeout(r, 500));

  // Compute metrics
  const totalDurationSec = (lastFrameTime - firstFrameTime) / 1000;
  const measuredSentFps = totalDurationSec > 0 ? (receivedFrames / totalDurationSec) : 0;

  // Aggregate stats from worker samples
  const recentStats = capturedStats.slice(2); // discard warm-up samples
  const avgCaptureFps = recentStats.length
    ? (recentStats.reduce((acc, s) => acc + (s.captureFps || 0), 0) / recentStats.length).toFixed(1)
    : '0';
  const avgAdmittedFps = recentStats.length
    ? (recentStats.reduce((acc, s) => acc + (s.admittedFps || 0), 0) / recentStats.length).toFixed(1)
    : '0';
  const avgEncodedFps = recentStats.length
    ? (recentStats.reduce((acc, s) => acc + (s.encodedFps || 0), 0) / recentStats.length).toFixed(1)
    : '0';
  const avgSentFps = recentStats.length
    ? (recentStats.reduce((acc, s) => acc + (s.sentFps || 0), 0) / recentStats.length).toFixed(1)
    : '0';

  const totalDroppedDuplicate = recentStats.reduce((acc, s) => acc + (s.droppedDuplicate || 0), 0);
  const totalDroppedObsolete = recentStats.reduce((acc, s) => acc + (s.droppedObsolete || 0), 0);
  const totalDroppedEncoderPressure = recentStats.reduce((acc, s) => acc + (s.droppedEncoderPressure || 0), 0);
  const totalDroppedTransportPressure = recentStats.reduce((acc, s) => acc + (s.droppedTransportPressure || 0), 0);

  // Interval percentiles from relay receipt
  const sortedIntervals = [...frameIntervals].sort((a, b) => a - b);
  const p50 = sortedIntervals.length ? sortedIntervals[Math.floor(sortedIntervals.length * 0.5)].toFixed(1) : '0';
  const p95 = sortedIntervals.length ? sortedIntervals[Math.floor(sortedIntervals.length * 0.95)].toFixed(1) : '0';
  const p99 = sortedIntervals.length ? sortedIntervals[Math.floor(sortedIntervals.length * 0.99)].toFixed(1) : '0';
  const maxInterval = sortedIntervals.length ? sortedIntervals[sortedIntervals.length - 1].toFixed(1) : '0';

  const gaps25 = frameIntervals.filter((i) => i > 25 && i <= 33).length;
  const gaps33 = frameIntervals.filter((i) => i > 33 && i <= 50).length;
  const gaps50 = frameIntervals.filter((i) => i > 50 && i <= 100).length;
  const gaps100 = frameIntervals.filter((i) => i > 100).length;

  const results = {
    totalFramesReceived: receivedFrames,
    testDurationSeconds: Number(totalDurationSec.toFixed(2)),
    metrics: {
      rawCaptureFps: Number(avgCaptureFps),
      admittedFps: Number(avgAdmittedFps),
      encodedFps: Number(avgEncodedFps),
      sentFps: Number(avgSentFps),
      receivedFps: Number(measuredSentFps.toFixed(1)),
    },
    drops: {
      droppedDuplicate: totalDroppedDuplicate,
      droppedObsolete: totalDroppedObsolete,
      droppedEncoderPressure: totalDroppedEncoderPressure,
      droppedTransportPressure: totalDroppedTransportPressure,
    },
    intervals: {
      p50Ms: Number(p50),
      p95Ms: Number(p95),
      p99Ms: Number(p99),
      maxMs: Number(maxInterval),
    },
    gaps: {
      gaps25Ms: gaps25,
      gaps33Ms: gaps33,
      gaps50Ms: gaps50,
      gaps100Ms: gaps100,
    },
    codec: recentStats[recentStats.length - 1]?.codec || 'unknown',
    hardwareStatus: recentStats[recentStats.length - 1]?.hardwareStatus || 'unknown',
  };

  console.log('--- PHYSICAL METRICS RESULT JSON START ---');
  console.log(JSON.stringify(results, null, 2));
  console.log('--- PHYSICAL METRICS RESULT JSON END ---');

  // Cleanup
  ws.close();
  server.close();
  captureWin.destroy();
  if (dummyWin && !dummyWin.isDestroyed()) dummyWin.destroy();

  app.quit();
});
