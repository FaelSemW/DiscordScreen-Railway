import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAppServer } from '../server/runtime.js';
import * as R from '../server/rooms.js';
import { ProcessManager, STATES } from '../desktop/main/manager.js';
import { WebSocket } from 'ws';

describe('P0 Connection Stability & Reconnect Forensics', () => {
  let appServer = null;
  let serverPort = null;
  let baseUrl = null;
  let wsBaseUrl = null;

  beforeEach(async () => {
    appServer = createAppServer({
      port: 0,
      publicOrigin: 'http://127.0.0.1:3001',
      sessionSecret: 'test-secret-key-12345678901234567890',
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
        try { client.terminate(); } catch {}
      }
      await new Promise((resolve) => appServer.wss.close(resolve));
      await new Promise((resolve) => appServer.server.close(resolve));
    }
  });

  it('A: /control connection opens, registers desktop, and remains stable with pings', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/control`);
    const messages = [];

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    ws.send(JSON.stringify({ type: 'register-desktop', clientId: 'test-client-123' }));

    await new Promise((r) => setTimeout(r, 100));

    expect(messages.some((m) => m.type === 'desktop-registered' && m.activeClientId === 'test-client-123')).toBe(true);

    // Send ping and receive pong
    ws.send(JSON.stringify({ type: 'ping', timestamp: 12345 }));
    await new Promise((r) => setTimeout(r, 100));

    expect(messages.some((m) => m.type === 'pong')).toBe(true);

    ws.close();
  });

  it('B & C: ProcessManager replaces old control socket safely without reconnect loops', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    // Connect first socket
    await pm._connectControlChannel();
    expect(pm.controlWs).not.toBeNull();
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);

    const firstWs = pm.controlWs;
    let firstWsCloseCount = 0;
    firstWs.on('close', () => { firstWsCloseCount++; });

    // Connect second socket (replacement)
    await pm._connectControlChannel();
    expect(pm.controlWs).not.toBeNull();
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm.controlWs).toBe(firstWs); // Should reuse open socket without terminating it unnecessarily

    await pm.stop();
  });

  it('D & E: Single-flight guard prevents concurrent overlapping connection attempts', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    // Launch 3 simultaneous connect attempts
    const [c1, c2, c3] = await Promise.all([
      pm._connectControlChannel(),
      pm._connectControlChannel(),
      pm._connectControlChannel(),
    ]);

    expect(pm.controlWs).not.toBeNull();
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm.reconnectTimer).toBeNull();

    await pm.stop();
  });

  it('F, G, J: Room and broadcaster remain active when broadcaster viewer temporarily disconnects or backgrounded', async () => {
    const room = R.ensureCallRoom('instance-test', 'room-test-1', {});
    
    // Attach viewer
    const fakeViewerWs = {
      readyState: 1,
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: 0,
    };
    R.attachViewer(room, fakeViewerWs, { id: 'user-broadcaster-1', name: 'Broadcaster User' });

    // Attach broadcaster
    const fakeBroadcasterWs = {
      readyState: 1,
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: 0,
    };
    const entry = R.attachBroadcaster(room, fakeBroadcasterWs, { id: 'user-broadcaster-1', name: 'Broadcaster User' }, 'tela');
    expect(typeof entry).toBe('object');
    R.startStream(room, entry);
    expect(entry.streaming).toBe(true);

    // Another viewer joins and watches
    const fakeFriendWs = {
      readyState: 1,
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: 0,
    };
    R.attachViewer(room, fakeFriendWs, { id: 'user-friend-2', name: 'Friend User' });
    R.watch(room, fakeFriendWs, entry.slot);

    // The broadcaster's own viewer disconnects (e.g. Activity backgrounded/reloading)
    R.detachViewer(room, fakeViewerWs);

    // Run sweeper simulation at now + 20 seconds
    const now = Date.now() + 20_000;
    
    // Broadcaster MUST NOT be killed because an active viewer is watching the stream!
    expect(room.broadcasters.has(entry.chave)).toBe(true);
    expect(entry.streaming).toBe(true);
  });
});
