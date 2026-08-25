import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAppServer } from '../server/runtime.js';
import { signToken } from '../server/tokens.js';

describe('Multi-Tenant Room Isolation', () => {
  let instance;
  let baseUrl;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'isolation-test-key-32-chars-long-railway!';
    instance = createAppServer({
      port: 0,
      sessionSecret: 'isolation-test-key-32-chars-long-railway!',
      nodeEnv: 'test',
    });

    await new Promise((resolve) => instance.server.listen(0, resolve));
    const port = instance.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (instance?.server?.listening) {
      await new Promise((resolve) => instance.server.close(resolve));
    }
  });

  it('isolates rooms across different instances', async () => {
    // User 1 in Instance A creates Room A
    const identityA = signToken({ instance: 'guild-123', uid: 'user-1', name: 'Alice', scope: 'identity' }, 3600);
    const resA = await fetch(`${baseUrl}/api/rooms/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: identityA, name: 'Alice Secret Room' }),
    });
    expect(resA.status).toBe(200);
    const dataA = await resA.json();
    expect(dataA.roomId).toBeDefined();

    // User 2 in Instance B queries rooms list
    const identityB = signToken({ instance: 'guild-456', uid: 'user-2', name: 'Bob', scope: 'identity' }, 3600);
    const listResB = await fetch(`${baseUrl}/api/rooms/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: identityB }),
    });
    expect(listResB.status).toBe(200);
    const listDataB = await listResB.json();

    // User 2 in Guild B must NOT see Room A from Guild A
    const foundRoomA = listDataB.rooms.find((r) => r.id === dataA.roomId);
    expect(foundRoomA).toBeUndefined();

    // User 2 tries to join Room A directly
    const joinRes = await fetch(`${baseUrl}/api/rooms/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: identityB, roomId: dataA.roomId }),
    });
    // Should be rejected (404 / not found in that instance)
    expect(joinRes.status).toBe(404);
  });
});
