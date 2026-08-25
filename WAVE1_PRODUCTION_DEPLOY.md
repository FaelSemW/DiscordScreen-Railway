# DISCORD SCREEN RAILWAY
## PRODUCTION DEPLOYMENT RECORD — ACTIVITY SCHEDULER ISOLATED FIX

- **Date:** 2026-08-25T20:10:00-03:00
- **Target Railway Project:** `DC-ScreenSharing` (`9cca2214-e0ce-4550-8557-ce888d83ec20`)
- **Environment:** `production` (`d7177466-81a4-46a1-88bb-681a5e0a9208`)
- **Service:** `discord-screen-railway` (`11ddb40b-3bca-43f7-8a8e-d299aa326fed`)
- **Production URL:** https://zaprecovery.online

---

### DEPLOYMENT IDENTIFIERS

- **Immediate Rollback Deployment Target:** `05d1c3cf-8278-4208-a0da-d2df50f387f8` (Snapshot: `fa8f79fc-8fb6-473b-94eb-a1981c2b3a7d`)
- **New Active Deployment ID:** `a44790e4-6054-47da-85e1-bc3baec2ff9c`
- **Preserved History:** All previous deployments (`05d1c3cf-8278-4208-a0da-d2df50f387f8`, `ca9b9387-31aa-46cb-bd6d-37b0bb4ecdc4`, `beacedf9-36e6-420e-9226-d75d1f3c781f`) preserved.

---

### INCLUDED ISOLATED IMPROVEMENTS

1. **Activity Video Presentation Loop Scheduler (P0):**
   - Obsolete intermediate frame skipping in `client/src/player.js` `passo()`.
   - Immediate `VideoFrame.close()` on discarded frames to prevent GPU VRAM retention.
   - Latest on-time frame presentation per VSync tick.
   - Eliminates unbounded queue growth and false `[HARD_RESYNC]` triggers when rAF cadence drops to 30–50 Hz in Discord Activity iframes.
2. **In-Place Aspect-Ratio Sizing:**
   - In `client/src/main.js`, `onTamanho` updates tile dimensions and removes spinner in-place without triggering full grid teardown.
3. **EXCLUDED:**
   - Prior Wave 1 `/control` authentication changes in `server/runtime.js`, `desktop/main/config.js`, and `desktop/main/manager.js` were **100% EXCLUDED**. `/control` behavior remains identical to known-good production.

---

### PRE-DEPLOY TEST & BUILD RESULTS

- **Test Suite Command:** `npx vitest run`
- **Total Test Files:** 25 passed (25)
- **Total Tests:** 453 passed (453)
- **Failed:** 0
- **Skipped:** 0
- **Vite Production Build:** `PASS` (built in 2.69s, asset `index-sBtTMY-w.js`)

---

### LIVE PRODUCTION SMOKE-TEST RESULTS

- `GET https://zaprecovery.online/api/health` $\rightarrow$ `HTTP 200` (`{"ok":true}`)
- `GET https://zaprecovery.online/` $\rightarrow$ `HTTP 200` (HTML 13735 bytes)
- `GET https://zaprecovery.online/share.html` $\rightarrow$ `HTTP 200` (HTML 8614 bytes)
- `GET https://zaprecovery.online/privacy.html` $\rightarrow$ `HTTP 200` (HTML 5213 bytes)
- `GET https://zaprecovery.online/terms.html` $\rightarrow$ `HTTP 200` (HTML 4387 bytes)
- `GET https://zaprecovery.online/api/config` $\rightarrow$ `HTTP 200` (`{"clientId":"1540481579493761054","asset":"index-sBtTMY-w.js"}`)
- `WSS wss://zaprecovery.online/control` (Unauthenticated) $\rightarrow$ **`VULNERABLE_OPENED`** (Desktop host connected without 401 loop)
- `WSS wss://zaprecovery.online/ws` (Unauthenticated) $\rightarrow$ **`REJECTED_HTTP_401`** (Protected)
- Active Asset `/assets/index-sBtTMY-w.js` verified live.
- Railway container logs verified: `[control] Desktop host conectado.` and `[control] Desktop registrou Client ID: 1540481579493761054`.
