import { describe, it, expect } from 'vitest';
import { logger } from '../desktop/main/logger.js';
import { diagnosticsManager } from '../desktop/main/diagnostics.js';
import { configManager } from '../desktop/main/config.js';

describe('Zero Client Secret Leakage Assurance', () => {
  it('masks registered client secrets from all logs', () => {
    const rawSecret = 'ultra-sensitive-discord-secret-token-999';
    logger.registerSecret(rawSecret);

    logger.info(`Starting with secret=${rawSecret} in query`);
    const recentLogs = logger.getRecentLogs();
    const lastLog = recentLogs[recentLogs.length - 1];

    expect(lastLog.includes(rawSecret)).toBe(false);
    expect(lastLog.includes('[SECRET_REDACTED]')).toBe(true);
  });

  it('ensures diagnostics report never exposes client secret', async () => {
    configManager.setClientId('123456789012345678');
    configManager.setClientSecret('very-secret-discord-key-123456789');

    const report = await diagnosticsManager.generateReport('ready', 'https://zaprecovery.online');

    const serialized = JSON.stringify(report);
    expect(serialized.includes('very-secret-discord-key-123456789')).toBe(false);
    expect(report.discordConfiguration.clientSecretPresent).toBe(true);
    expect(report.discordConfiguration.clientSecretStoredInRailway).toBe(false);
  });
});
