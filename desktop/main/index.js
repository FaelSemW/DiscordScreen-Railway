import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, shell, Tray, Menu, clipboard, nativeImage } from 'electron';
import { logger } from './logger.js';
import { configManager } from './config.js';
import { processManager, STATES } from './manager.js';
import { diagnosticsManager } from './diagnostics.js';
import {
  validateClientId,
  validateClientSecret,
  validateBotToken,
  validateAdminId,
  ensureDiscordEntryPoint,
  openDiscordApp,
  openCapturePage,
} from './discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure completely isolated userData directory
app.setPath('userData', path.join(app.getPath('appData'), 'DiscordScreenRailway'));
app.setAppUserModelId('com.discordscreen.railway');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Global Uncaught Exception & Rejection Traps
process.on('uncaughtException', (err) => {
  logger.error('Exceção não tratada capturada no processo principal:', err);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-change', {
      state: STATES.ERROR,
      lastError: {
        code: 'MAIN_PROCESS_EXCEPTION',
        title: 'Erro no Processo Principal',
        message: 'Ocorreu um erro interno na aplicação. Detalhes salvos nos logs de diagnóstico.',
        technical: err.stack || String(err),
      },
    });
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error('Promise rejeitada não tratada no processo principal:', reason);
});

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logger.info('Outra instância do Discord Screen Railway já está em execução. Encerrando esta.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(initApp);
}

function logEarlyDiagnostics() {
  logger.info('==================================================');
  logger.info('DISCORD SCREEN RAILWAY — STARTUP DIAGNOSTICS');
  logger.info(`App Version: ${app.getVersion()}`);
  logger.info(`Electron Version: ${process.versions.electron}`);
  logger.info(`Node Version: ${process.versions.node}`);
  logger.info(`Packaged Mode: ${app.isPackaged ? 'YES' : 'NO'}`);
  logger.info(`userData Path: ${app.getPath('userData')}`);
  logger.info(`Target Server: https://zaprecovery.online`);
  logger.info('==================================================');
}

