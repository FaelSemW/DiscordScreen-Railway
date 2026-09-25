import os from 'node:os';
import { logger } from './logger.js';
import { configManager } from './config.js';
import { BUILD_METADATA } from '../../shared/build-metadata.js';

export class DiagnosticsManager {
  async generateReport(currentState, publicUrl, stateData = {}) {
    const timestamp = new Date().toISOString();
    const config = configManager.getPublicConfig();

    const targetOrigin = (publicUrl || config.publicOrigin || config.localUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const wsOrigin = targetOrigin.replace(/^http/, 'ws');

    let endpointHealthy = false;
    let endpointPingMs = null;

    try {
      const start = Date.now();
      const res = await fetch(`${targetOrigin}/api/health`, {
        signal: AbortSignal.timeout(4000),
      });
      endpointPingMs = Date.now() - start;
      endpointHealthy = res.ok;
    } catch {
      endpointHealthy = false;
    }

    const report = {
      timestamp,
      build: BUILD_METADATA,
      application: {
        name: 'DC Screen Sharing',
        version: config.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
        freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
      },
      infrastructure: {
        target: targetOrigin,
        localPort: config.port,
        localUrl: config.localUrl,
        publicUrl: config.publicOrigin,
        websocket: `${wsOrigin}/ws`,
        healthy: endpointHealthy,
        latencyMs: endpointPingMs,
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
        tunnelRunning: stateData.tunnelRunning ?? false,
        serverState: stateData.serverState ?? 'unknown',
        cloudflareState: stateData.cloudflareState ?? 'unknown',
        reconnectAttempts: stateData.reconnectAttempts ?? 0,
      },
      processMetrics: {
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        activeHandles: typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null,
        activeRequests: typeof process._getActiveRequests === 'function' ? process._getActiveRequests().length : null,
      },
      recentLogs: logger.getRecentLogs().slice(-30),
    };

    return report;
  }
}

export const diagnosticsManager = new DiagnosticsManager();
