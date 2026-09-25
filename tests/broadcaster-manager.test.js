/**
 * Tests for BroadcasterManager
 *
 * Covers:
 *  - State machine transitions
 *  - Audio exclusion startup race (STARTING → guard)
 *  - Source enumeration
 *  - Watchdog detection
 *  - Reconnect scheduling
 *  - Source change (stop + restart sequence)
 *  - Stats emission
 *  - Clean shutdown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Electron APIs (not available in Node test environment) ──────────────
vi.mock('electron', () => ({
  powerSaveBlocker: { start: vi.fn(() => 7), stop: vi.fn() },
  desktopCapturer: {
    getSources: vi.fn(async () => [
      { id: 'screen:0:0', name: 'Entire Screen', display_id: '1', thumbnail: { toDataURL: () => 'data:image/png;base64,aaa' }, appIcon: null },
      { id: 'window:12345:0', name: 'Chrome', display_id: '', thumbnail: { toDataURL: () => 'data:image/png;base64,bbb' }, appIcon: null },
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
    webContents: {
      send: vi.fn(),
    },
    on: vi.fn(),
    once: vi.fn((event, cb) => { if (event === 'ready-to-show') cb(); }),
  })),
  app: { getPath: () => 'C:/Users/Test/AppData', isPackaged: false },
}));

// ── Mock logger ──────────────────────────────────────────────────────────────
vi.mock('../desktop/main/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), onLog: vi.fn() },
}));

// ── Mock AudioExclusionManager ───────────────────────────────────────────────
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

// ── Mock ws ──────────────────────────────────────────────────────────────────
vi.mock('ws', () => {
  const MockWebSocket = vi.fn().mockImplementation(function () {
    const handlers = {};
    const ws = {
      readyState: 1, // OPEN
      send: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn((event, handler) => { handlers[event] = handler; }),
      // Trigger an event for testing
      _trigger: (event, ...args) => handlers[event]?.(...args),
      _handlers: handlers,
    };
    // Auto-open
    setTimeout(() => handlers.open?.(), 0);
    return ws;
  });
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSED = 3;
  return { WebSocket: MockWebSocket };
});

// ── Mock global fetch ────────────────────────────────────────────────────────
global.fetch = vi.fn();

// ── Import under test ─────────────────────────────────────────────────────────
let BroadcasterManager, BROADCASTER_STATES;

beforeEach(async () => {
  vi.resetModules();
  // Reset fetch mock
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

describe('Long-running broadcast regressions', () => {
  it('resumes a silent video stream after its transport queue drains without another packet', () => {
    const mgr = new BroadcasterManager();
    mgr._state = 'streaming';
    mgr._ws = { readyState: 1, bufferedAmount: 2_000_000, send: vi.fn() };
    mgr._sendToCapture = vi.fn();
    mgr._sendWs(new Uint8Array([0, 1, 0]).buffer);
    expect(mgr._transportPressureActive).toBe(true);
    mgr._ws.bufferedAmount = 0;
    mgr._checkWatchdog();
    expect(mgr._sendToCapture).toHaveBeenCalledWith({ type: 'transport-pressure', active: false });
    expect(mgr._sendToCapture).toHaveBeenCalledWith({ type: 'capture-keyframe' });
  });

  it('bounds the socket queue and waits for a keyframe after dropping video', () => {
    const mgr = new BroadcasterManager();
    mgr._ws = { readyState: 1, bufferedAmount: 4 * 1024 * 1024, send: vi.fn() };
    mgr.onEncodedChunk(new Uint8Array([0, 2, 0]).buffer);
    expect(mgr._ws.send).not.toHaveBeenCalled();
    expect(mgr._lastSentFrameAt).toBeNull();
    mgr._ws.bufferedAmount = 0;
    mgr.onEncodedChunk(new Uint8Array([0, 2, 0]).buffer);
    expect(mgr._ws.send).not.toHaveBeenCalled();
    mgr.onEncodedChunk(new Uint8Array([0, 1, 0]).buffer);
    mgr.onEncodedChunk(new Uint8Array([0, 2, 0]).buffer);
    expect(mgr._ws.send).toHaveBeenCalledTimes(2);
  });

  it('does not postpone a pending reconnect when the watchdog runs again', () => {
    vi.useFakeTimers();
    try {
      const mgr = new BroadcasterManager();
      mgr._state = 'streaming';
      mgr._wsUrl = 'ws://127.0.0.1/ws';
      mgr._scheduleReconnect();
      const timer = mgr._reconnectTimer;
      mgr._scheduleReconnect();
      expect(mgr._reconnectTimer).toBe(timer);
      expect(mgr._reconnectAttempts).toBe(1);
      mgr._clearTimers();
    } finally { vi.useRealTimers(); }
  });

  it('distinguishes a live stats heartbeat from an actual captured frame', () => {
    const mgr = new BroadcasterManager();
    mgr.onCaptureMessage({ type: 'capture-stats', stats: { lastFrameAt: 123, captureFps: 0 } });
    expect(mgr._lastCaptureFrameAt).toBe(123);
    expect(mgr._lastWorkerHeartbeatAt).toBeGreaterThan(123);
  });

  it('recreates a failed capture worker while retaining the socket and session', async () => {
    const mgr = new BroadcasterManager();
    mgr._state = 'streaming';
    mgr._config = { sourceId: 'window:1:0', audio: false };
    const ws = mgr._ws = { readyState: 1 };
    const old = mgr._captureWin = { isDestroyed: () => false, destroy: vi.fn() };
    mgr._openCaptureWindow = vi.fn().mockResolvedValue();
    mgr._sendCaptureStart = vi.fn().mockResolvedValue();
    await mgr._recoverCapture('simulated crash');
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(mgr._sendCaptureStart).toHaveBeenCalledWith(mgr._config);
    expect(mgr._ws).toBe(ws);
    expect(mgr._state).toBe('streaming');
    expect(mgr._captureRecovery).toBeNull();
  });

  it('does not restart capture after stopping during recovery', async () => {
    const mgr = new BroadcasterManager();
    mgr._state = 'streaming';
    mgr._config = { sourceId: 'window:1:0', audio: false };
    let ready;
    mgr._openCaptureWindow = vi.fn(() => new Promise(r => { ready = r; }));
    mgr._sendCaptureStart = vi.fn();
    const recovering = mgr._recoverCapture('simulated crash');
    await mgr.stopBroadcast();
    ready();
    await recovering;
    expect(mgr._sendCaptureStart).not.toHaveBeenCalled();
    expect(mgr._state).toBe('idle');
  });

  it('releases the sleep blocker when startup fails', async () => {
    const { powerSaveBlocker } = await import('electron');
    const mgr = new BroadcasterManager();
    mgr._openCaptureWindow = vi.fn().mockRejectedValue(new Error('failure'));
    await expect(mgr.startBroadcast({ audio: false })).rejects.toThrow('failure');
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(7);
    expect(mgr._powerBlockerId).toBeNull();
  });

  it('recovers audio after an unexpected helper exit', async () => {
    const mgr = new BroadcasterManager();
    mgr._state = 'streaming';
    mgr._config = { audio: true, audioMode: 'system', excludeDiscord: true };
    mgr._audioExclusion.state = 'STOPPED';
    mgr._startAudio = vi.fn(async () => { mgr._audioExclusion.state = 'CAPTURING'; });
    mgr._scheduleCaptureRecovery = vi.fn();
    mgr._checkWatchdog();
    await mgr._audioRecovery;
    expect(mgr._startAudio).toHaveBeenCalledWith(mgr._config);
    expect(mgr._scheduleCaptureRecovery).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('BROADCASTER_STATES', () => {
  it('has all required state values', () => {
    expect(BROADCASTER_STATES.IDLE).toBe('idle');
    expect(BROADCASTER_STATES.STARTING).toBe('starting');
    expect(BROADCASTER_STATES.STREAMING).toBe('streaming');
    expect(BROADCASTER_STATES.STOPPING).toBe('stopping');
    expect(BROADCASTER_STATES.ERROR).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('BroadcasterManager — initial state', () => {
  it('starts in IDLE state', () => {
    const mgr = new BroadcasterManager();
    expect(mgr.getState().state).toBe('idle');
    expect(mgr.getState().lastError).toBeNull();
  });

  it('getState returns stats object', () => {
    const mgr = new BroadcasterManager();
    const state = mgr.getState();
    expect(state.stats).toBeDefined();
    expect(state.stats.capture).toBeDefined();
    expect(state.stats.network).toBeDefined();
    expect(state.stats.audio).toBeDefined();
    expect(state.stats.watchdog).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Source enumeration', () => {
  it('enumerateSources returns screens and windows', async () => {
    const mgr = new BroadcasterManager();
    const sources = await mgr.enumerateSources();
    expect(sources.length).toBeGreaterThan(0);
    const screens = sources.filter((s) => s.type === 'screen');
    const windows = sources.filter((s) => s.type === 'window');
    expect(screens.length).toBeGreaterThan(0);
    expect(windows.length).toBeGreaterThan(0);
  });

  it('screen sources have display metadata', async () => {
    const mgr = new BroadcasterManager();
    const sources = await mgr.enumerateSources();
    const screen = sources.find((s) => s.type === 'screen');
    expect(screen).toBeDefined();
    expect(screen.width).toBe(1920);
    expect(screen.height).toBe(1080);
  });

  it('returns empty array on desktopCapturer failure', async () => {
    const { desktopCapturer } = await import('electron');
    desktopCapturer.getSources.mockRejectedValueOnce(new Error('Permission denied'));
    const mgr = new BroadcasterManager();
    const sources = await mgr.enumerateSources();
    expect(sources).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('State machine', () => {
  it('emits state-change events on transition', async () => {
    const mgr = new BroadcasterManager();
    const transitions = [];
    mgr.on('state-change', (state) => transitions.push(state.state));

    // Manually trigger a state change
    mgr._setState(BROADCASTER_STATES.STARTING);
    mgr._setState(BROADCASTER_STATES.STREAMING);
    mgr._setState(BROADCASTER_STATES.STOPPING);
    mgr._setState(BROADCASTER_STATES.IDLE);

    expect(transitions).toEqual(['starting', 'streaming', 'stopping', 'idle']);
  });

  it('setError sets lastError', () => {
    const mgr = new BroadcasterManager();
    mgr._setError('TEST', 'Test Title', 'Test message');
    expect(mgr._lastError).toEqual({ code: 'TEST', title: 'Test Title', message: 'Test message' });
  });

  it('getState returns lastError', () => {
    const mgr = new BroadcasterManager();
    mgr._setError('CODE', 'Title', 'Msg');
    expect(mgr.getState().lastError.code).toBe('CODE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Audio exclusion startup race', () => {
  it('does not proceed if exclusion stuck in STARTING and Discord is running', async () => {
    const mgr = new BroadcasterManager();
    mgr._audioStartingTimeoutMs = 50;

    // Simulate exclusion stuck in STARTING with Discord running
    mgr._audioExclusion.state = 'STARTING';
    mgr._audioExclusion.start.mockImplementation(async () => {
      mgr._audioExclusion.state = 'STARTING';
      return true;
    });
    mgr._audioExclusion.discordDetector.check.mockResolvedValue({ isRunning: true, rootPid: 12345 });

    const result = await mgr._startAudio(true);
    expect(result).toBe(false);
    expect(mgr._lastError?.code).toBe('AUDIO_EXCLUSION_FAILED');
  });

  it('proceeds if Discord is NOT running when exclusion fails', async () => {
    const mgr = new BroadcasterManager();
    mgr._audioStartingTimeoutMs = 50;

    mgr._audioExclusion.state = 'STARTING';
    mgr._audioExclusion.start.mockImplementation(async () => {
      mgr._audioExclusion.state = 'STARTING';
      return true;
    });
    mgr._audioExclusion.discordDetector.check.mockResolvedValue({ isRunning: false });

    const result = await mgr._startAudio(true);
    // Should succeed (Discord not running, so safe)
    expect(result).not.toBe(false);
    // No privacy error
    expect(mgr._lastError?.code).not.toBe('AUDIO_EXCLUSION_FAILED');
  });

  it('succeeds immediately when exclusion reaches CAPTURING', async () => {
    const mgr = new BroadcasterManager();

    mgr._audioExclusion.start.mockImplementation(async () => {
      mgr._audioExclusion.state = 'CAPTURING';
      return true;
    });

    const result = await mgr._startAudio(true);
    expect(result).not.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Watchdog', () => {
  it('emits watchdog-warning when no capture frames arrive', async () => {
    vi.useFakeTimers();
    const mgr = new BroadcasterManager();
    mgr._state = BROADCASTER_STATES.STREAMING;

    const warnings = [];
    mgr.on('watchdog-warning', (w) => warnings.push(w));

    mgr._startWatchdog();
    // Simulate no frames arriving
    mgr._lastCaptureFrameAt = Date.now() - 1_500;

    vi.advanceTimersByTime(600);

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].stage).toBe('capture');

    mgr._stopWatchdog();
    vi.useRealTimers();
  });

  it('does not recover more frequently than debounce window', async () => {
    vi.useFakeTimers();
    const mgr = new BroadcasterManager();
    mgr._state = BROADCASTER_STATES.STREAMING;
    mgr._sendToCapture = vi.fn();

    mgr._startWatchdog();
    mgr._lastCaptureFrameAt  = Date.now() - 10_000;
    mgr._lastEncodedFrameAt  = Date.now() - 10_000;
    mgr._lastSentFrameAt     = Date.now() - 10_000;
    mgr._lastRecoveryAt      = Date.now(); // just recovered

    vi.advanceTimersByTime(1_000);
    // Should NOT send another recovery because debounce is 5s
    expect(mgr._sendToCapture).not.toHaveBeenCalled();

    mgr._stopWatchdog();
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Reconnect scheduling', () => {
  it('schedules Tier1 reconnect with exponential backoff', () => {
    vi.useFakeTimers();
    const mgr = new BroadcasterManager();
    mgr._state = BROADCASTER_STATES.STREAMING;
    mgr._wsUrl = 'wss://zaprecovery.online/ws?t=fake';

    mgr._scheduleReconnect();
    expect(mgr._reconnectAttempts).toBe(1);
    expect(mgr._reconnectTimer).not.toBeNull();

    mgr._clearTimers();
    vi.useRealTimers();
  });

  it('switches to passive standby after MAX_ATTEMPTS', () => {
    vi.useFakeTimers();
    const mgr = new BroadcasterManager();
    mgr._state = BROADCASTER_STATES.STREAMING;
    mgr._reconnectAttempts = 8; // already at max

    const stateChanges = [];
    mgr.on('state-change', (s) => stateChanges.push(s));

    mgr._scheduleReconnect();
    expect(mgr._passiveTimer).not.toBeNull();
    expect(mgr._reconnectTimer).toBeNull();

    mgr._clearTimers();
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Source change', () => {
  it('resets frame timestamps on source change', async () => {
    const mgr = new BroadcasterManager();
    mgr._sendToCapture = vi.fn();
    mgr._config = { sourceId: 'screen:0:0', audio: false };

    // Simulate having timestamps
    mgr._lastCaptureFrameAt  = Date.now();
    mgr._lastEncodedFrameAt  = Date.now();
    mgr._lastSentFrameAt     = Date.now();

    // Mock audio exclusion (no-op for this test)
    mgr._audioExclusion.stop = vi.fn().mockResolvedValue(undefined);

    await mgr.changeSource({ sourceId: 'window:123:0' });

    // Timestamps should be reset
    expect(mgr._lastCaptureFrameAt).toBeNull();
    expect(mgr._lastEncodedFrameAt).toBeNull();
    expect(mgr._lastSentFrameAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('onEncodedChunk routing', () => {
  it('forwards chunk to WS and updates lastSentFrameAt', () => {
    const mgr = new BroadcasterManager();
    mgr._ws = { readyState: 1, send: vi.fn() }; // OPEN

    const buf = new Uint8Array(32);
    buf[1] = 2; // delta video frame
    mgr.onEncodedChunk(buf.buffer);

    expect(mgr._ws.send).toHaveBeenCalledWith(buf.buffer);
    expect(mgr._lastSentFrameAt).not.toBeNull();
    expect(mgr._lastEncodedFrameAt).not.toBeNull();
  });

  it('counts dropped frames when WS is not open', () => {
    const mgr = new BroadcasterManager();
    mgr._ws = { readyState: 3, send: vi.fn() }; // CLOSED

    const before = mgr._stats.network.droppedNetworkFrames || 0;
    mgr.onEncodedChunk(new ArrayBuffer(100));
    expect(mgr._stats.network.droppedNetworkFrames).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('onCaptureMessage routing', () => {
  it('sets captureWinReady on capture-ready', () => {
    const mgr = new BroadcasterManager();
    mgr.onCaptureMessage({ type: 'capture-ready' });
    expect(mgr._captureWinReady).toBe(true);
  });

  it('sets error on capture-error', () => {
    const mgr = new BroadcasterManager();
    mgr.on('error', () => {});
    mgr.onCaptureMessage({ type: 'capture-error', message: 'GPU crashed' });
    expect(mgr._lastError?.code).toBe('CAPTURE_ERROR');
    expect(mgr._lastError?.message).toContain('GPU crashed');
  });

  it('relays capture-config to WS', () => {
    const mgr = new BroadcasterManager();
    mgr._ws = { readyState: 1, send: vi.fn() };
    mgr.onCaptureMessage({ type: 'capture-config', config: { codec: 'avc1.640033', width: 1920, height: 1080 } });
    expect(mgr._ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"config"'),
    );
  });

  it('relays audio-config to WS', () => {
    const mgr = new BroadcasterManager();
    mgr._ws = { readyState: 1, send: vi.fn() };
    mgr.onCaptureMessage({ type: 'audio-config', config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } });
    expect(mgr._ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"audio-config"'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Cleanup', () => {
  it('_cleanup closes WS and stops audio', async () => {
    const mgr = new BroadcasterManager();
    const mockWs = { readyState: 1, send: vi.fn(), terminate: vi.fn() };
    mgr._ws = mockWs;

    await mgr._cleanup(false);

    expect(mockWs.terminate).toHaveBeenCalled();
    expect(mgr._ws).toBeNull();
    expect(mgr._audioExclusion.stop).toHaveBeenCalled();
  });

  it('sends stop message on graceful cleanup', async () => {
    const mgr = new BroadcasterManager();
    const mockWs = { readyState: 1, send: vi.fn(), terminate: vi.fn() };
    mgr._ws = mockWs;

    await mgr._cleanup(true);

    expect(mockWs.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"stop"'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Empty stats structure', () => {
  it('returns empty stats with all required keys', () => {
    const mgr = new BroadcasterManager();
    const stats = mgr._emptyStats();
    expect(stats.capture).toBeDefined();
    expect(stats.encoder).toBeDefined();
    expect(stats.network).toBeDefined();
    expect(stats.audio).toBeDefined();
    expect(stats.watchdog).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Room Creation & Joining Existing Rooms', () => {
  it('creates room with custom name and password', async () => {
    const mgr = new BroadcasterManager();
    const calls = [];
    global.fetch.mockImplementation(async (url, opts) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/api/session-guest')) {
        return { ok: true, json: async () => ({ identity: 'test-guest-jwt' }) };
      }
      if (url.includes('/api/rooms/create')) {
        return {
          ok: true,
          json: async () => ({
            roomId: 'custom-room-123',
            shareUrl: 'https://zaprecovery.online/share.html?t=custom-broadcaster-token',
            viewerToken: 'custom-viewer-token',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const wsUrl = await mgr._buildWsUrl({
      mode: 'create',
      name: 'Sala Secreta',
      password: 'minha-senha-123',
    });

    expect(wsUrl).toContain('custom-broadcaster-token');
    const createCall = calls.find((c) => c.url.includes('/api/rooms/create'));
    expect(createCall).toBeDefined();
    expect(createCall.body.name).toBe('Sala Secreta');
    expect(createCall.body.password).toBe('minha-senha-123');
    expect(mgr.getState().shareUrl).toContain('custom-viewer-token');
  });

  it('joins existing room by roomId and password', async () => {
    const mgr = new BroadcasterManager();
    const calls = [];
    global.fetch.mockImplementation(async (url, opts) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes('/api/session-guest')) {
        return { ok: true, json: async () => ({ identity: 'test-guest-jwt' }) };
      }
      if (url.includes('/api/rooms/join')) {
        return {
          ok: true,
          json: async () => ({
            roomId: 'call-4491',
            shareUrl: 'https://zaprecovery.online/share.html?t=call-broadcaster-token',
            viewerToken: 'call-viewer-token',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const wsUrl = await mgr._buildWsUrl({
      mode: 'join',
      target: 'call-4491',
      password: 'pass',
    });

    expect(wsUrl).toContain('call-broadcaster-token');
    const joinCall = calls.find((c) => c.url.includes('/api/rooms/join'));
    expect(joinCall).toBeDefined();
    expect(joinCall.body.roomId).toBe('call-4491');
    expect(joinCall.body.password).toBe('pass');
  });

  it('joins existing room by shareUrl or token parameter', async () => {
    const mgr = new BroadcasterManager();
    global.fetch.mockImplementation(async (url) => {
      if (url.includes('/api/session-guest')) {
        return { ok: true, json: async () => ({ identity: 'test-guest-jwt' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const wsUrl = await mgr._buildWsUrl({
      mode: 'join',
      target: 'https://zaprecovery.online/share.html?t=direct-token-xyz',
    });

    expect(wsUrl).toBe('wss://zaprecovery.online/ws?t=direct-token-xyz');
    expect(mgr._sessionToken).toBe('direct-token-xyz');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Audio Mode Selection (Window vs System vs None)', () => {
  it('handles window-specific audio mode by launching process loopback exclusion/isolation', async () => {
    const mgr = new BroadcasterManager();
    const sentCmds = [];
    mgr._sendToCapture = vi.fn((cmd) => sentCmds.push(cmd));
    mgr._connectWs = vi.fn().mockResolvedValue();
    mgr._openCaptureWindow = vi.fn().mockResolvedValue();
    mgr._audioExclusion.state = 'CAPTURING';

    await mgr.startBroadcast({
      sourceId: 'window:12345:0',
      audio: true,
      audioMode: 'window',
      wsUrl: 'wss://test.ws/ws',
    });

    expect(mgr._audioExclusion.start).toHaveBeenCalled();
    const startCmd = sentCmds.find((c) => c.type === 'capture-start');
    expect(startCmd).toBeDefined();
    expect(startCmd.audio).toBe(true);
    expect(startCmd.audioMode).toBe('window');
    expect(startCmd.nativeAudio).toBe(true);

    await mgr.stopBroadcast();
  });

  it('handles system audio mode by starting system audio exclusion', async () => {
    const mgr = new BroadcasterManager();
    const sentCmds = [];
    mgr._sendToCapture = vi.fn((cmd) => sentCmds.push(cmd));
    mgr._connectWs = vi.fn().mockResolvedValue();
    mgr._openCaptureWindow = vi.fn().mockResolvedValue();
    mgr._audioExclusion.state = 'CAPTURING';

    await mgr.startBroadcast({
      sourceId: 'screen:0:0',
      audio: true,
      audioMode: 'system',
      excludeDiscord: true,
      wsUrl: 'wss://test.ws/ws',
    });

    expect(mgr._audioExclusion.start).toHaveBeenCalledWith({ excludeDiscord: true });
    const startCmd = sentCmds.find((c) => c.type === 'capture-start');
    expect(startCmd).toBeDefined();
    expect(startCmd.audio).toBe(true);
    expect(startCmd.audioMode).toBe('system');
    expect(startCmd.nativeAudio).toBe(true);

    await mgr.stopBroadcast();
  });

  it('handles disabled audio mode (none)', async () => {
    const mgr = new BroadcasterManager();
    const sentCmds = [];
    mgr._sendToCapture = vi.fn((cmd) => sentCmds.push(cmd));
    mgr._connectWs = vi.fn().mockResolvedValue();
    mgr._openCaptureWindow = vi.fn().mockResolvedValue();

    await mgr.startBroadcast({
      sourceId: 'window:12345:0',
      audio: false,
      audioMode: 'none',
      wsUrl: 'wss://test.ws/ws',
    });

    expect(mgr._audioExclusion.start).not.toHaveBeenCalled();
    const startCmd = sentCmds.find((c) => c.type === 'capture-start');
    expect(startCmd).toBeDefined();
    expect(startCmd.audio).toBe(false);
    expect(startCmd.audioMode).toBe('none');

    await mgr.stopBroadcast();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Railway WebSocket Signaling & Keyframe Protocol', () => {
  it('handles need-keyframe message from server by triggering capture-keyframe', async () => {
    const mgr = new BroadcasterManager();
    const sentCmds = [];
    mgr._sendToCapture = vi.fn((cmd) => sentCmds.push(cmd));

    await mgr._connectWs('wss://test/ws');
    expect(mgr._ws).toBeDefined();

    // Server sends 'need-keyframe' when a viewer clicks "Assistir"
    mgr._ws._trigger('message', Buffer.from(JSON.stringify({ type: 'need-keyframe' })), false);

    expect(sentCmds).toContainEqual({ type: 'capture-keyframe' });
  });

  it('handles slot assignment, updates viewerUrl, and stamps slot byte on frames and audio', async () => {
    const mgr = new BroadcasterManager();
    const sentCmds = [];
    mgr._sendToCapture = vi.fn((cmd) => sentCmds.push(cmd));
    mgr._roomRes = { viewerToken: 'viewer-tok-123' };
    mgr._viewerBaseUrl = 'https://zaprecovery.online';

    await mgr._connectWs('wss://test/ws');

    // Server assigns slot 2
    mgr._ws._trigger('message', Buffer.from(JSON.stringify({ type: 'slot', slot: 2 })), false);

    expect(mgr._slot).toBe(2);
    expect(mgr.getState().slot).toBe(2);
    expect(mgr.getState().viewerUrl).toContain('slot=2');
    expect(sentCmds).toContainEqual({ type: 'set-slot', slot: 2 });
    expect(sentCmds).toContainEqual({ type: 'capture-keyframe' });

    // Video chunk stamping
    const sentBuffers = [];
    mgr._sendWs = vi.fn((buf) => sentBuffers.push(buf));
    const rawFrame = new Uint8Array([0, 1, 10, 20, 30]).buffer; // slot 0 initially
    mgr.onEncodedChunk(rawFrame);
    expect(new Uint8Array(sentBuffers[0])[0]).toBe(2); // Stamped with slot 2

    // Audio chunk stamping
    const rawAudio = new Uint8Array([0, 3, 40, 50]).buffer;
    mgr.onEncodedAudio(rawAudio);
    expect(new Uint8Array(sentBuffers[1])[0]).toBe(2); // Stamped with slot 2
  });

  it('tracks viewer count accurately from room state message for the assigned slot', async () => {
    const mgr = new BroadcasterManager();
    mgr._slot = 1;

    await mgr._connectWs('wss://test/ws');

    const statePayload = {
      type: 'state',
      viewers: 5,
      streams: [
        { slot: 0, watchers: ['user-a'] },
        { slot: 1, watchers: ['user-b', 'user-c', 'user-d'] }, // 3 watchers for slot 1
      ],
    };

    mgr._ws._trigger('message', Buffer.from(JSON.stringify(statePayload)), false);

    expect(mgr.getState().stats.network.viewers).toBe(3);
  });
});
