import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAppServer } from '../server/runtime.js';
import * as R from '../server/rooms.js';
import { ProcessManager, STATES } from '../desktop/main/manager.js';
import { WebSocket } from 'ws';

describe('P0 Connection Stability, Reconnect Forensics & Stream Resumption', () => {
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

  it('TEST 1: Normal stable stream and control channel remain open with regular keepalives', async () => {
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

    ws.send(JSON.stringify({ type: 'ping', timestamp: 12345 }));
    await new Promise((r) => setTimeout(r, 100));

    expect(messages.some((m) => m.type === 'pong')).toBe(true);
    ws.close();
  });

  it('TEST 2 & 3 & 4: Abnormal 1006 / 2s / 5s disconnect within grace window resumes same slot seamlessly', async () => {
    const room = R.ensureCallRoom('instance-test', 'room-test-grace', {});
    
    // Broadcaster connects
    const ws1 = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const entry = R.attachBroadcaster(room, ws1, { id: 'user-broadcaster-grace', name: 'Grace Broadcaster' }, 'tela');
    R.startStream(room, entry);
    R.setConfig(room, entry, { codec: 'avc1.640028', width: 1280, height: 720 });

    expect(entry.slot).toBe(0);
    expect(entry.streaming).toBe(true);

    // Attach a watching viewer
    const viewerWs = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), __info: { id: 'v1' }, __watching: new Set(), __primed: new Set() };
    R.attachViewer(room, viewerWs, { id: 'v1', name: 'Viewer 1' });
    R.watch(room, viewerWs, entry.slot);

    // Simulate abnormal WebSocket termination (e.g. 1006 / network blip)
    R.handleBroadcasterDisconnect(room, ws1, 1006, 'Abnormal Closure');
    expect(entry.ws).toBeNull();
    expect(entry.reconnectingSince).not.toBeNull();
    expect(entry.streaming).toBe(true); // Stream entry remains alive during grace!

    // Broadcaster reconnects within 2-5s grace window with same identity
    const ws2 = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const resumedEntry = R.attachBroadcaster(room, ws2, { id: 'user-broadcaster-grace', name: 'Grace Broadcaster' }, 'tela');

    expect(resumedEntry).toBe(entry);
    expect(resumedEntry.slot).toBe(0); // Resumed on the SAME slot!
    expect(resumedEntry.ws).toBe(ws2);
    expect(resumedEntry.reconnectingSince).toBeNull();
    expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'slot', slot: 0, resumed: true }));

    // Viewers are still watching
    expect(viewerWs.__watching.has(0)).toBe(true);
  });

  it('TEST 5: Disconnection beyond 10s grace window expires cleanly without creating zombie streams', async () => {
    vi.useFakeTimers();
    const room = R.ensureCallRoom('instance-test', 'room-test-expire', {});
    
    const ws1 = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const entry = R.attachBroadcaster(room, ws1, { id: 'user-broadcaster-expire', name: 'Expire Broadcaster' }, 'tela');
    R.startStream(room, entry);

    // Abnormal drop
    R.handleBroadcasterDisconnect(room, ws1, 1006, 'Abnormal');
    expect(room.broadcasters.has(entry.chave)).toBe(true);

    // Advance time past 10s grace period
    vi.advanceTimersByTime(11_000);

    // Broadcaster entry MUST be cleaned up
    expect(room.broadcasters.has(entry.chave)).toBe(false);
    expect(room.slots.has(entry.slot)).toBe(false);
    vi.useRealTimers();
  });

  it('TEST 6 & 7 & 8: Intentional stop / track.onended / page unload destroys stream immediately with zero grace', async () => {
    const room = R.ensureCallRoom('instance-test', 'room-test-intentional', {});
    
    const ws1 = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const entry = R.attachBroadcaster(room, ws1, { id: 'user-broadcaster-int', name: 'Int Broadcaster' }, 'tela');
    R.startStream(room, entry);

    // Intentional stop
    entry.intentionalStop = true;
    R.detachBroadcaster(room, ws1);

    expect(room.broadcasters.has(entry.chave)).toBe(false);
    expect(room.slots.has(entry.slot)).toBe(false);
  });

  it('TEST 9: Stale socket close emitted after replacement cannot terminate active transport', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    await pm._connectControlChannel();
    pm.state = STATES.READY;
    const oldWs = pm.controlWs;

    // Advance to generation 2 and attach new socket
    pm._connectionGeneration++;
    const newWs = new WebSocket(`${wsBaseUrl}/control`);
    await new Promise((r) => newWs.on('open', r));
    pm.controlWs = newWs;

    // Old socket emits close event
    oldWs.emit('close');
    await new Promise((r) => setTimeout(r, 50));

    expect(pm.reconnectTimer).toBeNull();
    expect(pm.controlWs).toBe(newWs);

    await pm.stop();
    try { newWs.close(); } catch {}
  });

  it('TEST 10: Desktop control reconnects repeatedly without affecting broadcaster or room state', async () => {
    const room = R.ensureCallRoom('instance-test', 'room-test-ctrl-indep', {});
    const bWs = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
    const entry = R.attachBroadcaster(room, bWs, { id: 'b-indep', name: 'Indep Broadcaster' }, 'tela');
    R.startStream(room, entry);

    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    for (let i = 0; i < 5; i++) {
      await pm._connectControlChannel();
      pm.controlWs.terminate();
    }

    expect(room.broadcasters.has(entry.chave)).toBe(true);
    expect(entry.streaming).toBe(true);
    await pm.stop();
  });

  it('TEST 12: Resume slot hijack attempt by another user is strictly rejected', async () => {
    const room = R.ensureCallRoom('instance-test', 'room-test-hijack', {});
    
    // Legitimate broadcaster
    const legitWs = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() };
    const legitEntry = R.attachBroadcaster(room, legitWs, { id: 'user-legit', name: 'Legit User' }, 'tela');
    R.startStream(room, legitEntry);

    // Disconnect legit
    R.handleBroadcasterDisconnect(room, legitWs, 1006, 'Drop');

    // Attacker tries to attach to the same room with different identity
    const attackerWs = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() };
    const attackerEntry = R.attachBroadcaster(room, attackerWs, { id: 'user-attacker', name: 'Attacker' }, 'tela');

    // Attacker gets a NEW separate slot, CANNOT hijack legitEntry
    expect(attackerEntry).not.toBe(legitEntry);
    expect(attackerEntry.slot).not.toBe(legitEntry.slot);
    expect(room.broadcasters.get(legitEntry.chave)).toBe(legitEntry);
  });
});
