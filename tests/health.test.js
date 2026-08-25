import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAppServer } from '../server/runtime.js';

describe('Railway Server Health and Config API', () => {
  let instance;
  let baseUrl;

  beforeAll(async () => {
    instance = createAppServer({
      port: 0,
      sessionSecret: 'test-railway-secret-1234567890abcdef',
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

  it('GET /api/health returns 200 { ok: true }', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });
  });

  it('GET /api/ice returns STUN servers', async () => {
    const res = await fetch(`${baseUrl}/api/ice`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.iceServers).toBeDefined();
    expect(Array.isArray(data.iceServers)).toBe(true);
    expect(data.iceServers.length).toBeGreaterThan(0);
  });
});
