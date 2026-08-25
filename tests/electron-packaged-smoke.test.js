import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import electronBinary from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Electron BrowserWindow & Preload Smoke Test', () => {
  it('loads BrowserWindow with preload and verifies bridge availability', async () => {
    const runnerScript = `
      import { app, BrowserWindow, ipcMain } from 'electron';
      import path from 'node:path';
      import { fileURLToPath } from 'node:url';

      const __dirname = path.dirname(fileURLToPath(import.meta.url));

      app.whenReady().then(async () => {
        ipcMain.handle('get-config', () => ({ isConfigured: false, firstRunCompleted: false }));
        ipcMain.handle('get-state', () => ({ state: 'idle' }));
        ipcMain.handle('validate-credentials', (_e, data) => ({ valid: true, errors: {} }));
        ipcMain.handle('save-config', (_e, patch) => ({ ok: true }));

        const win = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: path.join(__dirname, 'desktop', 'main', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          }
        });

        await win.loadFile(path.join(__dirname, 'desktop', 'ui', 'index.html'));

        // Execute assertions in renderer context
        const result = await win.webContents.executeJavaScript(\`
          (() => {
            const hasCanonical = typeof window.discordScreenRailway === 'object' && window.discordScreenRailway !== null;
            const hasAlias = typeof window.electronAPI === 'object' && window.electronAPI !== null;
            const hasValidate = typeof window.discordScreenRailway?.validateCredentials === 'function';
            const hasSave = typeof window.discordScreenRailway?.saveConfig === 'function';
            const hasGetConfig = typeof window.discordScreenRailway?.getConfig === 'function';
            return { hasCanonical, hasAlias, hasValidate, hasSave, hasGetConfig };
          })()
        \`);

        console.log('RENDERER_BRIDGE_CHECK:' + JSON.stringify(result));
        app.quit();
      });
    `;

    const runnerFile = path.join(__dirname, '..', 'smoke-temp-runner.js');
    fs.writeFileSync(runnerFile, runnerScript, 'utf8');

    const output = await new Promise((resolve, reject) => {
      execFile(electronBinary, [runnerFile], { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
        try {
          fs.unlinkSync(runnerFile);
        } catch {}
        if (err) return reject(err);
        resolve(stdout + stderr);
      });
    });

    expect(output).toContain('RENDERER_BRIDGE_CHECK:');
    const match = output.match(/RENDERER_BRIDGE_CHECK:(\{.*\})/);
    expect(match).not.toBeNull();
    const data = JSON.parse(match[1]);

    expect(data.hasCanonical).toBe(true);
    expect(data.hasAlias).toBe(true);
    expect(data.hasValidate).toBe(true);
    expect(data.hasSave).toBe(true);
    expect(data.hasGetConfig).toBe(true);
  }, 30000);
});
