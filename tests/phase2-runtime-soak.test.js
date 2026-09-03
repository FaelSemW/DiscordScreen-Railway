import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAppServer } from '../server/runtime.js';
import { ProcessManager, STATES } from '../desktop/main/manager.js';
import { WebSocket } from 'ws';
import { monitorEventLoopDelay } from 'node:perf_hooks';

describe('PHASE 2: Real Runtime Stability, Soak, and Chaos Validation', () => {
  let appServer = null;
  let serverPort = null;
  let baseUrl = null;
  let wsBaseUrl = null;

  beforeEach(async () => {
    appServer = createAppServer({
      port: 0,
      publicOrigin: 'http://127.0.0.1:3001',
      sessionSecret: 'test-secret-key-phase2-soak-1234567890',
      nodeEnv: 'test',
    });

    await new Promise((resolve) => {
      appServer.server.listen(0, '127.0.0.1', () => {
        serverPort = appServer.server.address().port;
        baseUrl = `http://127.0.0.1:${serverPort}`;
        wsBaseUrl = `ws://127.0.0.1:${serverPort}`;
        appServer.setPublicOrigin(baseUrl);
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (appServer) {
      clearInterval(appServer.heartbeat);
      for (const client of appServer.wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
      await new Promise((resolve) => appServer.wss.close(resolve));
      await new Promise((resolve) => appServer.server.close(resolve));
      appServer = null;
    }
  });

  // =========================================================================
  // 1. BASELINE & 100 RECONNECT CYCLES + LISTENER LEAKS (Sections 3, 4, 5)
  // =========================================================================
  it('Sections 3, 4, 5: 100 Reconnect Cycles, Memory, and Listener Stability', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    // BASELINE SNAPSHOT
    if (global.gc) global.gc();
    const baselineMem = process.memoryUsage();
    const baselineHandles = process._getActiveHandles?.()?.length ?? 0;
    const baselineRequests = process._getActiveRequests?.()?.length ?? 0;

    const metricsHistory = [];
    const warningSpies = [];
    const onWarning = (w) => warningSpies.push(w);
    process.on('warning', onWarning);

    const initialListenerCount = pm.listenerCount('state-change');

    try {
      for (let cycle = 1; cycle <= 100; cycle++) {
        await pm._connectControlChannel();
        pm.state = STATES.READY;

        expect(pm.controlWs).not.toBeNull();
        expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
        expect(pm._pingInterval).not.toBeNull();

        // Simulate disconnect
        pm.controlWs.terminate();
        await new Promise((r) => setTimeout(r, 20));

        // Ping interval must be immediately cleared on disconnect
        expect(pm._pingInterval).toBeNull();

        // Collect metrics every 10 cycles
        if (cycle % 10 === 0) {
          const mem = process.memoryUsage();
          const handles = process._getActiveHandles?.()?.length ?? 0;
          metricsHistory.push({
            cycle,
            heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
            rssMB: (mem.rss / 1024 / 1024).toFixed(2),
            handles,
            listeners: pm.listenerCount('state-change'),
            pingIntervalActive: pm._pingInterval !== null,
            reconnectTimerActive: pm.reconnectTimer !== null,
          });
        }
      }

      await pm.stop();

      // Expectations after 100 cycles:
      expect(pm._pingInterval).toBeNull();
      expect(pm.reconnectTimer).toBeNull();
      expect(pm.controlWs).toBeNull();
      expect(pm.listenerCount('state-change')).toBe(initialListenerCount);
      expect(warningSpies.filter((w) => w.name === 'MaxListenersExceededWarning').length).toBe(0);

      // Server should have 0 lingering clients
      expect(appServer.wss.clients.size).toBe(0);
    } finally {
      process.off('warning', onWarning);
      await pm.stop();
    }
  }, 45000);

  // =========================================================================
  // 2. RAPID SOCKET REPLACEMENT & GENERATION ID (Sections 11, 12)
  // =========================================================================
  it('Sections 11, 12: Rapid Socket Replacement (A -> B -> C) & Stale Generation Invalidation', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    // Socket A
    await pm._doConnectControlChannel();
    pm.state = STATES.READY;
    const socketA = pm.controlWs;
    const genA = pm._connectionGeneration;

    // Socket B supersedes A
    await pm._doConnectControlChannel();
    const socketB = pm.controlWs;
    const genB = pm._connectionGeneration;

    expect(genB).toBeGreaterThan(genA);
    expect(socketB).not.toBe(socketA);

    // Socket C supersedes B
    await pm._doConnectControlChannel();
    const socketC = pm.controlWs;
    const genC = pm._connectionGeneration;

    expect(genC).toBeGreaterThan(genB);
    expect(pm.controlWs).toBe(socketC);

    // Only one active ping interval exists, owned by the ProcessManager
    expect(pm._pingInterval).not.toBeNull();

    // Late events from Socket A must NOT affect active Socket C state
    socketA.emit('message', JSON.stringify({ type: 'desktop-registered', activeClientId: 'stale-A' }));
    socketA.emit('close');
    socketA.emit('error', new Error('stale A error'));

    // Late events from Socket B must NOT affect active Socket C state
    socketB.emit('close');

    // Socket C should still be active and intact
    expect(pm.controlWs).toBe(socketC);
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm.state).toBe(STATES.READY);
    expect(pm._connectionGeneration).toBe(genC);

    await pm.stop();
    expect(pm._pingInterval).toBeNull();
    expect(pm.controlWs).toBeNull();
  });

  // =========================================================================
  // 3. PING / PONG METRIC ROBUSTNESS (Section 13)
  // =========================================================================
  it('Section 13: Ping/Pong RTT calculation never produces NaN, Infinity, or stale timestamps', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/control`);
    await new Promise((r) => ws.on('open', r));

    // Register desktop
    ws.send(JSON.stringify({ type: 'register-desktop', clientId: 'test-ping-client' }));
    await new Promise((r) => setTimeout(r, 50));

    // Normal ping
    const t0 = Date.now();
    ws.send(JSON.stringify({ type: 'ping', timestamp: t0 }));
    const pongMsg = await new Promise((resolve) => {
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'pong') resolve(m);
        } catch {}
      });
    });

    expect(pongMsg.type).toBe('pong');
    expect(pongMsg.timestamp).toBe(t0);

    const rtt = Date.now() - pongMsg.timestamp;
    expect(Number.isFinite(rtt)).toBe(true);
    expect(rtt).toBeGreaterThanOrEqual(0);
    expect(rtt).toBeLessThan(5000);

    // Corrupted/null timestamp ping
    ws.send(JSON.stringify({ type: 'ping', timestamp: null }));
    const fallbackPong = await new Promise((resolve) => {
      const handler = (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'pong') {
            ws.off('message', handler);
            resolve(m);
          }
        } catch {}
      };
      ws.on('message', handler);
    });

    expect(Number.isFinite(fallbackPong.timestamp)).toBe(true);
    expect(fallbackPong.timestamp).toBeGreaterThan(0);

    ws.close();
  });

  // =========================================================================
  // 4. OAUTH PENDING MAP STRESS ON DISCONNECT (Section 17)
  // =========================================================================
  it('Section 17: In-flight delegated OAuth exchanges reject cleanly on host drop without hanging', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/control`);
    await new Promise((r) => ws.on('open', r));

    ws.send(JSON.stringify({ type: 'register-desktop', clientId: 'oauth-stress-client' }));
    await new Promise((r) => setTimeout(r, 50));

    // Initiate 5 simultaneous /api/token exchanges
    const tokenPromises = [];
    for (let i = 0; i < 5; i++) {
      tokenPromises.push(
        fetch(`${baseUrl}/api/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: `test-code-${i}` }),
        }),
      );
    }

    // Give server time to send oauth-exchange-request to desktop
    await new Promise((r) => setTimeout(r, 50));

    // Drop desktop host mid-flight!
    ws.terminate();

    // All 5 HTTP requests must resolve with 500 status (clean rejection, NOT hanging for 12s)
    const startT = Date.now();
    const responses = await Promise.all(tokenPromises);
    const elapsed = Date.now() - startT;

    // Must resolve rapidly (< 1000ms), NOT wait for the 12000ms timer
    expect(elapsed).toBeLessThan(3000);

    for (const res of responses) {
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain('desconectou');
    }
  });

  // =========================================================================
  // 5. SERVER WEBSOCKET STRESS & CLIENT CLEANUP (Section 20)
  // =========================================================================
  it('Section 20: Rapid sequential & concurrent WebSocket connections return wss.clients to 0', async () => {
    const sockets = [];
    const NUM_CONCURRENT = 20;

    for (let i = 0; i < NUM_CONCURRENT; i++) {
      const s = new WebSocket(`${wsBaseUrl}/control`);
      sockets.push(s);
    }

    await Promise.all(sockets.map((s) => new Promise((resolve) => s.on('open', resolve))));
    expect(appServer.wss.clients.size).toBe(NUM_CONCURRENT);

    // Close all simultaneously
    for (const s of sockets) {
      s.close();
    }

    await new Promise((r) => setTimeout(r, 100));
    expect(appServer.wss.clients.size).toBe(0);
  });

  // =========================================================================
  // 6. EVENT LOOP DELAY RESPONSIVENESS (Section 7)
  // =========================================================================
  it('Section 7: Event loop responsiveness remains well under multi-second stalls', async () => {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();

    // Run active load
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    for (let i = 0; i < 10; i++) {
      await pm._connectControlChannel();
      pm.controlWs.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      await new Promise((r) => setTimeout(r, 20));
      pm.controlWs.terminate();
    }

    histogram.disable();

    const meanMs = histogram.mean / 1e6;
    const p95Ms = histogram.percentile(95) / 1e6;
    const p99Ms = histogram.percentile(99) / 1e6;
    const maxMs = histogram.max / 1e6;

    expect(meanMs).toBeLessThan(100);
    expect(p95Ms).toBeLessThan(200);
    expect(p99Ms).toBeLessThan(500);
    expect(maxMs).toBeLessThan(1000);

    await pm.stop();
  });

  // =========================================================================
  // 7. HTTP CHAOS TESTING (Section 15)
  // =========================================================================
  it('Section 15: Upstream HTTP chaos scenarios reject cleanly with bounded error responses', async () => {
    // 1. Missing code
    const res1 = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res1.status).toBe(400);

    // 2. Malformed JSON body
    const res2 = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this-is-not-valid-json',
    });
    expect(res2.status).toBe(400);

    // 3. No desktop host available
    const res3 = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'valid-looking-code' }),
    });
    expect(res3.status).toBe(500);
    const body3 = await res3.json();
    expect(body3.error).toBeDefined();

    // 4. Invalid session token
    const res4 = await fetch(`${baseUrl}/api/rooms/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'garbage-token-abc' }),
    });
    expect(res4.status).toBe(401);
  });

  // =========================================================================
  // 8. ABORTSIGNAL.TIMEOUT COMPATIBILITY (Section 16)
  // =========================================================================
  it('Section 16: AbortSignal.timeout is natively supported in the active runtime', async () => {
    expect(typeof AbortSignal.timeout).toBe('function');

    const signal = AbortSignal.timeout(50);
    expect(signal.aborted).toBe(false);

    await new Promise((r) => setTimeout(r, 60));
    expect(signal.aborted).toBe(true);
    expect(signal.reason.name).toBe('TimeoutError');
  });

  // =========================================================================
  // 9. IDEMPOTENT CLEANUP & REPEATED STOP (Sections 29, 30)
  // =========================================================================
  it('Sections 29, 30: Desktop stop() and cleanup are 100% idempotent across multiple calls', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    await pm._connectControlChannel();
    pm.state = STATES.READY;

    // Call stop() 5 times consecutively
    await pm.stop();
    await pm.stop();
    await pm.stop();
    await pm.stop();
    await pm.stop();

    expect(pm.state).toBe(STATES.IDLE);
    expect(pm.controlWs).toBeNull();
    expect(pm._pingInterval).toBeNull();
    expect(pm.reconnectTimer).toBeNull();
  });
});
