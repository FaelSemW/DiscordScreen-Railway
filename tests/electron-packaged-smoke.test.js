import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import electronBinary from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Electron BrowserWindow & Preload Smoke Test', () => {
  it('loads BrowserWindow with preload and verifies bridge availability', async () => {
    // NOTE: The runner MUST use CJS require('electron') — NOT ESM import.
    // When Electron runs a child-process main file, the 'electron' specifier is
    // only available through the CJS module system. An ESM `import { app }
    // from 'electron'` resolves to node_modules/electron/index.js (which is a
    // Node.js path stub, not the Electron API) and throws:
    //   "does not provide an export named 'BrowserWindow'"
    //
    // Saving the file as .cjs guarantees CJS treatment regardless of the
    // project-level "type": "module" in package.json.
    const projectRoot = path.join(__dirname, '..');
    const runnerScript = `
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

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

    // Use .cjs extension so Node/Electron treats the file as CommonJS even
    // though the root package.json declares "type": "module".
    const runnerFile = path.join(projectRoot, 'smoke-temp-runner.cjs');
    fs.writeFileSync(runnerFile, runnerScript, 'utf8');

    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const output = await new Promise((resolve) => {
      execFile(
        electronBinary,
        [runnerFile],
        { cwd: projectRoot, timeout: 25000, env: childEnv },
        (err, stdout, stderr) => {
          try { fs.unlinkSync(runnerFile); } catch {}
          resolve(stdout + stderr);
        },
      );
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
