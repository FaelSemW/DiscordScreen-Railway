import { EventEmitter } from 'node:events';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { configManager } from './config.js';
import {
  createAppServer,
  startServer,
  stopServer,
  setPublicOrigin,
} from '../../server/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SERVER_STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  ERROR: 'error',
};

/**
 * Checks if a TCP port is currently available on the given host.
 * @param {number} port
 * @param {string} host
 * @returns {Promise<boolean>}
 */
export function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      resolve(false);
    });
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

/**
 * Finds an available port starting at preferredPort, scanning sequentially.
 * @param {number} preferredPort
 * @param {string} host
 * @param {number} maxScan
 * @returns {Promise<number>}
 */
export async function findFreePort(preferredPort = 3000, host = '127.0.0.1', maxScan = 50) {
  for (let offset = 0; offset < maxScan; offset++) {
    const candidate = preferredPort + offset;
    const free = await isPortAvailable(candidate, host);
    if (free) return candidate;
  }
  throw new Error(`Não foi possível encontrar uma porta livre entre ${preferredPort} e ${preferredPort + maxScan}`);
}

export class LocalServerManager extends EventEmitter {
  constructor() {
    super();
    this.state = SERVER_STATES.STOPPED;
    this.port = null;
    this.host = '127.0.0.1';
    this.runtime = null;
    this.lastError = null;
    this._healthCheckTimer = null;
    this._startPromise = null;
    this._autoRestartEnabled = true;
    this._restartAttempts = 0;
    // Keep the signing key stable across local server restarts in this process.
    this._sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  }

  getState() {
    return {
      state: this.state,
      port: this.port,
      host: this.host,
      localUrl: this.port ? `http://${this.host}:${this.port}` : null,
      running: this.state === SERVER_STATES.READY,
      lastError: this.lastError,
    };
  }

  _setState(newState, extra = {}) {
    this.state = newState;
    if (extra.lastError !== undefined) this.lastError = extra.lastError;
    logger.server('INFO', `Local Server state changed to: ${newState}${this.port ? ` (port ${this.port})` : ''}`);
    this.emit('state-change', this.getState());
  }

  async start() {
    if (this._startPromise) return this._startPromise;
    if (this.state === SERVER_STATES.READY && this.runtime) {
      return this.getState();
    }

    this._startPromise = this._doStart();
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _doStart() {
    try {
      this._setState(SERVER_STATES.STARTING);
      this.lastError = null;

      const configuredPort = configManager.getPort() || 3000;
      this.host = configManager.getHost() || '127.0.0.1';

      logger.server('INFO', `Buscando porta livre (preferencial: ${configuredPort})...`);
      this.port = await findFreePort(configuredPort, this.host);

      if (this.port !== configuredPort) {
        logger.server('WARN', `Porta ${configuredPort} em uso. Utilizando porta alternativa ${this.port}.`);
      } else {
        logger.server('INFO', `Porta ${this.port} disponível com sucesso.`);
      }

      // Resolve static directory for client bundle
      const clientDistPath = path.resolve(__dirname, '..', '..', 'client', 'dist');

      const clientId = configManager.getClientId();
      const clientSecret = configManager.getClientSecret();
      const publicOrigin = configManager.getPublicOrigin() || `http://${this.host}:${this.port}`;

      logger.server('INFO', `Inicializando Express + WebSocketServer na porta ${this.port}...`);

      this.runtime = await startServer({
        port: this.port,
        host: this.host,
        discordClientId: clientId || null,
        discordClientSecret: clientSecret || null,
        discordBotToken: configManager.getBotToken() || null,
        discordAdminId: configManager.getAdminId() || '',
        publicOrigin,
        staticDirectory: clientDistPath,
        sessionSecret: this._sessionSecret,
        nodeEnv: 'production',
      });

      // Verify health check with progressive retries (up to 5s)
      let healthy = false;
      for (let attempt = 1; attempt <= 10; attempt++) {
        healthy = await this.checkHealth(1000);
        if (healthy) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!healthy) {
        throw new Error(`Falha no health-check inicial do servidor local em http://${this.host}:${this.port}/api/health`);
      }

      this._restartAttempts = 0;
      this._startHealthMonitor();
      this._setState(SERVER_STATES.READY);
      return this.getState();
    } catch (err) {
      logger.server('ERROR', `Erro ao iniciar servidor local: ${err.message}`);
      this._setState(SERVER_STATES.ERROR, {
        lastError: {
          code: 'SERVER_START_FAILED',
          message: err.message,
          technical: err.stack,
        },
      });
      throw err;
    }
  }

  async stop() {
    this._stopHealthMonitor();
    this._autoRestartEnabled = false;

    if (this.runtime) {
      try {
        logger.server('INFO', 'Encerrando servidor local...');
        await stopServer();
      } catch (err) {
        logger.server('WARN', `Erro ao fechar servidor: ${err.message}`);
      }
      this.runtime = null;
    }

    this._setState(SERVER_STATES.STOPPED);
    this._autoRestartEnabled = true;
    return this.getState();
  }

  async checkHealth(timeoutMs = 2000) {
    if (!this.port) return false;
    const url = `http://${this.host}:${this.port}/api/health`;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return Boolean(data?.ok);
    } catch {
      return false;
    }
  }

  updatePublicOrigin(origin) {
    if (origin) {
      setPublicOrigin(origin);
      logger.server('INFO', `Public origin atualizado no runtime: ${origin}`);
    }
  }

  _startHealthMonitor() {
    this._stopHealthMonitor();
    this._healthCheckTimer = setInterval(async () => {
      if (this.state !== SERVER_STATES.READY) return;
      const ok = await this.checkHealth(2500);
      if (!ok) {
        logger.server('WARN', 'Servidor local não respondeu ao health check. Tentando recuperação...');
        this._handleServerFailure();
      }
    }, 10_000);
    this._healthCheckTimer.unref?.();
  }

  _stopHealthMonitor() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

  async _handleServerFailure() {
    if (!this._autoRestartEnabled) return;
    this._stopHealthMonitor();
    this._setState(SERVER_STATES.ERROR, {
      lastError: {
        code: 'HEALTH_CHECK_FAILED',
        message: 'Servidor local parou de responder.',
      },
    });

    if (this._restartAttempts < 5) {
      this._restartAttempts++;
      const delay = Math.min(2000 * Math.pow(1.5, this._restartAttempts - 1), 15000);
      logger.server('INFO', `Reiniciando servidor local em ${Math.round(delay / 1000)}s (tentativa ${this._restartAttempts}/5)...`);
      setTimeout(async () => {
        try {
          await this.stop();
          await this.start();
        } catch (err) {
          logger.server('ERROR', `Falha ao reiniciar servidor local: ${err.message}`);
        }
      }, delay);
    } else {
      logger.server('ERROR', 'Limite de tentativas de reinicialização do servidor local atingido.');
    }
  }
}

export const localServerManager = new LocalServerManager();
