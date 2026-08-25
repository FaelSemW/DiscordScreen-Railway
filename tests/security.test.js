import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '../server/tokens.js';

describe('Security & Token Isolation for Multi-Tenant Hosting', () => {
  it('signs and verifies valid tokens', () => {
    process.env.SESSION_SECRET = 'super-secret-key-32-chars-long-railway!';
    const payload = { room: 'room-101', uid: 'user-abc', role: 'viewer' };
    const token = signToken(payload, 3600);

    const verified = verifyToken(token);
    expect(verified).not.toBeNull();
    expect(verified.room).toBe('room-101');
    expect(verified.uid).toBe('user-abc');
    expect(verified.role).toBe('viewer');
  });

  it('rejects tampered or forged tokens', () => {
    process.env.SESSION_SECRET = 'super-secret-key-32-chars-long-railway!';
    const token = signToken({ room: 'room-101', role: 'viewer' });
    const [body, sig] = token.split('.');

    // Tamper with payload body to impersonate room-999
    const tamperedBody = Buffer.from(JSON.stringify({ room: 'room-999', role: 'viewer' })).toString('base64url');
    const tamperedToken = `${tamperedBody}.${sig}`;

    const verified = verifyToken(tamperedToken);
    expect(verified).toBeNull();
  });

  it('rejects expired tokens', () => {
    process.env.SESSION_SECRET = 'super-secret-key-32-chars-long-railway!';
    // Expired 10 seconds ago
    const token = signToken({ room: 'room-101' }, -10);
    const verified = verifyToken(token);
    expect(verified).toBeNull();
  });

  it('ensures token payload never contains client secrets', () => {
    process.env.SESSION_SECRET = 'super-secret-key-32-chars-long-railway!';
    const token = signToken({ room: 'room-101', uid: 'u1' });
    const [body] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
    expect(decoded.clientSecret).toBeUndefined();
    expect(decoded.secret).toBeUndefined();
  });
});
