import os from 'node:os';
import { logger } from './logger.js';
import { configManager } from './config.js';

export class DiagnosticsManager {
  async generateReport(currentState, publicUrl, stateData = {}) {
    const timestamp = new Date().toISOString();
    const config = configManager.getPublicConfig();

    let railwayHealthy = false;
    let railwayPingMs = null;

    try {
      const start = Date.now();
      const res = await fetch('https://zaprecovery.online/api/health', {
        signal: AbortSignal.timeout(4000),
      });
      railwayPingMs = Date.now() - start;
      railwayHealthy = res.ok;
    } catch {
      railwayHealthy = false;
    }

    const report = {
      timestamp,
      application: {
        name: 'Discord Screen Railway',
        version: config.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
        freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
      },
      infrastructure: {
        target: 'https://zaprecovery.online',
        websocket: 'wss://zaprecovery.online/ws',
        healthy: railwayHealthy,
        latencyMs: railwayPingMs,
      },
      discordConfiguration: {
        configured: config.isConfigured,
        clientIdPresent: Boolean(config.discordClientId),
        clientIdMasked: config.discordClientId
          ? `${config.discordClientId.slice(0, 4)}••••${config.discordClientId.slice(-4)}`
          : 'AUSENTE',
        clientSecretPresent: config.hasClientSecret,
        clientSecretStoredInRailway: false,
        portalConfirmed: Boolean(config.confirmedPublicOrigin),
      },
      runtimeState: {
        state: currentState,
        serverRunning: stateData.serverRunning ?? false,
        controlConnected: stateData.publicEndpointReady ?? false,
      },
      recentLogs: logger.getRecentLogs().slice(-30),
    };

    return report;
  }
}

export const diagnosticsManager = new DiagnosticsManager();
