import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppServer } from '../server/runtime.js';
import * as R from '../server/rooms.js';
import { WebSocket } from 'ws';
import { signToken } from '../server/tokens.js';

describe('Long-Run Stream & WebSocket Lifetime Stability Tests', () => {
  let appServer;
  let serverPort;

  beforeEach(async () => {
    appServer = createAppServer({
      port: 0,
      sessionSecret: 'test-session-secret-long-run-1234567890',
      nodeEnv: 'development',
    });

    await new Promise((resolve) => {
      appServer.server.listen(0, () => {
        serverPort = appServer.server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    clearInterval(appServer?.heartbeat);
    for (const ws of appServer?.wss?.clients ?? []) {
      try {
        ws.terminate();
      } catch {}
    }
    if (appServer?.server?.listening) {
      await new Promise((resolve) => appServer.server.close(resolve));
    }
  });

  it('Scenario: /control channel responds to ping/pong and stays alive across multiple heartbeat ticks', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/control`);

    await new Promise((resolve) => ws.on('open', resolve));

    ws.send(JSON.stringify({ type: 'register-desktop', clientId: '123456789012345678' }));

    const registered = await new Promise((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'desktop-registered') resolve(msg);
      });
    });

    expect(registered.ok).toBe(true);

    // Simulate 3 server heartbeat cycles
    for (let i = 0; i < 3; i++) {
      for (const client of appServer.wss.clients) {
        client.ping();
      }
      await new Promise((r) => setTimeout(r, 50));
      // Verify client remains open and connected
      expect(ws.readyState).toBe(WebSocket.OPEN);
    }

    ws.close();
  });

  it('Scenario: Active broadcaster sending binary chunks keeps room and socket alive without idle cleanup', async () => {
    const { room } = R.createRoom({
      instance: 'test-inst',
      name: 'Stability Room',
      ownerId: 'guest-desktop-1',
      ownerName: 'Guest Host',
    });

    const token = signToken({ room: room.id, uid: 'guest-desktop-1', name: 'Guest Host', role: 'broadcaster' });
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?t=${encodeURIComponent(token)}&fonte=tela`);
    ws.binaryType = 'arraybuffer';

    await new Promise((resolve) => ws.on('open', resolve));

    // Start stream
    ws.send(JSON.stringify({ type: 'start' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(room.broadcasters.size).toBe(1);

    // Send binary media chunks
    for (let i = 0; i < 5; i++) {
      const chunk = Buffer.from([0, 1, 0x12, 0x34]); // Slot 0, Keyframe
      ws.send(chunk);
      await new Promise((r) => setTimeout(r, 30));
    }

    // Room must be active and not empty
    expect(room.broadcasters.size).toBe(1);
    expect(room.emptySince).toBeNull();

    ws.close();
  });

  it('Scenario: Broadcaster reconnects to existing slot seamlessly after socket disconnect', async () => {
    const { room } = R.createRoom({
      instance: 'test-inst-2',
      name: 'Reconnect Room',
      ownerId: 'guest-host-2',
      ownerName: 'Guest Host',
    });

    const token = signToken({ room: room.id, uid: 'guest-host-2', name: 'Guest Host', role: 'broadcaster' });
    
    // First connection
    const ws1 = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?t=${encodeURIComponent(token)}&fonte=tela`);
    await new Promise((resolve) => ws1.on('open', resolve));
    ws1.send(JSON.stringify({ type: 'start' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(room.slots.has(0)).toBe(true);

    // Abrupt socket close
    ws1.terminate();
    await new Promise((r) => setTimeout(r, 50));

    // Second connection (reconnect) with same credentials
    const ws2 = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?t=${encodeURIComponent(token)}&fonte=tela`);
    
    const slotPromise = new Promise((resolve) => {
      ws2.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'slot') resolve(msg);
        } catch {}
      });
    });

    await new Promise((resolve) => ws2.on('open', resolve));
    const slotMsg = await slotPromise;

    // Reconnected successfully to the same slot
    expect(slotMsg.slot).toBe(0);
    expect(room.broadcasters.size).toBe(1);

    ws2.close();
  });

  it('Scenario: Application-level ping/pong keeps connection alive', async () => {
    const { room } = R.createRoom({
      instance: 'test-inst-3',
      name: 'Ping Room',
      ownerId: 'user-ping',
      ownerName: 'Ping User',
    });

    const token = signToken({ room: room.id, uid: 'user-ping', name: 'Ping User', role: 'broadcaster' });
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?t=${encodeURIComponent(token)}&fonte=tela`);

    await new Promise((resolve) => ws.on('open', resolve));

    // Send application ping
    ws.send(JSON.stringify({ type: 'ping', timestamp: 123456 }));

    const pong = await new Promise((resolve) => {
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'pong') resolve(msg);
        } catch {}
      });
    });

    expect(pong.type).toBe('pong');
    expect(pong.timestamp).toBe(123456);

    ws.close();
  });
});
