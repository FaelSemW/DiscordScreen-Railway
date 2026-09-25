import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { configManager } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CLOUDFLARE_STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  CONNECTED: 'connected',
  ERROR: 'error',
};

// Matches trycloudflare quick tunnel URLs
const TRYCLOUDFLARE_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i;

export class CloudflareManager extends EventEmitter {
  constructor() {
    super();
    this.state = CLOUDFLARE_STATES.STOPPED;
    this.publicUrl = null;
    this.localPort = null;
    this.process = null;
    this.lastError = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._isManualStop = false;
    this._startPromise = null;
  }

  getState() {
    return {
      state: this.state,
      publicUrl: this.publicUrl,
      localPort: this.localPort,
      connected: this.state === CLOUDFLARE_STATES.CONNECTED,
      lastError: this.lastError,
      reconnectAttempts: this._reconnectAttempts,
    };
  }

  _setState(newState, extra = {}) {
    this.state = newState;
    if (extra.lastError !== undefined) this.lastError = extra.lastError;
    logger.cloudflare('INFO', `Cloudflare Tunnel state changed: ${newState}${this.publicUrl ? ` (${this.publicUrl})` : ''}`);
    this.emit('state-change', this.getState());
  }

  getBinaryPath() {
    let electronApp = null;
    if (process.versions?.electron) {
      try {
        const electron = (globalThis.require && globalThis.require('electron')) || null;
        electronApp = electron?.app || null;
      } catch {
        // Fallback
      }
    }

    const resourcesPath = process.resourcesPath || '';
    const candidatePaths = [
      // 1. Packaged app asarUnpack path (priority in production)
      resourcesPath ? path.resolve(resourcesPath, 'app.asar.unpacked', 'desktop', 'bin', 'cloudflared.exe') : '',
      electronApp?.getAppPath() ? path.resolve(electronApp.getAppPath(), '..', 'app.asar.unpacked', 'desktop', 'bin', 'cloudflared.exe') : '',
      __dirname.includes('app.asar') ? path.join(__dirname.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'), '..', 'bin', 'cloudflared.exe') : '',
      // 2. Standard dev path (only when NOT inside app.asar)
      path.resolve(__dirname, '..', 'bin', 'cloudflared.exe'),
      path.resolve(process.cwd(), 'desktop', 'bin', 'cloudflared.exe'),
    ].filter(Boolean);

    for (const p of candidatePaths) {
      // Ensure we NEVER return a path inside app.asar for process spawn
      if (!p.includes('app.asar\\') && !p.includes('app.asar/') && fs.existsSync(p)) {
        return p;
      }
    }

    return 'cloudflared.exe';
  }

  async start(localPort) {
    if (this._startPromise) return this._startPromise;
    if (this.state === CLOUDFLARE_STATES.CONNECTED && this.process) {
      return this.getState();
    }

    this._startPromise = this._doStart(localPort);
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _doStart(localPort) {
    if (localPort) this.localPort = localPort;
    if (!this.localPort) {
      throw new Error('Porta local do servidor não fornecida para o Cloudflare Tunnel.');
    }

    this._isManualStop = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._killExistingProcess();
    this._setState(CLOUDFLARE_STATES.STARTING);
    this.lastError = null;

    const binPath = this.getBinaryPath();
    logger.cloudflare('INFO', `Iniciando Cloudflare Tunnel com binário: ${binPath}`);

    const tunnelToken = configManager.getCloudflareTunnelToken();
    let args;

    if (tunnelToken) {
      logger.cloudflare('INFO', 'Iniciando com Token de Túnel Privado (Named Tunnel)...');
      args = ['tunnel', 'run', '--token', tunnelToken];
    } else {
      logger.cloudflare('INFO', `Iniciando Quick Tunnel para http://127.0.0.1:${this.localPort}...`);
      args = ['tunnel', '--url', `http://127.0.0.1:${this.localPort}`, '--no-autoupdate'];
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const err = new Error('Tempo limite de 30s esgotado ao aguardar criação do túnel Cloudflare.');
          this._setState(CLOUDFLARE_STATES.ERROR, {
            lastError: { code: 'CLOUDFLARE_TIMEOUT', message: err.message },
          });
          reject(err);
        }
      }, 35_000);

      try {
        const child = spawn(binPath, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process = child;

        const onOutput = (data) => {
          const text = data.toString();
          logger.cloudflare('DEBUG', text.trim());

          const match = text.match(TRYCLOUDFLARE_REGEX);
          if (match && match[0]) {
            const discoveredUrl = match[0].trim();
            const oldUrl = this.publicUrl;
            this.publicUrl = discoveredUrl;
            this._reconnectAttempts = 0;

            logger.cloudflare('INFO', `Túnel Cloudflare estabelecido com sucesso! URL: ${discoveredUrl}`);
            configManager.setPublicOrigin(discoveredUrl);
            configManager.save();

            if (oldUrl && oldUrl !== discoveredUrl) {
              logger.cloudflare('WARN', `URL pública do Cloudflare alterada: de ${oldUrl} para ${discoveredUrl}`);
              this.emit('url-changed', { oldUrl, newUrl: discoveredUrl });
            }

            this._setState(CLOUDFLARE_STATES.CONNECTED);
            this.emit('url-discovered', discoveredUrl);

            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve(this.getState());
            }
          }
        };

        child.stdout.on('data', onOutput);
        child.stderr.on('data', onOutput);

        child.on('error', (err) => {
          logger.cloudflare('ERROR', `Erro no processo do cloudflared: ${err.message}`);
          this._handleProcessExit('error', err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(err);
          }
        });

        child.on('close', (code, signal) => {
          logger.cloudflare('WARN', `Processo cloudflared finalizado (código: ${code}, sinal: ${signal})`);
          this._handleProcessExit('close', { code, signal });
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error(`cloudflared finalizou inesperadamente com código ${code}`));
          }
        });

      } catch (err) {
        logger.cloudflare('ERROR', `Falha ao iniciar processo cloudflared: ${err.message}`);
        this._setState(CLOUDFLARE_STATES.ERROR, {
          lastError: { code: 'SPAWN_FAILED', message: err.message },
        });
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      }
    });
  }

  _handleProcessExit(event, detail) {
    this.process = null;

    if (this._isManualStop) {
      this._setState(CLOUDFLARE_STATES.STOPPED);
      return;
    }

    this._setState(CLOUDFLARE_STATES.ERROR, {
      lastError: {
        code: 'TUNNEL_DISCONNECTED',
        message: 'Conexão com Cloudflare Tunnel interrompida.',
        technical: JSON.stringify(detail),
      },
    });

    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._isManualStop) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);

    this._reconnectAttempts++;
    const delayMs = Math.min(3000 * Math.pow(1.5, Math.min(this._reconnectAttempts - 1, 6)), 30_000);
    logger.cloudflare('INFO', `Agendando reconexão do Cloudflare Tunnel em ${Math.round(delayMs / 1000)}s (tentativa ${this._reconnectAttempts})...`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.start(this.localPort);
      } catch (err) {
        logger.cloudflare('ERROR', `Falha na tentativa de reconexão do túnel: ${err.message}`);
      }
    }, delayMs);
    this._reconnectTimer.unref?.();
  }

  _killExistingProcess() {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {}
      this.process = null;
    }
  }

  async stop() {
    this._isManualStop = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._killExistingProcess();
    this._setState(CLOUDFLARE_STATES.STOPPED);
    return this.getState();
  }

  async restart() {
    logger.cloudflare('INFO', 'Reiniciando Cloudflare Tunnel manualmente...');
    await this.stop();
    return await this.start(this.localPort);
  }
}

export const cloudflareManager = new CloudflareManager();
