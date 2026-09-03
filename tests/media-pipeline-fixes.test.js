import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LATENCY_MODES } from '../shared/latency-policy.js';
import { createAudio } from '../client/src/audio.js';
import { createPlayer } from '../client/src/player.js';

describe('Media Pipeline Fixes: Stutter, A/V Sync, Tab Audio & iPhone Audio', () => {
  let originalAudioContext;
  let originalAudioDecoder;
  let originalVideoDecoder;
  let originalEncodedAudioChunk;
  let originalEncodedVideoChunk;
  let originalRAF;
  let originalCancelRAF;

  beforeEach(() => {
    originalAudioContext = globalThis.AudioContext;
    originalAudioDecoder = globalThis.AudioDecoder;
    originalVideoDecoder = globalThis.VideoDecoder;
    originalEncodedAudioChunk = globalThis.EncodedAudioChunk;
    originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
    originalRAF = globalThis.requestAnimationFrame;
    originalCancelRAF = globalThis.cancelAnimationFrame;

    globalThis.EncodedAudioChunk = class {
      constructor(init) {
        Object.assign(this, init);
      }
    };
    globalThis.EncodedVideoChunk = class {
      constructor(init) {
        Object.assign(this, init);
      }
    };
  });

  afterEach(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.AudioDecoder = originalAudioDecoder;
    globalThis.VideoDecoder = originalVideoDecoder;
    globalThis.EncodedAudioChunk = originalEncodedAudioChunk;
    globalThis.EncodedVideoChunk = originalEncodedVideoChunk;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
    vi.restoreAllMocks();
  });

  describe('Bug 1 & Bug 2: Latency Policy & Queue Bounds', () => {
    it('defines bounded filaMax and buffer targets across all latency modes', () => {
      expect(LATENCY_MODES.stable.filaMax).toBeDefined();
      expect(LATENCY_MODES.balanced.filaMax).toBeLessThan(LATENCY_MODES.stable.filaMax);
      expect(LATENCY_MODES['ultra-low'].filaMax).toBeLessThan(LATENCY_MODES.balanced.filaMax);
    });

    it('sets real-time buffer targets suitable for interactive screen sharing', () => {
      expect(LATENCY_MODES.stable.targetBufferMs).toBe(1000);
      expect(LATENCY_MODES.balanced.targetBufferMs).toBe(600);
      expect(LATENCY_MODES['ultra-low'].targetBufferMs).toBe(150);
      expect(LATENCY_MODES.stable.hardResyncThresholdMs).toBe(1800);
    });
  });

  describe('Bug 2: Audio Presentation Clock Precision', () => {
    it('calculates physical presentation time before chunk starts playing', () => {
      let currentTime = 10.0; // AudioContext timeline

      class MockAudioContext {
        get currentTime() {
          return currentTime;
        }
        createGain() {
          return {
            gain: { value: 1, setTargetAtTime: vi.fn() },
            connect: vi.fn(),
          };
        }
        createBuffer() {
          return { duration: 0.02, getChannelData: () => new Float32Array(960) };
        }
        createBufferSource() {
          return {
            connect: vi.fn(),
            start: vi.fn(),
          };
        }
        get state() {
          return 'running';
        }
        close() {
          return Promise.resolve();
        }
      }

      class MockAudioDecoder {
        constructor({ output }) {
          this.output = output;
          this.state = 'unconfigured';
        }
        configure() {
          this.state = 'configured';
        }
        decode() {
          // Deliver one 20ms chunk scheduled ahead
          this.output({
            numberOfChannels: 2,
            numberOfFrames: 960,
            sampleRate: 48000,
            timestamp: 5000000, // 5.0s in us = 5000ms
            copyTo: vi.fn(),
            close: vi.fn(),
          });
        }
        close() {
          this.state = 'closed';
        }
      }

      globalThis.AudioContext = MockAudioContext;
      globalThis.AudioDecoder = MockAudioDecoder;

      const audio = createAudio({ latencyMode: 'stable' });
      audio.start({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });

      // Feed an audio packet
      const fakeBuffer = new ArrayBuffer(20);
      const view = new DataView(fakeBuffer);
      view.setFloat64(2, 5000000);
      view.setFloat64(10, Date.now());
      audio.push(fakeBuffer);

      // currentTime is 10.0. The scheduled chunk startTime is around 10.4 (400ms cushion in stable).
      // Since agora < startTime, presentation time must be lower than 5000ms by ~400ms (around 4600ms)
      const clock = audio.getAudioClock();
      expect(clock.active).toBe(true);
      expect(clock.mediaTimestampMs).toBeLessThanOrEqual(5000);
      expect(clock.mediaTimestampMs).toBeGreaterThan(4500);

      // Advance timeline to exact start time
      currentTime = 10.4;
      const clockAtStart = audio.getAudioClock();
      expect(Math.round(clockAtStart.mediaTimestampMs)).toBe(5000);

      audio.stop();
    });
  });

  describe('Bug 4: iPhone Audio Autoplay Lifecycle & User Gesture Unlock', () => {
    it('detects suspended AudioContext state on iOS and resumes synchronously on user gesture', async () => {
      let state = 'suspended';
      const onStateChange = vi.fn();

      class MockSuspendedContext {
        constructor() {
          this._state = state;
        }
        get state() {
          return this._state;
        }
        set state(v) {
          this._state = v;
          this.onstatechange?.();
        }
        createGain() {
          return {
            gain: { value: 1, setTargetAtTime: vi.fn() },
            connect: vi.fn(),
          };
        }
        resume() {
          this._state = 'running';
          this.onstatechange?.();
          return Promise.resolve();
        }
        close() {
          this._state = 'closed';
          return Promise.resolve();
        }
      }

      class MockAudioDecoder {
        configure() {}
        close() {}
      }

      globalThis.AudioContext = MockSuspendedContext;
      globalThis.AudioDecoder = MockAudioDecoder;

      const audio = createAudio({ onStateChange });
      const started = audio.start({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      expect(started).toBe(true);

      // Verify suspended state detection
      expect(audio.isSuspended()).toBe(true);
      expect(audio.getState()).toBe('suspended');

      // Synchronous user gesture trigger
      const resumed = await audio.resume();
      expect(resumed).toBe(true);
      expect(audio.isSuspended()).toBe(false);
      expect(audio.getState()).toBe('running');

      audio.stop();
      expect(audio.getState()).toBe('closed');
    });
  });

  describe('Bug 1 & Bug 2: Player Immediate Initial A/V Calibration', () => {
    it('calibrates A/V offset on epoch difference and applies smooth drift slew', () => {
      class MockVideoDecoder {
        constructor({ output }) {
          this.output = output;
          this.decodeQueueSize = 0;
          this.state = 'unconfigured';
        }
        configure() {
          this.state = 'configured';
        }
        decode(chunk) {
          this.output({
            timestamp: chunk.timestamp,
            displayWidth: 1280,
            displayHeight: 720,
            close: vi.fn(),
          });
        }
        close() {
          this.state = 'closed';
        }
      }

      let rafCallbacks = [];
      globalThis.requestAnimationFrame = (cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      };
      globalThis.cancelAnimationFrame = () => {
        rafCallbacks = [];
      };
      globalThis.VideoDecoder = MockVideoDecoder;

      const mockCanvas = {
        width: 1280,
        height: 720,
        getContext: () => ({
          drawImage: vi.fn(),
          fillRect: vi.fn(),
        }),
      };

      // Video epoch is 50,000ms ahead of audio
      let mockAudioTimestamp = 0;
      const getAudioClock = () => ({
        active: true,
        mediaTimestampMs: mockAudioTimestamp,
      });

      const player = createPlayer(mockCanvas, {
        getAudioClock,
        latencyMode: 'stable',
      });

      player.start({ codec: 'avc1.42E01E', width: 1280, height: 720 });

      // Video keyframe arrives with timestamp 50000ms (video ahead of audio > 1800ms)
      const buf = new ArrayBuffer(20);
      const view = new DataView(buf);
      view.setUint8(0, 0); // slot
      view.setUint8(1, 1); // keyframe
      view.setFloat64(2, 50000000); // 50s in us = 50000ms
      view.setFloat64(10, Date.now());

      player.push(buf, true, 16);

      // Trigger RAF tick
      expect(rafCallbacks.length).toBeGreaterThan(0);
      const cb = rafCallbacks.shift();
      cb();

      // Verify calibration happened
      expect(player.getAudioToVideoOffset()).toBe(50000);
      expect(player.getAvDrift()).toBe(0);

      player.stop();
    });
  });

  describe('Diagnostics Instrumentation: Alarms & Metric Snapshots', () => {
    it('reports frame backlog alarms, keyframe request counts, and queue age diagnostics', () => {
      class MockVideoDecoder {
        constructor({ output }) {
          this.output = output;
          this.decodeQueueSize = 0;
          this.state = 'unconfigured';
        }
        configure() {
          this.state = 'configured';
        }
        decode(chunk) {
          this.output({
            timestamp: chunk.timestamp,
            displayWidth: 1280,
            displayHeight: 720,
            close: vi.fn(),
          });
        }
        close() {
          this.state = 'closed';
        }
      }

      globalThis.VideoDecoder = MockVideoDecoder;
      globalThis.requestAnimationFrame = vi.fn();
      globalThis.cancelAnimationFrame = vi.fn();

      const mockCanvas = {
        width: 1280,
        height: 720,
        getContext: () => ({
          drawImage: vi.fn(),
          fillRect: vi.fn(),
        }),
      };

      let keyframesRequested = 0;
      const player = createPlayer(mockCanvas, {
        onNeedKeyframe: () => {
          keyframesRequested++;
        },
        latencyMode: 'stable',
      });

      player.start({ codec: 'avc1.42E01E', width: 1280, height: 720 });

      // Initial metrics check
      const initialMetrics = player.getMetrics();
      expect(initialMetrics.frameBacklogAlarm).toBe('NORMAL');
      expect(initialMetrics.keyframeRequestCount).toBe(0);
      expect(initialMetrics.hardResyncsPerMinute).toBe(0);
      expect(initialMetrics.pipelineHealth).toBe('HEALTHY');

      // Push a frame
      const buf = new ArrayBuffer(20);
      const view = new DataView(buf);
      view.setUint8(0, 0); // slot
      view.setUint8(1, 1); // keyframe
      view.setFloat64(2, 1000000); // 1s
      view.setFloat64(10, Date.now());

      player.push(buf, true, 16);

      const runningMetrics = player.getMetrics();
      expect(runningMetrics.presentationQueueSize).toBe(1);
      expect(runningMetrics.oldestQueuedFrameAgeMs).toBeGreaterThanOrEqual(0);
      expect(runningMetrics.frameBacklogAlarm).toBe('NORMAL');

      player.stop();
    });

    it('accurately tracks chunksReceivedCount in audio player', () => {
      class MockAudioContext {
        constructor() {
          this.currentTime = 0;
          this.state = 'running';
          this.destination = {};
        }
        createGain() {
          return {
            connect: vi.fn(),
            gain: { setTargetAtTime: vi.fn() },
          };
        }
        createBuffer() {
          return {
            copyToChannel: vi.fn(),
          };
        }
        createBufferSource() {
          return {
            buffer: null,
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            onended: null,
          };
        }
        resume() {
          this.state = 'running';
          return Promise.resolve();
        }
        close() {
          this.state = 'closed';
          return Promise.resolve();
        }
      }

      class MockAudioDecoder {
        constructor({ output }) {
          this.output = output;
          this.state = 'unconfigured';
        }
        configure() {
          this.state = 'configured';
        }
        decode() {}
        close() {
          this.state = 'closed';
        }
      }

      globalThis.AudioContext = MockAudioContext;
      globalThis.AudioDecoder = MockAudioDecoder;

      const audio = createAudio();
      audio.start({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });

      expect(audio.getChunksReceived()).toBe(0);

      const fakeBuffer = new ArrayBuffer(20);
      const view = new DataView(fakeBuffer);
      view.setFloat64(2, 1000000);
      view.setFloat64(10, Date.now());

      audio.push(fakeBuffer);
      audio.push(fakeBuffer);
      audio.push(fakeBuffer);

      expect(audio.getChunksReceived()).toBe(3);

      audio.stop();
      expect(audio.getChunksReceived()).toBe(0);
    });
  });
});
