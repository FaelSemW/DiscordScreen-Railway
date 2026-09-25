import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, shell, Tray, Menu, clipboard, nativeImage, session, desktopCapturer } from 'electron';
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
import { AudioExclusionManager } from './audio-exclusion-manager.js';
import { broadcasterManager } from './broadcaster-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure completely isolated userData directory for DC Screen Sharing Self-Hosted
app.setPath('userData', path.join(app.getPath('appData'), 'DC Screen Sharing'));
app.setAppUserModelId('com.dcscreensharing.selfhosted');

let mainWindow = null;
let broadcasterWindow = null;
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
  logger.error('Promessa rejeitada sem tratamento no processo principal:', reason);
});

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logger.info('Outra instância do DC Screen Sharing já está em execução. Encerrando esta.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      openMainWindow();
    }
  });

  app.whenReady().then(initApp);
}

function logEarlyDiagnostics() {
  logger.info('==================================================');
  logger.info('DC SCREEN SHARING — STARTUP DIAGNOSTICS (SELF-HOSTED)');
  logger.info(`App Version: ${app.getVersion()}`);
  logger.info(`Electron Version: ${process.versions.electron}`);
  logger.info(`Node Version: ${process.versions.node}`);
  logger.info(`Packaged Mode: ${app.isPackaged ? 'YES' : 'NO'}`);
  logger.info(`userData Path: ${app.getPath('userData')}`);
  logger.info(`Mode: Local Backend + Cloudflare Tunnel`);
  logger.info('==================================================');
}

let pendingDisplayMediaCallback = null;
let cachedSources = [];
let pickerWindow = null;
const captureWindows = new Set();

export const audioExclusionManager = new AudioExclusionManager({ logger });

audioExclusionManager.on('data', (chunk) => {
  for (const win of captureWindows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('audio-pcm-chunk', chunk);
    }
  }
});

// ── Broadcaster IPC (capture worker → main → WS) ──────────────────────────
// Binary encoded chunks from the capture renderer
ipcMain.on('broadcaster-chunk', (event, buffer) => {
  if (event.sender !== broadcasterManager._captureWin?.webContents) return;
  broadcasterManager.onEncodedChunk(buffer);
});

// JSON control messages from the capture renderer
ipcMain.on('broadcaster-message', (event, msg) => {
  if (event.sender !== broadcasterManager._captureWin?.webContents) return;
  broadcasterManager.onCaptureMessage(msg);
});

// Forward broadcaster state changes to the broadcaster window
broadcasterManager.on('state-change', (state) => {
  if (broadcasterWindow && !broadcasterWindow.isDestroyed()) {
    broadcasterWindow.webContents.send('broadcaster-state', state);
  }
  updateTrayMenu();
});

broadcasterManager.on('stats', (stats) => {
  if (broadcasterWindow && !broadcasterWindow.isDestroyed()) {
    broadcasterWindow.webContents.send('broadcaster-stats', stats);
  }
});

broadcasterManager.on('session-created', ({ shareUrl }) => {
  if (broadcasterWindow && !broadcasterWindow.isDestroyed()) {
    broadcasterWindow.webContents.send('broadcaster-state', {
      ...broadcasterManager.getState(),
      shareUrl,
    });
  }
});

export async function openCaptureInElectron(captureUrl) {
  if (!captureUrl) return false;
  try {
    const win = new BrowserWindow({
      width: 1040,
      height: 760,
      minWidth: 800,
      minHeight: 600,
      title: 'Transmissão - Discord Screen Railway',
      backgroundColor: '#0c0e14',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });

    captureWindows.add(win);
    win.on('closed', () => {
      captureWindows.delete(win);
      if (captureWindows.size === 0) {
        audioExclusionManager.stop().catch(() => {});
      }
    });
    await win.loadURL(captureUrl);
    return true;
  } catch (err) {
    logger.error(`Erro ao abrir janela de transmissão no Electron: ${err.message}`);
    if (shell) await shell.openExternal(captureUrl);
    return false;
  }
}

