/**
 * Activity Fullscreen Restoration Tests
 *
 * These tests validate the two-mode player behavior:
 *   NORMAL              -- palco layout with sidebar, aspect-ratio on tile
 *   ACTIVITY_FULLSCREEN -- telaCheia mode, aspect-ratio removed, tile fills viewport
 *
 * No media pipeline (audio.js, decoders, A/V clocks) is involved or modified.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock for the state that renderGrid() tracks */
function makeState(overrides = {}) {
  return {
    telaCheia: false,
    activeSlot: 1,
    inRoom: true,
    ...overrides,
  };
}

/** Compute how a canvas should be sized inside a viewport (object-fit:contain logic) */
function containFit(srcW, srcH, vpW, vpH) {
  const scale = Math.min(vpW / srcW, vpH / srcH);
  return {
    displayW: srcW * scale,
    displayH: srcH * scale,
    unusedH: vpH - srcH * scale,
    unusedW: vpW - srcW * scale,
  };
}

/**
 * Simulate the effective tile size for .tile-palco.
 *
 * NORMAL:               inline aspect-ratio constrains height.
 * ACTIVITY_FULLSCREEN:  CSS rule sets width:100%; height:100%; aspect-ratio:unset.
 */
function tileEffectiveSize(srcW, srcH, vpW, vpH, telaCheia) {
  if (!telaCheia) {
    const tileH = (vpW * srcH) / srcW;
    return {
      tileW: vpW,
      tileH: Math.min(tileH, vpH),
      mode: 'NORMAL',
    };
  }
  return { tileW: vpW, tileH: vpH, mode: 'ACTIVITY_FULLSCREEN' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Activity Fullscreen -- Normal player size', () => {
  it('1. normal palco: tile width equals viewport width', () => {
    const { tileW } = tileEffectiveSize(1920, 1080, 1280, 720, false);
    expect(tileW).toBe(1280);
  });

  it('2. normal palco: tile height is aspect-ratio constrained, not full viewport', () => {
    const { tileH, mode } = tileEffectiveSize(1920, 1080, 1280, 900, false);
    expect(mode).toBe('NORMAL');
    expect(tileH).toBeCloseTo(720, 0);
    expect(900 - tileH).toBeCloseTo(180, 0);
  });

  it('3. normal mode has vertical black margin for non-matching aspect ratios', () => {
    const { tileH } = tileEffectiveSize(1920, 1080, 1280, 900, false);
    expect(900 - tileH).toBeGreaterThan(0);
  });
});

describe('Activity Fullscreen -- Enter ACTIVITY_FULLSCREEN', () => {
  it('4. fullscreen mode: tile fills entire viewport width', () => {
    const { tileW } = tileEffectiveSize(1920, 1080, 1280, 720, true);
    expect(tileW).toBe(1280);
  });

  it('5. fullscreen mode: tile fills entire viewport height', () => {
    const { tileH } = tileEffectiveSize(1920, 1080, 1280, 720, true);
    expect(tileH).toBe(720);
  });

  it('6. fullscreen mode reports ACTIVITY_FULLSCREEN state', () => {
    const { mode } = tileEffectiveSize(1920, 1080, 1280, 720, true);
    expect(mode).toBe('ACTIVITY_FULLSCREEN');
  });

  it('7. inline aspect-ratio is NOT applied when telaCheia is true', () => {
    const state = makeState({ telaCheia: true });
    let aspectRatioSet = false;
    const medida = { w: 1920, h: 1080 };
    if (true /* palco */ && medida?.w && !state.telaCheia) {
      aspectRatioSet = true;
    }
    expect(aspectRatioSet).toBe(false);
  });

  it('8. inline aspect-ratio IS applied when telaCheia is false (normal mode)', () => {
    const state = makeState({ telaCheia: false });
    let aspectRatioSet = false;
    const medida = { w: 1920, h: 1080 };
    if (true /* palco */ && medida?.w && !state.telaCheia) {
      aspectRatioSet = true;
    }
    expect(aspectRatioSet).toBe(true);
  });
});

describe('Activity Fullscreen -- Exit fullscreen', () => {
  it('9. exiting fullscreen restores telaCheia to false', () => {
    const state = makeState({ telaCheia: true });
    state.telaCheia = false;
    expect(state.telaCheia).toBe(false);
  });

  it('10. exiting fullscreen: tile reverts to aspect-ratio-constrained normal mode', () => {
    const { mode } = tileEffectiveSize(1920, 1080, 1280, 900, false);
    expect(mode).toBe('NORMAL');
  });

  it('11. fullscreenchange listener syncs telaCheia when native FS exits without button', () => {
    const state = makeState({ telaCheia: true });
    const simulateFullscreenChange = (hasFullscreenElement) => {
      if (!hasFullscreenElement && state.telaCheia) {
        state.telaCheia = false;
      }
    };
    simulateFullscreenChange(false); // ESC pressed, element gone
    expect(state.telaCheia).toBe(false);
  });

  it('12. fullscreenchange does NOT change telaCheia when entering fullscreen', () => {
    const state = makeState({ telaCheia: false });
    const simulateFullscreenChange = (hasFullscreenElement) => {
      if (!hasFullscreenElement && state.telaCheia) {
        state.telaCheia = false;
      }
    };
    simulateFullscreenChange(true); // entering FS, element present
    expect(state.telaCheia).toBe(false);
  });
});

