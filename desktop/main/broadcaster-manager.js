/**
 * BroadcasterManager — Main-process orchestrator for native capture broadcasting.
 *
 * This runs entirely in the Electron main process (Node.js). It:
 *   1. Creates/manages a hidden capture BrowserWindow (show:false, backgroundThrottling:false)
 *   2. Owns the WebSocket broadcaster connection to Railway (same protocol as share.html)
 *   3. Owns AudioExclusionManager (DCSS.AudioCapture.exe) for system-audio capture
 *   4. Implements a multi-stage stream watchdog
 *   5. Implements Tier1/Tier2 reconnect (matching existing control-channel pattern)
 *   6. Emits live diagnostics for the broadcaster UI
 *
 * The browser (renderer) is NOT the timing authority for capture. The hidden
 * capture window's MediaStreamTrackProcessor is push-based: the OS delivers
 * frames when they arrive, independent of RAF or JS timers.
 */

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, desktopCapturer, screen, powerSaveBlocker } from 'electron';
import { WebSocket } from 'ws';
import { logger } from './logger.js';
import { configManager } from './config.js';
import { AudioExclusionManager, EXCLUSION_STATES } from './audio-exclusion-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolves the Process ID (PID) and process name from an HWND (Window Handle) using user32.dll GetWindowThreadProcessId.
 * @param {number|string} hwnd
 * @returns {Promise<{ pid: number, processName: string } | null>}
 */
function resolveWindowProcessInfo(hwnd) {
  return new Promise((resolve) => {
    if (!hwnd || isNaN(Number(hwnd))) return resolve(null);
    const ps = `
$c = @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
Add-Type -TypeDefinition $c
[uint32]$wPid = 0
[Win]::GetWindowThreadProcessId([IntPtr][int64]${Number(hwnd)}, [ref]$wPid)
$pName = ""
if ($wPid -gt 0) {
  try {
    $proc = Get-Process -Id $wPid -ErrorAction SilentlyContinue
    if ($proc) { $pName = $proc.ProcessName }
  } catch {}
}
Write-Output "$wPid|$pName"
`.trim();
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 3500, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const out = (stdout || '').trim();
      const parts = out.split('|');
      const pid = parseInt(parts[0], 10);
      if (pid > 0) {
        resolve({ pid, processName: (parts[1] || '').trim() });
      } else {
        resolve(null);
      }
    });
  });
}

// ── Broadcaster states ──────────────────────────────────────────────────────
export const BROADCASTER_STATES = {
  IDLE: 'idle',
  STARTING: 'starting',
  STREAMING: 'streaming',
  STOPPING: 'stopping',
  ERROR: 'error',
};

// ── Watchdog thresholds ─────────────────────────────────────────────────────
const WATCHDOG_NO_CAPTURE_WARN_MS  = 1_000;
const WATCHDOG_NO_CAPTURE_ERROR_MS = 3_000;
const WATCHDOG_NO_ENCODED_MS       = 2_000;
const WATCHDOG_NO_SENT_MS          = 4_000;
const WATCHDOG_INTERVAL_MS         = 500;
const WATCHDOG_DEBOUNCE_MS         = 5_000; // min gap between recovery actions

// ── Reconnect parameters (mirror existing control-channel pattern) ──────────
const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_BASE_MS      = 3_000;
const RECONNECT_MAX_MS       = 30_000;
const PASSIVE_STANDBY_MS     = 60_000;

// ── Stats interval ──────────────────────────────────────────────────────────
const STATS_INTERVAL_MS = 1_000;

