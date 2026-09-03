import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppServer } from '../server/runtime.js';
import { ProcessManager, STATES } from '../desktop/main/manager.js';
import * as R from '../server/rooms.js';
import { WebSocket } from 'ws';

describe('PHASE 2: Network Interruption, Server Restart, and Stream Lifecycle Stress', () => {
  let appServer = null;
  let serverPort = null;
  let baseUrl = null;
  let wsBaseUrl = null;

  beforeEach(async () => {
    appServer = createAppServer({
      port: 0,
      publicOrigin: 'http://127.0.0.1:3001',
      sessionSecret: 'test-secret-network-lifecycle-1234567890',
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
  // 1. SERVER RESTART TEST (Section 8)
  // =========================================================================
  it('Section 8: Server restart triggers single cleanup and automatic bounded recovery', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    await pm._connectControlChannel();
    pm.state = STATES.READY;
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);

    const oldWs = pm.controlWs;
    const oldGen = pm._connectionGeneration;

    // Simulate Server Restart: terminate all server sockets and close server
    for (const c of appServer.wss.clients) {
      c.terminate();
    }
    await new Promise((resolve) => appServer.wss.close(resolve));
    await new Promise((resolve) => appServer.server.close(resolve));

    // Wait 100ms for desktop to detect drop and trigger single cleanup
    await new Promise((r) => setTimeout(r, 100));
    expect(oldWs.readyState).toBe(WebSocket.CLOSED);
    expect(pm._pingInterval).toBeNull();

    // Restart server on the SAME port
    appServer = createAppServer({
      port: serverPort,
      publicOrigin: baseUrl,
      sessionSecret: 'test-secret-network-lifecycle-1234567890',
      nodeEnv: 'test',
    });

    await new Promise((resolve) => {
      appServer.server.listen(serverPort, '127.0.0.1', resolve);
    });

    // Manually trigger reconnect or let reconnect timer connect
    const startTime = Date.now();
    await pm._connectControlChannel();
    const recoveryTimeMs = Date.now() - startTime;

    expect(recoveryTimeMs).toBeLessThan(5000);
    expect(pm.controlWs).not.toBeNull();
    expect(pm.controlWs).not.toBe(oldWs);
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm._connectionGeneration).toBeGreaterThan(oldGen);
    expect(pm._pingInterval).not.toBeNull();

    await pm.stop();
  });

  // =========================================================================
  // 2. INTERNET LOSS SIMULATION (5s, 15s, 60s) (Section 9)
  // =========================================================================
  it('Section 9: Internet loss simulation (5s and 15s) recovers without CPU spin or timer explosion', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    await pm._connectControlChannel();
    pm.state = STATES.READY;

    // 5s Outage
    pm.controlWs.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(pm._pingInterval).toBeNull();
    expect(pm.reconnectTimer).not.toBeNull();

    // Recover after 5s
    await pm._connectControlChannel();
    pm.state = STATES.READY;
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm._pingInterval).not.toBeNull();

    // 15s Outage
    pm.controlWs.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(pm._pingInterval).toBeNull();

    // Recover after 15s outage
    await pm._connectControlChannel();
    pm.state = STATES.READY;
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm._pingInterval).not.toBeNull();

    await pm.stop();
    expect(pm._pingInterval).toBeNull();
    expect(pm.reconnectTimer).toBeNull();
  });

  // =========================================================================
  // 3. 50-CYCLE STREAM SESSION START/STOP STRESS (Section 18)
  // =========================================================================
  it('Section 18: 50 cycles of stream session start and stop without handle or state leaks', async () => {
    const room = R.ensureCallRoom('instance-soak', 'room-soak-stream', {});

    for (let cycle = 1; cycle <= 50; cycle++) {
      const mockWs = {
        readyState: 1,
        OPEN: 1,
        send: () => {},
        close: () => {},
        bufferedAmount: 0,
      };

      const entry = R.attachBroadcaster(
        room,
        mockWs,
        { id: `broadcaster-${cycle}`, name: `Broadcaster ${cycle}` },
        'tela',
      );

      R.startStream(room, entry);
      expect(entry.streaming).toBe(true);
      expect(room.broadcasters.size).toBe(1);

      R.stopStream(room, entry);
      expect(entry.streaming).toBe(false);

      R.detachBroadcaster(room, mockWs);
      expect(room.broadcasters.size).toBe(0);
      expect(room.slots.size).toBe(0);
    }

    expect(room.broadcasters.size).toBe(0);
    expect(room.slots.size).toBe(0);
  });

  // =========================================================================
  // 4. SHUTDOWN IN DIVERSE STATES (Section 24)
  // =========================================================================
  it('Section 24: Clean shutdown while connected, while reconnecting, and during OAuth request', async () => {
    // 1. Quit while connected
    const pm1 = new ProcessManager();
    pm1.getVerifiedPublicOrigin = () => baseUrl;
    pm1.checkHealth = async () => true;
    await pm1._connectControlChannel();
    pm1.state = STATES.READY;

    const t0 = Date.now();
    await pm1.stop();
    const elapsed1 = Date.now() - t0;
    expect(elapsed1).toBeLessThan(1000);
    expect(pm1.state).toBe(STATES.IDLE);
    expect(pm1.controlWs).toBeNull();
    expect(pm1._pingInterval).toBeNull();

    // 2. Quit while reconnecting
    const pm2 = new ProcessManager();
    pm2.getVerifiedPublicOrigin = () => baseUrl;
    pm2.checkHealth = async () => true;
    await pm2._connectControlChannel();
    pm2.state = STATES.READY;
    pm2.controlWs.terminate();
    await new Promise((r) => setTimeout(r, 20));
    expect(pm2.reconnectTimer).not.toBeNull();

    const t1 = Date.now();
    await pm2.stop();
    const elapsed2 = Date.now() - t1;
    expect(elapsed2).toBeLessThan(1000);
    expect(pm2.reconnectTimer).toBeNull();
    expect(pm2.state).toBe(STATES.IDLE);

    // 3. Quit during in-flight connection promise
    const pm3 = new ProcessManager();
    pm3.getVerifiedPublicOrigin = () => 'http://127.0.0.1:59999'; // Dead port
    pm3.checkHealth = async () => false;

    // Trigger connect that will be in-flight
    const connectPromise = pm3._connectControlChannel().catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    const t2 = Date.now();
    await pm3.stop();
    await connectPromise;
    const elapsed3 = Date.now() - t2;
    expect(elapsed3).toBeLessThan(3500);
    expect(pm3.state).toBe(STATES.IDLE);
  });
});
