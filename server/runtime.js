import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';

import { signToken, verifyToken } from './tokens.js';
import * as R from './rooms.js';
import { systemSnapshot, startSampling } from './system.js';
import { buildAdminDashboard } from './admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let activeRuntime = null;

/**
 * Cria e configura a aplicação e os servidores HTTP/WebSocket sem depender de .env ou dotenv.
 */
export function createAppServer(options = {}) {
  let server = null;
  const {
    port = Number(process.env.PORT) || 3001,
    discordClientId = process.env.DISCORD_CLIENT_ID || null,
    discordClientSecret = process.env.DISCORD_CLIENT_SECRET || null,
    discordBotToken = process.env.DISCORD_BOT_TOKEN || null,
    discordAdminId = process.env.DISCORD_ADMIN_ID || '',
    turnUrl = process.env.TURN_URL || '',
    turnUser = process.env.TURN_USER || '',
    turnPass = process.env.TURN_PASS || '',
    publicOrigin: rawOrigin = process.env.PUBLIC_ORIGIN || null,
    sessionSecret = process.env.SESSION_SECRET || '',
    nodeEnv = process.env.NODE_ENV || 'development',
    staticDirectory = null,
  } = options;

  if (sessionSecret) {
    process.env.SESSION_SECRET = sessionSecret;
  }

  let currentPublicOrigin = rawOrigin ? String(rawOrigin).replace(/[/]+$/, '') : null;
  const getPublicOrigin = () => {
    if (currentPublicOrigin) return currentPublicOrigin;
    const boundPort =
      (server && typeof server.address === 'function' && server.address()?.port) || port;
    return `http://127.0.0.1:${boundPort}`;
  };
  const getVerifiedPublicOrigin = () => {
    if (currentPublicOrigin && currentPublicOrigin.startsWith('https://')) {
      return currentPublicOrigin;
    }
    if (nodeEnv !== 'production') {
      return getPublicOrigin();
    }
    return null;
  };
  const setPublicOrigin = (origin) => {
    currentPublicOrigin = origin ? String(origin).trim().replace(/[/]+$/, '') : null;
  };

  const isProd = nodeEnv === 'production';
  const ADMIN_IDS = new Set(
    String(discordAdminId)
      .split(/[\s,;]+/)
      .filter(Boolean),
  );
  const TEM_ADMIN = ADMIN_IDS.size > 0;
  const ADMIN_COOKIE = 'discord_screen_admin';

  if (TEM_ADMIN) startSampling();

  const app = express();
  app.set('trust proxy', true);

  app.use((req, _res, next) => {
    if (req.url === '/.proxy' || req.url.startsWith('/.proxy/')) {
      req.url = req.url.slice('/.proxy'.length) || '/';
      req.originalUrl = req.url;
    }
    next();
  });

  app.use(express.json());

  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com",
    );
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Cloudflare-Frame-Options', 'allow');
    next();
  });

  app.use(
    express.static(path.join(__dirname, 'public'), {
      extensions: ['html'],
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    }),
  );

  app.use(
    '/shared',
    express.static(path.join(__dirname, '..', 'shared'), {
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    }),
  );

  // ------------------------------------------------------------------ Desktop Control Channel & OAuth Bridge
  const desktopHosts = new Set();
  let activeDesktopClientId = null;
  const pendingOAuthExchanges = new Map(); // reqId -> { resolve, reject, timer }

  function delegateOAuthExchange(code, clientId) {
    if (desktopHosts.size === 0) {
      return Promise.reject(
        new Error('O aplicativo Desktop do Discord Screen não está aberto no computador do anfitrião.'),
      );
    }

    const host = desktopHosts.values().next().value;
    const reqId = crypto.randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingOAuthExchanges.delete(reqId);
        reject(new Error('Tempo limite esgotado ao aguardar autorização do aplicativo Desktop.'));
      }, 12000);

      pendingOAuthExchanges.set(reqId, { resolve, reject, timer });

      R.sendJson(host, {
        type: 'oauth-exchange-request',
        reqId,
        code,
        clientId: clientId || activeDesktopClientId || discordClientId,
        redirectUri: getRedirectUri(),
      });
    });
  }

  // ------------------------------------------------------------------ OAuth

  app.post('/api/token', async (req, res) => {
    const { code, client_id } = req.body ?? {};
    if (!code) return res.status(400).json({ error: 'code obrigatorio' });

    const effectiveClientId = client_id || activeDesktopClientId || discordClientId;

    if (client_id && discordClientId && client_id !== discordClientId && !activeDesktopClientId) {
      console.error(
        `[oauth] atividade e da aplicacao ${client_id}, mas o servidor tem ${discordClientId}`,
      );
      return res.status(409).json({
        error:
          `Esta atividade é da aplicação ${client_id}, mas o servidor está configurado ` +
          `com a ${discordClientId}. As duas precisam ser a mesma.`,
      });
    }

    // Se temos secret configurado no servidor, usa direto
    if (discordClientId && discordClientSecret) {
      try {
        const r = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: discordClientId,
            client_secret: discordClientSecret,
            grant_type: 'authorization_code',
            code,
          }),
        });

        const data = await r.json();
        if (!data.access_token) {
          console.error('[oauth] Discord recusou a troca:', data);
          const motivo = data.error_description || data.error || 'motivo não informado';
          return res.status(401).json({ error: `O Discord recusou o login: ${motivo}` });
        }
        return res.json({ access_token: data.access_token });
      } catch (err) {
        console.error('[oauth] erro:', err);
        return res.status(500).json({ error: 'erro interno' });
      }
    }

    // Modo Railway com Desktop Privado: delega a troca de token ao Electron Main local
    if (desktopHosts.size === 0) {
      return res.status(500).json({
        error:
          'O servidor está sem as credenciais do Discord. Abra o aplicativo Desktop ou configure as credenciais.',
      });
    }

    try {
      const result = await delegateOAuthExchange(code, effectiveClientId);
      if (!result?.access_token) {
        return res.status(401).json({ error: result?.error || 'Falha na autenticação do Discord.' });
      }
      return res.json({ access_token: result.access_token });
    } catch (err) {
      console.error('[oauth-delegated] erro:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/session', async (req, res) => {
    const { access_token, instance_id, guild_id, channel_id } = req.body ?? {};
    if (!access_token || !instance_id) {
      return res.status(400).json({ error: 'access_token e instance_id obrigatorios' });
    }

    try {
      const me = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${access_token}` },
      }).then((r) => r.json());

      if (!me?.id) return res.status(401).json({ error: 'token invalido' });

      const guildId = /^[0-9]{15,21}$/.test(String(guild_id ?? '')) ? String(guild_id) : null;
      const channelId = /^[0-9]{15,21}$/.test(String(channel_id ?? '')) ? String(channel_id) : null;
      const [presenca, guildName] = await Promise.all([
        inVoiceChannel(guildId, channelId, me.id),
        resolveGuildName(guildId),
      ]);
      if (presenca === 'fora') {
        return res.status(403).json({ error: 'Entre na call antes de abrir a atividade.' });
      }

      const verificado = {
        ...(presenca === 'ok' ? { call: channelId } : {}),
        ...(guildId ? { guild: guildId } : {}),
        ...(guildName ? { guildName } : {}),
        ...(channelId ? { channel: channelId } : {}),
      };

      const identity = issueIdentity(
        instance_id,
        me.id,
        me.global_name || me.username,
        me.avatar ?? null,
        8 * 60 * 60,
        verificado,
      );

      const comoMe = {
        uid: me.id,
        name: me.global_name || me.username,
        av: me.avatar ?? null,
        instance: instance_id,
        ...verificado,
      };
      const salaDela = R.ensureCallRoom(comoMe.instance, salaDaCall(comoMe), {
        guildId: comoMe.guild ?? null,
        guildName: comoMe.guildName ?? null,
        channelId: comoMe.channel ?? comoMe.call ?? null,
      });

      res.json({
        ...identity,
        call: presenca === 'ok' ? channelId : null,
        guild: guildId,
        guildName,
        channel: channelId,
        sala: issueRoomTokens(salaDela.id, comoMe),
      });
    } catch (err) {
      console.error('[session] erro:', err);
      res.status(500).json({ error: 'erro interno' });
    }
  });

  app.post('/api/session-dev', (req, res) => {
    if (isProd) return res.status(404).end();
    const { instance_id = 'dev', name = 'Dev', call = null } = req.body ?? {};
    res.json(
      issueIdentity(instance_id, `dev-${name}`, name, null, 8 * 60 * 60, call ? { call } : {}),
    );
  });

  app.post('/api/session-guest', (req, res) => {
    const raw = String(req.body?.name ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 32);
    const name = raw || `Convidado ${Math.floor(Math.random() * 9000 + 1000)}`;
    const uid = `guest-${crypto.randomBytes(8).toString('base64url')}`;
    res.json(issueIdentity(WEB_INSTANCE, uid, name, null, 30 * 24 * 60 * 60));
  });

  function issueIdentity(instance, uid, name, avatar, ttl = 8 * 60 * 60, extra = {}) {
    return {
      user: { id: uid, name, avatar },
      instance,
      identity: signToken({ instance, uid, name, av: avatar, scope: 'identity', ...extra }, ttl),
    };
  }

  const guildCache = new Map();

  async function resolveGuildName(guildId) {
    if (!discordBotToken || !guildId) return null;

    const cached = guildCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;

    let name = null;
    try {
      const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
        headers: { Authorization: `Bot ${discordBotToken}` },
        signal: AbortSignal.timeout(5000),
      });
      const guild = response.ok ? await response.json() : null;
      if (typeof guild?.name === 'string') name = guild.name;
    } catch {
      name = null;
    }

    guildCache.set(guildId, {
      name,
      expiresAt: Date.now() + (name ? 60 * 60 * 1000 : 10 * 60 * 1000),
    });
    return name;
  }

  async function inVoiceChannel(guildId, channelId, userId) {
    if (!discordBotToken || !guildId || !channelId) return 'indisponivel';

    try {
      const r = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/voice-states/${userId}`,
        {
          headers: { Authorization: `Bot ${discordBotToken}` },
        },
      );

      if (r.status === 404) {
        const erro = await r.json().catch(() => ({}));
        if (erro?.code === 10004) {
          console.warn('[voz] o bot nao esta neste servidor — escopo cai para a instancia');
          return 'indisponivel';
        }
        return 'fora';
      }
      if (!r.ok) {
        console.warn(`[voz] Discord respondeu ${r.status} — verificação ignorada`);
        return 'indisponivel';
      }

      const state = await r.json();
      return state?.channel_id === channelId ? 'ok' : 'fora';
    } catch (err) {
      console.warn('[voz] falhou:', err.message);
      return 'indisponivel';
    }
  }

  const AVATAR_ID = /^[0-9]{15,21}$/;
  const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;
  const AVATAR_CACHE = new Map();
  const AVATAR_CACHE_MAX = 200;

  app.get('/api/avatar/:id/:hash', async (req, res) => {
    const { id, hash } = req.params;
    if (!AVATAR_ID.test(id) || !AVATAR_HASH.test(hash)) return res.status(400).end();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

    const chave = `${id}/${hash}`;
    const guardado = AVATAR_CACHE.get(chave);
    if (guardado) return res.end(guardado);

    try {
      const upstream = await fetch(
        `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=128`,
        {
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!upstream.ok) return res.status(404).end();

      const imagem = Buffer.from(await upstream.arrayBuffer());
      if (AVATAR_CACHE.size >= AVATAR_CACHE_MAX) {
        AVATAR_CACHE.delete(AVATAR_CACHE.keys().next().value);
      }
      AVATAR_CACHE.set(chave, imagem);

      res.end(imagem);
    } catch {
      res.status(502).end();
    }
  });

  function identityOf(req, res) {
    const payload = verifyToken(req.body?.identity);
    if (!payload || payload.scope !== 'identity') {
      res.status(401).json({ error: 'identidade invalida ou expirada' });
      return null;
    }
    return payload;
  }

  function issueRoomTokens(roomId, me) {
    const base = {
      room: roomId,
      uid: me.uid,
      name: me.name,
      av: me.av ?? null,
      guild: me.guild ?? null,
      channel: me.channel ?? me.call ?? null,
    };
    const origin = getPublicOrigin();
    return {
      roomId,
      viewerToken: signToken({ ...base, role: 'viewer' }),
      shareUrl: `${origin}/share.html?t=${encodeURIComponent(
        signToken({ ...base, role: 'broadcaster' }),
      )}`,
    };
  }

  // ---------------------------------------------------------------------- salas

  app.post('/api/rooms/list', (req, res) => {
    const me = verifyToken(req.body?.identity);
    const instance = me?.scope === 'identity' ? me.instance : WEB_INSTANCE;
    res.json({ rooms: R.listRooms(instance) });
  });

  app.post('/api/rooms/create', (req, res) => {
    const me = identityOf(req, res);
    if (!me) return;

    const { room, error } = R.createRoom({
      instance: me.instance,
      name: req.body?.name,
      ownerId: me.uid,
      ownerName: me.name,
      password: req.body?.password || null,
      guildId: me.guild ?? null,
      guildName: me.guildName ?? null,
      channelId: me.channel ?? null,
    });
    if (error) return res.status(400).json({ error });

    console.log(`[room ${room.id}] criada por ${me.name}: "${room.name}"`);
    res.json(issueRoomTokens(room.id, me));
  });

  const salaDaCall = (me) => (me.call ? `call-${me.call}` : `atividade-${me.instance}`);

  app.post('/api/rooms/call', (req, res) => {
    const me = identityOf(req, res);
    if (!me) return;

    const room = R.ensureCallRoom(me.instance, salaDaCall(me), {
      guildId: me.guild ?? null,
      guildName: me.guildName ?? null,
      channelId: me.channel ?? me.call ?? null,
    });
    res.json(issueRoomTokens(room.id, me));
  });

  app.post('/api/rooms/join', (req, res) => {
    const me = identityOf(req, res);
    if (!me) return;

    const room = R.getRoom(req.body?.roomId);
    if (!room) return res.status(404).json({ error: 'Sala não existe mais.' });

    if (room.isCall) {
      if (room.id !== salaDaCall(me)) {
        return res.status(403).json({ error: 'Entre na call para acessar esta sala.' });
      }
      return res.json(issueRoomTokens(room.id, me));
    }

    if (room.instance !== me.instance) {
      return res.status(404).json({ error: 'Sala não existe mais.' });
    }

    const check = R.checkPassword(room, req.body?.password);
    if (!check.ok) {
      return res.status(check.reason === 'bloqueado' ? 429 : 403).json({
        error:
          check.reason === 'bloqueado'
            ? `Muitas tentativas. Tente de novo em ${check.seconds}s.`
            : 'Senha incorreta.',
        reason: check.reason,
      });
    }

    res.json(issueRoomTokens(room.id, me));
  });

  app.post('/api/rooms/open', (req, res) => {
    const ingresso = verifyToken(req.body?.token);
    if (!ingresso?.room || ingresso.role !== 'viewer') {
      return res.status(401).json({ error: 'Link inválido ou expirado.' });
    }

    const room = R.getRoom(ingresso.room);
    if (!room) return res.status(404).json({ error: 'Sala não existe mais.' });

    res.json({ ...issueRoomTokens(room.id, ingresso), name: room.name });
  });

  app.post('/api/rooms/password', (req, res) => {
    const me = identityOf(req, res);
    if (!me) return;

    const room = R.getRoom(req.body?.roomId);
    if (!room || room.instance !== me.instance) {
      return res.status(404).json({ error: 'Sala não existe mais.' });
    }

    const error = R.setPassword(room, me.uid, req.body?.password || null);
    if (error) return res.status(403).json({ error });

    res.json({ ok: true, locked: Boolean(room.password) });
  });

  // ------------------------------------------------- login web (fora do Discord)

  const WEB_INSTANCE = 'web';
  const getRedirectUri = () => `${getPublicOrigin()}/auth/callback`;

  function discordAuthorizeUrl(state = null) {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', discordClientId || '');
    url.searchParams.set('redirect_uri', getRedirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    if (state) url.searchParams.set('state', state);
    return url;
  }

  app.get('/auth/login', (_req, res) => {
    const url = discordAuthorizeUrl();
    res.redirect(url.toString());
  });

  app.get('/admin/auth/login', (_req, res) => {
    if (!TEM_ADMIN) return res.redirect('/admin?error=not_configured');
    if (!discordClientId || !discordClientSecret) {
      return res.redirect('/admin?error=discord_not_configured');
    }

    const state = signToken(
      {
        scope: 'oauth-state',
        target: 'admin',
        nonce: crypto.randomBytes(12).toString('base64url'),
      },
      10 * 60,
    );
    res.redirect(discordAuthorizeUrl(state).toString());
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const oauthState = verifyToken(typeof state === 'string' ? state : '');
    const adminFlow = oauthState?.scope === 'oauth-state' && oauthState.target === 'admin';
    if (!code) return res.redirect(adminFlow ? '/admin?error=sem_codigo' : '/?erro=sem_codigo');

    try {
      const token = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: discordClientId || '',
          client_secret: discordClientSecret || '',
          grant_type: 'authorization_code',
          redirect_uri: getRedirectUri(),
          code: String(code),
        }),
      }).then((r) => r.json());

      if (!token.access_token) {
        return res.redirect(adminFlow ? '/admin?error=troca_falhou' : '/?erro=troca_falhou');
      }

      const me = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }).then((r) => r.json());

      if (!me?.id) {
        return res.redirect(adminFlow ? '/admin?error=perfil_falhou' : '/?erro=perfil_falhou');
      }

      if (adminFlow) {
        if (!ADMIN_IDS.has(me.id)) return res.redirect('/admin?error=forbidden');

        const adminSession = signToken(
          {
            scope: 'admin',
            uid: me.id,
            name: me.global_name || me.username,
            av: me.avatar ?? null,
          },
          8 * 60 * 60,
        );
        const secure = getPublicOrigin().startsWith('https://') ? '; Secure' : '';
        res.setHeader(
          'Set-Cookie',
          `${ADMIN_COOKIE}=${adminSession}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 60 * 60}${secure}`,
        );
        return res.redirect('/admin');
      }

      const identity = issueIdentity(
        WEB_INSTANCE,
        me.id,
        me.global_name || me.username,
        me.avatar ?? null,
      );

      res.redirect(`/#identity=${encodeURIComponent(identity.identity)}`);
    } catch (err) {
      console.error('[auth] erro:', err);
      res.redirect(adminFlow ? '/admin?error=interno' : '/?erro=interno');
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/ice', (_req, res) => {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

    if (turnUrl) {
      const turn = { urls: turnUrl };
      if (turnUser) turn.username = turnUser;
      if (turnPass) turn.credential = turnPass;
      iceServers.push(turn);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ iceServers });
  });

  function cookieOf(req, name) {
    for (const item of String(req.headers.cookie ?? '').split(';')) {
      const separator = item.indexOf('=');
      if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
      try {
        return decodeURIComponent(item.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
    return null;
  }

  function adminOf(req) {
    const session = verifyToken(cookieOf(req, ADMIN_COOKIE));
    if (!session || session.scope !== 'admin' || !ADMIN_IDS.has(session.uid)) return null;
    return session;
  }

  function requireAdmin(req, res, next) {
    const admin = adminOf(req);
    if (!admin) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(401).json({ error: 'admin_required', configured: TEM_ADMIN });
    }
    req.admin = admin;
    res.setHeader('Cache-Control', 'no-store');
    next();
  }

  app.get('/api/admin/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!TEM_ADMIN) return res.status(503).json({ configured: false, error: 'not_configured' });
    const admin = adminOf(req);
    if (!admin) return res.status(401).json({ configured: true, error: 'admin_required' });
    res.json({
      configured: true,
      user: { id: admin.uid, name: admin.name, avatar: admin.av ?? null },
    });
  });

  app.post('/api/admin/logout', (_req, res) => {
    const secure = getPublicOrigin().startsWith('https://') ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  app.get('/api/admin/metrics', requireAdmin, (_req, res) => {
    const dashboard = buildAdminDashboard({
      roomState: R.adminStats(),
      sockets: wss.clients,
      system: systemSnapshot(),
      configuration: {
        environment: nodeEnv,
        port: Number(port),
        publicOrigin: getPublicOrigin(),
        clientId: discordClientId || null,
        botConfigured: Boolean(discordBotToken),
        adminIds: [...ADMIN_IDS],
        sessionSecretConfigured: Boolean(sessionSecret || process.env.SESSION_SECRET),
      },
    });
    res.json(dashboard);
  });

  const clientDist = staticDirectory || path.join(__dirname, '..', 'client', 'dist');

  app.get('/api/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    let asset = null;
    try {
      const html = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8');
      asset = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? null;
    } catch {
      // Ainda sem build
    }

    res.json({ clientId: activeDesktopClientId || discordClientId || null, asset });
  });

  app.use(
    express.static(clientDist, {
      setHeaders: (res, filePath) => {
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-store');
      },
    }),
  );

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(clientDist, 'index.html'), (err) => err && next());
  });

  // -------------------------------------------------------------- WebSocket

  server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      try {
        server.listen(0);
      } catch {
        // ignore
      }
      return;
    }
    throw err;
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/^\/\.proxy/, '');

    if (pathname === '/control') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleDesktopControl(ws);
      });
      return;
    }

    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const payload = verifyToken(url.searchParams.get('t'));
    if (!payload || !payload.room) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const pedida = url.searchParams.get('fonte');
    const fonte = R.FONTES.has(pedida) ? pedida : 'tela';
    const controle = url.searchParams.get('modo') === 'controle';

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, payload, fonte, controle);
    });
  });

  function handleDesktopControl(ws) {
    ws.__alive = true;
    ws.__missedPings = 0;
    ws.__connectedAt = Date.now();
    ws.__rttMs = null;
    ws.__pingSentAt = null;

    ws.on('pong', () => {
      ws.__alive = true;
      ws.__missedPings = 0;
      if (ws.__pingSentAt) {
        const measured = Date.now() - ws.__pingSentAt;
        ws.__rttMs = Number.isFinite(ws.__rttMs) ? ws.__rttMs * 0.7 + measured * 0.3 : measured;
        ws.__pingSentAt = null;
      }
    });

    desktopHosts.add(ws);
    console.log('[control] Desktop host conectado.');

    ws.on('message', (data, isBinary) => {
      ws.__alive = true;
      ws.__missedPings = 0;
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        R.sendJson(ws, { type: 'pong', timestamp: msg.timestamp || Date.now() });
        return;
      }

      if (msg.type === 'pong') {
        return;
      }

      if (msg.type === 'register-desktop') {
        if (msg.clientId && typeof msg.clientId === 'string') {
          activeDesktopClientId = msg.clientId.trim();
          console.log(`[control] Desktop registrou Client ID: ${activeDesktopClientId}`);
        }
        R.sendJson(ws, {
          type: 'desktop-registered',
          ok: true,
          activeClientId: activeDesktopClientId,
        });
      } else if (msg.type === 'oauth-exchange-response') {
        const pending = pendingOAuthExchanges.get(msg.reqId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingOAuthExchanges.delete(msg.reqId);
          if (msg.access_token) {
            pending.resolve({ access_token: msg.access_token });
          } else {
            pending.reject(new Error(msg.error || 'Discord recusou a troca de token no desktop.'));
          }
        }
      }
    });

    const cleanup = () => {
      desktopHosts.delete(ws);
      console.log('[control] Desktop host desconectado.');
      if (desktopHosts.size === 0) {
        activeDesktopClientId = null;
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  wss.on('connection', (ws, _req, auth, fonte, controle) => {
    ws.__alive = true;
    ws.__missedPings = 0;
    ws.__connectedAt = Date.now();
    ws.__rttMs = null;
    ws.__pingSentAt = null;

    ws.on('pong', () => {
      ws.__alive = true;
      ws.__missedPings = 0;
      if (ws.__pingSentAt) {
        const measured = Date.now() - ws.__pingSentAt;
        ws.__rttMs = Number.isFinite(ws.__rttMs) ? ws.__rttMs * 0.7 + measured * 0.3 : measured;
        ws.__pingSentAt = null;
      }
    });

    const room = R.getRoom(auth.room);

    if (!room) {
      R.sendJson(ws, { type: 'room-gone' });
      ws.close();
      return;
    }

    if (auth.role === 'broadcaster' && controle) {
      handleControl(ws, room, auth);
    } else if (auth.role === 'broadcaster') {
      handleBroadcaster(
        ws,
        room,
        { id: auth.uid, name: auth.name, avatar: auth.av ?? null },
        fonte,
      );
    } else {
      handleViewer(ws, room, auth);
    }
  });

  function handleControl(ws, room, auth) {
    R.attachControl(room, ws, auth.uid);
    console.log(`[room ${room.id}] aba de captura de ${auth.name} conectada`);

    R.broadcastState(room);

    ws.on('message', (data, isBinary) => {
      ws.__alive = true;
      ws.__missedPings = 0;
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          R.sendJson(ws, { type: 'pong', timestamp: msg.timestamp || Date.now() });
        }
      } catch {
        // ignore
      }
    });

    const sair = () => {
      R.detachControl(room, ws);
      R.broadcastState(room);
    };
    ws.on('close', sair);
    ws.on('error', sair);
  }

  function handleBroadcaster(ws, room, info, fonte) {
    const entry = R.attachBroadcaster(room, ws, info, fonte);

    if (typeof entry === 'string') {
      R.sendJson(ws, { type: 'error', message: entry });
      ws.close();
      return;
    }

    console.log(
      `[room ${room.id}] broadcaster conectado: ${info.name} · ${fonte} (slot ${entry.slot})`,
    );

    ws.on('message', (data, isBinary) => {
      ws.__alive = true;
      ws.__missedPings = 0;
      if (isBinary) {
        R.pushChunk(room, entry, data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        R.sendJson(ws, { type: 'pong', timestamp: msg.timestamp || Date.now() });
        return;
      } else if (msg.type === 'pong') {
        return;
      } else if (msg.type === 'start') {
        R.startStream(room, entry);
        console.log(`[room ${room.id}] stream iniciada por ${info.name}`);
      } else if (msg.type === 'config' && msg.config) {
        R.setConfig(room, entry, msg.config);
        console.log(`[room ${room.id}] codec de ${info.name}: ${msg.config.codec}`);
      } else if (msg.type === 'audio-config' && msg.config) {
        R.setAudioConfig(room, entry, msg.config);
        console.log(`[room ${room.id}] audio de ${info.name}: ${msg.config.codec}`);
      } else if (msg.type === 'rtc' && typeof msg.peer === 'string' && msg.payload) {
        R.rtcParaViewer(room, entry, msg.peer, msg.payload);
      } else if (msg.type === 'stop') {
        R.stopStream(room, entry);
        console.log(`[room ${room.id}] stream parada por ${info.name}`);
      }
    });

    ws.on('close', () => {
      R.detachBroadcaster(room, ws);
      console.log(`[room ${room.id}] broadcaster saiu: ${info.name}`);
    });
  }

  function handleViewer(ws, room, auth) {
    R.attachViewer(room, ws, { id: auth.uid, name: auth.name, avatar: auth.av ?? null });

    ws.on('message', (data, isBinary) => {
      ws.__alive = true;
      ws.__missedPings = 0;
      if (isBinary) return;

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        R.sendJson(ws, { type: 'pong', timestamp: msg.timestamp || Date.now() });
        return;
      }

      if (msg.type === 'pong') {
        return;
      }

      if (msg.type === 'rename') {
        R.rename(room, ws, msg.name);
        return;
      }

      if (msg.type === 'watch' && Number.isInteger(msg.slot)) {
        R.watch(room, ws, msg.slot);
        return;
      }

      if (msg.type === 'unwatch' && Number.isInteger(msg.slot)) {
        R.unwatch(room, ws, msg.slot);
        return;
      }

      if (msg.type === 'rtc' && Number.isInteger(msg.slot) && msg.payload) {
        R.rtcParaBroadcaster(room, ws, msg.slot, msg.payload);
        return;
      }

      if (msg.type === 'rtc-ativo' && Number.isInteger(msg.slot)) {
        R.rtcAtivo(room, ws, msg.slot, Boolean(msg.on));
        return;
      }

      if (msg.type === 'start-broadcast' && R.FONTES.has(msg.fonte)) {
        const n = R.toControls(room, auth.uid, {
          type: 'start-request',
          fonte: msg.fonte,
          opcoes: msg.opcoes,
        });
        if (n) console.log(`[room ${room.id}] ${auth.name} pediu ${msg.fonte} à própria aba`);
        return;
      }

      if (msg.type === 'config-broadcast' && msg.opcoes) {
        R.toControls(room, auth.uid, { type: 'config-request', opcoes: msg.opcoes });
        return;
      }

      if (msg.type === 'stop-broadcast') {
        const fonte = R.FONTES.has(msg.fonte) ? msg.fonte : null;
        const alvos = R.broadcastersOf(room, auth.uid, fonte);

        for (const entry of alvos) R.sendJson(entry.ws, { type: 'stop-request' });
        if (alvos.length) {
          console.log(
            `[room ${room.id}] parada pedida por ${auth.name}: ${alvos.map((e) => e.fonte).join(', ')}`,
          );
        }
      }
    });

    ws.on('close', () => R.detachViewer(room, ws));
    ws.on('error', () => R.detachViewer(room, ws));
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      // Tolera até 3 ciclos de ping sem resposta antes de terminar
      if (ws.__alive === false) {
        ws.__missedPings = (ws.__missedPings || 0) + 1;
        if (ws.__missedPings >= 3) {
          console.warn('[ws heartbeat] encerrando conexao inativa apos 3 pings sem resposta');
          ws.terminate();
          continue;
        }
      } else {
        ws.__missedPings = 0;
      }
      ws.__alive = false;
      ws.__pingSentAt = Date.now();
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, 15_000);

  wss.on('connection', (ws) => {
    ws.__alive = true;
    ws.on('pong', () => {
      ws.__alive = true;
      if (ws.__pingSentAt) {
        const measured = Date.now() - ws.__pingSentAt;
        ws.__rttMs = Number.isFinite(ws.__rttMs) ? ws.__rttMs * 0.7 + measured * 0.3 : measured;
        ws.__pingSentAt = null;
      }
    });
  });

  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  return {
    app,
    server,
    wss,
    heartbeat,
    port: Number(port),
    getPublicOrigin,
    getVerifiedPublicOrigin,
    setPublicOrigin,
  };
}

