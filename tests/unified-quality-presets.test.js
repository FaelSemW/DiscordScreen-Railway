import { describe, it, expect, vi } from 'vitest';
import {
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  validateQualityConfig,
  RESOLUTION_OPTIONS,
  FPS_OPTIONS,
  MIN_BITRATE,
  MAX_BITRATE,
} from '../shared/quality-presets.js';
import { opcoesTela, createBroadcaster, fitWithin } from '../shared/broadcaster.js';

describe('Unified Stream Quality Presets', () => {
  it('1. Defines canonical quality presets with exact expected values', () => {
    // Economia: 1280x720, 30 FPS, 2 Mbps
    expect(QUALITY_PRESETS.economia).toMatchObject({
      id: 'economia',
      name: 'Economia',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 2_000_000,
      description: '720p · 30 FPS · 2 Mbps',
    });

    // Equilibrado: 1600x900, 30 FPS, 4 Mbps
    expect(QUALITY_PRESETS.equilibrado).toMatchObject({
      id: 'equilibrado',
      name: 'Equilibrado',
      width: 1600,
      height: 900,
      fps: 30,
      bitrate: 4_000_000,
      description: '900p · 30 FPS · 4 Mbps',
    });

    // Alta: 1920x1080, 30 FPS, 6 Mbps
    expect(QUALITY_PRESETS.alta).toMatchObject({
      id: 'alta',
      name: 'Alta',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrate: 6_000_000,
      description: '1080p · 30 FPS · 6 Mbps',
    });

    // Máxima: 1920x1080, 60 FPS, 8 Mbps
    expect(QUALITY_PRESETS.maxima).toMatchObject({
      id: 'maxima',
      name: 'Máxima',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 8_000_000,
      description: '1080p · 60 FPS · 8 Mbps',
    });

    // Automático: Adaptive mode
    expect(QUALITY_PRESETS.automatico).toMatchObject({
      id: 'automatico',
      name: 'Automático',
      isAuto: true,
      description: 'Ajusta a qualidade automaticamente',
    });

    // Personalizado: Custom mode
    expect(QUALITY_PRESETS.personalizado).toMatchObject({
      id: 'personalizado',
      name: 'Personalizado',
      isCustom: true,
    });
  });

  it('2. Default preset is Equilibrado', () => {
    expect(DEFAULT_PRESET).toBe('equilibrado');
    const defaultVal = validateQualityConfig(null);
    expect(defaultVal.preset).toBe('equilibrado');
    expect(defaultVal.width).toBe(1600);
    expect(defaultVal.height).toBe(900);
    expect(defaultVal.fps).toBe(30);
    expect(defaultVal.bitrate).toBe(4_000_000);
  });

  it('3. Validates custom resolution, FPS, and bitrate within safe limits', () => {
    // Valid custom config
    const custom = validateQualityConfig({
      preset: 'personalizado',
      resolution: '1080p',
      fps: 60,
      bitrate: 10_000_000,
    });
    expect(custom).toMatchObject({
      preset: 'personalizado',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 10_000_000,
    });

    // Bounds clipping: negative/zero/extreme bitrate
    const boundedMin = validateQualityConfig({
      preset: 'personalizado',
      resolution: '720p',
      fps: 30,
      bitrate: 0,
    });
    expect(boundedMin.bitrate).toBe(MIN_BITRATE);

    const boundedMax = validateQualityConfig({
      preset: 'personalizado',
      resolution: '1080p',
      fps: 60,
      bitrate: 100_000_000,
    });
    expect(boundedMax.bitrate).toBe(MAX_BITRATE);

    // Unsupported FPS falls back to 30
    const boundedFps = validateQualityConfig({
      preset: 'personalizado',
      fps: 120,
    });
    expect(boundedFps.fps).toBe(30);
  });

  it('4. Capture constraints request 60 FPS for Máxima and 30 FPS for others', () => {
    const opts60 = opcoesTela({ fps: 60 });
    expect(opts60.video.frameRate.ideal).toBe(60);
    expect(opts60.video.frameRate.max).toBe(60);

    const opts30 = opcoesTela({ fps: 30 });
    expect(opts30.video.frameRate.ideal).toBe(30);
    expect(opts30.video.frameRate.max).toBe(30);
  });

  it('5. Broadcaster configured with Máxima uses 1080p60 and 8 Mbps', () => {
    const validated = validateQualityConfig({ preset: 'maxima' });
    expect(validated.fps).toBe(60);
    expect(validated.bitrate).toBe(8_000_000);
    expect(validated.width).toBe(1920);
    expect(validated.height).toBe(1080);
  });

  it('6. Broadcaster configured with Economia uses 720p30 and 2 Mbps', () => {
    const validated = validateQualityConfig({ preset: 'economia' });
    expect(validated.fps).toBe(30);
    expect(validated.bitrate).toBe(2_000_000);
    expect(validated.width).toBe(1280);
    expect(validated.height).toBe(720);
  });

  it('7. Broadcaster configured with Alta uses 1080p30 and 6 Mbps', () => {
    const validated = validateQualityConfig({ preset: 'alta' });
    expect(validated.fps).toBe(30);
    expect(validated.bitrate).toBe(6_000_000);
    expect(validated.width).toBe(1920);
    expect(validated.height).toBe(1080);
  });

  it('8. Broadcaster configured with Equilibrado uses 900p30 and 4 Mbps', () => {
    const validated = validateQualityConfig({ preset: 'equilibrado' });
    expect(validated.fps).toBe(30);
    expect(validated.bitrate).toBe(4_000_000);
    expect(validated.width).toBe(1600);
    expect(validated.height).toBe(900);
  });

  it('9. Preserves aspect ratio during resolution scaling without distortion', () => {
    // 16:9 source (2560x1440) scaled within 1920x1080
    const scaled169 = fitWithin(2560, 1440, 1920, 1080);
    expect(scaled169.width).toBe(1920);
    expect(scaled169.height).toBe(1080);
    expect(scaled169.width / scaled169.height).toBeCloseTo(16 / 9, 2);

    // 21:9 ultrawide source (3440x1440) scaled within 1920x1080
    const scaledUltrawide = fitWithin(3440, 1440, 1920, 1080);
    expect(scaledUltrawide.width).toBe(1920);
    expect(scaledUltrawide.height).toBe(804);
    expect(scaledUltrawide.width / scaledUltrawide.height).toBeCloseTo(3440 / 1440, 2);

    // 4:3 source (1024x768) scaled within 1920x1080
    const scaled43 = fitWithin(1024, 768, 1920, 1080);
    expect(scaled43.width).toBe(1024);
    expect(scaled43.height).toBe(768);
  });

  it('10. P0 Reconnect / Resume maintains selected preset configuration', () => {
    const initialConfig = validateQualityConfig({ preset: 'maxima' });
    expect(initialConfig.fps).toBe(60);
    expect(initialConfig.bitrate).toBe(8_000_000);
    expect(initialConfig.width).toBe(1920);
    expect(initialConfig.height).toBe(1080);

    // When connection disconnects and resumes on same slot:
    const resumedConfig = validateQualityConfig(initialConfig);
    expect(resumedConfig.fps).toBe(60);
    expect(resumedConfig.bitrate).toBe(8_000_000);
    expect(resumedConfig.width).toBe(1920);
    expect(resumedConfig.height).toBe(1080);
    expect(resumedConfig.preset).toBe('maxima');
  });
});
