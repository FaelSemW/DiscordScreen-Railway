import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { logger } from './logger.js';
import { configManager } from './config.js';
import { exchangeOAuthCode } from './discord.js';

export const STATES = {
  IDLE: 'idle',
  CHECKING_CONFIG: 'checking_config',
  CONNECTING_SERVER: 'connecting_server',
  WAITING_DISCORD_CONFIGURATION: 'waiting_discord_configuration',
  DISCORD_CONFIG_REQUIRED: 'waiting_discord_configuration',
  READY: 'ready',
  STOPPING: 'stopping',
  ERROR: 'error',
};

export class ProcessManager extends EventEmitter {
  constructor() {
    super();
    this.state = STATES.IDLE;
    this.controlWs = null;
    this.lastError = null;
    this.startPromise = null;
    this.reconnectTimer = null;
    this.isStopping = false;
    this._connectPromise = null;
    this._connectionGeneration = 0;
  }

  getVerifiedPublicOrigin() {
    return 'https://zaprecovery.online';
  }

  getState() {
    const verifiedOrigin = this.getVerifiedPublicOrigin();
    const isConfirmed = configManager.isDiscordConfigConfirmedFor(verifiedOrigin);
    const isConfigured = configManager.isConfigured();

    return {
      state: this.state,
      publicUrl: verifiedOrigin,
      verifiedPublicUrl: verifiedOrigin,
      discordTarget: 'zaprecovery.online',
      discordRedirect: 'https://zaprecovery.online/auth/callback',
      lastError: this.lastError,
      urlNeedsDiscordUpdate: Boolean(verifiedOrigin && !isConfirmed),
      discordConfigConfirmed: isConfirmed,
      confirmedPublicOrigin: configManager.getConfirmedPublicOrigin(),
      serverRunning: this.state === STATES.READY,
      tunnelRunning: true, // Permanent Railway infra is always available
      publicEndpointReady: this.state === STATES.READY,
      shareLinkAvailable: Boolean(this.state === STATES.READY && isConfirmed),
      isConfigured,
      clientId: configManager.getClientId(),
    };
  }

  setState(newState, extra = {}) {
    this.state = newState;
    if (extra.lastError !== undefined) this.lastError = extra.lastError;
    logger.info(`State changed: ${newState}`);
    this.emit('state-change', this.getState());
  }

