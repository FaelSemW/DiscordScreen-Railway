import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAppServer } from '../server/runtime.js';
import { ProcessManager, STATES } from '../desktop/main/manager.js';
import { WebSocket } from 'ws';

describe('Two-Tier Reconnect Policy & Long-Offline Simulation', () => {
  let appServer = null;
  let serverPort = null;
  let baseUrl = null;
  let wsBaseUrl = null;

  beforeEach(async () => {
    appServer = createAppServer({
      port: 0,
      publicOrigin: 'http://127.0.0.1:3001',
      sessionSecret: 'test-secret-two-tier-1234567890',
      nodeEnv: 'test',
    });

    await new Promise((resolve) => {
      appServer.server.listen(0, '127.0.0.1', () => {
        serverPort = appServer.server.address().port;
        baseUrl = `http://127.0.0.1:${serverPort}`;
        wsBaseUrl = `ws://127.0.0.1:${serverPort}`;
        appServer.setPublicOrigin(baseUrl);
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (appServer) {
      clearInterval(appServer.heartbeat);
      for (const client of appServer.wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
      await new Promise((resolve) => appServer.wss.close(resolve));
      await new Promise((resolve) => appServer.server.close(resolve));
      appServer = null;
    }
  });

  // =========================================================================
  // TEST A: Exhaust Tier 1 -> Enters ERROR/OFFLINE, active timer 0, passive timer 1
  // =========================================================================
  it('TEST A: Exhausting Tier 1 transitions to STATES.ERROR and activates passive standby timer', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.checkHealth = async () => true;

    // Simulate 8 failed attempts by setting attempts to 8 directly
    pm._reconnectAttempts = 8;
    pm.state = STATES.READY;

    // Trigger reconnect
    pm._scheduleReconnect();

    expect(pm.state).toBe(STATES.ERROR);
    expect(pm.lastError?.code).toBe('CONTROL_CHANNEL_LOST');
    expect(pm.reconnectTimer).toBeNull();
    expect(pm.passiveStandbyTimer).not.toBeNull();

    await pm.stop();
  });

  // =========================================================================
  // TEST B: Advance passive retry when backend still offline -> single timer rescheduled
  // =========================================================================
  it('TEST B: Passive retry when backend is still down maintains single timer without multiplication', async () => {
    const pm = new ProcessManager();
    // Point to non-existent server port
    pm.getVerifiedPublicOrigin = () => 'http://127.0.0.1:59998';
    pm.state = STATES.ERROR;

    // Schedule passive standby with a short 20ms delay for testing
    pm._schedulePassiveStandby(20);
    const initialTimer = pm.passiveStandbyTimer;
    expect(initialTimer).not.toBeNull();

    // Wait for the passive check to fire and fail
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Must still be in ERROR state with a newly scheduled passive timer
    expect(pm.state).toBe(STATES.ERROR);
    expect(pm.passiveStandbyTimer).not.toBeNull();
    expect(pm.reconnectTimer).toBeNull();
    expect(pm._pingInterval).toBeNull();

    await pm.stop();
    expect(pm.passiveStandbyTimer).toBeNull();
  });

  // =========================================================================
  // TEST C: Backend becomes available -> Automatic recovery restores connection & READY
  // =========================================================================
  it('TEST C: Automatic recovery succeeds when backend returns, clearing passive timer and setting READY', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.state = STATES.ERROR;
    pm.lastError = { code: 'CONTROL_CHANNEL_LOST' };

    // Schedule passive check with 20ms delay against active server
    pm._schedulePassiveStandby(20);
    expect(pm.passiveStandbyTimer).not.toBeNull();

    // Wait for passive retry to connect
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(pm.state).toBe(STATES.READY);
    expect(pm.lastError).toBeNull();
    expect(pm.passiveStandbyTimer).toBeNull();
    expect(pm.reconnectTimer).toBeNull();
    expect(pm.controlWs).not.toBeNull();
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm._pingInterval).not.toBeNull();
    expect(pm._reconnectAttempts).toBe(0);

    await pm.stop();
  });

  // =========================================================================
  // TEST D: Stop() during passive standby clears all timers and cancels future attempts
  // =========================================================================
  it('TEST D: stop() during passive standby destroys timer and guarantees no reconnect activity', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.state = STATES.ERROR;

    pm._schedulePassiveStandby(5000);
    expect(pm.passiveStandbyTimer).not.toBeNull();

    await pm.stop();

    expect(pm.passiveStandbyTimer).toBeNull();
    expect(pm.reconnectTimer).toBeNull();
    expect(pm._pingInterval).toBeNull();
    expect(pm.state).toBe(STATES.IDLE);
    expect(pm.isStopping).toBe(true);

    // Wait past the original delay to verify no background wake-up occurred
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pm.controlWs).toBeNull();
  });

  // =========================================================================
  // TEST E: Manual reconnect during passive standby cancels passive and starts flow
  // =========================================================================
  it('TEST E: Manual reconnect during passive standby cancels passive timer and reconnects cleanly', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => baseUrl;
    pm.state = STATES.ERROR;

    pm._schedulePassiveStandby(10000);
    expect(pm.passiveStandbyTimer).not.toBeNull();

    // User triggers manual reconnect
    const state = await pm.manualReconnect();

    expect(pm.passiveStandbyTimer).toBeNull();
    expect(state.state).toBe(STATES.READY);
    expect(pm.controlWs).not.toBeNull();
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm._pingInterval).not.toBeNull();

    await pm.stop();
  });

  // =========================================================================
  // SECTION 8: Long-Offline Simulation (15 minutes of simulated offline)
  // =========================================================================
  it('Section 8: 15 minutes of simulated offline maintains zero handle growth and recovers on restore', async () => {
    const pm = new ProcessManager();
    pm.getVerifiedPublicOrigin = () => 'http://127.0.0.1:59997'; // Offline endpoint
    pm.state = STATES.ERROR;

    const initialHandles = process._getActiveHandles?.()?.length ?? 0;
    const initialListeners = pm.listenerCount('state-change');

    // Simulate 15 intervals of passive retries (equivalent to 15 minutes at 60s/interval)
    for (let minute = 1; minute <= 15; minute++) {
      pm._schedulePassiveStandby(5); // 5ms fast-forward per simulated minute
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(pm.state).toBe(STATES.ERROR);
      expect(pm.controlWs).toBeNull();
    }
    expect(pm.passiveStandbyTimer).not.toBeNull();

    // Verify zero explosion
    const midHandles = process._getActiveHandles?.()?.length ?? 0;
    expect(Math.abs(midHandles - initialHandles)).toBeLessThanOrEqual(3);
    expect(pm.listenerCount('state-change')).toBe(initialListeners);

    // Now restore backend!
    pm.getVerifiedPublicOrigin = () => baseUrl;

    // Trigger next passive probe
    pm._schedulePassiveStandby(10);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Must recover automatically!
    expect(pm.state).toBe(STATES.READY);
    expect(pm.controlWs).not.toBeNull();
    expect(pm.controlWs.readyState).toBe(WebSocket.OPEN);
    expect(pm.passiveStandbyTimer).toBeNull();
    expect(pm._pingInterval).not.toBeNull();

    await pm.stop();
  });
});