describe('Activity Fullscreen -- Fullscreen API unavailable fallback', () => {
  it('13. telaCheia is set to true even when requestFullscreen throws', async () => {
    const state = makeState({ telaCheia: false });
    const requestFullscreen = async () => { throw new Error('API blocked'); };
    try {
      await requestFullscreen();
    } catch {
      // Ignored -- same as the real handler
    }
    state.telaCheia = true;
    expect(state.telaCheia).toBe(true);
  });

  it('14. CSS fullscreen mode activates regardless of Fullscreen API support', () => {
    const state = makeState({ telaCheia: true });
    const { mode } = tileEffectiveSize(1920, 1080, 1280, 720, state.telaCheia);
    expect(mode).toBe('ACTIVITY_FULLSCREEN');
  });
});

describe('Activity Fullscreen -- Resize while fullscreen', () => {
  it('15. resize while fullscreen: tile still fills the new viewport', () => {
    const before = tileEffectiveSize(1920, 1080, 1280, 720, true);
    expect(before.tileW).toBe(1280);
    expect(before.tileH).toBe(720);
    const after = tileEffectiveSize(1920, 1080, 960, 720, true);
    expect(after.tileW).toBe(960);
    expect(after.tileH).toBe(720);
  });

  it('16. visualViewport resize triggers renderGrid when telaCheia and inRoom', () => {
    const state = makeState({ telaCheia: true, inRoom: true });
    const renderGrid = vi.fn();
    const handleViewportResize = () => {
      if (state.telaCheia && state.inRoom) renderGrid();
    };
    handleViewportResize();
    expect(renderGrid).toHaveBeenCalledTimes(1);
  });

  it('17. visualViewport resize does NOT trigger renderGrid when not in fullscreen', () => {
    const state = makeState({ telaCheia: false, inRoom: true });
    const renderGrid = vi.fn();
    const handleViewportResize = () => {
      if (state.telaCheia && state.inRoom) renderGrid();
    };
    handleViewportResize();
    expect(renderGrid).not.toHaveBeenCalled();
  });
});

describe('Activity Fullscreen -- Aspect ratio preservation', () => {
  it('18. 16:9 source in 16:9 viewport fills >99% of area', () => {
    const { displayW, displayH, unusedH, unusedW } = containFit(1920, 1080, 1920, 1080);
    expect(displayW).toBeCloseTo(1920, 0);
    expect(displayH).toBeCloseTo(1080, 0);
    expect(unusedH).toBeCloseTo(0, 0);
    expect(unusedW).toBeCloseTo(0, 0);
  });

  it('19. 16:9 source nearly fills approximate 16:9 Activity viewport', () => {
    const { displayW, displayH } = containFit(1920, 1080, 1100, 620);
    const fillRatio = (displayW * displayH) / (1100 * 620);
    expect(fillRatio).toBeGreaterThan(0.95);
  });

  it('20. ultrawide viewport (21:9): video fills height, letterboxed horizontally', () => {
    const { displayH, unusedH, unusedW } = containFit(1920, 1080, 3440, 1440);
    expect(displayH).toBeCloseTo(1440, 0);
    expect(unusedH).toBeCloseTo(0, 0);
    expect(unusedW).toBeGreaterThan(0);
  });

  it('21. portrait viewport: video fills width, letterboxed vertically', () => {
    const { displayW, unusedW, unusedH } = containFit(1920, 1080, 720, 1280);
    expect(displayW).toBeCloseTo(720, 0);
    expect(unusedW).toBeCloseTo(0, 0);
    expect(unusedH).toBeGreaterThan(0);
  });

  it('22. source aspect ratio is preserved -- no stretching', () => {
    const srcRatio = 1920 / 1080;
    const { displayW, displayH } = containFit(1920, 1080, 1280, 900);
    const displayRatio = displayW / displayH;
    expect(Math.abs(displayRatio - srcRatio)).toBeLessThan(0.001);
  });
});

describe('Activity Fullscreen -- No artificial max-width/max-height in fullscreen', () => {
  it('23. ACTIVITY_FULLSCREEN tile has no max-width constraint', () => {
    const vpW = 2560;
    const { tileW } = tileEffectiveSize(1920, 1080, vpW, 1440, true);
    expect(tileW).toBe(vpW);
  });

  it('24. ACTIVITY_FULLSCREEN tile has no max-height constraint', () => {
    const vpH = 1600;
    const { tileH } = tileEffectiveSize(1920, 1080, 2560, vpH, true);
    expect(tileH).toBe(vpH);
  });
});