export class BroadcasterManager extends EventEmitter {
  constructor() {
    super();

    this._state = BROADCASTER_STATES.IDLE;
    this._lastError = null;

    // Capture window
    this._captureWin = null;
    this._captureWinReady = false;

    // WebSocket to Railway (/ws?t=<broadcasterToken>)
    this._ws = null;
    this._wsUrl = null;
    this._shareUrl = null;
    this._viewerUrl = null;
    this._viewerBaseUrl = null;
    this._sessionToken = null;
    this._slot = null;
    this._roomRes = null;
    this._lastVideoConfig = null;
    this._lastAudioConfig = null;
    this._wsGeneration = 0;
    this._wsConnectPromise = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._passiveTimer = null;

    // Local and Public base URLs for Self-Hosted
    this._localBaseUrl = null;
    this._publicBaseUrl = null;

    // Audio
    this._audioExclusion = new AudioExclusionManager({ logger });
    this._audioExclusion.on('data', (chunk) => this._forwardAudioPcm(chunk));
    this._audioExclusion.on('error', (err) => {
      logger.error('[BroadcasterManager] AudioExclusion error:', err.message);
    });

    // Broadcaster config (set at startBroadcast time)
    this._config = null;

    // Watchdog
    this._watchdogInterval = null;
    this._lastCaptureFrameAt  = null;
    this._lastEncodedFrameAt  = null;
    this._lastSentFrameAt     = null;
    this._lastAudioChunkAt    = null;
    this._lastRecoveryAt      = 0;

    // Live stats (populated by messages from capture window)
    this._stats = this._emptyStats();

    // Stats timer
    this._statsInterval = null;

    // IPC → capture window command queue (before window ready)
    this._pendingCmd = null;
    this._powerBlockerId = null;
    this._captureRecovery = null;
    this._captureRecoveryTimer = null;
    this._lifecycleGeneration = 0;
    this._transportPressureActive = false;
    this._awaitingKeyframe = false;
    this._lastWorkerHeartbeatAt = null;
    this._audioRecovery = null;
    this._lastAudioRecoveryAt = 0;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setServerUrls({ localBaseUrl, publicBaseUrl } = {}) {
    if (localBaseUrl) this._localBaseUrl = localBaseUrl.replace(/\/+$/, '');
    if (publicBaseUrl) this._publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  getLocalBaseUrl() {
    return this._localBaseUrl || (configManager.getPort() ? `http://127.0.0.1:${configManager.getPort()}` : 'http://127.0.0.1:3000');
  }

  getPublicBaseUrl() {
    return this._publicBaseUrl || configManager.getPublicOrigin() || this.getLocalBaseUrl();
  }

  getState() {
    return {
      state: this._state,
      lastError: this._lastError,
      stats: this._stats,
      config: this._config,
      shareUrl: this._viewerUrl || this._shareUrl,
      viewerUrl: this._viewerUrl,
      slot: this._slot,
      audioExclusionState: this._audioExclusion.getState(),
    };
  }

  async enumerateSources() {
    try {
      const [electronSources, displays] = await Promise.all([
        desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        }),
        Promise.resolve(screen.getAllDisplays()),
      ]);

      const sources = electronSources.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : '',
        appIconDataUrl: s.appIcon ? s.appIcon.toDataURL() : null,
        displayId: s.display_id || null,
      }));

      // Annotate screen sources with display resolution
      for (const src of sources) {
        if (src.type === 'screen' && src.displayId) {
          const disp = displays.find((d) => String(d.id) === String(src.displayId));
          if (disp) {
            src.width  = disp.size.width  * (disp.scaleFactor || 1);
            src.height = disp.size.height * (disp.scaleFactor || 1);
            src.scaleFactor = disp.scaleFactor || 1;
          }
        }
      }

      return sources;
    } catch (err) {
      logger.error('[BroadcasterManager] enumerateSources failed:', err.message);
      return [];
    }
  }

  /**
   * Start a broadcast.
   *
   * @param {object} opts
   * @param {string} opts.sourceId          — Electron desktopCapturer source ID
   * @param {boolean} [opts.audio]          — capture system audio
   * @param {boolean} [opts.excludeDiscord] — filter Discord from system audio
   * @param {string}  [opts.preset]         — quality preset name
   * @param {number}  [opts.fps]
   * @param {number}  [opts.width]
   * @param {number}  [opts.height]
   * @param {number}  [opts.bitrate]
   * @param {string}  [opts.sessionToken]   — pre-issued broadcaster JWT (optional)
   * @param {string}  [opts.wsUrl]          — pre-built WS URL (optional)
   */
  async startBroadcast(opts = {}) {
    if (this._state === BROADCASTER_STATES.STREAMING || this._state === BROADCASTER_STATES.STARTING) {
      logger.warn('[BroadcasterManager] Already running; call stopBroadcast first.');
      return this.getState();
    }

    this._setState(BROADCASTER_STATES.STARTING);
    this._lastError = null;
    const lifecycle = ++this._lifecycleGeneration;
    const assertActive = () => {
      if (lifecycle !== this._lifecycleGeneration) throw new Error('Transmissão cancelada.');
    };

    const isWindow = opts.sourceId?.startsWith('window:');
    const audioMode = opts.audioMode || (opts.audio ? (isWindow ? 'window' : 'system') : 'none');
    opts.audioMode = audioMode;
    opts.audio = audioMode !== 'none';
    this._config = { ...opts };

    try {
      this._powerBlockerId ??= powerSaveBlocker.start('prevent-app-suspension');
      // 1. Start audio capture (if requested) BEFORE video, so it's ready
      if (opts.audio) {
        await this._startAudio({
          audioMode,
          sourceId: opts.sourceId,
          sourceName: opts.sourceName,
          excludeDiscord: opts.excludeDiscord !== false,
        });
      } else {
        await this._audioExclusion.stop().catch(() => {});
      }

      // 2. Open capture window
      assertActive();
      await this._openCaptureWindow();
      assertActive();

      // 3. Connect WebSocket to Railway
      const wsUrl = opts.wsUrl || (await this._buildWsUrl(opts.room));
      assertActive();
      this._wsUrl = wsUrl;
      await this._connectWs(wsUrl);
      assertActive();

      // 4. Tell capture window to start
      await this._sendCaptureStart(opts);
      assertActive();

      // 5. Start watchdog
      this._startWatchdog();

      // 6. Start stats relay
      this._startStatsInterval();

      this._setState(BROADCASTER_STATES.STREAMING);
      logger.info('[BroadcasterManager] Broadcast started successfully.');
      return this.getState();
    } catch (err) {
      if (lifecycle !== this._lifecycleGeneration) return this.getState();
      logger.error('[BroadcasterManager] startBroadcast failed:', err.message);
      this._setError('START_FAILED', 'Falha ao iniciar transmissão', err.message);
      await this._cleanup(false);
      this._setState(BROADCASTER_STATES.ERROR);
      throw err;
    }
  }

  async stopBroadcast() {
    if (this._state === BROADCASTER_STATES.IDLE) return this.getState();
    this._setState(BROADCASTER_STATES.STOPPING);
    await this._cleanup(true);
    this._setState(BROADCASTER_STATES.IDLE);
    logger.info('[BroadcasterManager] Broadcast stopped.');
    return this.getState();
  }

  /**
   * Change capture source without stopping the stream.
   * Correct sequence: stop old capture → flush → reset → start fresh.
   */
  async changeSource(opts = {}) {
    const generation = this._lifecycleGeneration;
    logger.info('[BroadcasterManager] Changing source...');
    // Tell capture window to stop its current capture
    this._sendToCapture({ type: 'capture-stop' });
    await new Promise((r) => setTimeout(r, 200)); // brief flush
    if (generation !== this._lifecycleGeneration) return this.getState();

    // Restart capture with new options (WS stays connected)
    const newOpts = { ...this._config, ...opts };
    this._config = newOpts;

    // Stop + restart audio if audio config changed
    if (opts.audio !== undefined || opts.excludeDiscord !== undefined || opts.audioMode !== undefined || opts.sourceId !== undefined) {
      await this._audioExclusion.stop().catch(() => {});
      if (newOpts.audio) {
        await this._startAudio({
          audioMode: newOpts.audioMode,
          sourceId: newOpts.sourceId,
          sourceName: newOpts.sourceName,
          excludeDiscord: newOpts.excludeDiscord !== false,
        });
      }
    }

    // Reset timestamps
    if (generation !== this._lifecycleGeneration) return this.getState();
    this._lastCaptureFrameAt = null;
    this._lastEncodedFrameAt = null;
    this._lastSentFrameAt    = null;
    this._stats = this._emptyStats();

    await this._sendCaptureStart(newOpts);
    logger.info('[BroadcasterManager] Source changed.');
    return this.getState();
  }

  // Called by capture window renderer via IPC when a frame has been encoded
  onEncodedChunk(frameBuffer) {
    if (!frameBuffer) return;
    const now = Date.now();
    let type = 0;
    if (frameBuffer.byteLength > 1) {
      const u8 = new Uint8Array(frameBuffer);
      if (this._slot !== null && this._slot !== undefined) {
        u8[0] = this._slot;
      }
      type = u8[1];
    }

    if (type === 1 || type === 2) {
      // Video chunk (keyframe or delta)
      this._lastEncodedFrameAt = now;
    } else if (type === 3) {
      // Audio chunk
      this._lastAudioChunkAt = now;
    }

    this._sendWs(frameBuffer);
  }

  // Called by capture window renderer via IPC for audio
  onEncodedAudio(audioBuffer) {
    this._lastAudioChunkAt = Date.now();
    if (audioBuffer && audioBuffer.byteLength > 0 && this._slot !== null && this._slot !== undefined) {
      new Uint8Array(audioBuffer)[0] = this._slot;
    }
    this._sendWs(audioBuffer);
  }

  // Called by capture window renderer via IPC for capture stats
  onCaptureStats(stats) {
    this._lastWorkerHeartbeatAt = Date.now();
    if (Number.isFinite(stats.lastFrameAt)) this._lastCaptureFrameAt = stats.lastFrameAt;
    Object.assign(this._stats.capture, stats);
  }

  // Called for JSON control messages from capture window
  onCaptureMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'capture-ready') {
      logger.info('[BroadcasterManager] Capture window ready.');
      this._captureWinReady = true;
      if (this._pendingCmd) {
        this._sendToCapture(this._pendingCmd);
        this._pendingCmd = null;
      }
    } else if (msg.type === 'capture-config') {
      // Relay codec config to server
      this._lastVideoConfig = msg.config;
      if (this._ws?.readyState === (WebSocket.OPEN ?? 1)) {
        try { this._ws.send(JSON.stringify({ type: 'config', config: msg.config })); } catch {}
        logger.info(`[BroadcasterManager] Codec: ${msg.config.codec} ${msg.config.width}×${msg.config.height}`);
      }
    } else if (msg.type === 'audio-config') {
      this._lastAudioConfig = msg.config;
      if (this._ws?.readyState === (WebSocket.OPEN ?? 1)) {
        try { this._ws.send(JSON.stringify({ type: 'audio-config', config: msg.config })); } catch {}
      }
    } else if (msg.type === 'capture-started') {
      if (this._ws?.readyState === WebSocket.OPEN) {
        try { this._ws.send(JSON.stringify({ type: 'start' })); } catch {}
      }
      if (this._lastVideoConfig && this._ws?.readyState === (WebSocket.OPEN ?? 1)) {
        try { this._ws.send(JSON.stringify({ type: 'config', config: this._lastVideoConfig })); } catch {}
      }
      if (this._lastAudioConfig && this._ws?.readyState === (WebSocket.OPEN ?? 1)) {
        try { this._ws.send(JSON.stringify({ type: 'audio-config', config: this._lastAudioConfig })); } catch {}
      }
      logger.info('[BroadcasterManager] Capture started — stream announced to server.');
    } else if (msg.type === 'capture-error') {
      logger.error('[BroadcasterManager] Capture error:', msg.message);
      this._setError('CAPTURE_ERROR', 'Erro na captura', msg.message);
      this._scheduleCaptureRecovery(msg.message);
    } else if (msg.type === 'capture-stats') {
      this.onCaptureStats(msg.stats || {});
    }
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  async _startAudio(opts = {}) {
    const isBool = typeof opts === 'boolean';
    const excludeDiscord = isBool ? opts : opts.excludeDiscord !== false;
    const audioMode = isBool ? 'system' : (opts.audioMode || 'system');
    const sourceId = isBool ? null : opts.sourceId;
    const sourceName = isBool ? '' : (opts.sourceName || opts.name || '');

    logger.info(`[BroadcasterManager] Starting audio (mode=${audioMode}, excludeDiscord=${excludeDiscord}, sourceName="${sourceName}")`);

    const startParams = { excludeDiscord };
    if (audioMode === 'window' && sourceId?.startsWith('window:')) {
      const isBrowserOrMediaTitle = /chrome|edge|brave|opera|firefox|vivaldi|arc|wavebox|spotify|youtube|twitch|netflix/i.test(sourceName);
      if (isBrowserOrMediaTitle) {
        logger.info(`[BroadcasterManager] Janela "${sourceName}" identificada como navegador/mídia pelo título. Ativando loopback com exclusão do Discord para áudio perfeito.`);
        delete startParams.includePid;
        startParams.excludeDiscord = true;
      } else {
        // sourceId format from Electron desktopCapturer: "window:<HWND>:<extra>"
        // Split on ':' and take index 1 (the HWND portion)
        const parts = sourceId.split(':');
        const hwndStr = parts[1]; // e.g. '12345'
        const hwnd = hwndStr ? parseInt(hwndStr, 10) : NaN;
        if (!isNaN(hwnd) && hwnd > 0) {
          try {
            const winInfo = await resolveWindowProcessInfo(hwnd);
            if (winInfo && winInfo.pid) {
              const procLower = (winInfo.processName || '').toLowerCase();
              const isBrowserOrMedia = /^(chrome|msedge|edge|brave|opera|firefox|vivaldi|arc|wavebox|spotify|steam|discord|electron)$/i.test(procLower);
              if (isBrowserOrMedia) {
                logger.info(`[BroadcasterManager] Janela selecionada pertence ao aplicativo "${winInfo.processName}" (PID ${winInfo.pid}). Aplicativos Chromium/CEF usam subprocessos de áudio out-of-process. Ativando loopback com exclusão do Discord para áudio perfeito.`);
                // For browsers and CEF apps, WASAPI loopback with includePid produces silence due to Chromium/Gecko out-of-process sandboxed audio service.
                // Capturing with Discord exclusion captures window audio flawlessly while keeping Discord calls private.
                delete startParams.includePid;
                startParams.excludeDiscord = true;
              } else {
                logger.info(`[BroadcasterManager] Resolved window HWND ${hwnd} (from sourceId="${sourceId}") to PID ${winInfo.pid} (${winInfo.processName})`);
                startParams.includePid = winInfo.pid;
              }
            } else {
              logger.warn(`[BroadcasterManager] Could not resolve PID for HWND ${hwnd} — will use system loopback audio.`);
            }
          } catch (e) {
            logger.warn('[BroadcasterManager] Failed to resolve window PID:', e.message);
          }
        } else {
          logger.warn(`[BroadcasterManager] Could not parse HWND from sourceId="${sourceId}" (parts=${JSON.stringify(parts)}) — will use system loopback audio.`);
        }
      }
    }

    let started = await this._audioExclusion.start(startParams);
    if (!started) {
      logger.warn('[BroadcasterManager] AudioExclusion start returned false.');
      return false;
    }

    // Wait for CAPTURING state (guard against STARTING → race)
    const timeoutMs = this._audioStartingTimeoutMs || 5_000;
    const deadline = Date.now() + timeoutMs;
    while (this._audioExclusion.state === EXCLUSION_STATES.STARTING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60));
    }

    // Se a captura isolada por PID falhou ao entrar em CAPTURING, fallback imediato para loopback com exclusão do Discord
    if (startParams.includePid && this._audioExclusion.state !== EXCLUSION_STATES.CAPTURING) {
      logger.warn(
        `[BroadcasterManager] Captura isolada de janela (PID=${startParams.includePid}) não atingiu CAPTURING ` +
        `(estado atual: ${this._audioExclusion.state}). Ativando fallback automático para loopback com exclusão do Discord para garantir áudio.`,
      );
      await this._audioExclusion.stop().catch(() => {});
      delete startParams.includePid;
      startParams.excludeDiscord = true;
      started = await this._audioExclusion.start(startParams);
      if (started) {
        const retryDeadline = Date.now() + 4_000;
        while (this._audioExclusion.state === EXCLUSION_STATES.STARTING && Date.now() < retryDeadline) {
          await new Promise((r) => setTimeout(r, 60));
        }
      }
    }

    if (this._audioExclusion.state !== EXCLUSION_STATES.CAPTURING) {
      const { isRunning } = await this._audioExclusion.discordDetector.check().catch(() => ({}));

      if (isRunning) {
        // Discord is active and exclusion failed — refuse audio rather than leak voice chat
        logger.error('[BroadcasterManager] Discord is active but audio exclusion failed. Refusing audio to protect privacy.');
        this._setError(
          'AUDIO_EXCLUSION_FAILED',
          'Exclusão de áudio do Discord falhou',
          'Não foi possível excluir o áudio do Discord. Transmitindo sem áudio para proteger a privacidade da call.',
        );
        this._stats.audio.audioCaptureSource = 'disabled';
        return false;
      }
      // Discord not running → safe to proceed without exclusion; capture-worker will use WebRTC loopback.
      logger.info('[BroadcasterManager] Audio exclusion helper not in CAPTURING state but Discord not detected. Continuing (nativeAudio=false fallback).');
    }

    return true;
  }

  _forwardAudioPcm(chunk) {
    // PCM from DCSS.AudioCapture.exe is forwarded to the capture window
    // which feeds it to its AudioEncoder
    this._lastAudioChunkAt = Date.now();
    if (this._captureWin && !this._captureWin.isDestroyed()) {
      this._captureWin.webContents.send('audio-pcm-chunk', chunk);
    }
  }

  // ── Capture window ────────────────────────────────────────────────────────

  async _openCaptureWindow() {
    if (this._captureWin && !this._captureWin.isDestroyed()) {
      return; // reuse existing window
    }

    this._captureWinReady = false;
    this._captureWin = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        offscreen: false,
      },
    });

    const captureWindow = this._captureWin;
    captureWindow.webContents.on?.('render-process-gone', (_event, details) => {
      if (this._captureWin !== captureWindow) return;
      this._captureWinReady = false;
      this._scheduleCaptureRecovery(`Processo de captura encerrado: ${details.reason}`);
    });
    captureWindow.on('unresponsive', () => {
      if (this._captureWin === captureWindow) this._scheduleCaptureRecovery('Captura sem resposta.');
    });
    this._captureWin.on('closed', () => {
      if (this._captureWin !== captureWindow) return;
      this._captureWin = null;
      this._captureWinReady = false;
      logger.warn('[BroadcasterManager] Capture window closed unexpectedly.');
      if (this._state === BROADCASTER_STATES.STREAMING) {
        this._setError('CAPTURE_WINDOW_CLOSED', 'Janela de captura fechada', 'A janela de captura foi fechada inesperadamente.');
        this._scheduleCaptureRecovery('Janela de captura fechada.');
      }
    });

    await this._captureWin.loadFile(path.join(__dirname, '..', 'ui', 'capture-worker.html'));

    // Wait for capture-ready IPC (with timeout)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(check);
        reject(new Error('Capture window ready timeout (8s)'));
      }, 8_000);
      const check = setInterval(() => {
        if (this._captureWin !== captureWindow || captureWindow.isDestroyed()) {
          clearInterval(check);
          clearTimeout(timer);
          reject(new Error('Capture window cancelled'));
          return;
        }
        if (this._captureWinReady) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
    });
  }

  _scheduleCaptureRecovery(reason) {
    if (this._state !== BROADCASTER_STATES.STREAMING || !this._config ||
        this._captureRecovery || this._captureRecoveryTimer) return;
    this._captureRecoveryTimer = setTimeout(() => {
      this._captureRecoveryTimer = null;
      this._recoverCapture(reason);
    }, Math.max(250, WATCHDOG_DEBOUNCE_MS - (Date.now() - this._lastRecoveryAt)));
  }

  async _recoverCapture(reason) {
    if (this._state !== BROADCASTER_STATES.STREAMING || !this._config || this._captureRecovery) return;
    const generation = this._lifecycleGeneration;
    this._lastRecoveryAt = Date.now();
    const recovery = (async () => {
      logger.warn(`[BroadcasterManager] Reiniciando captura: ${reason}`);
      const oldWindow = this._captureWin;
      this._captureWin = null;
      this._captureWinReady = false;
      this._pendingCmd = null;
      if (oldWindow && !oldWindow.isDestroyed()) oldWindow.destroy();
      await this._openCaptureWindow();
      if (generation !== this._lifecycleGeneration || this._state !== BROADCASTER_STATES.STREAMING) return;
      await this._sendCaptureStart(this._config);
      this._lastWorkerHeartbeatAt = Date.now();
      this._lastCaptureFrameAt = Date.now();
      this._lastEncodedFrameAt = Date.now();
      this._lastError = null;
      this._stats.watchdog.captureRecoveries++;
    })();
    this._captureRecovery = recovery;
    let failed = false;
    try { await recovery; }
    catch (err) {
      failed = true;
      if (generation === this._lifecycleGeneration) this._setError('CAPTURE_RECOVERING', 'Recuperando captura', err.message);
    } finally {
      if (this._captureRecovery === recovery) this._captureRecovery = null;
    }
    if (failed && generation === this._lifecycleGeneration) this._scheduleCaptureRecovery(reason);
  }

  _sendToCapture(msg) {
    if (!this._captureWin || this._captureWin.isDestroyed()) return;
    if (!this._captureWinReady) {
      this._pendingCmd = msg;
      return;
    }
    this._captureWin.webContents.send('capture-cmd', msg);
  }

  async _sendCaptureStart(opts) {
    const isWindow = opts.sourceId?.startsWith('window:');
    const audioMode = opts.audioMode || (opts.audio ? (isWindow ? 'window' : 'system') : 'none');
    // nativeAudio=true tells capture worker to receive PCM from DCSS.AudioCapture.exe.
    // If the exclusion manager is CAPTURING, use native audio.
    // If it's not CAPTURING (e.g. helper unavailable) but audio was requested,
    // nativeAudio=false lets the capture worker attempt WebRTC loopback as fallback.
    const nativeAudio = Boolean(opts.audio && this._audioExclusion.state === EXCLUSION_STATES.CAPTURING);
    const audioRequested = Boolean(opts.audio && audioMode !== 'none');

    const cmd = {
      type: 'capture-start',
      sourceId: opts.sourceId,
      fps: opts.fps || 60,
      width: opts.width || 1920,
      height: opts.height || 1080,
      bitrate: opts.bitrate || 8_000_000,
      preset: opts.preset || 'maxima',
      audio: audioRequested,
      audioMode, // 'window' | 'system' | 'none'
      nativeAudio,
    };
    this._sendToCapture(cmd);
    logger.info(`[BroadcasterManager] capture-start sent: ${opts.sourceId} (${cmd.width}x${cmd.height}@${cmd.fps}) audio=${cmd.audio} (mode=${audioMode}, native=${nativeAudio}, exclusionState=${this._audioExclusion.state})`);
  }

  // ── WebSocket (broadcaster channel) ──────────────────────────────────────

  async _buildWsUrl(roomOpts = {}) {
    const localBase = this.getLocalBaseUrl();
    const publicBase = this.getPublicBaseUrl();
    const mode = roomOpts.mode || 'create'; // 'create' | 'join'
    const name = (roomOpts.name || '').trim() || 'Transmissão Nativa';
    const password = (roomOpts.password || '').trim() || null;
    const target = (roomOpts.target || '').trim();

    // 1. Get guest session identity from local server
    const guestRes = await fetch(`${localBase}/api/session-guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Native Broadcaster' }),
      signal: AbortSignal.timeout(8_000),
    }).then((r) => r.json());

    if (!guestRes?.identity) throw new Error(`Não foi possível obter sessão convidada de ${localBase}.`);

    let roomRes;

    if (mode === 'join') {
      if (!target) {
        throw new Error('Informe o link, token ou ID da sala existente.');
      }

      let token = null;
      let roomId = target;

      if (target.includes('?')) {
        try {
          const u = new URL(target.startsWith('http') ? target : `https://${target}`);
          token = u.searchParams.get('t');
        } catch {}
      } else if (target.length > 50) {
        token = target;
      }

      if (token) {
        // Try to resolve room via /api/rooms/open
        const openRes = await fetch(`${localBase}/api/rooms/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          signal: AbortSignal.timeout(8_000),
        }).then((r) => r.json()).catch(() => null);

        if (openRes?.shareUrl) {
          roomRes = openRes;
        } else {
          // Token is directly usable as broadcaster token (e.g. from share.html?t=...)
          let hostBase = localBase;
          if (target.startsWith('http')) {
            try {
              const u = new URL(target);
              hostBase = `${u.protocol}//${u.host}`;
            } catch {}
          }
          const wsBase = hostBase.replace(/^http/, 'ws');
          const wsUrl  = `${wsBase}/ws?t=${encodeURIComponent(token)}`;
          const viewerUrl = target.includes('share.html')
            ? (target.startsWith('http') ? target.replace('share.html', '') : target.replace('share.html', '').replace(localBase, publicBase))
            : `${publicBase}/?t=${encodeURIComponent(token)}&slot=0&cheia=1`;

          logger.info(`[BroadcasterManager] Direct token session ready. WS: ${wsUrl}, Public Viewer: ${viewerUrl}`);
          this._sessionToken = token;
          this._shareUrl = target.startsWith('http') ? target : `${publicBase}/share.html?t=${token}`;
          this._viewerUrl = viewerUrl;
          this.emit('session-created', { shareUrl: viewerUrl, wsUrl });
          return wsUrl;
        }
      } else {
        // Connect to existing roomId with optional password
        roomRes = await fetch(`${localBase}/api/rooms/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identity: guestRes.identity,
            roomId,
            password,
          }),
          signal: AbortSignal.timeout(8_000),
        }).then((r) => r.json());

        if (!roomRes?.shareUrl) {
          throw new Error(roomRes?.error || 'Não foi possível entrar na sala informada. Verifique o ID e a senha.');
        }
      }
    } else {
      // mode === 'create'
      roomRes = await fetch(`${localBase}/api/rooms/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identity: guestRes.identity,
          name,
          password,
        }),
        signal: AbortSignal.timeout(8_000),
      }).then((r) => r.json());

      if (!roomRes?.shareUrl) {
        throw new Error(roomRes?.error || 'Falha ao criar sala de transmissão no servidor.');
      }
    }

    // shareUrl contains the broadcasterToken; extract the /ws URL
    const shareUrl = new URL(roomRes.shareUrl);
    const token = shareUrl.searchParams.get('t');
    if (!token) throw new Error('Token de transmissão não encontrado na resposta do servidor.');

    // Connect to local WebSocket for optimal throughput
    const wsBase = localBase.replace(/^http/, 'ws');
    const wsUrl  = `${wsBase}/ws?t=${encodeURIComponent(token)}`;

    const slotParam = (this._slot !== null && this._slot !== undefined) ? this._slot : 0;
    const viewerUrl = roomRes.viewerToken
      ? `${publicBase}/?t=${encodeURIComponent(roomRes.viewerToken)}&slot=${slotParam}&cheia=1`
      : (roomRes.shareUrl ? roomRes.shareUrl.replace(localBase, publicBase) : `${publicBase}/?t=${encodeURIComponent(token)}&slot=${slotParam}&cheia=1`);

    const publicShare = roomRes.shareUrl ? roomRes.shareUrl.replace(localBase, publicBase) : viewerUrl;

    logger.info(`[BroadcasterManager] Session ready (${mode}). Local WS: ${wsUrl}, Public ViewerUrl: ${viewerUrl}`);
    this._sessionToken = token;
    this._roomRes = roomRes;
    this._viewerBaseUrl = publicBase;
    this._shareUrl = publicShare;
    this._viewerUrl = viewerUrl;
    this.emit('session-created', { shareUrl: viewerUrl, wsUrl, slot: slotParam });
    return wsUrl;
  }

  async _connectWs(wsUrl) {
    if (this._wsConnectPromise) return this._wsConnectPromise;
    this._wsConnectPromise = this._doConnectWs(wsUrl);
    try {
      return await this._wsConnectPromise;
    } finally {
      this._wsConnectPromise = null;
    }
  }

  _doConnectWs(wsUrl) {
    const gen = ++this._wsGeneration;
    return new Promise((resolve, reject) => {
      const target = new URL(wsUrl);
      target.searchParams.set('background', '1');
      const ws = new WebSocket(target.toString());
      this._connectingWs = ws;
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { ws.terminate(); } catch {}
          reject(new Error('WS connect timeout (8s)'));
        }
      }, 8_000);

      ws.on('open', () => {
        clearTimeout(timeout);
        if (this._wsGeneration !== gen) {
          try { ws.terminate(); } catch {}
          if (!resolved) { resolved = true; reject(new Error('Conexão cancelada.')); }
          return;
        }
        this._connectingWs = null;
        this._ws = ws;
        this._awaitingKeyframe = true;
        this._updateTransportPressure();
        this._reconnectAttempts = 0;
        logger.info('[BroadcasterManager] WebSocket connected to Railway.');

        // Re-announce start and configs on open or reconnect
        try { ws.send(JSON.stringify({ type: 'start' })); } catch {}
        if (this._lastVideoConfig) {
          try { ws.send(JSON.stringify({ type: 'config', config: this._lastVideoConfig })); } catch {}
        }
        if (this._lastAudioConfig) {
          try { ws.send(JSON.stringify({ type: 'audio-config', config: this._lastAudioConfig })); } catch {}
        }

        if (!resolved) { resolved = true; resolve(); }
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary || this._wsGeneration !== gen) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp || Date.now() }));
        } else if (msg.type === 'pong') {
          // RTT measurement
        } else if (msg.type === 'slot') {
          this._slot = msg.slot;
          logger.info(`[BroadcasterManager] Server assigned slot: ${this._slot}`);
          if (this._roomRes?.viewerToken && this._viewerBaseUrl) {
            this._viewerUrl = `${this._viewerBaseUrl}/?t=${encodeURIComponent(this._roomRes.viewerToken)}&slot=${this._slot}&cheia=1`;
            this.emit('session-created', { shareUrl: this._viewerUrl, wsUrl: this._wsUrl, slot: this._slot });
          }
          this._sendToCapture({ type: 'set-slot', slot: this._slot });
          this._sendToCapture({ type: 'capture-keyframe' });
        } else if (msg.type === 'need-keyframe' || msg.type === 'keyframe-request' || msg.type === 'force-keyframe') {
          logger.info(`[BroadcasterManager] Keyframe requested by server (${msg.type}).`);
          if (this._lastVideoConfig && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'config', config: this._lastVideoConfig })); } catch {}
          }
          if (this._lastAudioConfig && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'audio-config', config: this._lastAudioConfig })); } catch {}
          }
          this._sendToCapture({ type: 'capture-keyframe' });
        } else if (msg.type === 'chunks') {
          logger.info(`[BroadcasterManager] Relay chunks: ${msg.on ? 'active' : 'inactive'}`);
        } else if (msg.type === 'state') {
          const mySlot = (this._slot !== null && this._slot !== undefined) ? this._slot : 0;
          const myStream = (msg.streams || []).find((s) => s.slot === mySlot);
          this._stats.network.viewers = myStream ? (myStream.watchers?.length ?? 0) : (msg.viewers ?? 0);
          this.emit('stats', this._stats);
        } else if (msg.type === 'room-gone') {
          logger.warn('[BroadcasterManager] Room gone — stopping broadcast.');
          this.stopBroadcast();
        } else if (msg.type === 'stop-request') {
          logger.info('[BroadcasterManager] Stop requested by server.');
          this.stopBroadcast();
        } else if (msg.type === 'viewers') {
          this._stats.network.viewers = msg.count ?? 0;
        }
      });

      ws.on('close', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error('Conexão encerrada antes de abrir.'));
        }
        if (this._wsGeneration !== gen) return;
        this._connectingWs = null;
        this._ws = null;
        logger.warn('[BroadcasterManager] WebSocket disconnected.');
        if (this._state === BROADCASTER_STATES.STREAMING) {
          this._scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
        if (this._wsGeneration !== gen) return;
        logger.error('[BroadcasterManager] WebSocket error:', err.message);
      });

      ws.on('ping', () => { try { ws.pong(); } catch {} });
    });
  }

  _sendWs(data) {
    if (!this._ws || this._ws.readyState !== (WebSocket.OPEN ?? 1)) {
      this._stats.network.droppedNetworkFrames = (this._stats.network.droppedNetworkFrames || 0) + 1;
      return;
    }
    const bytes = data?.byteLength ?? data?.length ?? 0;
    const type = data instanceof ArrayBuffer ? new Uint8Array(data)[1] : data?.[1];
    this._updateTransportPressure();
    // Bound the main-process queue as well as the encoder queue. After dropping
    // a video packet, deltas are unusable until the next keyframe.
    if ((this._ws.bufferedAmount || 0) + bytes > 4 * 1024 * 1024 ||
        (type === 2 && this._awaitingKeyframe)) {
      this._stats.network.droppedNetworkFrames++;
      if (type === 1 || type === 2) this._awaitingKeyframe = true;
      return;
    }
    try {
      this._ws.send(data);
      if (type === 1) this._awaitingKeyframe = false;
      this._lastSentFrameAt = Date.now();
      this._updateTransportPressure();

      if (data?.byteLength) this._stats.network.totalBytesSent = (this._stats.network.totalBytesSent || 0) + data.byteLength;
    } catch (err) {
      logger.warn('[BroadcasterManager] WS send error:', err.message);
    }
  }

  _updateTransportPressure() {
    if (!this._ws && !this._wsUrl) return;
    const open = this._ws?.readyState === WebSocket.OPEN;
    const buffered = this._ws?.bufferedAmount || 0;
    this._stats.network.transportQueueBytes = buffered;
    const active = !open || buffered > 1_500_000 || (this._transportPressureActive && buffered >= 300_000);
    if (active === this._transportPressureActive) return;
    this._transportPressureActive = active;
    this._sendToCapture({ type: 'transport-pressure', active });
    if (!active) {
      this._awaitingKeyframe = true;
      this._sendToCapture({ type: 'capture-keyframe' });
    }
  }

  _scheduleReconnect() {
    if (this._state !== BROADCASTER_STATES.STREAMING) return;
    if ((this._reconnectTimer || this._passiveTimer) && this._reconnectAttempts < RECONNECT_MAX_ATTEMPTS) return;
    this._clearTimers();
    if (this._reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      logger.warn('[BroadcasterManager] Tier1 exhausted — entering passive standby.');
      this._setError('WS_LOST', 'Conexão com Railway perdida', 'Monitorando recuperação em segundo plano.');
      this._schedulePassiveStandby();
      return;
    }

    const jitter = Math.random() * 1_000;
    const delay  = Math.min(RECONNECT_BASE_MS * 2 ** this._reconnectAttempts + jitter, RECONNECT_MAX_MS);
    this._reconnectAttempts++;
    logger.info(`[BroadcasterManager] Reconnect attempt ${this._reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay)}ms`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._state !== BROADCASTER_STATES.STREAMING) return;
      try {
        await this._connectWs(this._wsUrl);
        this._reconnectAttempts = 0;
        // Re-announce stream
        this._sendToCapture({ type: 'capture-keyframe' });
      } catch (err) {
        logger.warn('[BroadcasterManager] Reconnect failed:', err.message);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _schedulePassiveStandby() {
    this._clearTimers();
    const jitter = Math.random() * 5_000;
    const delay  = PASSIVE_STANDBY_MS + jitter;
    this._passiveTimer = setTimeout(async () => {
      this._passiveTimer = null;
      if (this._state !== BROADCASTER_STATES.STREAMING) return;
      try {
        await this._connectWs(this._wsUrl);
        this._reconnectAttempts = 0;
        this._setState(BROADCASTER_STATES.STREAMING);
        logger.info('[BroadcasterManager] Passive standby: reconnected!');
      } catch {
        this._schedulePassiveStandby();
      }
    }, delay);
  }

  _clearTimers() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._passiveTimer)   { clearTimeout(this._passiveTimer);   this._passiveTimer   = null; }
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────

  _startWatchdog() {
    this._stopWatchdog();
    this._lastCaptureFrameAt  = Date.now();
    this._lastEncodedFrameAt  = Date.now();
    this._lastSentFrameAt     = Date.now();
    this._lastWorkerHeartbeatAt = Date.now();

    this._watchdogInterval = setInterval(() => this._checkWatchdog(), WATCHDOG_INTERVAL_MS);
  }

  _stopWatchdog() {
    if (this._watchdogInterval) { clearInterval(this._watchdogInterval); this._watchdogInterval = null; }
  }

  _checkWatchdog() {
    if (this._state !== BROADCASTER_STATES.STREAMING) return;
    const now = Date.now();
    // Poll even while video/audio are paused: otherwise backpressure never clears.
    this._updateTransportPressure();
    if (this._config?.audio && !this._audioRecovery && now - this._lastAudioRecoveryAt > 30_000 &&
        [EXCLUSION_STATES.ERROR, EXCLUSION_STATES.STOPPED].includes(this._audioExclusion.state)) {
      const generation = this._lifecycleGeneration;
      this._lastAudioRecoveryAt = now;
      this._audioRecovery = this._startAudio(this._config).then(() => {
        if (generation === this._lifecycleGeneration && this._audioExclusion.state === EXCLUSION_STATES.CAPTURING) {
          this._scheduleCaptureRecovery('Áudio nativo recuperado.');
        }
      }).catch(err => logger.warn('[BroadcasterManager] Audio recovery:', err.message))
        .finally(() => { this._audioRecovery = null; });
    }
    if (this._captureRecovery || this._captureRecoveryTimer) return;
    if (this._lastWorkerHeartbeatAt !== null && now - this._lastWorkerHeartbeatAt > 10_000) {
      this._scheduleCaptureRecovery('Worker sem resposta por 10 segundos.');
      return;
    }
    if (!this._transportPressureActive && this._lastEncodedFrameAt !== null &&
        now - this._lastEncodedFrameAt > 15_000 && (this._stats.capture.encoderQueueSize || 0) > 0) {
      this._scheduleCaptureRecovery('Encoder não entrega quadros.');
      return;
    }
    const canRecover = now - this._lastRecoveryAt > WATCHDOG_DEBOUNCE_MS;

    // 1. Capture Watchdog: no capture frames
    if (this._lastCaptureFrameAt !== null) {
      const captureGap = now - this._lastCaptureFrameAt;
      if (captureGap > WATCHDOG_NO_CAPTURE_WARN_MS) {
        this.emit('watchdog-warning', { stage: 'capture', gapMs: captureGap });
        this._stats.watchdog = { ...this._stats.watchdog, captureStalled: true, captureGapMs: captureGap };
      } else if (this._stats.watchdog?.captureStalled) {
        this._stats.watchdog = { ...this._stats.watchdog, captureStalled: false, captureGapMs: captureGap };
      }
      if (captureGap > WATCHDOG_NO_CAPTURE_ERROR_MS && canRecover) {
        logger.warn(`[Watchdog] No capture frames for ${captureGap}ms — requesting keyframe restart.`);
        this._lastRecoveryAt = now;
        this._sendToCapture({ type: 'capture-keyframe' });
        this._stats.watchdog = { ...this._stats.watchdog, captureRecoveries: (this._stats.watchdog?.captureRecoveries || 0) + 1 };
      }
    }

    // 2. Encoder Watchdog: no encoded frames
    if (this._lastEncodedFrameAt !== null) {
      const encGap = now - this._lastEncodedFrameAt;
      if (encGap > WATCHDOG_NO_ENCODED_MS && canRecover) {
        logger.warn(`[Watchdog] No encoded frames for ${encGap}ms — forcing keyframe.`);
        this._lastRecoveryAt = now;
        this._stats.watchdog = { ...this._stats.watchdog, encoderStalled: true };
        this._sendToCapture({ type: 'capture-keyframe' });
      } else if (encGap <= WATCHDOG_NO_ENCODED_MS && this._stats.watchdog?.encoderStalled) {
        this._stats.watchdog = { ...this._stats.watchdog, encoderStalled: false };
      }
    }

    // 3. Transport Watchdog: no sent frames
    if (this._lastSentFrameAt !== null) {
      const sendGap = now - this._lastSentFrameAt;
      if (sendGap > WATCHDOG_NO_SENT_MS && canRecover) {
        logger.warn(`[Watchdog] No sent frames for ${sendGap}ms — attempting WS reconnect.`);
        this._lastRecoveryAt = now;
        this._stats.watchdog = { ...this._stats.watchdog, transportStalled: true };
        if (this._ws?.readyState !== (WebSocket.OPEN ?? 1) && !this._reconnectTimer && !this._passiveTimer && !this._wsConnectPromise) {
          this._scheduleReconnect();
        }
      } else if (sendGap <= WATCHDOG_NO_SENT_MS && this._stats.watchdog?.transportStalled) {
        this._stats.watchdog = { ...this._stats.watchdog, transportStalled: false };
      }
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  _startStatsInterval() {
    if (this._statsInterval) clearInterval(this._statsInterval);
    this._statsInterval = setInterval(async () => {
      this._stats.audio.exclusionState = this._audioExclusion.state;
      this._stats.audio.exclusionStats = this._audioExclusion.getState().stats;
      this._stats.network.wsOpen = this._ws?.readyState === (WebSocket.OPEN ?? 1);
      this._stats.network.reconnectAttempts = this._reconnectAttempts;

      // Determine audioCaptureSource accurately
      if (!this._config?.audio) {
        this._stats.audio.audioCaptureSource = 'disabled';
      } else if (this._audioExclusion.state === EXCLUSION_STATES.CAPTURING) {
        if (this._audioExclusion.currentIncludePid) {
          this._stats.audio.audioCaptureSource = 'window-isolated';
        } else if (this._audioExclusion.currentExcludePid && this._audioExclusion.currentExcludePid !== process.pid) {
          this._stats.audio.audioCaptureSource = 'native-exclusion';
        } else {
          this._stats.audio.audioCaptureSource = 'system-loopback-safe';
        }
      } else {
        const { isRunning } = await this._audioExclusion.discordDetector.check().catch(() => ({}));
        if (isRunning && this._config.excludeDiscord !== false) {
          this._stats.audio.audioCaptureSource = 'blocked-discord-exclusion-not-ready';
        } else {
          this._stats.audio.audioCaptureSource = 'system-loopback-safe';
        }
      }

      this.emit('stats', this._stats);
    }, STATS_INTERVAL_MS);
  }

  _stopStatsInterval() {
    if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
  }

  _emptyStats() {
    return {
      capture: {
        fps: 0,
        captureFps: 0,
        admittedFps: 0,
        encodedFps: 0,
        sentFps: 0,
        requestedFps: 60,
        sourceFps: 60,
        dropCount: 0,
        droppedDuplicate: 0,
        droppedObsolete: 0,
        droppedEncoderPressure: 0,
        droppedTransportPressure: 0,
        droppedInvalid: 0,
        encoderQueueSize: 0,
        p50IntervalMs: 0,
        p95IntervalMs: 0,
        p99IntervalMs: 0,
        maxIntervalMs: 0,
        gap25Ms: 0,
        gap33Ms: 0,
        gap50Ms: 0,
        gap100Ms: 0,
        avgEncodeLatencyMs: 0,
        hardwareStatus: 'Hardware requested / runtime confirmation unavailable',
      },
      encoder: { fps: 0, queueSize: 0, avgEncodeMs: 0, keyframeCount: 0 },
      network: { wsOpen: false, sentFps: 0, totalBytesSent: 0, droppedNetworkFrames: 0, transportQueueBytes: 0, reconnectAttempts: 0, viewers: 0 },
      audio:   { exclusionState: 'IDLE', audioCaptureSource: 'disabled', exclusionStats: null },
      watchdog: { captureStalled: false, captureGapMs: 0, captureRecoveries: 0, encoderStalled: false, transportStalled: false },
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async _cleanup(graceful = true) {
    ++this._lifecycleGeneration;
    ++this._wsGeneration;
    clearTimeout(this._captureRecoveryTimer);
    this._captureRecoveryTimer = null;
    if (this._connectingWs) {
      try { this._connectingWs.terminate(); } catch {}
      this._connectingWs = null;
    }
    if (this._powerBlockerId !== null) {
      powerSaveBlocker.stop(this._powerBlockerId);
      this._powerBlockerId = null;
    }
    this._stopWatchdog();
    this._stopStatsInterval();
    this._clearTimers();

    // Stop capture window
    if (this._captureWin && !this._captureWin.isDestroyed()) {
      try {
        this._captureWin.webContents.send('capture-cmd', { type: 'capture-stop' });
        await new Promise((r) => setTimeout(r, 200));
        this._captureWin.close();
      } catch {}
      this._captureWin = null;
      this._captureWinReady = false;
    }

    // Close WS
    if (this._ws) {
      try {
        if (graceful && this._ws.readyState === WebSocket.OPEN) {
          this._ws.send(JSON.stringify({ type: 'stop' }));
        }
        this._ws.terminate();
      } catch {}
      this._ws = null;
    }

    // Stop audio
    if (this._audioRecovery) await this._audioRecovery;
    await this._audioExclusion.stop().catch(() => {});

    this._stats = this._emptyStats();
    this._config = null;
    this._wsUrl  = null;
    this._shareUrl = null;
    this._viewerUrl = null;
    this._slot = null;
    this._roomRes = null;
    this._viewerBaseUrl = null;
    this._lastVideoConfig = null;
    this._lastAudioConfig = null;
    this._pendingCmd = null;
    this._transportPressureActive = false;
    this._awaitingKeyframe = false;
  }

  _setState(newState) {
    this._state = newState;
    logger.info(`[BroadcasterManager] State → ${newState}`);
    this.emit('state-change', this.getState());
  }

  _setError(code, title, message) {
    this._lastError = { code, title, message };
    this.emit('error-state', this._lastError);
  }
}

export const broadcasterManager = new BroadcasterManager();
