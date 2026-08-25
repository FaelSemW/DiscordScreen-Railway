import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createAppServer } from '../server/runtime.js';
import { signToken } from '../server/tokens.js';

describe('Desktop Delegated OAuth Bridge', () => {
  let instance;
  let baseUrl;
  let wsUrl;
  const sessionSecret = 'test-session-secret-oauth-bridge-12345';

  beforeAll(async () => {
    process.env.SESSION_SECRET = sessionSecret;
    // Server has NO discordClientSecret configured (Railway production private model)
    instance = createAppServer({
      port: 0,
      sessionSecret,
      discordClientId: null,
      discordClientSecret: null,
      nodeEnv: 'test',
    });

    await new Promise((resolve) => instance.server.listen(0, resolve));
    const port = instance.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (instance?.server?.listening) {
      await new Promise((resolve) => instance.server.close(resolve));
    }
  });

  it('returns 500 if no desktop host is connected during token exchange', async () => {
    const res = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'sample-oauth-code-123' }),
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('aplicativo Desktop');
  });

  it('delegates OAuth token exchange to connected desktop host', async () => {
    const desktopToken = signToken({ role: 'desktop-host' });
    const ws = new WebSocket(`${wsUrl}/control?t=${encodeURIComponent(desktopToken)}`);

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // 1. Desktop registers its Client ID
    ws.send(JSON.stringify({ type: 'register-desktop', clientId: '998877665544332211' }));

    // Listen for OAuth exchange request from server and respond
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'oauth-exchange-request') {
        expect(msg.code).toBe('valid-discord-auth-code');
        expect(msg.clientId).toBe('998877665544332211');

        // Simulate desktop calling Discord with its local secret and returning access_token
        ws.send(
          JSON.stringify({
            type: 'oauth-exchange-response',
            reqId: msg.reqId,
            access_token: 'mock-discord-access-token-xyz',
          }),
        );
      }
    });

    // Verify /api/config now reflects the registered desktop client ID
    const configRes = await fetch(`${baseUrl}/api/config`);
    const configData = await configRes.json();
    expect(configData.clientId).toBe('998877665544332211');

    // 2. Activity calls /api/token
    const tokenRes = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'valid-discord-auth-code' }),
    });

    expect(tokenRes.status).toBe(200);
    const tokenData = await tokenRes.json();
    expect(tokenData.access_token).toBe('mock-discord-access-token-xyz');

    ws.close();
  });
});
