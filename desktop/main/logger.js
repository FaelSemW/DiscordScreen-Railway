import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

class Logger {
  constructor() {
    this.logs = [];
    this.maxLogs = 500;
    this.listeners = new Set();
    this.registeredSecrets = new Set();

    const logDir = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'DiscordScreenRailway',
      'logs',
    );
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.logFile = path.join(logDir, 'app.log');
    } catch {
      this.logFile = null;
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

  _log(level, ...args) {
    const timestamp = new Date().toISOString();
    const rawMessage = args
      .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ');
    const sanitizedMessage = this._maskSecrets(rawMessage);
    const line = `[${timestamp}] [${level}] ${sanitizedMessage}`;

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

    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, `${line}\n`, 'utf8');
      } catch {
        // Ignore file logging error
      }
    }

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

  onLog(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getRecentLogs() {
    return [...this.logs];
  }
}

export const logger = new Logger();
