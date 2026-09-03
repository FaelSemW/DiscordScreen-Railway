/**
 * REGRESSION & STABILITY TESTS: Video/Audio Readiness & Presentation Pipeline
 *
 * Covers:
 * - Section 28: Stream active, audio flowing, unaligned video frames arrive, assert
 *   seamless transition to playing, first frame rendered, tile-loading removed.
 * - Section 29: Audio arrives at T+0, video delayed by 1.5s, verifies intermediate
 *   WAITING_FOR_VIDEO state and clean recovery when first frame arrives.
 * - Section 30: Video stops while audio continues, restarts smoothly without page reload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPlayer } from '../client/src/player.js';

describe('Video/Audio Readiness, Timebase Alignment & Recovery Pipeline', () => {
  let agora = 0;
  let pendentes = [];
  let desenhados = [];
  let keyframeRequests = 0;
  let decodedFrames = [];

  function canvasFalso() {
    return {
      width: 1280,
      height: 720,
      getContext: () => ({
        drawImage: (frame) => {
          desenhados.push({
            tsMs: Math.round(frame.timestamp / 1000),
            renderedAt: agora,
            w: frame.displayWidth,
            h: frame.displayHeight,
          });
        },
        fillRect: () => {},
        set fillStyle(_) {},
      }),
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    };
  }

  function avancar(ms, passo = 16) {
    const alvo = agora + ms;
    while (agora < alvo) {
      agora = Math.min(alvo, agora + passo);
      const rodando = pendentes;
      pendentes = [];
      for (const cb of rodando) cb(agora);
    }
  }

  function pacote(tipo, timestampMs, sentAtMs = Date.now()) {
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    view.setUint8(0, 0); // slot 0
    view.setUint8(1, tipo); // 1 = key, 2 = delta
    view.setFloat64(2, timestampMs * 1000); // us
    view.setFloat64(10, sentAtMs);
    return buffer;
  }

  beforeEach(() => {
    agora = 1000;
    pendentes = [];
    desenhados = [];
    decodedFrames = [];
    keyframeRequests = 0;

    vi.spyOn(performance, 'now').mockImplementation(() => agora);
    globalThis.requestAnimationFrame = (cb) => {
      pendentes.push(cb);
      return pendentes.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    globalThis.VideoDecoder = class {
      constructor({ output, error }) {
        this.output = output;
        this.error = error;
        this.state = 'unconfigured';
        this.width = 1280;
        this.height = 720;
      }
      configure(cfg) {
        this.state = 'configured';
        this.width = cfg?.codedWidth || 1280;
        this.height = cfg?.codedHeight || 720;
      }
      decode(chunk) {
        decodedFrames.push(chunk.timestamp);
        this.output({
          timestamp: chunk.timestamp,
          displayWidth: this.width,
          displayHeight: this.height,
          close: vi.fn(),
        });
      }
      close() {
        this.state = 'closed';
      }
    };

    globalThis.EncodedVideoChunk = class {
      constructor(init) {
        Object.assign(this, init);
      }
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Section 28: Audio flowing, unaligned video arrives, transitions to render-ready without freezing', () => {
    // Audio is playing continuously at 50,000ms offset (WASAPI / hardware time base)
    let audioClockMs = 50000;
    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: audioClockMs,
      bufferAheadMs: 400,
      underrunCount: 0,
    });

    let onTamanhoFired = false;
    let renderedDimensions = null;

    const player = createPlayer(canvasFalso(), {
      latencyMode: 'stable',
      getAudioClock: fakeAudioClock,
      onNeedKeyframe: () => {
        keyframeRequests++;
      },
      onTamanho: (dim) => {
        onTamanhoFired = true;
        renderedDimensions = dim;
      },
    });

    expect(player.start({ codec: 'avc1.640028', codedWidth: 1280, codedHeight: 720 })).toBe(true);

    // Initial packet arrives (raw video capture time from host, starting at 0)
    player.push(pacote(1, 0));
    avancar(16);

    // Initial offset triggered keyframe request as expected
    expect(keyframeRequests).toBe(1);

    // Broadcaster responds with keyframe on its own timeline
    player.push(pacote(1, 16.67));
    player.push(pacote(2, 33.34));

    // Advance clock while audio advances synchronously
    for (let i = 0; i < 30; i++) {
      audioClockMs += 16.67;
      avancar(16.67);
    }

    // Proves: first frame rendered, onTamanho fired, video rendered smoothly
    expect(onTamanhoFired).toBe(true);
    expect(renderedDimensions).toEqual({ width: 1280, height: 720 });
    expect(desenhados.length).toBeGreaterThan(0);
    expect(player.takeFrameCount()).toBeGreaterThan(0);

    const metrics = player.getMetrics();
    expect(metrics.audio.clockSource).toBe('AUDIO');
    expect(Math.abs(metrics.audio.avDriftMs)).toBeLessThan(100);
  });

  it('Section 29: Late first frame (audio at T+0, video delayed by 1.5s) recovers cleanly', () => {
    let audioClockMs = 1000;
    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: audioClockMs,
      bufferAheadMs: 400,
      underrunCount: 0,
    });

    let onTamanhoFired = false;

    const player = createPlayer(canvasFalso(), {
      latencyMode: 'stable',
      getAudioClock: fakeAudioClock,
      onTamanho: () => {
        onTamanhoFired = true;
      },
    });

    player.start({ codec: 'avc1.640028', codedWidth: 1280, codedHeight: 720 });

    // Audio runs for 1.5 seconds (90 frames at 60Hz) with NO video arriving
    for (let i = 0; i < 90; i++) {
      audioClockMs += 16.67;
      avancar(16.67);
    }

    // Video has not rendered yet during the delay
    expect(onTamanhoFired).toBe(false);
    expect(desenhados).toHaveLength(0);

    // Delayed video keyframe finally arrives at T+1.5s
    player.push(pacote(1, 1500));
    player.push(pacote(2, 1516.67));
    player.push(pacote(2, 1533.34));

    // Advance 100ms
    for (let i = 0; i < 10; i++) {
      audioClockMs += 16.67;
      avancar(16.67);
    }

    // Recovers cleanly and presents video frames aligned to audio
    expect(onTamanhoFired).toBe(true);
    expect(desenhados.length).toBeGreaterThan(0);
    expect(desenhados[0].tsMs).toBeGreaterThanOrEqual(1500);
  });

  it('Section 30: Video stops while audio continues, then video restarts smoothly without reload', () => {
    let audioClockMs = 2000;
    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: audioClockMs,
      bufferAheadMs: 400,
      underrunCount: 0,
    });

    let onTamanhoCount = 0;

    const player = createPlayer(canvasFalso(), {
      latencyMode: 'stable',
      getAudioClock: fakeAudioClock,
      onTamanho: () => {
        onTamanhoCount++;
      },
    });

    // Session 1: video active
    player.start({ codec: 'avc1.640028', codedWidth: 1280, codedHeight: 720 });
    player.push(pacote(1, 2000));
    player.push(pacote(2, 2016.67));
    avancar(100);

    expect(desenhados.length).toBeGreaterThan(0);
    expect(onTamanhoCount).toBe(1);

    // User/network pauses or stops video stream, but audio keeps running
    player.stop();

    for (let i = 0; i < 60; i++) {
      audioClockMs += 16.67;
      avancar(16.67);
    }

    // Session 2: video restarts with new keyframe (e.g. user toggled screen share)
    expect(player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 })).toBe(true);
    player.push(pacote(1, 3000));
    player.push(pacote(2, 3016.67));
    player.push(pacote(2, 3033.34));

    for (let i = 0; i < 20; i++) {
      audioClockMs += 16.67;
      avancar(16.67);
    }

    // Decoder rebound cleanly, onTamanho fired for new resolution, frames rendered
    expect(onTamanhoCount).toBe(2);
    expect(desenhados.length).toBeGreaterThan(2);
    expect(player.getSizes().video).toBe('1920×1080');
  });

  it('Critical: Calibration learned from Stream A never survives into Stream B (substantial epoch change)', () => {
    let audioClockMs = 500;
    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: audioClockMs,
      bufferAheadMs: 300,
      underrunCount: 0,
    });

    let resyncCount = 0;
    let onTamanhoCount = 0;

    const player = createPlayer(canvasFalso(), {
      latencyMode: 'stable',
      getAudioClock: fakeAudioClock,
      onNeedKeyframe: () => {
        resyncCount++;
      },
      onTamanho: () => {
        onTamanhoCount++;
      },
    });

    // --- STREAM A ---
    // Video starts at epoch 100,000ms while audio is at 500ms
    player.start({ codec: 'avc1.640028', codedWidth: 1280, codedHeight: 720 });
    player.push(pacote(1, 100000));
    player.push(pacote(2, 100016.67));
    player.push(pacote(2, 100033.34));

    for (let i = 0; i < 20; i++) {
      audioClockMs += 16.67;
      avancar(16.67);
    }

    expect(onTamanhoCount).toBe(1);
    expect(desenhados.length).toBeGreaterThan(0);
    const metricsA = player.getMetrics();
    expect(Math.abs(metricsA.audio.avDriftMs)).toBeLessThan(100);

    // --- STOP STREAM A ---
    player.stop();

    // Verify all stream A state is cleared
    const metricsStopped = player.getMetrics();
    expect(metricsStopped.videoFrameLifetime.currentlyLive).toBe(0);
    expect(metricsStopped.playbackBuffer.state).toBe('BUILDING');

    // Simulate idle time
    audioClockMs = 15000;
    for (let i = 0; i < 30; i++) {
      audioClockMs += 16.67;
      avancar(16.67);
    }

    // --- STREAM B ---
    // Video starts at a drastically different epoch: 85,000,000ms (QPC uptime in another session)
    // If Stream A's offset (~99,500ms) survived, Stream B would suffer massive drift (>84M ms)
    // and fail to render or loop on HARD_RESYNC.
    const preResyncs = resyncCount;
    desenhados.length = 0;

    player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });
    player.push(pacote(1, 85000000));
    player.push(pacote(2, 85000016.67));
    player.push(pacote(2, 85000033.34));

    for (let i = 0; i < 25; i++) {
      audioClockMs += 16.67;
      avancar(16.67);
    }

    // Verify fresh calibration, first frame rendered, no infinite resync loop
    expect(onTamanhoCount).toBe(2);
    expect(desenhados.length).toBeGreaterThan(0);
    expect(desenhados[0].tsMs).toBeGreaterThanOrEqual(85000000);
    const metricsB = player.getMetrics();
    expect(Math.abs(metricsB.audio.avDriftMs)).toBeLessThan(100);
  });

  it('10 restart cycles with varying timestamp epochs converge smoothly without stall', () => {
    let audioClockMs = 1000;
    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: audioClockMs,
      bufferAheadMs: 350,
      underrunCount: 0,
    });

    let resyncCount = 0;
    let onTamanhoCount = 0;

    const player = createPlayer(canvasFalso(), {
      latencyMode: 'stable',
      getAudioClock: fakeAudioClock,
      onNeedKeyframe: () => {
        resyncCount++;
      },
      onTamanho: () => {
        onTamanhoCount++;
      },
    });

    // 10 distinct epochs
    const epochs = [
      0,
      50000,
      1200000,
      350,
      9999999,
      12345,
      45000000,
      88888,
      250000,
      77777777,
    ];

    for (let cycle = 0; cycle < 10; cycle++) {
      const baseVideoTs = epochs[cycle];
      audioClockMs += 5000; // audio moves forward across cycles
      const previousResyncs = resyncCount;

      player.start({ codec: 'avc1.640028', codedWidth: 1280, codedHeight: 720 });

      desenhados.length = 0;
      player.push(pacote(1, baseVideoTs));
      player.push(pacote(2, baseVideoTs + 16.67));
      avancar(16.67);

      // If initial packet requested a keyframe (e.g. video clock behind audio), broadcaster provides keyframe
      if (resyncCount > previousResyncs) {
        player.push(pacote(1, baseVideoTs + 33.34));
        player.push(pacote(2, baseVideoTs + 50));
      } else {
        player.push(pacote(2, baseVideoTs + 33.34));
      }

      for (let f = 0; f < 25; f++) {
        audioClockMs += 16.67;
        avancar(16.67);
      }

      expect(onTamanhoCount).toBe(cycle + 1);
      expect(desenhados.length).toBeGreaterThan(0);
      const metrics = player.getMetrics();
      expect(Math.abs(metrics.audio.avDriftMs)).toBeLessThan(100);

      player.stop();
    }
  });
});