function showSourcePicker(request, callback) {
  pendingDisplayMediaCallback = callback;

  desktopCapturer
    .getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 360, height: 200 },
      fetchWindowIcons: true,
    })
    .then((sources) => {
      cachedSources = sources || [];

      if (pickerWindow && !pickerWindow.isDestroyed()) {
        pickerWindow.focus();
        pickerWindow.webContents.send('sources-updated');
        return;
      }

      pickerWindow = new BrowserWindow({
        width: 720,
        height: 560,
        minWidth: 600,
        minHeight: 480,
        title: 'Compartilhar Tela',
        parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
        modal: Boolean(mainWindow && !mainWindow.isDestroyed()),
        show: false,
        frame: false,
        backgroundColor: '#0c0e14',
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });

      pickerWindow.loadFile(path.join(__dirname, '..', 'ui', 'picker.html'));
      pickerWindow.once('ready-to-show', () => {
        pickerWindow.show();
      });

      pickerWindow.on('closed', () => {
        pickerWindow = null;
        if (pendingDisplayMediaCallback) {
          pendingDisplayMediaCallback({});
          pendingDisplayMediaCallback = null;
        }
      });
    })
    .catch((err) => {
      logger.error('Erro ao buscar fontes no setDisplayMediaRequestHandler:', err);
      callback({});
      pendingDisplayMediaCallback = null;
    });
}

async function initApp() {
  logEarlyDiagnostics();

  // Configura suporte a display media request handler no Electron com seletor customizado e áudio loopback
  if (session?.defaultSession?.setDisplayMediaRequestHandler) {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      showSourcePicker(request, callback);
    });
  }

  if (session?.defaultSession?.setPermissionRequestHandler) {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(true);
    });
  }

  openMainWindow();
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

  // Auto-start self-hosted services (Local Server + Cloudflare Tunnel)
  logger.info('Iniciando infraestrutura self-hosted (Servidor Local + Cloudflare Tunnel)...');
  processManager.start().catch((err) => logger.error('Erro no auto-start self-hosted:', err));
}