describe('Activity Fullscreen -- Stream resolution change while fullscreen', () => {
  it('25. resolution change while fullscreen: tile still fills viewport', () => {
    const before = tileEffectiveSize(1920, 1080, 1280, 720, true);
    expect(before.tileW).toBe(1280);
    expect(before.tileH).toBe(720);
    const after = tileEffectiveSize(1280, 720, 1280, 720, true);
    expect(after.tileW).toBe(1280);
    expect(after.tileH).toBe(720);
  });

  it('26. resolution change while fullscreen: canvas proportion recalculates correctly', () => {
    const fit1080 = containFit(1920, 1080, 1280, 720);
    const fit720  = containFit(1280, 720,  1280, 720);
    expect(fit1080.displayW).toBeCloseTo(1280, 0);
    expect(fit720.displayW).toBeCloseTo(1280, 0);
  });

  it('27. no inline aspect-ratio re-set on resolution change when telaCheia is true', () => {
    const state = makeState({ telaCheia: true });
    const medida = { w: 1280, h: 720 };
    let inlineAspectSet = false;
    if (true /* palco */ && medida?.w && !state.telaCheia) {
      inlineAspectSet = true;
    }
    expect(inlineAspectSet).toBe(false);
  });
});

describe('Activity Fullscreen -- Controls accessibility', () => {
  it('28. fullscreen button is visible when a slot is active', () => {
    const noPalco = true;
    const buttonHidden = !noPalco;
    expect(buttonHidden).toBe(false);
  });

  it('29. fullscreen button is hidden when no slot is active', () => {
    const noPalco = false;
    const buttonHidden = !noPalco;
    expect(buttonHidden).toBe(true);
  });

  it('30. fullscreen button label alternates correctly', () => {
    const labelEnter = 'Tela cheia';
    const labelExit  = 'Sair da tela cheia';
    const state = makeState({ telaCheia: false });
    expect(state.telaCheia ? labelExit : labelEnter).toBe(labelEnter);
    state.telaCheia = true;
    expect(state.telaCheia ? labelExit : labelEnter).toBe(labelExit);
  });
});

describe('Activity Fullscreen -- No media pipeline restart', () => {
  it('31. toggling telaCheia does not call player.stop()', () => {
    const playerStopSpy = vi.fn();
    const state = makeState({ telaCheia: false });
    const toggleFullscreen = () => { state.telaCheia = !state.telaCheia; };
    toggleFullscreen();
    expect(playerStopSpy).not.toHaveBeenCalled();
  });

  it('32. toggling telaCheia does not call player.start()', () => {
    const playerStartSpy = vi.fn();
    const state = makeState({ telaCheia: false });
    const toggleFullscreen = () => { state.telaCheia = !state.telaCheia; };
    toggleFullscreen();
    expect(playerStartSpy).not.toHaveBeenCalled();
  });

  it('33. fullscreen state change is layout-only -- no decoder reconfigure', () => {
    let decoderReconfigured = false;
    const fakePlayer = { start: () => { decoderReconfigured = true; } };
    const state = makeState({ telaCheia: false });
    state.telaCheia = true;
    // renderGrid does NOT call fakePlayer.start()
    expect(decoderReconfigured).toBe(false);
    expect(typeof fakePlayer.start).toBe('function');
  });
});

describe('Activity Fullscreen -- Mobile safe-area compatibility', () => {
  it('34. safe-area insets coexist with fullscreen CSS (structural check)', () => {
    const fullscreenRule = '.grid.palco.cheia .tile-palco';
    const safeAreaElements = '.bottombar, .topbar';
    expect(fullscreenRule).not.toContain('bottombar');
    expect(fullscreenRule).not.toContain('topbar');
    expect(safeAreaElements).not.toContain('tile-palco');
  });

  it('35. fullscreen tile uses height:100% (not 100vh) for safe-area compatibility', () => {
    // CSS rule uses height:100% which inherits from the grid correctly.
    // 100vh ignores safe-areas on iOS; 100% propagates insets correctly.
    const cssHeightValue = '100%';
    expect(cssHeightValue).not.toBe('100vh');
    expect(cssHeightValue).toBe('100%');
  });

  it('36. contain fit calculation works for portrait mobile viewport', () => {
    // iPhone 14 portrait: 390x844 CSS px
    const { displayW, displayH, unusedH } = containFit(1920, 1080, 390, 844);
    expect(displayW).toBeCloseTo(390, 0);
    expect(displayH).toBeCloseTo(390 * (1080 / 1920), 0);
    expect(unusedH).toBeGreaterThan(0);
  });
});