async function initApp() {
  logEarlyDiagnostics();

  createMainWindow();
  createTray();
  setupIpc();

  // Forward process manager state changes to renderer window
  processManager.on('state-change', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state-change', state);
    }
    updateTrayMenu();
  });

  // Forward logs to renderer window
  logger.onLog((line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log-line', line);
    }
  });

  // Auto-start connection if configured and confirmed
  const publicConfig = configManager.getPublicConfig();
  if (
    publicConfig.isConfigured &&
    publicConfig.firstRunCompleted &&
    publicConfig.confirmedPublicOrigin
  ) {
    logger.info('Iniciando conexão com Railway automaticamente...');
    processManager.start().catch((err) => logger.error('Erro no auto-start:', err));
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 740,
    minWidth: 840,
    minHeight: 640,
    title: 'Discord Screen Railway',
    backgroundColor: '#0c0e14',
    show: false,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && configManager.config.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  try {
    const svgIcon = `
      <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" rx="8" fill="#5865F2"/>
        <path d="M9 11h14v10H9z" fill="none" stroke="#FFFFFF" stroke-width="2"/>
        <path d="M13 21v3h6v-3" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    const icon = nativeImage.createFromBuffer(Buffer.from(svgIcon));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('Discord Screen Railway');
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    updateTrayMenu();
  } catch (err) {
    logger.warn(`Erro ao criar ícone da bandeja: ${err.message}`);
  }
}

function updateTrayMenu() {
  if (!tray) return;

  const currentState = processManager.getState();
  const isRunning = currentState.state === STATES.READY;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir Discord Screen Railway',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: isRunning ? 'Reconectar Servidor' : 'Conectar Servidor',
      click: () => {
        processManager.start();
      },
    },
    {
      label: 'Copiar Endereço do Servidor',
      click: () => {
        clipboard.writeText('https://zaprecovery.online');
      },
    },
    {
      label: 'Abrir Discord',
      click: () => openDiscordApp(),
    },
    {
      label: 'Compartilhar Tela',
      click: async () => {
        try {
          const shareUrl = await processManager.createStreamingSession();
          await openCapturePage(shareUrl);
        } catch (err) {
          logger.error('Erro ao abrir compartilhamento:', err);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function setupIpc() {
  ipcMain.handle('get-config', () => {
    return configManager.getPublicConfig();
  });

  ipcMain.handle('save-config', (_event, patch) => {
    if (!patch || typeof patch !== 'object') {
      return { ok: false, error: 'Dados de configuração inválidos.' };
    }

    try {
      if (patch.discordClientId !== undefined) {
        configManager.setClientId(patch.discordClientId);
      }
      if (patch.discordClientSecret !== undefined && patch.discordClientSecret !== '') {
        configManager.setClientSecret(patch.discordClientSecret);
      }
      if (patch.discordBotToken !== undefined && patch.discordBotToken !== '') {
        configManager.setBotToken(patch.discordBotToken);
      }
      if (patch.discordAdminId !== undefined) {
        configManager.setAdminId(patch.discordAdminId);
      }
      if (patch.firstRunCompleted !== undefined) {
        configManager.config.firstRunCompleted = Boolean(patch.firstRunCompleted);
      }
      if (patch.beginnerMode !== undefined) {
        configManager.config.beginnerMode = Boolean(patch.beginnerMode);
      }
      if (patch.minimizeToTray !== undefined) {
        configManager.config.minimizeToTray = Boolean(patch.minimizeToTray);
      }

      const saved = configManager.save();
      if (!saved) {
        return { ok: false, error: 'Não foi possível gravar as configurações no disco.' };
      }
      return { ok: true, config: configManager.getPublicConfig() };
    } catch (err) {
      logger.error('Erro ao salvar configuração:', err);
      return { ok: false, error: err.message || 'Erro interno ao salvar configurações.' };
    }
  });

  ipcMain.handle('validate-credentials', (_event, data = {}) => {
    const errors = {};
    if (data.clientId !== undefined) {
      const err = validateClientId(data.clientId);
      if (err) errors.clientId = err;
    } else {
      errors.clientId = 'O Client ID é obrigatório.';
    }

    if (data.clientSecret !== undefined && data.clientSecret !== '') {
      const err = validateClientSecret(data.clientSecret);
      if (err) errors.clientSecret = err;
    } else if (!configManager.getClientSecret()) {
      errors.clientSecret = 'O Client Secret é obrigatório.';
    }

    if (data.botToken !== undefined && data.botToken !== '') {
      const err = validateBotToken(data.botToken);
      if (err) errors.botToken = err;
    }
    if (data.adminId !== undefined && data.adminId !== '') {
      const err = validateAdminId(data.adminId);
      if (err) errors.adminId = err;
    }
    return { valid: Object.keys(errors).length === 0, errors };
  });

  ipcMain.handle('check-discord-entry-point', async (_event, clientId, clientSecret) => {
    const id = clientId || configManager.getClientId();
    const secret = clientSecret || configManager.getClientSecret();
    return await ensureDiscordEntryPoint(id, secret);
  });

  ipcMain.handle('start-services', async () => {
    await processManager.start();
    return processManager.getState();
  });

  ipcMain.handle('stop-services', async () => {
    await processManager.stop();
    return processManager.getState();
  });

  ipcMain.handle('get-state', () => {
    return processManager.getState();
  });

  ipcMain.handle('open-external', async (_event, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('open-capture-page', async (_event, customUrl) => {
    let target = customUrl;
    if (!target) {
      try {
        target = await processManager.createStreamingSession();
      } catch (err) {
        logger.error('Erro ao gerar sessão de captura:', err);
        return { ok: false, error: err.message };
      }
    }
    const opened = await openCapturePage(target);
    return { ok: opened };
  });

  ipcMain.handle('open-discord', async () => {
    const opened = await openDiscordApp();
    return { ok: opened };
  });

  ipcMain.handle('confirm-discord-config', async (_event, origin) => {
    return processManager.confirmDiscordConfiguration(origin);
  });

  ipcMain.handle('get-diagnostics', async () => {
    const state = processManager.getState();
    return await diagnosticsManager.generateReport(state.state, state.publicUrl, state);
  });

  ipcMain.handle('copy-to-clipboard', (_event, text) => {
    if (typeof text === 'string') {
      clipboard.writeText(text);
      return true;
    }
    return false;
  });

  ipcMain.handle('get-recent-logs', () => {
    return logger.getRecentLogs();
  });

  ipcMain.handle('validate-discord-config', () => {
    return configManager.validateDiscordConfiguration();
  });

  ipcMain.handle('reset-config', async (_event, preservePreferences = true) => {
    logger.info('[IPC] reset-config chamado.');
    await processManager.resetConfiguration(preservePreferences);
    return configManager.getPublicConfig();
  });

  ipcMain.handle('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.handle('window-close', () => {
    if (mainWindow) {
      if (configManager.config.minimizeToTray) {
        mainWindow.hide();
      } else {
        isQuitting = true;
        app.quit();
      }
    }
  });
}

// Clean termination hook
app.on('before-quit', async (event) => {
  if (!isQuitting) {
    isQuitting = true;
    event.preventDefault();
    try {
      await processManager.stop();
    } catch {
      // Ignore
    }
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !configManager.config.minimizeToTray) {
    app.quit();
  }
});