/**
 * Inicia o servidor backend na porta informada e aguarda listening.
 */
export async function startServer(options = {}) {
  if (activeRuntime?.server?.listening) {
    return activeRuntime;
  }

  const instance = createAppServer(options);
  const { server, port } = instance;

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListen);
      reject(err);
    };
    const onListen = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port);
  });

  activeRuntime = instance;
  return instance;
}

/**
 * Atualiza dinamicamente o endereço público ativo no runtime em execução.
 */
export function setPublicOrigin(origin) {
  if (activeRuntime?.setPublicOrigin) {
    activeRuntime.setPublicOrigin(origin);
  }
}

/**
 * Retorna o endereço público atual do runtime ativo.
 */
export function getPublicOrigin() {
  if (activeRuntime?.getPublicOrigin) {
    return activeRuntime.getPublicOrigin();
  }
  return null;
}

/**
 * Retorna o endereço público verificado do runtime ativo.
 */
export function getVerifiedPublicOrigin() {
  if (activeRuntime?.getVerifiedPublicOrigin) {
    return activeRuntime.getVerifiedPublicOrigin();
  }
  return null;
}

/**
 * Encerra o servidor backend e o WebSocket ativos.
 */
export async function stopServer() {
  if (!activeRuntime) return;

  const { server, wss, heartbeat } = activeRuntime;
  clearInterval(heartbeat);

  try {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => wss.close(resolve));
  } catch {
    // ignore
  }

  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }

  activeRuntime = null;
}
