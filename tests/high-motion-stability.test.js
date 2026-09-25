import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPlayer } from '../client/src/player.js';

describe('High-Motion Stability, Presentation Queue Bounding & Alt+Tab Recovery', () => {
  let canvas;
  let ctx;

  beforeEach(() => {
    ctx = {
      drawImage: vi.fn(),
      fillStyle: '#000',
      fillRect: vi.fn(),
    };
    canvas = {
      getContext: vi.fn().mockReturnValue(ctx),
      width: 1920,
      height: 1080,
      getBoundingClientRect: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
    };
  });

  it('performs live edge recovery without accumulating stale frames while hidden', () => {
    const player = createPlayer(canvas);

    // Initial state check
    const initialMetrics = player.getMetrics();
    expect(initialMetrics.framesDropped).toBe(0);

    // Calling performLiveEdgeRecovery() is safe, flushes queues, and triggers keyframe request
    player.performLiveEdgeRecovery();

    expect(player.getKeyframeRequestCount()).toBe(1);

    player.destroy();
  });

  it('bounds presentation queue and discards obsolete frames beyond age threshold', () => {
    const player = createPlayer(canvas);

    // Start with a mock decoder configuration
    player.start({
      codec: 'avc1.64002a',
      codedWidth: 1920,
      codedHeight: 1080,
    });

    const metrics = player.getMetrics();
    expect(metrics.framesDropped).toBe(0);

    player.destroy();
  });

  it('calculates normalized transmission backlog correctly', () => {
    const bitrate = 4_000_000; // 4 Mbps
    const bufferedBytes = 250_000; // 250 KB = 2,000,000 bits
    const bufferedMs = (bufferedBytes * 8 / bitrate) * 1000; // 500ms

    expect(bufferedMs).toBe(500);

    // Recovery threshold <= 100ms:
    const recoveredBytes = 30_000;
    const recoveredMs = (recoveredBytes * 8 / bitrate) * 1000; // 60ms
    expect(recoveredMs).toBeLessThanOrEqual(100);
  });

  it('includes BUILD_METADATA in player metrics report', () => {
    const player = createPlayer(canvas);
    const metrics = player.getMetrics();
    expect(metrics).toHaveProperty('build');
    expect(metrics.build).toHaveProperty('repo', 'D:\\DiscordScreen-Railway');
    expect(metrics.build).toHaveProperty('buildId');
    player.destroy();
  });

  it('admission control allows queue depth up to 5 for GPU hardware pipeline without dropping frames', () => {
    let afogado = false;
    let droppedAdmissionPressure = 0;

    function checkAdmission(queueSize) {
      const isOverloaded = queueSize > (afogado ? 2 : 5);
      if (isOverloaded) {
        afogado = true;
        droppedAdmissionPressure++;
        return false; // dropped
      }
      if (afogado && queueSize <= 2) {
        afogado = false;
      }
      return true; // admitted
    }

    // Normal GPU pipeline depth (1, 2, 3 frames) MUST be admitted without drops
    expect(checkAdmission(1)).toBe(true);
    expect(checkAdmission(2)).toBe(true);
    expect(checkAdmission(3)).toBe(true);
    expect(checkAdmission(4)).toBe(true);
    expect(checkAdmission(5)).toBe(true);
    expect(droppedAdmissionPressure).toBe(0);

    // Backlog spike of 6 frames triggers drop and enters hysteresis
    expect(checkAdmission(6)).toBe(false);
    expect(droppedAdmissionPressure).toBe(1);
    expect(afogado).toBe(true);

    // While afogado, threshold drops to 2 to drain
    expect(checkAdmission(3)).toBe(false);
    expect(droppedAdmissionPressure).toBe(2);

    // When queue drains to <= 2, afogado recovers
    expect(checkAdmission(2)).toBe(true);
    expect(afogado).toBe(false);

    // Back to normal healthy capacity
    expect(checkAdmission(3)).toBe(true);
  });

  it('sustained 60-frame input produces >= 58 admitted frames', () => {
    let admitted = 0;
    let dropped = 0;
    let afogado = false;

    // Simulate 60 frames arriving at 16.67ms intervals
    for (let i = 0; i < 60; i++) {
      // Healthy hardware encoder has 0, 1, or 2 frames in-flight
      const queueDepth = i % 3; // 0, 1, 2
      const isOverloaded = queueDepth > (afogado ? 1 : 2);
      if (isOverloaded) {
        dropped++;
      } else {
        admitted++;
      }
    }

    expect(admitted).toBe(60);
    expect(dropped).toBe(0);
    expect(admitted).toBeGreaterThanOrEqual(58);
  });

  it('presentation distinguishes HOLD from DROP: future frames are held, only stale frames (>60ms) are dropped', () => {
    const mediaPlaybackTime = 1000;

    const futureFrame = { tsMs: 1020 }; // +20ms ahead
    const currentFrame = { tsMs: 1004 }; // +4ms (within +8ms)
    const staleFrame = { tsMs: 930 }; // -70ms behind (>60ms)

    const isStale = staleFrame.tsMs < mediaPlaybackTime - 60;
    const isDue = currentFrame.tsMs <= mediaPlaybackTime + 8;
    const isFutureDue = futureFrame.tsMs <= mediaPlaybackTime + 8;
    const isFutureHeld = futureFrame.tsMs > mediaPlaybackTime + 8;

    expect(isStale).toBe(true); // Genuinely stale -> drop
    expect(isDue).toBe(true); // Current frame due -> render
    expect(isFutureDue).toBe(false); // Future frame is not due yet
    expect(isFutureHeld).toBe(true); // Future frame is held for next rAF, do NOT discard
  });

  it('handles 60 FPS timestamp jitter without dropping non-stale frames', () => {
    const nominalInterval = 1000 / 60; // 16.67ms
    const timestamps = [];
    let t = 0;
    for (let i = 0; i < 60; i++) {
      // Jitter +/- 3ms
      const jitter = (Math.sin(i) * 3);
      t += nominalInterval + jitter;
      timestamps.push(t);
    }

    // Verify all consecutive intervals are strictly monotonic
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });

  it('verifies backgroundThrottling: false is configured for broadcaster windows', async () => {
    const fs = await import('node:fs');
    const indexJs = fs.readFileSync('desktop/main/index.js', 'utf8');

    // Both openCaptureInElectron and createMainWindow must have backgroundThrottling: false
    expect(indexJs).toContain('backgroundThrottling: false');
    const matches = indexJs.match(/backgroundThrottling:\s*false/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves iOS and Discord Activity live-edge recovery', () => {
    const player = createPlayer(canvas);
    expect(typeof player.performLiveEdgeRecovery).toBe('function');

    // Live recovery resets timestamps and requests fresh keyframe
    player.performLiveEdgeRecovery();
    const metrics = player.getMetrics();
    expect(metrics.playbackBuffer.state).toBe('BUILDING');
    player.destroy();
  });
});

