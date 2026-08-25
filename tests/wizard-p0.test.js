import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigManager } from '../desktop/main/config.js';
import { validateClientId, validateClientSecret } from '../desktop/main/discord.js';

describe('P0 First-Run Wizard Validation & Save Flow', () => {
  let tempConfigPath;

  beforeEach(() => {
    tempConfigPath = path.join(
      os.tmpdir(),
      `wizard-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
    } catch {
      // Ignore
    }
  });

  it('Scenario 1: Valid Client ID + Secret validates and saves successfully', () => {
    const manager = new ConfigManager(tempConfigPath);
    const clientId = '123456789012345678';
    const clientSecret = 'my-secret-discord-key-1234567890';

    expect(validateClientId(clientId)).toBeNull();
    expect(validateClientSecret(clientSecret)).toBeNull();

    manager.setClientId(clientId);
    manager.setClientSecret(clientSecret);
    const saved = manager.save();

    expect(saved).toBe(true);
    expect(manager.getClientId()).toBe(clientId);
    expect(manager.getClientSecret()).toBe(clientSecret);
    expect(manager.isConfigured()).toBe(true);
  });

  it('Scenario 2: Missing Client ID returns visible validation error', () => {
    expect(validateClientId('')).toMatch(/Client ID é obrigatório/);
    expect(validateClientId('   ')).toMatch(/Client ID é obrigatório/);
    expect(validateClientId(null)).toMatch(/Client ID é obrigatório/);
    expect(validateClientId('123abc456')).toMatch(/apenas números/);
  });

  it('Scenario 3: Missing Client Secret returns visible validation error', () => {
    expect(validateClientSecret('')).toMatch(/Client Secret é obrigatório/);
    expect(validateClientSecret('   ')).toMatch(/Client Secret é obrigatório/);
    expect(validateClientSecret(null)).toMatch(/Client Secret é obrigatório/);
    expect(validateClientSecret('short')).toMatch(/muito curto/);
  });

  it('Scenario 4: Fallback encryption operates safely if safeStorage is unavailable', () => {
    const manager = new ConfigManager(tempConfigPath);
    const secret = 'custom-secret-fallback-test-99999';

    // Test fallback AES-256-GCM encryption
    manager.setClientSecret(secret);
    manager.save();

    const readSecret = manager.getClientSecret();
    expect(readSecret).toBe(secret);
  });

  it('Scenario 5: Config write failures handle gracefully without crashing', () => {
    const invalidPath = path.join(os.tmpdir(), 'non-existent-dir-999', 'sub', 'test.json');
    const manager = new ConfigManager(invalidPath);
    // Overwrite with impossible read-only root or broken file
    manager.configFile = '/invalid_path_root/test.json';
    const saved = manager.save();
    expect(saved).toBe(false);
  });

  it('Scenario 8 & 9: Reset configuration allows configuring again and advancing', () => {
    const manager = new ConfigManager(tempConfigPath);
    manager.setClientId('111111111111111111');
    manager.setClientSecret('first-secret-key-1234567890');
    manager.setConfirmedPublicOrigin('https://zaprecovery.online');
    manager.save();

    expect(manager.isConfigured()).toBe(true);
    expect(manager.isDiscordConfigConfirmedFor('https://zaprecovery.online')).toBe(true);

    // User clicks Reset Configuration
    manager.reset(false);
    expect(manager.getClientId()).toBe('');
    expect(manager.getClientSecret()).toBe('');
    expect(manager.isConfigured()).toBe(false);
    expect(manager.config.confirmedPublicOrigin).toBe('');

    // Reconfigure
    manager.setClientId('222222222222222222');
    manager.setClientSecret('second-secret-key-1234567890');
    manager.save();

    expect(manager.getClientId()).toBe('222222222222222222');
    expect(manager.getClientSecret()).toBe('second-secret-key-1234567890');
    expect(manager.isConfigured()).toBe(true);
  });
});
