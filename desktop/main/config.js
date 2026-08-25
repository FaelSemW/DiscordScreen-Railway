import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from './logger.js';

let safeStorage = null;
if (process.versions?.electron) {
  try {
    const electron = await import('electron');
    safeStorage = electron.safeStorage || electron.default?.safeStorage || null;
  } catch {
    // Fallback
  }
}

export class ConfigManager {
  constructor(customConfigPath = null) {
    // Isolated directory strictly for the Railway private client
    this.configDir = customConfigPath
      ? path.dirname(customConfigPath)
      : path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
          'DiscordScreenRailway',
        );
    this.configFile = customConfigPath || path.join(this.configDir, 'config.json');
    this.config = this.getDefaults();

    try {
      fs.mkdirSync(this.configDir, { recursive: true });
    } catch {
      // Ignore directory creation error
    }

    this.load();
  }

  getDefaults() {
    return {
      schemaVersion: 1,
      version: '1.0.0',
      discordClientId: '',
      discordClientSecretEncrypted: '',
      discordBotTokenEncrypted: '',
      discordAdminId: '',
      publicOrigin: 'https://zaprecovery.online',
      confirmedPublicOrigin: '',
      firstRunCompleted: false,
      beginnerMode: true,
      theme: 'dark',
      language: 'pt-BR',
      minimizeToTray: true,
    };
  }

  _encrypt(plainText) {
    if (!plainText || typeof plainText !== 'string') return '';
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        const buffer = safeStorage.encryptString(plainText);
        return `dpapi:${buffer.toString('base64')}`;
      }
    } catch (err) {
      logger.warn(`DPAPI encryption failed, falling back to local cipher: ${err.message}`);
    }

    // Fallback machine-specific encryption if safeStorage is not available
    const machineId = `${os.hostname()}-${os.userInfo().username}-DiscordScreenRailway`;
    const key = crypto.createHash('sha256').update(machineId).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `aes:${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  _decrypt(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string') return '';
    if (encryptedText.startsWith('dpapi:')) {
      const base64Data = encryptedText.slice(6);
      try {
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(base64Data, 'base64'));
        }
      } catch (err) {
        logger.error(`DPAPI decryption error: ${err.message}`);
        return '';
      }
    }

    if (encryptedText.startsWith('aes:')) {
      try {
        const parts = encryptedText.split(':');
        if (parts.length === 4) {
          const iv = Buffer.from(parts[1], 'hex');
          const authTag = Buffer.from(parts[2], 'hex');
          const data = parts[3];
          const machineId = `${os.hostname()}-${os.userInfo().username}-DiscordScreenRailway`;
          const key = crypto.createHash('sha256').update(machineId).digest();
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(authTag);
          let decrypted = decipher.update(data, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          return decrypted;
        }
      } catch (err) {
        logger.error(`AES decryption error: ${err.message}`);
        return '';
      }
    }

    return encryptedText;
  }

  load() {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        const parsed = JSON.parse(raw);
        this.config = { ...this.getDefaults(), ...parsed };
      } else {
        this.config = this.getDefaults();
      }
    } catch (err) {
      logger.error(`Failed to load config: ${err.message}`);
      this.config = this.getDefaults();
    }

    // Always enforce the fixed production domain
    this.config.publicOrigin = 'https://zaprecovery.online';

    this._registerSecretsInLogger();
    return this.config;
  }

  _registerSecretsInLogger() {
    const secret = this.getClientSecret();
    if (secret) logger.registerSecret(secret);
    const botToken = this.getBotToken();
    if (botToken) logger.registerSecret(botToken);
  }

  save() {
    try {
      const tempPath = `${this.configFile}.tmp`;
      const data = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(tempPath, data, 'utf8');
      try {
        fs.renameSync(tempPath, this.configFile);
      } catch {
        fs.writeFileSync(this.configFile, data, 'utf8');
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Ignore
        }
      }
      this._registerSecretsInLogger();
      return true;
    } catch (err) {
      logger.error(`Failed to save config: ${err.message}`);
      return false;
    }
  }

  reset(preservePreferences = true) {
    const defaults = this.getDefaults();
    if (preservePreferences) {
      this.config = {
        ...defaults,
        theme: this.config.theme || defaults.theme,
        language: this.config.language || defaults.language,
        minimizeToTray: this.config.minimizeToTray ?? defaults.minimizeToTray,
        beginnerMode: this.config.beginnerMode ?? defaults.beginnerMode,
        firstRunCompleted: false,
      };
    } else {
      this.config = defaults;
    }

    this.save();
    return true;
  }

  validateDiscordConfiguration() {
    const rawId = this.config.discordClientId;
    const encryptedSecret = this.config.discordClientSecretEncrypted;

    if (!rawId || typeof rawId !== 'string' || !rawId.trim()) {
      return {
        status: 'MISSING_CLIENT_ID',
        valid: false,
        message: 'Client ID da aplicação Discord não configurado.',
      };
    }

    const id = rawId.trim();
    if (!/^[0-9]{15,21}$/.test(id)) {
      return {
        status: 'INVALID_CLIENT_ID',
        valid: false,
        message: 'O Client ID do Discord deve conter apenas números (15 a 21 dígitos).',
      };
    }

    if (!encryptedSecret || typeof encryptedSecret !== 'string' || !encryptedSecret.trim()) {
      return {
        status: 'MISSING_CLIENT_SECRET',
        valid: false,
        message: 'Client Secret da aplicação Discord não configurado.',
      };
    }

    let decryptedSecret;
    try {
      decryptedSecret = this._decrypt(encryptedSecret);
    } catch {
      return {
        status: 'SECRET_DECRYPTION_FAILED',
        valid: false,
        message: 'Não foi possível descriptografar o Client Secret armazenado no Windows.',
      };
    }

    if (!decryptedSecret || decryptedSecret.length < 20) {
      return {
        status: 'MISSING_CLIENT_SECRET',
        valid: false,
        message: 'Client Secret da aplicação Discord inválido ou não configurado.',
      };
    }

    return {
      status: 'VALID',
      valid: true,
      message: 'Configuração do Discord válida.',
    };
  }

  getClientId() {
    return this.config.discordClientId || '';
  }

  setClientId(id) {
    const clean = (id || '').trim();
    if (this.config.discordClientId !== clean) {
      // Invalidate confirmed origin on client ID change
      this.config.confirmedPublicOrigin = '';
    }
    this.config.discordClientId = clean;
  }

  getClientSecret() {
    return this._decrypt(this.config.discordClientSecretEncrypted);
  }

  setClientSecret(secret) {
    this.config.discordClientSecretEncrypted = this._encrypt((secret || '').trim());
  }

  getBotToken() {
    return this._decrypt(this.config.discordBotTokenEncrypted);
  }

  setBotToken(token) {
    this.config.discordBotTokenEncrypted = this._encrypt((token || '').trim());
  }

  getAdminId() {
    return this.config.discordAdminId || '';
  }

  setAdminId(id) {
    this.config.discordAdminId = (id || '').trim();
  }

  getPublicOrigin() {
    return 'https://zaprecovery.online';
  }

  getConfirmedPublicOrigin() {
    return this.config.confirmedPublicOrigin
      ? this.config.confirmedPublicOrigin.trim().replace(/\/+$/, '')
      : null;
  }

  setConfirmedPublicOrigin(origin) {
    this.config.confirmedPublicOrigin = origin ? origin.trim().replace(/\/+$/, '') : '';
  }

  isDiscordConfigConfirmedFor(origin) {
    if (!origin || typeof origin !== 'string') return false;
    const normalized = origin.trim().replace(/\/+$/, '');
    const confirmed = this.getConfirmedPublicOrigin();
    return Boolean(confirmed && confirmed === normalized);
  }

  isConfigured() {
    return this.validateDiscordConfiguration().valid;
  }

  getPublicConfig() {
    const secret = this.getClientSecret();
    const botToken = this.getBotToken();
    const validation = this.validateDiscordConfiguration();
    return {
      version: this.config.version,
      discordClientId: this.getClientId(),
      hasClientSecret: Boolean(secret && secret.length >= 20),
      clientSecretMasked: secret ? `${secret.slice(0, 4)}••••••••••••${secret.slice(-4)}` : '',
      hasBotToken: Boolean(botToken && botToken.length >= 30),
      botTokenMasked: botToken ? `${botToken.slice(0, 6)}••••••••••••` : '',
      discordAdminId: this.getAdminId(),
      publicOrigin: this.getPublicOrigin(),
      confirmedPublicOrigin: this.getConfirmedPublicOrigin(),
      firstRunCompleted: this.config.firstRunCompleted,
      beginnerMode: this.config.beginnerMode,
      theme: this.config.theme,
      language: this.config.language,
      minimizeToTray: this.config.minimizeToTray,
      isConfigured: validation.valid,
      validationStatus: validation.status,
      validationMessage: validation.message,
    };
  }
}

export const configManager = new ConfigManager();
