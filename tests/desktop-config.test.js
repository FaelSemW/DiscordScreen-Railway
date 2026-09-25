import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigManager } from '../desktop/main/config.js';

describe('Desktop Config Manager Isolation & Encryption', () => {
  let tempConfigPath;

  beforeEach(() => {
    tempConfigPath = path.join(os.tmpdir(), `test-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
    } catch {
      // Ignore
    }
  });

  it('uses isolated config location and default local origin', () => {
    const manager = new ConfigManager(tempConfigPath);
    expect(manager.getPublicOrigin()).toBe('http://127.0.0.1:3000');
    expect(manager.config.publicOrigin).toBe('');
  });

  it('encrypts and decrypts client secret locally without storing plaintext', () => {
    const manager = new ConfigManager(tempConfigPath);
    const secret = 'super-secret-discord-key-1234567890';
    manager.setClientSecret(secret);
    manager.save();

    // Verify raw file on disk does NOT contain the plaintext secret
    const rawOnDisk = fs.readFileSync(tempConfigPath, 'utf8');
    expect(rawOnDisk.includes(secret)).toBe(false);

    // Verify decrypted getter returns the correct secret
    expect(manager.getClientSecret()).toBe(secret);
  });

  it('validates client ID and Secret', () => {
    const manager = new ConfigManager(tempConfigPath);
    manager.setClientId('123456789012345678');
    manager.setClientSecret('valid-length-client-secret-12345678');

    const validation = manager.validateDiscordConfiguration();
    expect(validation.valid).toBe(true);
  });

  it('invalidates confirmed origin when client ID changes', () => {
    const manager = new ConfigManager(tempConfigPath);
    manager.setClientId('111111111111111111');
    manager.setConfirmedPublicOrigin('https://zaprecovery.online');
    expect(manager.isDiscordConfigConfirmedFor('https://zaprecovery.online')).toBe(true);

    // Change client ID
    manager.setClientId('222222222222222222');
    expect(manager.isDiscordConfigConfirmedFor('https://zaprecovery.online')).toBe(false);
  });
});
