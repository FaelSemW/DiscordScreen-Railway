import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  createIntervalTracker,
  createValueTracker,
  createStutterDetector,
  classifyHitch,
} from './pacing-metrics.js';
import { createPlayer } from '../client/src/player.js';

describe('shared/pacing-metrics (Headless Telemetry Engine)', () => {
  it('handles empty interval tracker stats cleanly', () => {
    const tracker = createIntervalTracker(10);
    const emptyStats = tracker.getStats();
    expect(emptyStats.count).toBe(0);
    expect(emptyStats.avg).toBe(0);
    expect(emptyStats.p50).toBe(0);
    expect(emptyStats.max).toBe(0);
    expect(emptyStats.min).toBe(0);
  });

  it('tracks intervals and computes percentiles accurately in Float64Array', () => {
    const tracker = createIntervalTracker(20);

    let ts = 1000;
    tracker.sample(ts);
    for (let i = 0; i < 30; i++) {
      ts += 16.67;
      tracker.sample(ts);
    }

    const stats = tracker.getStats();
    expect(stats.count).toBe(20); // Window filled past capacity
    expect(stats.avg).toBeGreaterThanOrEqual(16);
    expect(stats.avg).toBeLessThanOrEqual(17.5);
    expect(stats.histogram).toBeDefined();

    tracker.resetWindowCounts();
    expect(tracker.getStats().late25).toBe(0);

    tracker.reset();
    expect(tracker.getStats().count).toBe(0);
  });

  it('samples delta intervals directly and tracks late counts across all buckets and ignores negative', () => {
    const tracker = createIntervalTracker(4);
    tracker.sampleInterval(-10.0); // Negative delta branch (ignored)
    tracker.sampleInterval(10.0); // lt12
    tracker.sampleInterval(16.6); // b12_20
    tracker.sampleInterval(24.0); // b20_28
    tracker.sampleInterval(33.0); // b28_38
    tracker.sampleInterval(45.0); // b38_50 (fills past window size 4)
    tracker.sampleInterval(65.0); // gt50

    const stats = tracker.getStats();
    expect(stats.count).toBe(4);
    expect(stats.late25).toBe(3);
    expect(stats.late33).toBe(2);
    expect(stats.late50).toBe(1);
    expect(stats.max).toBe(65);
    expect(stats.min).toBe(24);
  });

  it('tracks numerical values and statistics with createValueTracker', () => {
    const vt = createValueTracker(3);
    expect(vt.getStats().count).toBe(0);

    vt.sample(10);
    vt.sample(20);
    vt.sample(30);
    vt.sample(40); // Fills past window size 3

    const stats = vt.getStats();
    expect(stats.count).toBe(3);
    expect(stats.max).toBe(40);
    expect(stats.last).toBe(40);

    vt.reset();
    expect(vt.getStats().count).toBe(0);
  });

  it('detects stutters and caps history at exactly maxHistory = 25 entries', () => {
    const detector = createStutterDetector({
      candidateThresholdMs: 40,
      severeThresholdMs: 75,
      maxHistory: 25,
    });

    const normal = detector.record({ renderGapMs: 16.6 });
    expect(normal).toBeNull();

    // Push 30 stutter events
    for (let i = 1; i <= 30; i++) {
      detector.record({
        renderGapMs: 40 + i,
        captureGapMs: 16.6,
        decodeGapMs: 16.6,
        rafGapMs: 16.6,
        longestLongTaskMs: 0,
      });
    }

    const stats = detector.getStats();
    expect(stats.totalCandidateStutters).toBe(30);
    expect(stats.history.length).toBe(25); // Strictly capped at 25
    expect(stats.latestSnapshot.renderGapMs).toBe(70.0);

    detector.reset();
    expect(detector.getStats().history.length).toBe(0);
    expect(detector.getStats().totalCandidateStutters).toBe(0);
  });

  it('heuristically classifies hitch events across Cases A through E', () => {
    // Case D: Main thread / canvas draw
    const hitchD = classifyHitch({
      renderGapMs: 55.0,
      longestLongTaskMs: 45.0,
    });
    expect(hitchD.code).toBe('CASE_D');
    expect(hitchD.name).toBe('CANVAS / GPU COMPOSITION');
    expect(hitchD.heuristic).toBe(true);

    // Case C: rAF throttling with queue backlog
    const hitchC = classifyHitch({
      renderGapMs: 50.0,
      rafGapMs: 48.0,
      presentationQueueSize: 2,
    });
    expect(hitchC.code).toBe('CASE_C');
    expect(hitchC.name).toBe('RAF / MAIN THREAD / COMPOSITOR');
    expect(hitchC.heuristic).toBe(true);

    // Case B: Hardware decoder backlog
    const hitchB = classifyHitch({
      renderGapMs: 48.0,
      decodeGapMs: 42.0,
      decodeQueueSize: 3,
    });
    expect(hitchB.code).toBe('CASE_B');
    expect(hitchB.name).toBe('DECODER / GPU DECODE');
    expect(hitchB.heuristic).toBe(true);

    // Case A: Network / Ingestion gap
    const hitchA = classifyHitch({
      renderGapMs: 45.0,
      captureGapMs: 40.0,
    });
    expect(hitchA.code).toBe('CASE_A');
    expect(hitchA.name).toBe('NETWORK / ACTIVITY PROXY');
    expect(hitchA.heuristic).toBe(true);

    // Case E: Player clock / scheduler divergence
    const hitchE = classifyHitch({
      renderGapMs: 42.0,
      captureGapMs: 16.67,
      decodeGapMs: 16.67,
      rafGapMs: 16.67,
      longestLongTaskMs: 0,
      decodeQueueSize: 0,
      presentationQueueSize: 0,
    });
    expect(hitchE.code).toBe('CASE_E');
    expect(hitchE.name).toBe('PLAYER CLOCK / SCHEDULER');
    expect(hitchE.heuristic).toBe(true);
  });

  it('guarantees headless telemetry export contains no secrets, tokens, or media frames and is serializable', () => {
    const canvas = {
      getContext: () => ({ drawImage: () => {}, fillRect: () => {} }),
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
      width: 1280,
      height: 720,
    };

    const fakeDecoder = {
      configure: () => {},
      close: () => {},
      decode: () => {},
      state: 'configured',
      decodeQueueSize: 0,
    };
    globalThis.VideoDecoder = vi.fn(function () { return fakeDecoder; });

    const player = createPlayer(canvas);
    player.start({ codec: 'avc1.64002a', codedWidth: 1280, codedHeight: 720 });

    const metrics = player.getMetrics();
    expect(metrics).toBeDefined();

    const report = {
      capturedAt: new Date().toISOString(),
      inDiscord: false,
      metrics,
      recentStutterEvents: metrics.stutterEvents,
    };

    const serialized = JSON.stringify(report);
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('identity');
    expect(serialized).not.toContain('ArrayBuffer');
    expect(serialized).not.toContain('VideoFrame');

    player.stop();
  });

  it('preserves production decoder config contract: optimizeForLatency=true and Uint8Array description', () => {
    let configuredOptions = null;
    const fakeDecoder = {
      configure: (cfg) => { configuredOptions = cfg; },
      close: () => {},
      decode: () => {},
      state: 'configured',
      decodeQueueSize: 0,
    };
    globalThis.VideoDecoder = vi.fn(function () { return fakeDecoder; });

    const canvas = {
      getContext: () => ({ drawImage: () => {}, fillRect: () => {} }),
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
      width: 1280,
      height: 720,
    };

    const player = createPlayer(canvas);
    const rawConfig = {
      codec: 'avc1.64002a',
      codedWidth: 1280,
      codedHeight: 720,
      description: 'AQIDBA==', // base64 for bytes [1, 2, 3, 4]
    };

    const started = player.start(rawConfig);
    expect(started).toBe(true);
    expect(configuredOptions).toBeDefined();
    expect(configuredOptions.codec).toBe('avc1.64002a');
    expect(configuredOptions.codedWidth).toBe(1280);
    expect(configuredOptions.codedHeight).toBe(720);
    expect(configuredOptions.optimizeForLatency).toBe(true);
    expect(configuredOptions.hardwareAcceleration).toBeUndefined();
    expect(configuredOptions.description).toBeInstanceOf(Uint8Array);
    expect(Array.from(configuredOptions.description)).toEqual([1, 2, 3, 4]);

    player.stop();
  });

  it('guarantees client/index.html and client/src/style.css preserve good UI baseline and contain no HUD markup', () => {
    const htmlPath = path.resolve(__dirname, '../client/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    // 1. Single debugOverlay root (legacy debug overlay)
    const overlayMatches = html.match(/id="debugOverlay"/g);
    expect(overlayMatches).not.toBeNull();
    expect(overlayMatches.length).toBe(1);

    // 2. Contains NO 6-section new HUD markup
    expect(html).not.toContain('SEÇÃO 1');
    expect(html).not.toContain('dbg-net-pkts');
    expect(html).not.toContain('btnCopyDiagnostics');

    // 3. CSS contains NO HUD panel modifications
    const cssPath = path.resolve(__dirname, '../client/src/style.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).not.toContain('.badge-case-a');
    expect(css).not.toContain('.debug-scroll-container');
  });
});