  async checkHealth(baseUrl = 'https://zaprecovery.online', timeoutMs = 4000) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${baseUrl}/api/health`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data.ok);
    } catch (err) {
      logger.warn(`Health check failed for ${baseUrl}: ${err.message}`);
      return false;
    }
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.state === STATES.READY) return this.getState();

    this.startPromise = this._executeStart();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _executeStart() {
    try {
      this.isStopping = false;
      this.lastError = null;
      this.setState(STATES.CHECKING_CONFIG);

      // 1. Validate credentials
      const validation = configManager.validateDiscordConfiguration();
      if (!validation.valid) {
        this.setState(STATES.DISCORD_CONFIG_REQUIRED);
        return this.getState();
      }

      // 2. Check if Discord Developer Portal configuration was confirmed
      const verifiedOrigin = this.getVerifiedPublicOrigin();
      if (!configManager.isDiscordConfigConfirmedFor(verifiedOrigin)) {
        this.setState(STATES.DISCORD_CONFIG_REQUIRED);
        return this.getState();
      }

      // 3. Verify Railway server health
      this.setState(STATES.CONNECTING_SERVER);
      logger.info('Verificando status do servidor Railway em https://zaprecovery.online...');
      const healthy = await this.checkHealth('https://zaprecovery.online');
      if (!healthy) {
        throw {
          code: 'SERVER_UNAVAILABLE',
          title: 'Servidor Railway Indisponível',
          message:
            'Não foi possível conectar ao servidor central em https://zaprecovery.online. Verifique sua conexão com a internet.',
        };
      }

      // 4. Connect Control WebSocket & register active Client ID
      await this._connectControlChannel();

      this.setState(STATES.READY);
      return this.getState();
    } catch (err) {
      logger.error('Erro ao inicializar Discord Screen Railway:', err);
      this.setState(STATES.ERROR, {
        lastError: {
          code: err.code || 'STARTUP_ERROR',
          title: err.title || 'Erro na Conexão',
          message: err.message || 'Falha ao conectar com a infraestrutura Railway.',
          technical: err.technical || err.stack || String(err),
        },
      });
      return this.getState();
    }
  }

    async _connectControlChannel() {
    if (this.controlWs && this.controlWs.readyState === WebSocket.OPEN) {
      return;
    }
    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._connectPromise = this._doConnectControlChannel();
    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  async _doConnectControlChannel() {
    const currentGeneration = ++this._connectionGeneration;

    if (this.controlWs) {
      const oldWs = this.controlWs;
      this.controlWs = null;
      try {
        oldWs.removeAllListeners();
        oldWs.terminate();
      } catch {
        // Ignore
      }
    }

    const verifiedOrigin = this.getVerifiedPublicOrigin();
    const wsBaseUrl = verifiedOrigin.replace(/^http/, 'ws');
    const wsUrl = `${wsBaseUrl}/control`;
    logger.info(`Conectando canal de controle desktop em ${wsUrl}...`);

    return new Promise((resolve, reject) => {
      let resolved = false;
      const ws = new WebSocket(wsUrl);
      this.controlWs = ws;
      let pingInterval = null;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { ws.terminate(); } catch {}
          reject(new Error('Tempo limite esgotado ao conectar ao canal de controle do Railway.'));
        }
      }, 8000);

      ws.on('ping', () => {
        try {
          ws.pong();
        } catch {
          // ignore
        }
      });

      ws.on('open', () => {
        clearTimeout(timeout);
        if (this._connectionGeneration !== currentGeneration) {
          try { ws.close(); } catch {}
          return;
        }
        if (!resolved) {
          resolved = true;
          logger.info('Canal de controle conectado ao servidor Railway com sucesso.');

          clearInterval(pingInterval);
          pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            }
          }, 10_000);

          // Register active client ID
          ws.send(
            JSON.stringify({
              type: 'register-desktop',
              clientId: configManager.getClientId(),
            }),
          );
          resolve();
        }
      });

      ws.on('message', async (data) => {
        if (this._connectionGeneration !== currentGeneration) return;
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp || Date.now() }));
          }
          return;
        }

        if (msg.type === 'pong') {
          return;
        }

        if (msg.type === 'desktop-registered') {
          logger.info(`Servidor Railway confirmou registro do Client ID: ${msg.activeClientId}`);
        } else if (msg.type === 'oauth-exchange-request') {
          await this._handleOAuthExchangeRequest(msg);
        }
      });

      ws.on('close', () => {
        clearInterval(pingInterval);
        if (this._connectionGeneration === currentGeneration) {
          logger.warn('Canal de controle do Railway desconectado.');
          if (!this.isStopping && this.state === STATES.READY) {
            this._scheduleReconnect();
          }
        }
      });

      ws.on('error', (err) => {
        clearInterval(pingInterval);
        logger.error(`Erro no canal de controle do Railway: ${err.message}`);
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  async _handleOAuthExchangeRequest(req) {
    const { reqId, code, clientId, redirectUri } = req;
    logger.info(`[OAuth Bridge] Recebida solicitação de troca de token para reqId ${reqId}`);

    try {
      const activeClientId = clientId || configManager.getClientId();
      const clientSecret = configManager.getClientSecret();

      if (!clientSecret) {
        throw new Error('Client Secret não configurado no aplicativo Desktop.');
      }

      // Execute token exchange locally using local secret!
      const accessToken = await exchangeOAuthCode(
        activeClientId,
        clientSecret,
        code,
        redirectUri,
      );

      // Send access token back to Railway
      if (this.controlWs && this.controlWs.readyState === WebSocket.OPEN) {
        this.controlWs.send(
          JSON.stringify({
            type: 'oauth-exchange-response',
            reqId,
            access_token: accessToken,
          }),
        );
        logger.info(`[OAuth Bridge] Token de acesso enviado com sucesso para reqId ${reqId}`);
      }
    } catch (err) {
      logger.error(`[OAuth Bridge] Falha ao processar troca de token: ${err.message}`);
      if (this.controlWs && this.controlWs.readyState === WebSocket.OPEN) {
        this.controlWs.send(
          JSON.stringify({
            type: 'oauth-exchange-response',
            reqId,
            error: err.message,
          }),
        );
      }
    }
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (!this.isStopping && this.state === STATES.READY) {
        logger.info('Tentando reconectar canal de controle ao Railway...');
        try {
          await this._connectControlChannel();
        } catch {
          this._scheduleReconnect();
        }
      }
    }, 3000);
  }

  async createStreamingSession() {
    const baseUrl = 'https://zaprecovery.online';
    logger.info('Solicitando criação de sessão de transmissão no servidor Railway...');

    const guestRes = await fetch(`${baseUrl}/api/session-guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Desktop Broadcaster' }),
    }).then((r) => r.json());

    if (!guestRes?.identity) {
      throw new Error('Falha ao emitir sessão anfitriã no servidor Railway.');
    }

    const roomRes = await fetch(`${baseUrl}/api/rooms/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity: guestRes.identity,
        name: 'Transmissão Desktop',
      }),
    }).then((r) => r.json());

    if (!roomRes?.shareUrl) {
      throw new Error('Falha ao criar sala de transmissão no servidor Railway.');
    }

    logger.info(`Sessão de transmissão criada com sucesso: ${roomRes.shareUrl}`);
    return roomRes.shareUrl;
  }

  confirmDiscordConfiguration(origin) {
    const verified = origin || this.getVerifiedPublicOrigin();
    configManager.setConfirmedPublicOrigin(verified);
    configManager.config.firstRunCompleted = true;
    configManager.save();
    logger.info('Configuração do Discord Developer Portal confirmada pelo usuário.');
    this.emit('state-change', this.getState());
    return true;
  }

  async resetConfiguration(preservePreferences = true) {
    await this.stop();
    configManager.reset(preservePreferences);
    this.setState(STATES.IDLE);
    return true;
  }

  async stop() {
    this.isStopping = true;
    clearTimeout(this.reconnectTimer);
    this.setState(STATES.STOPPING);

    if (this.controlWs) {
      try {
        this.controlWs.close();
      } catch {
        // Ignore
      }
      this.controlWs = null;
    }

    this.setState(STATES.IDLE);
    return this.getState();
  }
}

export const processManager = new ProcessManager();
