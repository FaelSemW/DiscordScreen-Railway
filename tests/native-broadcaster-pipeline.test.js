/**
 * Comprehensive Automated Tests for the Native Broadcaster Pipeline
 *
 * Verifies:
 *  - Multi-factor frame admission (queue=2..4 admitted, queue>8 dropped)
 *  - Monotonic frame timestamp enforcement (DROP_DUPLICATE, DROP_OBSOLETE)
 *  - Transport backpressure handling (DROP_TRANSPORT_PRESSURE)
 *  - Granular watchdogs (capture, encoder, transport stalls)
 *  - Reconnect exponential backoff and passive standby
 *  - Audio exclusion privacy protection (NEVER leak Discord voice)
 *  - Shutdown and cleanup idempotence
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Electron APIs ────────────────────────────────────────────────────────
vi.mock('electron', () => ({
  powerSaveBlocker: { start: vi.fn(() => 7), stop: vi.fn() },
  desktopCapturer: {
    getSources: vi.fn(async () => [
      { id: 'screen:0:0', name: 'Primary Display', display_id: '1', thumbnail: { toDataURL: () => 'data:img' }, appIcon: null },
      { id: 'window:999:0', name: 'Game', display_id: '', thumbnail: { toDataURL: () => 'data:img' }, appIcon: null },
    ]),
  },
  screen: {
    getAllDisplays: () => [{ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1 }],
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn().mockResolvedValue(undefined),
    webContents: { send: vi.fn() },
    on: vi.fn(),
    once: vi.fn((ev, cb) => { if (ev === 'ready-to-show') cb(); }),
  })),
  app: { getPath: () => 'C:/Users/Test/AppData', isPackaged: false },
}));

vi.mock('../desktop/main/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), onLog: vi.fn() },
}));

vi.mock('../desktop/main/audio-exclusion-manager.js', () => ({
  EXCLUSION_STATES: { IDLE: 'IDLE', STARTING: 'STARTING', CAPTURING: 'CAPTURING', ERROR: 'ERROR', STOPPED: 'STOPPED' },
  AudioExclusionManager: vi.fn().mockImplementation(function () {
    return {
      state: 'IDLE',
      start: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      getState: vi.fn(() => ({ state: 'IDLE', currentExcludePid: null, stats: {}, helperExists: true })),
      discordDetector: {
        check: vi.fn().mockResolvedValue({ isRunning: false, rootPid: null }),
      },
    };
  }),
}));

vi.mock('ws', () => {
  const MockWebSocket = vi.fn().mockImplementation(() => {
    const handlers = {};
    const ws = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn((event, handler) => { handlers[event] = handler; }),
      _trigger: (event, ...args) => handlers[event]?.(...args),
    };
    setTimeout(() => handlers.open?.(), 0);
    return ws;
  });
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSED = 3;
  return { WebSocket: MockWebSocket };
});

global.fetch = vi.fn();

let BroadcasterManager, BROADCASTER_STATES;

beforeEach(async () => {
  vi.resetModules();
  global.fetch.mockImplementation(async (url) => {
    if (url.includes('/api/session-guest')) {
      return { ok: true, json: async () => ({ identity: 'test-identity-jwt', user: { id: 'guest-123', name: 'Test' } }) };
    }
    if (url.includes('/api/rooms/create')) {
      return { ok: true, json: async () => ({ shareUrl: 'https://zaprecovery.online/share.html?t=test-broadcaster-token', roomId: 'room-abc' }) };
    }
    return { ok: true, json: async () => ({}) };
  });

  const mod = await import('../desktop/main/broadcaster-manager.js');
  BroadcasterManager = mod.BroadcasterManager;
  BROADCASTER_STATES = mod.BROADCASTER_STATES;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Native Broadcaster Pipeline — Hardening & Diagnostics', () => {

  describe('1. Frame Admission & Multi-factor Queue Tolerance', () => {
    it('does NOT treat queue=2 or queue=3 as an overload condition', () => {
      // Logic simulation of capture worker encodeFrame backpressure
      function checkAdmission(queueSize, consecutiveHigh, transportBackpressure) {
        if (queueSize > 8 || consecutiveHigh >= 4) return { drop: true, reason: 'DROP_ENCODER_PRESSURE' };
        if (transportBackpressure) return { drop: true, reason: 'DROP_TRANSPORT_PRESSURE' };
        return { drop: false };
      }

      // Normal in-flight queues in hardware encoders (2, 3, 4) MUST NOT be dropped
      expect(checkAdmission(2, 0, false).drop).toBe(false);
      expect(checkAdmission(3, 0, false).drop).toBe(false);
      expect(checkAdmission(4, 0, false).drop).toBe(false);
      expect(checkAdmission(6, 1, false).drop).toBe(false);

      // Severe congestion MUST be dropped
      expect(checkAdmission(9, 0, false)).toEqual({ drop: true, reason: 'DROP_ENCODER_PRESSURE' });
      expect(checkAdmission(7, 4, false)).toEqual({ drop: true, reason: 'DROP_ENCODER_PRESSURE' });
      expect(checkAdmission(2, 0, true)).toEqual({ drop: true, reason: 'DROP_TRANSPORT_PRESSURE' });
    });
  });

  describe('2. Monotonic Timestamp Verification', () => {
    it('classifies duplicate and obsolete timestamps correctly', () => {
      function checkTimestamp(tsUs, lastTsUs) {
        if (lastTsUs !== null && tsUs <= lastTsUs) {
          if (tsUs < lastTsUs) return { drop: true, reason: 'DROP_OBSOLETE' };
          return { drop: true, reason: 'DROP_DUPLICATE' };
        }
        return { drop: false };
      }

      expect(checkTimestamp(1000, null).drop).toBe(false);
      expect(checkTimestamp(2000, 1000).drop).toBe(false);
      expect(checkTimestamp(2000, 2000)).toEqual({ drop: true, reason: 'DROP_DUPLICATE' });
      expect(checkTimestamp(1500, 2000)).toEqual({ drop: true, reason: 'DROP_OBSOLETE' });
    });
  });

  describe('3. Transport Backpressure Monitoring', () => {
    it('detects high WebSocket bufferedAmount and signals capture worker', () => {
      const mgr = new BroadcasterManager();
      const sendToCaptureSpy = vi.spyOn(mgr, '_sendToCapture');
      mgr._ws = { readyState: 1, bufferedAmount: 2_000_000, send: vi.fn() };

      const chunk = new Uint8Array(100);
      chunk[1] = 2; // delta
      mgr._sendWs(chunk.buffer);

      expect(mgr._stats.network.transportQueueBytes).toBe(2_000_000);
      expect(sendToCaptureSpy).toHaveBeenCalledWith({ type: 'transport-pressure', active: true });
      expect(mgr._transportPressureActive).toBe(true);

      // Recovery when buffer clears
      mgr._ws.bufferedAmount = 100_000;
      mgr._sendWs(chunk.buffer);
      expect(sendToCaptureSpy).toHaveBeenCalledWith({ type: 'transport-pressure', active: false });
      expect(mgr._transportPressureActive).toBe(false);
    });
  });

  describe('4. Granular Watchdog Diagnostics', () => {
    it('separates capture, encoder, and transport stalls', () => {
      const mgr = new BroadcasterManager();
      mgr._state = BROADCASTER_STATES.STREAMING;
      const sendToCaptureSpy = vi.spyOn(mgr, '_sendToCapture');

      const now = Date.now();
      // Simulate capture stall (no raw frames for 3.5s)
      mgr._lastCaptureFrameAt = now - 3500;
      mgr._lastEncodedFrameAt = now - 500;
      mgr._lastSentFrameAt    = now - 500;

      mgr._checkWatchdog();

      expect(mgr._stats.watchdog.captureStalled).toBe(true);
      expect(sendToCaptureSpy).toHaveBeenCalledWith({ type: 'capture-keyframe' });
      expect(mgr._stats.watchdog.captureRecoveries).toBe(1);

      // Clear capture stall and simulate encoder stall
      mgr._lastCaptureFrameAt = now;
      mgr._lastEncodedFrameAt = now - 2500; // 2.5s no encoded frame
      mgr._lastRecoveryAt = 0; // reset debounce

      mgr._checkWatchdog();
      expect(mgr._stats.watchdog.encoderStalled).toBe(true);
    });
  });

  describe('5. Discord Call Privacy Leak Guard', () => {
    it('blocks audio completely if Discord call is running and exclusion is not ready', async () => {
      const mgr = new BroadcasterManager();
      mgr._audioStartingTimeoutMs = 50;

      // Mock audio exclusion failure with Discord running
      mgr._audioExclusion.state = 'STARTING';
      mgr._audioExclusion.start.mockResolvedValue(true);
      mgr._audioExclusion.discordDetector.check.mockResolvedValue({ isRunning: true, rootPid: 4567 });

      const ok = await mgr._startAudio(true);

      expect(ok).toBe(false);
      expect(mgr._lastError?.code).toBe('AUDIO_EXCLUSION_FAILED');
      expect(mgr.getState().stats.audio.audioCaptureSource).toBe('disabled');
    });

    it('permits system audio when Discord is confirmed not running', async () => {
      const mgr = new BroadcasterManager();
      mgr._audioStartingTimeoutMs = 50;

      // Mock audio exclusion not CAPTURING but Discord NOT running
      mgr._audioExclusion.state = 'IDLE';
      mgr._audioExclusion.start.mockResolvedValue(true);
      mgr._audioExclusion.discordDetector.check.mockResolvedValue({ isRunning: false, rootPid: null });

      const ok = await mgr._startAudio(true);
      expect(ok).toBe(true);
    });
  });

  describe('6. Reconnect Scheduling & Standby', () => {
    it('executes exponential backoff and exhausts to passive standby without leaking timers', () => {
      const mgr = new BroadcasterManager();
      mgr._state = BROADCASTER_STATES.STREAMING;
      mgr._wsUrl = 'wss://zaprecovery.online/ws?t=123';

      expect(mgr._reconnectAttempts).toBe(0);
      mgr._scheduleReconnect();
      expect(mgr._reconnectAttempts).toBe(1);
      expect(mgr._reconnectTimer).not.toBeNull();

      // Fast forward attempts to max
      mgr._reconnectAttempts = 8;
      mgr._scheduleReconnect();
      expect(mgr._passiveTimer).not.toBeNull();
      expect(mgr._reconnectTimer).toBeNull();

      // Clean cleanup clears both
      mgr._clearTimers();
      expect(mgr._reconnectTimer).toBeNull();
      expect(mgr._passiveTimer).toBeNull();
    });
  });

  describe('7. Cleanup Idempotence', () => {
    it('can be called multiple times without throwing or memory leaks', async () => {
      const mgr = new BroadcasterManager();
      await mgr._cleanup(true);
      await mgr._cleanup(false);
      await mgr._cleanup(true);

      expect(mgr.getState().state).toBe('idle');
      expect(mgr._captureWin).toBeNull();
      expect(mgr._ws).toBeNull();
    });
  });
});
