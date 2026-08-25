import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAppServer,
  startServer,
  stopServer,
  setPublicOrigin,
  getPublicOrigin,
  getVerifiedPublicOrigin,
} from './runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
} catch {
  // Ignored if dotenv is not present
}

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_BOT_TOKEN,
  DISCORD_ADMIN_ID = '',
  TURN_URL = '',
  TURN_USER = '',
  TURN_PASS = '',
  PUBLIC_ORIGIN = 'http://localhost:3001',
  PORT = 3001,
  NODE_ENV = 'development',
  SESSION_SECRET = '',
} = process.env;

const instance = createAppServer({
  port: Number(PORT) || 3001,
  discordClientId: DISCORD_CLIENT_ID || null,
  discordClientSecret: DISCORD_CLIENT_SECRET || null,
  discordBotToken: DISCORD_BOT_TOKEN || null,
  discordAdminId: DISCORD_ADMIN_ID,
  turnUrl: TURN_URL,
  turnUser: TURN_USER,
  turnPass: TURN_PASS,
  publicOrigin: PUBLIC_ORIGIN,
  sessionSecret: SESSION_SECRET,
  nodeEnv: NODE_ENV,
});

export const app = instance.app;
export const server = instance.server;
export const wss = instance.wss;
export {
  startServer,
  stopServer,
  createAppServer,
  setPublicOrigin,
  getPublicOrigin,
  getVerifiedPublicOrigin,
};

try {
  server.listen(Number(PORT) || 3001);
} catch {
  // Ignore in case of concurrent test worker binding
}
