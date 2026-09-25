import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

const source = readFileSync(new URL('../desktop/ui/capture-worker.js', import.meta.url), 'utf8');

function worker() {
  const api = { ready: vi.fn(), onCommand: vi.fn(), sendMessage: vi.fn(), sendChunk: vi.fn() };
  const context = vm.createContext({
    window: { captureAPI: api }, console, performance, Date,
    setTimeout, clearTimeout, setInterval, clearInterval,
    VideoFrame: class {
      constructor(frame, options) { Object.assign(this, frame, options); }
      close() {}
    },
  });
  vm.runInContext(source, context);
  return { api, run: code => vm.runInContext(code, context), context };
}

describe('Actual capture worker lifecycle and sustained load', () => {
  it('keeps keyframe timestamps in the source clock domain', () => {
    const { run } = worker();
    const timestamps = run(`
      running = true;
      lastTimestampUs = 10;
      cachedFrame = { timestamp: 10 };
      let encodedTimestamps = [];
      encoder = { state: 'configured', encodeQueueSize: 0, encode: frame => encodedTimestamps.push(frame.timestamp) };
      dispatchImmediateKeyframe();
      [encodedTimestamps[0], lastTimestampUs];
    `);
    expect([...timestamps]).toEqual([11, 10]);
  });

  it('bounds timing records even when the encoder never returns output', () => {
    const { run } = worker();
    expect(run('for (let i = 0; i < 100000; i++) rememberEncode(i, i); frameEncodeStartMap.size')).toBe(120);
  });

  it('reduces sustained encoder load and only raises quality after stable throughput', () => {
    const { run } = worker();
    run(`
      config = { codec: 'avc1.64002a', width: 1920, height: 1080, framerate: 60, bitrate: 8000000 };
      requestedQuality = { width: 1920, height: 1080, fps: 60, bitrate: 8000000 };
      srcW = 1920; srcH = 1080;
      encoder = { state: 'configured', encodeQueueSize: 9, configure() {} };
      framesCapture = 60; droppedEncoderPressure = 30;
      adaptQuality(1); adaptQuality(1);
    `);
    expect(run('qualityLevel')).toBe(0);
    run('adaptQuality(1)');
    expect(run('config.width')).toBeLessThan(1920);
    expect(run('qualityLevel')).toBe(1);
    run('encoder.encodeQueueSize = 0; droppedEncoderPressure = 0; framesEncoded = 60; for (let i = 0; i < 44; i++) adaptQuality(1)');
    expect(run('qualityLevel')).toBe(1);
    run('adaptQuality(1)');
    expect(run('qualityLevel')).toBe(0);
    expect(run('config.width')).toBe(1920);
  });

  it('closes a pending old frame without encoding it into a replacement session', async () => {
    const { run, context } = worker();
    let resolveRead;
    context.pending = new Promise(resolve => { resolveRead = resolve; });
    const close = vi.fn();
    const pumping = run(`running = true; pumpDirect({}, { read: () => pending }, null, captureGeneration)`);
    run('handleStop(); running = true');
    resolveRead({ value: { close }, done: false });
    await pumping;
    expect(close).toHaveBeenCalledOnce();
    expect(run('framesCapture')).toBe(0);
  });

  it('allows quality to recover when capture delivers slightly less than the configured FPS', () => {
    const { run } = worker();
    run(`
      config = { codec: 'avc1.640020', width: 1280, height: 720, framerate: 45, bitrate: 2500000 };
      requestedQuality = { width: 1920, height: 1080, fps: 60, bitrate: 8000000 };
      qualityLevel = 2; srcW = 1920; srcH = 1080;
      encoder = { state: 'configured', encodeQueueSize: 0, configure() {} };
      framesCapture = 37; framesAdmitted = 37; framesEncoded = 37;
      for (let i = 0; i < 45; i++) adaptQuality(1);
    `);
    expect(run('qualityLevel')).toBe(1);
  });

  it('reports a broken read pump to trigger main-process recovery', async () => {
    const { run, api } = worker();
    await run(`running = true; pumpDirect({}, { read: async () => ({done: true}) }, null, captureGeneration)`);
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'capture-error' }));
  });
});
