import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { logger } from './logger.js';
import { configManager } from './config.js';
import { exchangeOAuthCode } from './discord.js';
import { localServerManager, SERVER_STATES } from './local-server-manager.js';
import { cloudflareManager, CLOUDFLARE_STATES } from './cloudflare-manager.js';
import { broadcasterManager } from './broadcaster-manager.js';

export const STATES = {
  IDLE: 'idle',
  CHECKING_CONFIG: 'checking_config',
  CONNECTING_SERVER: 'connecting_server',
  CONNECTING: 'connecting',
  STARTING_SERVER: 'starting_server',
  STARTING_TUNNEL: 'starting_tunnel',
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
    this.lastError = null;
    this.startPromise = null;
    this.isStopping = false;

    // Control channel & reconnect compatibility state
    this.controlWs = null;
    this.reconnectTimer = null;
    this._connectPromise = null;
    this._connectionGeneration = 0;
    this._pingInterval = null;
    this._reconnectAttempts = 0;
    this.passiveStandbyTimer = null;

    // Listen to local server events
    localServerManager.on('state-change', (sState) => {
      this._syncBroadcasterUrls();
      this.emit('state-change', this.getState());
    });

    // Listen to cloudflare events
    cloudflareManager.on('state-change', (cState) => {
      this._syncBroadcasterUrls();
      this.emit('state-change', this.getState());
    });

    cloudflareManager.on('url-discovered', (url) => {
      logger.info(`[ProcessManager] Nova URL pública descoberta: ${url}`);
      localServerManager.updatePublicOrigin(url);
      this._syncBroadcasterUrls();
      this.emit('state-change', this.getState());
    });

    cloudflareManager.on('url-changed', ({ oldUrl, newUrl }) => {
      logger.warn(`[ProcessManager] URL do Cloudflare alterada: ${oldUrl} -> ${newUrl}`);
      localServerManager.updatePublicOrigin(newUrl);
      this._syncBroadcasterUrls();
      this.emit('state-change', this.getState());
    });
  }

  _syncBroadcasterUrls() {
    const localUrl = localServerManager.getState().localUrl;
    const publicUrl = cloudflareManager.getState().publicUrl || localUrl;
    if (localUrl) {
      broadcasterManager.setServerUrls({
        localBaseUrl: localUrl,
        publicBaseUrl: publicUrl,
      });
    }
  }

  getVerifiedPublicOrigin() {
    return cloudflareManager.getState().publicUrl || localServerManager.getState().localUrl || configManager.getPublicOrigin();
  }

  getState() {
    const sState = localServerManager.getState();
    const cState = cloudflareManager.getState();
    const verifiedOrigin = this.getVerifiedPublicOrigin();
    const isConfirmed = configManager.isDiscordConfigConfirmedFor(verifiedOrigin);
    const isConfigured = configManager.isConfigured();

    let targetHostname = '';
    try {
      if (verifiedOrigin) {
        targetHostname = new URL(verifiedOrigin).hostname;
      }
    } catch {}

    return {
      state: this.state,
      publicUrl: verifiedOrigin,
      verifiedPublicUrl: verifiedOrigin,
      discordTarget: targetHostname || '127.0.0.1',
      discordRedirect: `${verifiedOrigin || 'http://127.0.0.1:3000'}/api/auth/discord/callback`,
      lastError: this.lastError,
      urlNeedsDiscordUpdate: Boolean(verifiedOrigin && !isConfirmed),
      discordConfigConfirmed: isConfirmed,
      confirmedPublicOrigin: configManager.getConfirmedPublicOrigin(),
      serverRunning: sState.state === SERVER_STATES.READY,
      tunnelRunning: cState.state === CLOUDFLARE_STATES.CONNECTED,
      publicEndpointReady: Boolean(verifiedOrigin),
      shareLinkAvailable: Boolean(sState.state === SERVER_STATES.READY),
      isConfigured,
      clientId: configManager.getClientId(),
      localPort: sState.port,
      localUrl: sState.localUrl,
      reconnectAttempts: this._reconnectAttempts,
      pingIntervalActive: this._pingInterval !== null,
      reconnectTimerActive: this.reconnectTimer !== null,
      passiveStandbyActive: this.passiveStandbyTimer !== null,
    };
  }

  setState(newState, extra = {}) {
    this.state = newState;
    if (extra.lastError !== undefined) this.lastError = extra.lastError;
    logger.info(`[ProcessManager] State changed: ${newState}`);
    this.emit('state-change', this.getState());
  }

  async checkHealth(baseUrl = null, timeoutMs = 4000) {
    const targetUrl = baseUrl || localServerManager.getState().localUrl || 'http://127.0.0.1:3000';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${targetUrl}/api/health`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data.ok);
    } catch (err) {
      logger.warn(`[ProcessManager] Health check failed for ${targetUrl}: ${err.message}`);
      return false;
    }
  }

  async start() {
    if (this.passiveStandbyTimer) {
      clearTimeout(this.passiveStandbyTimer);
      this.passiveStandbyTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._reconnectAttempts = 0;

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

      // 1. Iniciar Servidor Local Express + WebSocket
      this.setState(STATES.STARTING_SERVER);
      logger.info('[ProcessManager] 1/2 Iniciando servidor local...');
      const serverState = await localServerManager.start();

      if (!serverState.port) {
        throw new Error('Falha ao obter porta para o servidor local.');
      }
      logger.info(`[ProcessManager] Servidor local online em ${serverState.localUrl}`);

      // 2. Iniciar Cloudflare Tunnel
      this.setState(STATES.STARTING_TUNNEL);
      logger.info(`[ProcessManager] 2/2 Iniciando Cloudflare Tunnel para a porta ${serverState.port}...`);
      const cfState = await cloudflareManager.start(serverState.port);

      logger.info(`[ProcessManager] Cloudflare Tunnel conectado com sucesso: ${cfState.publicUrl}`);

      // 3. Sincronizar endpoints no Broadcaster
      this._syncBroadcasterUrls();

      // 4. Se tiver credenciais de Discord, verifica status
      const validation = configManager.validateDiscordConfiguration();
      const verifiedOrigin = this.getVerifiedPublicOrigin();

      if (validation.valid && !configManager.isDiscordConfigConfirmedFor(verifiedOrigin)) {
        logger.info('[ProcessManager] URL pública alterada ou não confirmada para o Discord.');
      }

      this.setState(STATES.READY);
      return this.getState();
    } catch (err) {
      logger.error('[ProcessManager] Erro durante inicialização do self-hosted:', err);
      this.setState(STATES.ERROR, {
        lastError: {
          code: err.code || 'STARTUP_ERROR',
          title: 'Erro de Inicialização Self-Hosted',
          message: err.message || 'Falha ao iniciar infraestrutura local.',
          technical: err.stack,
        },
      });
      return this.getState();
    }
  }

  // ── Backward-Compatible Control Channel / Reconnect ──────────────────────

  async _connectControlChannel() {
    if (this.isStopping) return;
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

    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }

    if (this.controlWs) {
      const oldWs = this.controlWs;
      this.controlWs = null;
      try {
        oldWs.terminate();
      } catch {}
    }

    const verifiedOrigin = this.getVerifiedPublicOrigin() || 'http://127.0.0.1:3000';
    const wsBaseUrl = verifiedOrigin.replace(/^http/, 'ws');
    const wsUrl = `${wsBaseUrl}/control`;
    logger.info(`[Connection:${currentGeneration}] Conectando canal de controle em ${wsUrl}...`);

    return new Promise((resolve, reject) => {
      if (this.isStopping) {
        return reject(new Error('Conexão cancelada: aplicativo está encerrando.'));
      }

      let resolved = false;
      const ws = new WebSocket(wsUrl);
      this.controlWs = ws;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { ws.terminate(); } catch {}
          reject(new Error('Tempo limite esgotado ao conectar ao canal de controle.'));
        }
      }, 8000);

      ws.on('ping', () => {
        try { ws.pong(); } catch {}
      });

      ws.on('open', () => {
        clearTimeout(timeout);
        if (this.isStopping || this._connectionGeneration !== currentGeneration) {
          try { ws.terminate(); } catch {}
          if (!resolved) { resolved = true; reject(new Error('Superseded by newer connection.')); }
          return;
        }
        if (!resolved) {
          resolved = true;
          logger.info(`[Connection:${currentGeneration}] Canal de controle conectado com sucesso.`);
          this._reconnectAttempts = 0;

          this._pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            }
          }, 10_000);

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

        if (msg.type === 'pong') return;

        if (msg.type === 'desktop-registered') {
          logger.info(`[Connection:${currentGeneration}] Servidor confirmou registro do Client ID: ${msg.activeClientId}`);
        } else if (msg.type === 'oauth-exchange-request') {
          await this._handleOAuthExchangeRequest(msg);
        }
      });

      ws.on('close', () => {
        if (this._connectionGeneration === currentGeneration) {
          if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
          }
          if (this.controlWs === ws) {
            this.controlWs = null;
          }
          logger.warn(`[Connection:${currentGeneration}] Canal de controle desconectado.`);
          if (!this.isStopping && this.state === STATES.READY) {
            this._scheduleReconnect();
          }
        }
      });

      ws.on('error', (err) => {
        if (this._connectionGeneration === currentGeneration) {
          if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
          }
          if (this.controlWs === ws) {
            this.controlWs = null;
          }
        }
        logger.error(`[Connection:${currentGeneration}] Erro no canal de controle: ${err.message}`);
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

      const accessToken = await exchangeOAuthCode(
        activeClientId,
        clientSecret,
        code,
        redirectUri,
      );

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
            type: 'oauth-exchange-error',
            reqId,
            error: err.message,
          }),
        );
      }
    }
  }

  _scheduleReconnect() {
    if (this.isStopping) return;

    if (this.passiveStandbyTimer) {
      clearTimeout(this.passiveStandbyTimer);
      this.passiveStandbyTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const MAX_ATTEMPTS = 8;
    const BASE_MS = 3000;
    const MAX_MS = 30_000;

    if (this._reconnectAttempts >= MAX_ATTEMPTS) {
      logger.warn(
        `[Reconnect] Tier 1 ativo esgotado após ${MAX_ATTEMPTS} tentativas falhas. Entrando em Tier 2 Passive Standby (60s).`,
      );
      this.setState(STATES.ERROR, {
        lastError: {
          code: 'CONTROL_CHANNEL_LOST',
          title: 'Conexão Perdida',
          message:
            'O canal de controle desconectou após múltiplas tentativas. Monitorando recuperação em segundo plano a cada 60s.',
        },
      });
      this._schedulePassiveStandby();
      return;
    }

    const jitter = Math.random() * 1000;
    const delay = Math.min(BASE_MS * 2 ** this._reconnectAttempts + jitter, MAX_MS);
    this._reconnectAttempts++;

    logger.info(
      `[Reconnect:Tier1] Tentativa ${this._reconnectAttempts}/${MAX_ATTEMPTS} em ${Math.round(delay)}ms...`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isStopping && this.state === STATES.READY) {
        try {
          await this._connectControlChannel();
          this._reconnectAttempts = 0;
        } catch (err) {
          logger.warn(`[Reconnect:Tier1] Tentativa ${this._reconnectAttempts} falhou: ${err.message}`);
          this._scheduleReconnect();
        }
      }
    }, delay);
  }

  _schedulePassiveStandby(delayMs = null) {
    if (this.isStopping) return;

    if (this.passiveStandbyTimer) {
      clearTimeout(this.passiveStandbyTimer);
      this.passiveStandbyTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const jitter = Math.random() * 5000;
    const delay = delayMs ?? (60_000 + jitter);

    logger.info(
      `[Passive Standby] Próxima verificação de conectividade agendada em ${Math.round(delay / 1000)}s...`,
    );

    this.passiveStandbyTimer = setTimeout(async () => {
      this.passiveStandbyTimer = null;
      if (this.isStopping || this.state !== STATES.ERROR) return;

      logger.info('[Passive Standby] Sondando conectividade com o servidor...');
      try {
        await this._connectControlChannel();
        logger.info('[Passive Standby] Conexão restabelecida automaticamente! Retornando ao estado READY.');
        this._reconnectAttempts = 0;
        if (this.passiveStandbyTimer) {
          clearTimeout(this.passiveStandbyTimer);
          this.passiveStandbyTimer = null;
        }
        this.setState(STATES.READY, { lastError: null });
      } catch (err) {
        logger.warn(`[Passive Standby] Servidor permanece inacessível (${err.message}). Mantendo standby.`);
        this._schedulePassiveStandby();
      }
    }, delay);
  }

  async manualReconnect() {
    if (this.isStopping) return this.getState();
    logger.info('[ProcessManager] Reconexão manual solicitada pelo usuário.');

    if (this.passiveStandbyTimer) {
      clearTimeout(this.passiveStandbyTimer);
      this.passiveStandbyTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._reconnectAttempts = 0;
    this.setState(STATES.CONNECTING);

    try {
      if (cloudflareManager.getState().state === CLOUDFLARE_STATES.CONNECTED || cloudflareManager.getState().state === CLOUDFLARE_STATES.STARTING) {
        await cloudflareManager.restart();
      } else {
        await this._connectControlChannel();
      }
      this.setState(STATES.READY, { lastError: null });
      return this.getState();
    } catch (err) {
      logger.warn(`[ProcessManager] Reconexão manual falhou: ${err.message}`);
      this.setState(STATES.READY);
      this._scheduleReconnect();
      return this.getState();
    }
  }

  async createStreamingSession() {
    const sState = localServerManager.getState();
    const localBase = sState.localUrl;
    const publicBase = cloudflareManager.getState().publicUrl || localBase;

    if (!localBase) {
      throw new Error('O servidor local não está em execução.');
    }

    logger.info(`[ProcessManager] Criando sessão de transmissão no servidor local (${localBase})...`);

    const guestRes = await fetch(`${localBase}/api/session-guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Desktop Broadcaster' }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json());

    if (!guestRes?.identity) {
      throw new Error('Falha ao emitir sessão anfitriã no servidor local.');
    }

    const roomRes = await fetch(`${localBase}/api/rooms/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity: guestRes.identity,
        name: 'Transmissão Desktop',
      }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json());

    if (!roomRes?.shareUrl) {
      throw new Error('Falha ao criar sala de transmissão no servidor local.');
    }

    // Rebase share URL to public Cloudflare origin for remote viewers
    let publicShareUrl = roomRes.shareUrl;
    if (publicBase && publicBase !== localBase) {
      publicShareUrl = publicShareUrl.replace(localBase, publicBase);
    }

    logger.info(`[ProcessManager] Sessão criada com sucesso: ${publicShareUrl}`);
    return publicShareUrl;
  }

  confirmDiscordConfiguration(origin) {
    const verified = origin || this.getVerifiedPublicOrigin();
    configManager.setConfirmedPublicOrigin(verified);
    configManager.config.firstRunCompleted = true;
    configManager.save();
    logger.info(`[ProcessManager] Configuração do Discord confirmada para: ${verified}`);
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.passiveStandbyTimer) {
      clearTimeout(this.passiveStandbyTimer);
      this.passiveStandbyTimer = null;
    }
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
    if (this.controlWs) {
      try { this.controlWs.terminate(); } catch {}
      this.controlWs = null;
    }

    this.setState(STATES.STOPPING);

    try {
      await cloudflareManager.stop();
    } catch {}

    try {
      await localServerManager.stop();
    } catch {}

    this.setState(STATES.IDLE);
    return this.getState();
  }
}

export const processManager = new ProcessManager();
