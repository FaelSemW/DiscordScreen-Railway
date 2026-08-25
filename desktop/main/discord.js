import { logger } from './logger.js';

let shell = null;
if (process.versions?.electron) {
  try {
    const electron = await import('electron');
    shell = electron.shell || electron.default?.shell || null;
  } catch {
    // Fallback
  }
}

const API_V10 = 'https://discord.com/api/v10';
const PRIMARY_ENTRY_POINT = 4;
const DISCORD_LAUNCH_ACTIVITY = 2;

export function validateClientId(id) {
  if (!id || typeof id !== 'string') return 'O Client ID é obrigatório.';
  const clean = id.trim().replace(/\s+/g, '');
  if (!clean) return 'O Client ID é obrigatório.';
  if (!/^[0-9]{15,22}$/.test(clean)) {
    return 'O Client ID deve conter apenas números (15 a 21 dígitos).';
  }
  return null;
}

export function validateClientSecret(secret) {
  if (!secret || typeof secret !== 'string') return 'O Client Secret é obrigatório.';
  const clean = secret.trim();
  if (!clean) return 'O Client Secret é obrigatório.';
  if (clean.length < 20) {
    return 'O Client Secret informado parece muito curto. Copie o Secret completo gerado no Discord.';
  }
  return null;
}

export function validateBotToken(token) {
  if (!token || typeof token !== 'string') return null;
  const clean = token.trim();
  if (clean === '') return null;
  if (clean.length < 50) {
    return 'O Token do Bot informado parece inválido ou muito curto.';
  }
  return null;
}

export function validateAdminId(id) {
  if (!id || typeof id !== 'string') return null;
  const clean = id.trim();
  if (clean === '') return null;
  const ids = clean.split(/[\s,;]+/).filter(Boolean);
  for (const item of ids) {
    if (!/^[0-9]{15,21}$/.test(item)) {
      return `O ID de administrador "${item}" não é válido. Use o ID numérico da sua conta Discord.`;
    }
  }
  return null;
}

/**
 * Executes OAuth2 code exchange directly from Electron Main process.
 * The Client Secret NEVER leaves the user's PC!
 */
export async function exchangeOAuthCode(clientId, clientSecret, code, redirectUri) {
  if (!clientId || !clientSecret || !code) {
    throw new Error('Parâmetros obrigatórios ausentes para troca de token.');
  }

  logger.info(`[OAuth Local] Executando troca de código OAuth para aplicação ${clientId}`);
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code: String(code),
  });
  if (redirectUri) {
    params.set('redirect_uri', redirectUri);
  }

  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    const motivo = data.error_description || data.error || `HTTP ${res.status}`;
    logger.error(`[OAuth Local] Discord recusou a troca de token: ${motivo}`);
    throw new Error(`Discord recusou o login: ${motivo}`);
  }

  logger.info('[OAuth Local] Troca de token concluída com sucesso no processo local.');
  return data.access_token;
}

export async function fetchDiscordToken(clientId, clientSecret) {
  const res = await fetch(`${API_V10}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'applications.commands.update',
    }),
  });

  if (!res.ok) {
    throw new Error(`Discord recusou as credenciais (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.access_token;
}

export async function ensureDiscordEntryPoint(clientId, clientSecret) {
  if (!clientId || !clientSecret) return { status: 'skipped', message: 'Credenciais ausentes' };

  try {
    const token = await fetchDiscordToken(clientId, clientSecret);
    const route = `${API_V10}/applications/${clientId}/commands`;
    const headers = { Authorization: `Bearer ${token}` };

    const listRes = await fetch(route, { headers });
    if (!listRes.ok) {
      throw new Error(`Falha ao listar comandos existentes: HTTP ${listRes.status}`);
    }

    const commands = await listRes.json();
    const exists = Array.isArray(commands) && commands.some((c) => c.type === PRIMARY_ENTRY_POINT);
    if (exists) {
      logger.info('Atalho de atividade (PRIMARY_ENTRY_POINT) já registrado no Discord.');
      return { status: 'exists', message: 'Atalho da atividade já configurado no Discord.' };
    }

    const createRes = await fetch(route, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'abrir',
        description: 'Abrir a Sala de Tela no canal de voz',
        type: PRIMARY_ENTRY_POINT,
        handler: DISCORD_LAUNCH_ACTIVITY,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Falha ao registrar comando: HTTP ${createRes.status} ${errText}`);
    }

    logger.info('Atalho de atividade (PRIMARY_ENTRY_POINT) registrado com sucesso no Discord.');
    return { status: 'created', message: 'Atalho da atividade criado automaticamente no Discord!' };
  } catch (err) {
    logger.warn(`Verificação do entry point do Discord: ${err.message}`);
    return { status: 'warning', message: err.message };
  }
}

export async function openDiscordApp() {
  try {
    if (shell) await shell.openExternal('discord://');
    return true;
  } catch {
    try {
      if (shell) await shell.openExternal('https://discord.com/app');
      return true;
    } catch {
      return false;
    }
  }
}

export async function openCapturePage(captureUrl) {
  if (!captureUrl) return false;
  try {
    if (shell) await shell.openExternal(captureUrl);
    return true;
  } catch (err) {
    logger.error(`Erro ao abrir página de captura: ${err.message}`);
    return false;
  }
}
