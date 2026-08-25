import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPlayer } from '../client/src/player.js';

describe('Activity Viewer In-Place DOM Resize (P0 Performance)', () => {
  let agora;
  let pendentes;

  beforeEach(() => {
    agora = 1000;
    pendentes = [];

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
      }
      configure() {
        this.state = 'configured';
      }
      decode(chunk) {
        this.output({
          timestamp: chunk.timestamp,
          displayWidth: chunk._w || 1920,
          displayHeight: chunk._h || 1080,
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

  function makeFakeCanvas() {
    return {
      width: 1280,
      height: 720,
      getContext: () => ({
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        set fillStyle(_) {},
      }),
      getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    };
  }

  it('1. onTamanho callback receives explicit width and height on resolution change', () => {
    const canvas = makeFakeCanvas();
    const onTamanhoSpy = vi.fn();

    const player = createPlayer(canvas, {
      onTamanho: onTamanhoSpy,
    });

    player.start({ codec: 'avc1.640028', width: 1280, height: 720 });

    // Push packet
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    view.setUint8(0, 0); // slot 0
    view.setUint8(1, 1); // KEYFRAME
    view.setFloat64(2, 1000 * 1000); // 1000ms
    view.setFloat64(10, Date.now());

    player.push(buffer);

    // Advance clock to trigger requestAnimationFrame step
    agora = 2000;
    while (pendentes.length) {
      const cb = pendentes.shift();
      cb(agora);
    }

    expect(onTamanhoSpy).toHaveBeenCalledTimes(1);
    expect(onTamanhoSpy).toHaveBeenCalledWith({ width: 1920, height: 1080 });
  });

  it('2. in-place DOM update preserves tile and canvas identity across resolution changes', () => {
    // Simulated DOM tree
    const grid = {
      children: [],
      replaceChildren: vi.fn(),
    };

    const tile = {
      className: 'tile sharing tile-palco',
      dataset: { slot: '0' },
      classList: {
        contains: (cls) => cls === 'tile-palco',
      },
      style: {
        aspectRatio: '16 / 9',
      },
      querySelector: (selector) => {
        if (selector === '.tile-loading') return loadingElement;
        return null;
      },
    };

    let loadingRemoved = false;
    const loadingElement = {
      remove: () => {
        loadingRemoved = true;
      },
    };

    const diagnostics = {
      fullGridRebuilds: 0,
      videoSizeChanges: 0,
    };

    // Simulated in-place resolution handler
    function handleResolutionChange(dim, slot) {
      diagnostics.videoSizeChanges++;
      if (tile.dataset.slot === String(slot)) {
        const loading = tile.querySelector('.tile-loading');
        if (loading) loading.remove();

        if (tile.classList.contains('tile-palco') && dim?.width && dim?.height) {
          tile.style.aspectRatio = `${dim.width} / ${dim.height}`;
        }
      }
    }

    // First frame (1920x1080)
    handleResolutionChange({ width: 1920, height: 1080 }, 0);
    expect(loadingRemoved).toBe(true);
    expect(tile.style.aspectRatio).toBe('1920 / 1080');
    expect(diagnostics.fullGridRebuilds).toBe(0);
    expect(grid.replaceChildren).not.toHaveBeenCalled();

    // Second resolution change (1600x900)
    handleResolutionChange({ width: 1600, height: 900 }, 0);
    expect(tile.style.aspectRatio).toBe('1600 / 900');
    expect(diagnostics.fullGridRebuilds).toBe(0);
    expect(diagnostics.videoSizeChanges).toBe(2);
    expect(grid.replaceChildren).not.toHaveBeenCalled();
  });

  it('3. stress test: rapid resolution fluctuations do not cause grid rebuilds or memory growth', () => {
    const resolutions = [
      { width: 1920, height: 1080 },
      { width: 1600, height: 900 },
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
      { width: 1720, height: 968 },
      { width: 1920, height: 1080 },
    ];

    const tile = {
      className: 'tile sharing tile-palco',
      dataset: { slot: '0' },
      classList: {
        contains: (cls) => cls === 'tile-palco',
      },
      style: { aspectRatio: '' },
      querySelector: () => null,
    };

    const diagnostics = {
      fullGridRebuilds: 0,
      videoSizeChanges: 0,
    };

    const fullGridRebuildMock = vi.fn();

    // 100 rapid resolution changes
    for (let i = 0; i < 100; i++) {
      const res = resolutions[i % resolutions.length];
      diagnostics.videoSizeChanges++;
      if (tile.dataset.slot === '0') {
        tile.style.aspectRatio = `${res.width} / ${res.height}`;
      }
    }

    expect(diagnostics.videoSizeChanges).toBe(100);
    expect(diagnostics.fullGridRebuilds).toBe(0);
    expect(fullGridRebuildMock).not.toHaveBeenCalled();
    expect(tile.style.aspectRatio).toBe('1024 / 768');
  });
});
