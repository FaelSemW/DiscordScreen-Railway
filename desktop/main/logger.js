import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

class Logger {
  constructor() {
    this.logs = [];
    this.maxLogs = 500;
    this.listeners = new Set();
    this.registeredSecrets = new Set();

    this.logDir = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'DC Screen Sharing',
      'logs',
    );
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.logFile = path.join(this.logDir, 'app.log');
      this.serverLogFile = path.join(this.logDir, 'server.log');
      this.cloudflareLogFile = path.join(this.logDir, 'cloudflare.log');
      this.broadcasterLogFile = path.join(this.logDir, 'broadcaster.log');
      this.audioLogFile = path.join(this.logDir, 'audio.log');
    } catch {
      this.logFile = null;
      this.serverLogFile = null;
      this.cloudflareLogFile = null;
      this.broadcasterLogFile = null;
      this.audioLogFile = null;
    }
  }

  registerSecret(secret) {
    if (secret && typeof secret === 'string' && secret.length >= 8) {
      this.registeredSecrets.add(secret.trim());
    }
  }

  _maskSecrets(text) {
    let sanitized = String(text);
    for (const sec of this.registeredSecrets) {
      if (sec && sanitized.includes(sec)) {
        sanitized = sanitized.split(sec).join('[SECRET_REDACTED]');
      }
    }
    // Mask potential OAuth bearer tokens
    sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [TOKEN_REDACTED]');
    // Mask potential client secrets in URLs
    sanitized = sanitized.replace(/client_secret=[^&\s]+/gi, 'client_secret=[SECRET_REDACTED]');
    return sanitized;
  }

  _formatLine(level, category, args) {
    const timestamp = new Date().toISOString();
    const rawMessage = args
      .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ');
    const sanitizedMessage = this._maskSecrets(rawMessage);
    const cat = category ? ` [${category}]` : '';
    return `[${timestamp}] [${level}]${cat} ${sanitizedMessage}`;
  }

  _writeTo(file, line) {
    if (!file) return;
    try {
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch {
      // Ignore file logging error
    }
  }

  _log(level, ...args) {
    const line = this._formatLine(level, null, args);

    this.logs.push(line);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }

    this._writeTo(this.logFile, line);

    for (const listener of this.listeners) {
      try {
        listener(line);
      } catch {
        // Ignore listener error
      }
    }
  }

  info(...args) {
    this._log('INFO', ...args);
  }

  warn(...args) {
    this._log('WARN', ...args);
  }

  error(...args) {
    this._log('ERROR', ...args);
  }

  server(level, ...args) {
    const lvl = (level || 'INFO').toUpperCase();
    const line = this._formatLine(lvl, 'SERVER', args);
    this._writeTo(this.serverLogFile, line);
    this._log(lvl, '[SERVER]', ...args);
  }

  cloudflare(level, ...args) {
    const lvl = (level || 'INFO').toUpperCase();
    const line = this._formatLine(lvl, 'CLOUDFLARE', args);
    this._writeTo(this.cloudflareLogFile, line);
    this._log(lvl, '[CLOUDFLARE]', ...args);
  }

  broadcaster(level, ...args) {
    const lvl = (level || 'INFO').toUpperCase();
    const line = this._formatLine(lvl, 'BROADCASTER', args);
    this._writeTo(this.broadcasterLogFile, line);
    this._log(lvl, '[BROADCASTER]', ...args);
  }

  audio(level, ...args) {
    const lvl = (level || 'INFO').toUpperCase();
    const line = this._formatLine(lvl, 'AUDIO', args);
    this._writeTo(this.audioLogFile, line);
    this._log(lvl, '[AUDIO]', ...args);
  }

  onLog(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getRecentLogs() {
    return [...this.logs];
  }

  getLogDirectory() {
    return this.logDir;
  }
}

export const logger = new Logger();
