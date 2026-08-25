import { describe, it, expect } from 'vitest';
import {
  createIntervalTracker,
  createValueTracker,
  createStutterDetector,
} from './pacing-metrics.js';

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
    expect(stats.countsByCategory).toBeDefined();

    detector.resetWindow();
    expect(detector.getStats().windowCandidateStutters).toBe(0);

    detector.reset();
    expect(detector.getStats().totalCandidateStutters).toBe(0);
    expect(detector.getStats().history.length).toBe(0);
  });

  it('accurately classifies hitch events across Case A through Case E', () => {
    // Case D: Canvas draw stall (> 16ms)
    const caseD = createStutterDetector().record({
      renderGapMs: 50,
      canvasDrawMs: 22.5,
      expectedIntervalMs: 16.67,
    });
    expect(caseD.classification.category).toBe('CASE D');

    // Case A: Network / Proxy gap preceded presentation gap
    const caseA = createStutterDetector().record({
      renderGapMs: 55,
      receiveGapMs: 50,
      decodeGapMs: 16.67,
      rafGapMs: 16.67,
      expectedIntervalMs: 16.67,
    });
    expect(caseA.classification.category).toBe('CASE A');

    // Case B: Decoder output delay with smooth network
    const caseB = createStutterDetector().record({
      renderGapMs: 60,
      receiveGapMs: 16.67,
      decodeGapMs: 55,
      rafGapMs: 16.67,
      expectedIntervalMs: 16.67,
    });
    expect(caseB.classification.category).toBe('CASE B');

    // Case C: rAF delayed with smooth decoder
    const caseC = createStutterDetector().record({
      renderGapMs: 65,
      receiveGapMs: 16.67,
      decodeGapMs: 16.67,
      rafGapMs: 60,
      expectedIntervalMs: 16.67,
    });
    expect(caseC.classification.category).toBe('CASE C');

    // Case E: Player clock / Presentation scheduler drift
    const caseE = createStutterDetector().record({
      renderGapMs: 50,
      receiveGapMs: 16.67,
      decodeGapMs: 16.67,
      rafGapMs: 16.67,
      expectedIntervalMs: 16.67,
    });
    expect(caseE.classification.category).toBe('CASE E');
  });
});
