import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Preload Bridge Contract & API Synchronization', () => {
  it('Scenario 10: preload.js uses ES import and exposes canonical and alias namespaces', () => {
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '..', 'desktop', 'main', 'preload.js'),
      'utf8',
    );

    // Verify it uses ES import instead of require()
    expect(preloadSource).toContain("import { contextBridge, ipcRenderer } from 'electron';");
    expect(preloadSource).not.toContain("require('electron')");

    // Verify canonical namespace
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('discordScreenRailway',");
    // Verify compatibility alias
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('electronAPI',");

    // Verify required methods are exposed in the API object
    const requiredMethods = [
      'validateCredentials',
      'saveConfig',
      'getConfig',
      'resetConfig',
      'startServices',
      'stopServices',
      'getState',
      'confirmDiscordConfig',
      'getDiagnostics',
      'copyToClipboard',
      'getRecentLogs',
      'validateDiscordConfig',
      'onStateChange',
      'onLogLine',
      'openExternal',
      'openCapturePage',
      'openDiscord',
    ];

    for (const method of requiredMethods) {
      expect(preloadSource).toContain(`${method}:`);
    }
  });

  it('verifies renderer app.js calls methods that match preload.js exactly', () => {
    const appSource = fs.readFileSync(
      path.join(__dirname, '..', 'desktop', 'ui', 'app.js'),
      'utf8',
    );

    // App should use bridge methods
    expect(appSource).toContain('bridge.validateCredentials(');
    expect(appSource).toContain('bridge.saveConfig(');
    expect(appSource).toContain('bridge.getConfig(');
    expect(appSource).toContain('bridge.getState(');
    expect(appSource).toContain('bridge.confirmDiscordConfig(');
    expect(appSource).toContain('bridge.startServices(');
    expect(appSource).toContain('bridge.resetConfig(');
    expect(appSource).toContain('bridge.getRecentLogs(');
  });

  it('verifies main index.js registers IPC handlers for all preload invocations', () => {
    const mainSource = fs.readFileSync(
      path.join(__dirname, '..', 'desktop', 'main', 'index.js'),
      'utf8',
    );

    const ipcChannels = [
      'get-config',
      'save-config',
      'validate-credentials',
      'check-discord-entry-point',
      'start-services',
      'stop-services',
      'get-state',
      'open-external',
      'open-capture-page',
      'open-discord',
      'confirm-discord-config',
      'get-diagnostics',
      'copy-to-clipboard',
      'get-recent-logs',
      'validate-discord-config',
      'reset-config',
      'window-minimize',
      'window-maximize',
      'window-close',
    ];

    for (const channel of ipcChannels) {
      expect(mainSource).toContain(`ipcMain.handle('${channel}'`);
    }
  });
});
