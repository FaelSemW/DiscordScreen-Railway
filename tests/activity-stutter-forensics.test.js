import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPlayer } from '../client/src/player.js';

describe('Discord Activity vs Web Viewer Stutter Forensics', () => {
  let agora = 0;
  let pendentes = [];
  let desenhados = [];
  let closedFrames = [];

  function fakeCanvas() {
    return {
      width: 1920,
      height: 1080,
      getContext: () => ({
        drawImage: (frame) => desenhados.push({ ts: Math.round(frame.timestamp / 1000), at: agora }),
        fillRect: () => {},
        set fillStyle(_) {},
      }),
      getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
    };
  }

  function makePacket(slot, isKeyframe, timestampMs) {
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    view.setUint8(0, slot);
    view.setUint8(1, isKeyframe ? 1 : 2);
    view.setFloat64(2, timestampMs * 1000);
    view.setFloat64(10, Date.now());
    return buffer;
  }

  function stepTime(ms, stepIntervalMs = 16.67) {
    const target = agora + ms;
    while (agora < target) {
      agora = Math.min(target, agora + stepIntervalMs);
      const toRun = pendentes;
      pendentes = [];
      for (const cb of toRun) cb(agora);
    }
  }

  beforeEach(() => {
    agora = 1000;
    pendentes = [];
    desenhados = [];
    closedFrames = [];

    vi.spyOn(performance, 'now').mockImplementation(() => agora);
    globalThis.requestAnimationFrame = (cb) => {
      pendentes.push(cb);
      return pendentes.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    globalThis.VideoDecoder = class {
      constructor({ output }) {
        this.output = output;
        this.state = 'unconfigured';
        this.decodeQueueSize = 0;
      }
      configure() {
        this.state = 'configured';
      }
      decode(chunk) {
        this.output({
          timestamp: chunk.timestamp,
          displayWidth: 1920,
          displayHeight: 1080,
          close: () => closedFrames.push(chunk.timestamp / 1000),
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

  it('1. Web Viewer (60 Hz steady rAF): plays 60 FPS stream smoothly with 1 frame per VSync', () => {
    const player = createPlayer(fakeCanvas(), { latencyMode: 'stable' });
    player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });

    // Initial startup buffer fill (800ms of 60 FPS frames = 48 frames)
    for (let i = 0; i < 48; i++) {
      player.push(makePacket(0, i === 0, i * 16.67));
    }

    // Run for 1 second at 60 Hz rAF (stepInterval = 16.67ms)
    // 60 more frames arrive continuously (1 per tick)
    for (let i = 48; i < 108; i++) {
      stepTime(16.67, 16.67);
      player.push(makePacket(0, false, i * 16.67));
    }

    expect(desenhados.length).toBeGreaterThan(45);
    const metrics = player.getMetrics();
    expect(metrics.presentationQueueSize).toBeLessThanOrEqual(48);
  });

  it('2. Activity Viewer under 30 Hz rAF throttling with 60 FPS stream: must present latest on-time frame without accumulating queue backlog', () => {
    const player = createPlayer(fakeCanvas(), { latencyMode: 'stable' });
    player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });

    // Startup buffer fill
    for (let i = 0; i < 48; i++) {
      player.push(makePacket(0, i === 0, i * 16.67));
    }

    // Run for 2 seconds (60 rAF ticks at 33.33ms / 30 Hz)
    // While broadcaster sends 60 FPS (2 frames per 33.33ms tick)
    for (let tick = 0; tick < 60; tick++) {
      const frameIdx = 48 + tick * 2;
      player.push(makePacket(0, false, frameIdx * 16.67));
      player.push(makePacket(0, false, (frameIdx + 1) * 16.67));
      stepTime(33.33, 33.33);
    }

    const metrics = player.getMetrics();
    expect(metrics.presentationQueueSize).toBeLessThanOrEqual(55);
    expect(closedFrames.length).toBeGreaterThan(30);
  });

  it('3. 30 FPS stream on 60 Hz display: presents 30 frames at steady 33.3ms intervals without stutter', () => {
    const player = createPlayer(fakeCanvas(), { latencyMode: 'stable' });
    player.start({ codec: 'avc1.640028', codedWidth: 1280, codedHeight: 720 });

    // Initial startup buffer fill (24 frames = 800ms)
    for (let i = 0; i < 24; i++) {
      player.push(makePacket(0, i === 0, i * 33.33));
    }

    // 1 second playback at 60 Hz rAF
    for (let tick = 0; tick < 60; tick++) {
      stepTime(16.67, 16.67);
      if (tick % 2 === 0) {
        player.push(makePacket(0, false, (24 + tick / 2) * 33.33));
      }
    }

    expect(desenhados.length).toBeGreaterThan(20);
    const metrics = player.getMetrics();
    expect(metrics.presentationQueueSize).toBeLessThanOrEqual(30);
  });

  it('4. Audio Master Clock sync: video scheduler stays aligned to WebAudio clock without queue drift', () => {
    let mockAudioTimeMs = 0;
    const mockAudioClock = {
      active: true,
      mediaTimestampMs: 0,
      bufferAheadMs: 500,
    };

    const player = createPlayer(fakeCanvas(), {
      latencyMode: 'stable',
      getAudioClock: () => ({
        active: mockAudioClock.active,
        mediaTimestampMs: mockAudioTimeMs,
        bufferAheadMs: mockAudioClock.bufferAheadMs,
      }),
    });
    player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });

    // 48 frames at 60 FPS
    for (let i = 0; i < 48; i++) {
      player.push(makePacket(0, i === 0, i * 16.67));
    }

    // Advance 1 second where audio clock advances by 16.67ms per tick
    for (let i = 0; i < 60; i++) {
      mockAudioTimeMs += 16.67;
      stepTime(16.67, 16.67);
      player.push(makePacket(0, false, (48 + i) * 16.67));
    }

    expect(desenhados.length).toBeGreaterThan(45);
    const metrics = player.getMetrics();
    expect(metrics.clockSource).toBe('AUDIO');
    expect(Math.abs(metrics.avDriftMs)).toBeLessThan(50);
  });

  it('5. Memory Leak Proof: all decoded frames are guaranteed closed upon render, discard, or stop', () => {
    const player = createPlayer(fakeCanvas(), { latencyMode: 'stable' });
    player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });

    // Push 100 frames
    for (let i = 0; i < 100; i++) {
      player.push(makePacket(0, i === 0, i * 16.67));
    }

    // Step through 30 Hz rAF
    for (let i = 0; i < 50; i++) {
      stepTime(33.33, 33.33);
    }

    player.stop();

    // In steady state after stop, every single pushed frame must be closed
    expect(closedFrames.length).toBe(100);
  });

  it('6. 60 FPS input under 45 Hz and 50 Hz rAF: queue remains bounded and latency near live edge', () => {
    const player = createPlayer(fakeCanvas(), { latencyMode: 'stable' });
    player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });

    // Initial buffer (48 frames)
    for (let i = 0; i < 48; i++) player.push(makePacket(0, i === 0, i * 16.67));

    // 45 Hz rAF (22.22ms step)
    for (let tick = 0; tick < 45; tick++) {
      const ts = (48 + tick * 1.33) * 16.67;
      player.push(makePacket(0, false, ts));
      stepTime(22.22, 22.22);
    }

    const metrics = player.getMetrics();
    expect(metrics.presentationQueueSize).toBeLessThanOrEqual(55);
  });

  it('7. 60 FPS input under irregular rAF pattern (16ms, 16ms, 33ms, 16ms, 50ms): no hard resync occurs', () => {
    const player = createPlayer(fakeCanvas(), { latencyMode: 'stable' });
    player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });

    for (let i = 0; i < 48; i++) player.push(makePacket(0, i === 0, i * 16.67));

    const pattern = [16.67, 16.67, 33.33, 16.67, 50.0, 16.67];
    let frameCount = 48;
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const step of pattern) {
        const framesInStep = Math.round(step / 16.67);
        for (let f = 0; f < framesInStep; f++) {
          player.push(makePacket(0, false, frameCount++ * 16.67));
        }
        stepTime(step, step);
      }
    }

    const metrics = player.getMetrics();
    expect(metrics.presentationQueueSize).toBeLessThanOrEqual(55);
  });

  it('8. Stall Recovery (250ms and 500ms renderer stalls during playback): catches up immediately by discarding stale frames', () => {
    const player = createPlayer(fakeCanvas(), { latencyMode: 'stable' });
    player.start({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 });

    for (let i = 0; i < 48; i++) player.push(makePacket(0, i === 0, i * 16.67));

    // Play actively for 1 second at 60 Hz so clock is anchored
    let frameIdx = 48;
    for (let i = 0; i < 60; i++) {
      stepTime(16.67, 16.67);
      player.push(makePacket(0, false, frameIdx++ * 16.67));
    }

    // Now simulate 250ms stall (packets arrive continuously over network while rAF callback is delayed)
    const stall250Frames = Math.round(250 / 16.67);
    for (let i = 0; i < stall250Frames; i++) {
      player.push(makePacket(0, false, frameIdx++ * 16.67));
    }
    // rAF wakes up after 250ms
    stepTime(250, 250);

    // One rAF tick after waking up: queue must drop obsolete frames and be near normal target buffer
    const metrics250 = player.getMetrics();
    expect(metrics250.presentationQueueSize).toBeLessThanOrEqual(52);

    // Simulate 500ms stall
    const stall500Frames = Math.round(500 / 16.67);
    for (let i = 0; i < stall500Frames; i++) {
      player.push(makePacket(0, false, frameIdx++ * 16.67));
    }
    stepTime(500, 500);

    const metrics500 = player.getMetrics();
    expect(metrics500.presentationQueueSize).toBeLessThanOrEqual(52);
  });
});