export function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createMainWindow();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 840,
    minHeight: 640,
    title: 'DC Screen Sharing — Self-Hosted',
    backgroundColor: '#0c0e14',
    show: true,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  mainWindow.show();
  mainWindow.focus();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
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
    tray.setToolTip('DC Screen Sharing — Transmissor de Tela');
    tray.on('click', () => {
      openBroadcasterWindow();
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
  const bState = broadcasterManager.getState();
  const isStreaming = bState.state === 'streaming';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '📡 Abrir Transmissor de Tela',
      click: () => openBroadcasterWindow(),
    },
    {
      label: isStreaming ? '⏹ Parar Transmissão' : '▶ Iniciar Transmissão',
      click: async () => {
        if (isStreaming) {
          await broadcasterManager.stopBroadcast();
        } else {
          openBroadcasterWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: '🌐 Assistir no Navegador',
      enabled: Boolean(isStreaming && broadcasterManager.getState().shareUrl),
      click: () => {
        const url = broadcasterManager.getState().shareUrl;
        if (url) shell.openExternal(url);
      },
    },
    {
      label: '📋 Copiar Link de Visualização',
      enabled: Boolean(isStreaming && broadcasterManager.getState().shareUrl),
      click: () => {
        const url = broadcasterManager.getState().shareUrl;
        if (url) clipboard.writeText(url);
      },
    },
    { type: 'separator' },
    {
      label: 'Sair do Transmissor',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function openBroadcasterWindow() {
  if (broadcasterWindow && !broadcasterWindow.isDestroyed()) {
    broadcasterWindow.show();
    broadcasterWindow.focus();
    return;
  }

  broadcasterWindow = new BrowserWindow({
    width: 540,
    height: 680,
    minWidth: 440,
    minHeight: 460,
    title: 'DC Screen Sharing — Native Broadcaster',
    backgroundColor: '#0c0e14',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  broadcasterWindow.setMenuBarVisibility(false);
  broadcasterWindow.loadFile(path.join(__dirname, '..', 'ui', 'broadcaster.html'));
  broadcasterWindow.show();
  broadcasterWindow.focus();

  broadcasterWindow.once('ready-to-show', () => {
    broadcasterWindow.show();
    broadcasterWindow.focus();
  });

  broadcasterWindow.on('close', (event) => {
    const isStreaming = ['starting', 'streaming'].includes(broadcasterManager.getState().state);
    if (!isQuitting && (isStreaming || configManager.config.minimizeToTray)) {
      event.preventDefault();
      broadcasterWindow.hide();
      logger.info('[Broadcaster] Window hidden to tray while running.');
    }
  });

  broadcasterWindow.on('closed', async () => {
    broadcasterWindow = null;
    logger.info('[Broadcaster] Broadcaster window closed.');
    updateTrayMenu();
  });

  updateTrayMenu();
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
    const opened = await openCaptureInElectron(target);
    return { ok: opened };
  });

  ipcMain.handle('picker-get-sources', async () => {
    try {
      if (!cachedSources || cachedSources.length === 0) {
        cachedSources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 360, height: 200 },
          fetchWindowIcons: true,
        });
      }
      return cachedSources.map((s) => ({
        id: s.id,
        name: s.name,
        display_id: s.display_id,
        thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : '',
        appIconDataUrl: s.appIcon ? s.appIcon.toDataURL() : null,
      }));
    } catch (err) {
      logger.error('Erro ao obter fontes para o picker:', err);
      return [];
    }
  });

  ipcMain.handle('picker-select-source', async (_event, { sourceId, shareAudio, excludeDiscord }) => {
    if (!pendingDisplayMediaCallback) return false;
    const source = cachedSources.find((s) => s.id === sourceId);
    if (!source) {
      pendingDisplayMediaCallback({});
      pendingDisplayMediaCallback = null;
      if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
      return false;
    }

    const isScreen = source.id.startsWith('screen:');
    const shouldExclude = excludeDiscord !== false;
    // Para tela inteira: loopback do sistema com exclusão do Discord ativa por padrão.
    // Para janela: objeto da própria janela para capturar áudio isolado.
    const audioOption = shareAudio ? (isScreen ? 'loopback' : source) : undefined;

    if (isScreen && shareAudio && shouldExclude) {
      try {
        const started = await audioExclusionManager.start({ excludeDiscord: true });
        if (!started || audioExclusionManager.state !== 'CAPTURING') {
          logger.warn('[AudioExclusionManager] Helper não inicializou em estado CAPTURING. Verificando presença do Discord...');
          const discordState = await audioExclusionManager.discordDetector.check();
          if (discordState.isRunning) {
            logger.warn('[AudioExclusionManager] Discord está ativo e o helper falhou. Desativando áudio do sistema para proteger privacidade.');
            audioOption = undefined;
          }
        }
      } catch (err) {
        logger.warn(`[AudioExclusionManager] Erro ao iniciar captura com exclusão: ${err.message}`);
        const discordState = await audioExclusionManager.discordDetector.check();
        if (discordState.isRunning) {
          audioOption = undefined;
        }
      }
    } else {
      audioExclusionManager.stop().catch(() => {});
    }

    logger.info(
      `[SourcePicker] Selecionado: "${source.name}" (screen=${isScreen}, audio=${audioOption || 'none'})`,
    );

    const cb = pendingDisplayMediaCallback;
    pendingDisplayMediaCallback = null;
    cb({ video: source, audio: audioOption });

    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.close();
    }
    return true;
  });

  ipcMain.handle('audio-exclusion-status', () => {
    return audioExclusionManager.getState();
  });

  ipcMain.handle('audio-exclusion-start', async (_event, params) => {
    const ok = await audioExclusionManager.start(params);
    return { ok, state: audioExclusionManager.getState() };
  });

  ipcMain.handle('audio-exclusion-stop', async () => {
    await audioExclusionManager.stop();
    return { ok: true, state: audioExclusionManager.getState() };
  });

  ipcMain.handle('discord-process-status', async () => {
    return await audioExclusionManager.discordDetector.check();
  });

  ipcMain.handle('picker-cancel', () => {
    audioExclusionManager.stop().catch(() => {});
    if (pendingDisplayMediaCallback) {
      pendingDisplayMediaCallback({});
      pendingDisplayMediaCallback = null;
    }
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.close();
    }
    return true;
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

  ipcMain.handle('open-main-window', () => {
    openMainWindow();
    return true;
  });

  // ── Native Broadcaster IPC handlers ────────────────────────────────────
  ipcMain.handle('broadcaster-open', () => {
    openBroadcasterWindow();
    return true;
  });

  ipcMain.handle('broadcaster-enumerate-sources', async () => {
    return await broadcasterManager.enumerateSources();
  });

  ipcMain.handle('broadcaster-start', async (_event, opts) => {
    const result = await broadcasterManager.startBroadcast(opts);
    updateTrayMenu();
    return result;
  });

  ipcMain.handle('broadcaster-stop', async () => {
    const result = await broadcasterManager.stopBroadcast();
    updateTrayMenu();
    return result;
  });

  ipcMain.handle('broadcaster-get-state', () => {
    return broadcasterManager.getState();
  });

  ipcMain.handle('broadcaster-change-source', async (_event, opts) => {
    return await broadcasterManager.changeSource(opts);
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

  ipcMain.handle('restart-tunnel', async () => {
    logger.info('[IPC] restart-tunnel chamado.');
    await processManager.manualReconnect();
    return processManager.getState();
  });

  ipcMain.handle('open-logs-folder', async () => {
    const dir = logger.getLogDirectory();
    if (dir) {
      await shell.openPath(dir);
      return true;
    }
    return false;
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
      await Promise.race([
        Promise.all([
          processManager.stop(),
          broadcasterManager.stopBroadcast().catch(() => {}),
        ]),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
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
