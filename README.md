# Discord Screen Railway

Centralized, permanently hosted production infrastructure for **Discord Screen** on Railway using the custom domain `https://zaprecovery.online`.

---

## 1. Overview

**Discord Screen Railway** is a lightweight, low-latency live media relay and Discord Activity backend. It provides:
- Permanent, stable HTTPS & WSS endpoints on `zaprecovery.online`
- Zero client-side Quick Tunnel dependency for hosted rooms
- Zero server-side video transcoding (relays pre-encoded WebCodecs H.264/VP8/VP9 and Opus audio packets)
- High-efficiency in-memory bounded backpressure queue to protect memory under slow viewer connections
- Multi-tenant room and session isolation using HMAC-SHA256 tokens

```
               https://zaprecovery.online
               wss://zaprecovery.online
                         │
                         ▼
             Discord Screen Railway
             ──────────────────────
             HTTP Express Server
             Activity Frontend (Vite)
             Share Frontend (/share.html)
             WebSocket Live Media Relay (/ws)
             Rooms & Bounded Queue
             HMAC Token Validation
             Health API (/api/health)
                ▲                ▲
                │                │
          Broadcaster     Discord Activity
             Client            Viewer
```

---

## 2. Architecture & Streaming Protocol

### Live Media Relay
- **Binary Packet Format**: `[Slot (1 Byte)][Type (1 Byte)][Media Payload]`
  - `Slot`: Broadcaster slot (0 to 3)
  - `Type`: `1` = Video Keyframe, `2` = Video Delta Frame, `3` = Opus Audio
- **Backpressure & Drop Protection**:
  - Buffer limit per viewer: `2 MB`.
  - When viewer buffer exceeds `2 MB`, delta packets are dropped and an immediate `need-keyframe` control message is requested from the broadcaster.
  - Áudio packets and keyframes are prioritized to preserve audio smoothness and rapid visual recovery.
- **Opt-in Streaming**:
  - Broadcaster does not send media packets until at least one viewer requests to watch that slot.
  - When direct WebRTC P2P is established between broadcaster and viewer, relay bandwidth drops to zero automatically.

---

## 3. Security & Multi-Tenancy Model

- **HMAC Token Signing**: All session identities, room viewer tokens, and broadcaster tokens are cryptographically signed using HMAC-SHA256 with `SESSION_SECRET`.
- **Cross-Room Isolation**: Tokens are tied to specific `roomId` and `instanceId` claims. Broadcasters and viewers cannot access or inject media into foreign rooms.
- **No Client Secret Exposure**: End users and broadcasters never transmit Discord Client Secrets to Railway. The centralized server uses its own environment variables (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`) to exchange OAuth authorization codes with Discord.

---

## 4. Environment Variables

| Variable | Description | Example |
| :--- | :--- | :--- |
| `PORT` | HTTP/WebSocket listening port (injected by Railway) | `3001` |
| `NODE_ENV` | Environment mode | `production` |
| `PUBLIC_ORIGIN` | Publicly accessible base URL | `https://zaprecovery.online` |
| `SESSION_SECRET` | 32+ character secret for signing HMAC tokens | `(secure random string)` |
| `DISCORD_CLIENT_ID` | Optional Discord Application Client ID | `123456789012345678` |
| `DISCORD_CLIENT_SECRET` | Optional Discord Application Client Secret | `••••••••••••` |
| `DISCORD_BOT_TOKEN` | Optional Discord Bot Token for voice presence check | `••••••••••••` |
| `DISCORD_ADMIN_ID` | Optional comma-separated Discord User IDs for admin metrics | `123456789012345678` |

---

## 5. Deployment & CLI Commands

### Local Testing & Build
```bash
# Install dependencies
npm install

# Build Activity frontend
npm run build

# Run unit and integration tests
npm test

# Run local development server
npm run dev
```

### Deploy to Railway
```bash
# Deploy directory directly to Railway service
railway up --service discord-screen-railway -y
```

### Health Check
- `GET https://zaprecovery.online/api/health` -> `200 { "ok": true }`
