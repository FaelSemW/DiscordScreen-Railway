import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  createIntervalTracker,
  createValueTracker,
  createStutterDetector,
  classifyHitch,
} from './pacing-metrics.js';
import { createPlayer } from '../client/src/player.js';

describe('shared/pacing-metrics', () => {
  it('handles empty interval tracker stats cleanly', () => {
    const tracker = createIntervalTracker(10);
    const emptyStats = tracker.getStats();
    expect(emptyStats.count).toBe(0);
    expect(emptyStats.avg).toBe(0);
    expect(emptyStats.p50).toBe(0);
    expect(emptyStats.max).toBe(0);
    expect(emptyStats.min).toBe(0);
  });

  it('tracks intervals and computes percentiles accurately', () => {
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

  it('detects and classifies stutters with createStutterDetector', () => {
    const detector = createStutterDetector({
      candidateThresholdMs: 40,
      severeThresholdMs: 75,
      maxHistory: 2,
    });

    const normal = detector.record({ renderGapMs: 16.6 });
    expect(normal).toBeNull();

    const candidate = detector.record({
      renderGapMs: 45.0,
      captureGapMs: 16.6,
      encodeDurationMs: 8.5,
      networkLagMs: 25.0,
      receiveGapMs: 40.0,
      decodeQueueSize: 2,
      presentationQueueSize: 1,
      isKeyframe: false,
    });
    expect(candidate).toBeDefined();
    expect(candidate.severity).toBe('candidate');

    const severe1 = detector.record({
      renderGapMs: 85.0,
      captureGapMs: 80.0,
      encodeDurationMs: 12.0,
      networkLagMs: 50.0,
      receiveGapMs: 80.0,
      isKeyframe: true,
    });
    expect(severe1).toBeDefined();
    expect(severe1.severity).toBe('severe');

    const severe2 = detector.record({
      renderGapMs: 95.0,
      isKeyframe: false,
    });
    expect(severe2).toBeDefined();

    const stats = detector.getStats();
    expect(stats.totalCandidateStutters).toBe(3);
    expect(stats.totalSevereStutters).toBe(2);
    expect(stats.history.length).toBe(2); // Capped by maxHistory

    detector.resetWindow();
    expect(detector.getStats().windowCandidateStutters).toBe(0);

    detector.reset();
    expect(detector.getStats().totalCandidateStutters).toBe(0);
    expect(detector.getStats().history.length).toBe(0);
  });

  it('accurately classifies hitch events across Case A through Case E', () => {
    // Case D: Main thread long task
    const hitchD = classifyHitch({
      renderGapMs: 55.0,
      longestLongTaskMs: 45.0,
    });
    expect(hitchD.code).toBe('CASE_D');

    // Case C: rAF throttling with queue backlog
    const hitchC = classifyHitch({
      renderGapMs: 50.0,
      rafGapMs: 48.0,
      presentationQueueSize: 2,
    });
    expect(hitchC.code).toBe('CASE_C');

    // Case B: Hardware decoder backlog
    const hitchB = classifyHitch({
      renderGapMs: 48.0,
      decodeGapMs: 42.0,
      decodeQueueSize: 3,
    });
    expect(hitchB.code).toBe('CASE_B');

    // Case A: Capture starvation
    const hitchA = classifyHitch({
      renderGapMs: 45.0,
      captureGapMs: 40.0,
    });
    expect(hitchA.code).toBe('CASE_A');

    // Case E: Jitter / clock divergence fallback
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

  it('guarantees single debug overlay root and unique DOM element IDs in client/index.html', () => {
    const htmlPath = path.resolve(__dirname, '../client/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    // 1. Single debugOverlay root
    const overlayMatches = html.match(/id="debugOverlay"/g);
    expect(overlayMatches).not.toBeNull();
    expect(overlayMatches.length).toBe(1);

    // 2. All element IDs are strictly unique
    const idRegex = /id="([^"]+)"/g;
    const ids = [];
    let match;
    while ((match = idRegex.exec(html)) !== null) {
      ids.push(match[1]);
    }

    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicateIds).toEqual([]);
  });
});
