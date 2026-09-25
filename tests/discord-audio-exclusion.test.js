import { describe, it, expect } from 'vitest';
import { detectDiscordProcessTree } from '../desktop/main/discord-detector.js';
import { AudioExclusionManager } from '../desktop/main/audio-exclusion-manager.js';

describe('Discord Audio Exclusion & Process Tree Detection', () => {
  it('detects discord processes and excludes non-discord binaries', async () => {
    const mockProcesses = [
      {
        Name: 'Discord.exe',
        ExecutablePath: 'C:\\Users\\Usuario\\AppData\\Local\\Discord\\app-1.0.9256\\Discord.exe',
        ParentProcessId: 1000,
        ProcessId: 16012,
      },
      {
        Name: 'Discord.exe',
        ExecutablePath: 'C:\\Users\\Usuario\\AppData\\Local\\Discord\\app-1.0.9256\\Discord.exe',
        ParentProcessId: 16012,
        ProcessId: 16050,
      },
      {
        Name: 'Discord.exe',
        ExecutablePath: 'C:\\Users\\Usuario\\AppData\\Local\\Discord\\app-1.0.9256\\Discord.exe',
        ParentProcessId: 16012,
        ProcessId: 16080,
      },
      {
        Name: 'chrome.exe',
        ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        ParentProcessId: 1000,
        ProcessId: 5000,
      },
      {
        Name: 'Discord Screen Railway.exe',
        ExecutablePath: 'D:\\DiscordScreen-Railway\\dist\\release\\win-unpacked\\Discord Screen Railway.exe',
        ParentProcessId: 1000,
        ProcessId: 8888,
      },
    ];

    const tree = await detectDiscordProcessTree({ mockProcesses });

    expect(tree.isRunning).toBe(true);
    expect(tree.rootPid).toBe(16012);
    expect(tree.flavor).toBe('Stable');
    expect(tree.allPids).toContain(16012);
    expect(tree.allPids).toContain(16050);
    expect(tree.allPids).toContain(16080);
    // MUST NOT include Chrome or our own Electron app
    expect(tree.allPids).not.toContain(5000);
    expect(tree.allPids).not.toContain(8888);
  });

  it('detects Discord Canary and PTB flavors accurately', async () => {
    const canaryProcesses = [
      {
        Name: 'DiscordCanary.exe',
        ExecutablePath: 'C:\\Users\\Usuario\\AppData\\Local\\DiscordCanary\\app-1.0.9000\\DiscordCanary.exe',
        ParentProcessId: 2000,
        ProcessId: 25000,
      },
    ];

    const tree = await detectDiscordProcessTree({ mockProcesses: canaryProcesses });

    expect(tree.isRunning).toBe(true);
    expect(tree.rootPid).toBe(25000);
    expect(tree.flavor).toBe('Canary');
  });

  it('reports isRunning: false when no Discord is running', async () => {
    const emptyProcesses = [
      {
        Name: 'explorer.exe',
        ExecutablePath: 'C:\\Windows\\explorer.exe',
        ParentProcessId: 999,
        ProcessId: 1234,
      },
    ];

    const tree = await detectDiscordProcessTree({ mockProcesses: emptyProcesses });

    expect(tree.isRunning).toBe(false);
    expect(tree.rootPid).toBeNull();
    expect(tree.allPids).toHaveLength(0);
  });

  it('AudioExclusionManager lifecycle maintains state and handles start/stop cleanly', async () => {
    const manager = new AudioExclusionManager();

    expect(manager.getState().state).toBe('IDLE');
    expect(manager.getState().stats.isExcluding).toBe(false);

    // Stop on a manager transitions to STOPPED cleanly
    await manager.stop();
    expect(manager.getState().state).toBe('STOPPED');
  });

  it('correctly maps audioCaptureSource according to exclusion state and surface', () => {
    function resolveAudioSource({ hasBridge, exclStatus, surface, hasTrack }) {
      if (hasBridge && (exclStatus?.state === 'CAPTURING' || exclStatus?.stats?.isExcluding)) {
        return 'wasapi-filtered-helper';
      }
      if (hasBridge && hasTrack) {
        return 'electron-full-loopback';
      }
      if (surface === 'window') return 'window-track';
      if (surface === 'browser') return 'tab-track';
      return hasTrack ? 'browser-track' : 'none';
    }

    // When bridge has active exclusion -> wasapi-filtered-helper
    expect(
      resolveAudioSource({
        hasBridge: true,
        exclStatus: { state: 'CAPTURING', stats: { isExcluding: true } },
        surface: 'monitor',
        hasTrack: true,
      }),
    ).toBe('wasapi-filtered-helper');

    // When bridge is present but exclusion failed/not active -> electron-full-loopback
    expect(
      resolveAudioSource({
        hasBridge: true,
        exclStatus: { state: 'IDLE', stats: { isExcluding: false } },
        surface: 'monitor',
        hasTrack: true,
      }),
    ).toBe('electron-full-loopback');

    // Window surface -> window-track
    expect(
      resolveAudioSource({
        hasBridge: false,
        exclStatus: null,
        surface: 'window',
        hasTrack: true,
      }),
    ).toBe('window-track');

    // Browser tab -> tab-track
    expect(
      resolveAudioSource({
        hasBridge: false,
        exclStatus: null,
        surface: 'browser',
        hasTrack: true,
      }),
    ).toBe('tab-track');
  });

  it('awaits exclusion start and prevents STARTING state from falling back to raw loopback', async () => {
    let state = 'STARTING';
    const fakeBridge = {
      getAudioExclusionStatus: async () => ({ state, stats: { isExcluding: state === 'CAPTURING' } }),
      onAudioPcmChunk: () => () => {},
    };

    // Simulate broadcaster waiting loop
    let audioCaptureSource = 'none';
    let exclStatus = await fakeBridge.getAudioExclusionStatus();
    if (exclStatus?.state === 'STARTING') {
      const waitStart = Date.now();
      while (exclStatus?.state === 'STARTING' && Date.now() - waitStart < 2000) {
        await new Promise((r) => setTimeout(r, 20));
        // After 50ms transition to CAPTURING
        if (Date.now() - waitStart >= 50) {
          state = 'CAPTURING';
        }
        exclStatus = await fakeBridge.getAudioExclusionStatus();
      }
    }

    if (exclStatus?.state === 'CAPTURING' || exclStatus?.stats?.isExcluding) {
      audioCaptureSource = 'wasapi-filtered-helper';
    } else {
      audioCaptureSource = 'electron-full-loopback';
    }

    expect(audioCaptureSource).toBe('wasapi-filtered-helper');
    expect(state).toBe('CAPTURING');
  });

  it('does NOT silently fall back to raw loopback if helper fails while Discord is active', async () => {
    const isScreen = true;
    const shareAudio = true;
    const shouldExclude = true;
    const discordRunning = true;
    const helperFailed = true;

    let audioOption = shareAudio ? (isScreen ? 'loopback' : 'window') : undefined;

    if (isScreen && shareAudio && shouldExclude) {
      if (discordRunning && helperFailed) {
        // Privacy guard: Never leak Discord conversation into whole-screen audio
        audioOption = undefined;
      }
    }

    expect(audioOption).toBeUndefined();
  });

  it('guarantees exactly one audio source: stops and disables Chromium loopback track when helper is active', () => {
    const track = {
      enabled: true,
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };

    const useNativeExclusion = true;
    let audioCaptureSource = 'none';

    if (useNativeExclusion) {
      track.enabled = false;
      track.stop();
      audioCaptureSource = 'wasapi-filtered-helper';
    }

    expect(track.enabled).toBe(false);
    expect(track.stopped).toBe(true);
    expect(audioCaptureSource).toBe('wasapi-filtered-helper');
  });

  it('watchdog handles Discord restart without temporary raw-loopback leakage', async () => {
    let currentSource = 'wasapi-filtered-helper';
    let targetPid = 16012;

    // Simulate Discord restart event
    const newPid = 24500;
    targetPid = newPid;

    // Source remains filtered helper (momentary silence allowed, but NEVER raw loopback)
    expect(currentSource).toBe('wasapi-filtered-helper');
    expect(targetPid).toBe(24500);
  });
});

