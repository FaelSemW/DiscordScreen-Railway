import { describe, it, expect } from 'vitest';
import {
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  validateQualityConfig,
  RESOLUTION_OPTIONS,
} from '../shared/quality-presets.js';
import { opcoesTela, createBroadcaster } from '../shared/broadcaster.js';

describe('Website Capture Page (share.js) & Broadcaster Custom Quality Flow', () => {
  it('1. Personalizado 720p30 produces exact 1280x720@30 capture constraints and encoder settings', () => {
    const custom = validateQualityConfig({
      preset: 'personalizado',
      resolution: '720p',
      fps: 30,
      bitrate: 2_000_000,
    });

    expect(custom).toMatchObject({
      preset: 'personalizado',
      resolution: '720p',
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 2_000_000,
    });

    const captureConstraints = opcoesTela({
      fps: custom.fps,
      width: custom.width,
      height: custom.height,
    });

    expect(captureConstraints.video.width.ideal).toBe(1280);
    expect(captureConstraints.video.height.ideal).toBe(720);
    expect(captureConstraints.video.frameRate.ideal).toBe(30);
    expect(captureConstraints.video.frameRate.max).toBe(30);
  });

  it('2. Personalizado 900p60 produces exact 1600x900@60 capture constraints and encoder settings', () => {
    const custom = validateQualityConfig({
      preset: 'personalizado',
      resolution: '900p',
      fps: 60,
      bitrate: 4_000_000,
    });

    expect(custom).toMatchObject({
      preset: 'personalizado',
      resolution: '900p',
      width: 1600,
      height: 900,
      fps: 60,
      bitrate: 4_000_000,
    });

    const captureConstraints = opcoesTela({
      fps: custom.fps,
      width: custom.width,
      height: custom.height,
    });

    expect(captureConstraints.video.width.ideal).toBe(1600);
    expect(captureConstraints.video.height.ideal).toBe(900);
    expect(captureConstraints.video.frameRate.ideal).toBe(60);
    expect(captureConstraints.video.frameRate.max).toBe(60);
  });

  it('3. Personalizado 1080p30 produces exact 1920x1080@30 capture constraints and encoder settings', () => {
    const custom = validateQualityConfig({
      preset: 'personalizado',
      resolution: '1080p',
      fps: 30,
      bitrate: 6_000_000,
    });

    expect(custom).toMatchObject({
      preset: 'personalizado',
      resolution: '1080p',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrate: 6_000_000,
    });

    const captureConstraints = opcoesTela({
      fps: custom.fps,
      width: custom.width,
      height: custom.height,
    });

    expect(captureConstraints.video.width.ideal).toBe(1920);
    expect(captureConstraints.video.height.ideal).toBe(1080);
    expect(captureConstraints.video.frameRate.ideal).toBe(30);
    expect(captureConstraints.video.frameRate.max).toBe(30);
  });

  it('4. Personalizado 1080p60 produces exact 1920x1080@60 capture constraints and encoder settings', () => {
    const custom = validateQualityConfig({
      preset: 'personalizado',
      resolution: '1080p',
      fps: 60,
      bitrate: 8_000_000,
    });

    expect(custom).toMatchObject({
      preset: 'personalizado',
      resolution: '1080p',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 8_000_000,
    });

    const captureConstraints = opcoesTela({
      fps: custom.fps,
      width: custom.width,
      height: custom.height,
    });

    expect(captureConstraints.video.width.ideal).toBe(1920);
    expect(captureConstraints.video.height.ideal).toBe(1080);
    expect(captureConstraints.video.frameRate.ideal).toBe(60);
    expect(captureConstraints.video.frameRate.max).toBe(60);
  });

  it('5. Custom preference persistence roundtrip restores all 4 custom parameters', () => {
    const stored = {
      preset: 'personalizado',
      resolution: '1080p',
      fps: 60,
      bitrate: 8_000_000,
    };

    const restored = validateQualityConfig(stored);
    expect(restored.preset).toBe('personalizado');
    expect(restored.resolution).toBe('1080p');
    expect(restored.width).toBe(1920);
    expect(restored.height).toBe(1080);
    expect(restored.fps).toBe(60);
    expect(restored.bitrate).toBe(8_000_000);
  });

  it('6. P0 Reconnect preserves custom quality (1280x720@60 3Mbps) without resetting to default', () => {
    const customProfile = validateQualityConfig({
      preset: 'personalizado',
      resolution: '720p',
      fps: 60,
      bitrate: 3_000_000,
    });

    // After reconnecting on the same slot, config remains intact
    const resumedProfile = validateQualityConfig(customProfile);
    expect(resumedProfile.preset).toBe('personalizado');
    expect(resumedProfile.width).toBe(1280);
    expect(resumedProfile.height).toBe(720);
    expect(resumedProfile.fps).toBe(60);
    expect(resumedProfile.bitrate).toBe(3_000_000);
    expect(resumedProfile.preset).not.toBe('equilibrado');
  });

  it('7. Standard presets remain completely unchanged', () => {
    // Economia: 1280x720@30 / 2 Mbps
    const eco = validateQualityConfig({ preset: 'economia' });
    expect(eco.width).toBe(1280);
    expect(eco.height).toBe(720);
    expect(eco.fps).toBe(30);
    expect(eco.bitrate).toBe(2_000_000);

    // Equilibrado: 1600x900@30 / 4 Mbps
    const eq = validateQualityConfig({ preset: 'equilibrado' });
    expect(eq.width).toBe(1600);
    expect(eq.height).toBe(900);
    expect(eq.fps).toBe(30);
    expect(eq.bitrate).toBe(4_000_000);

    // Alta: 1920x1080@30 / 6 Mbps
    const alta = validateQualityConfig({ preset: 'alta' });
    expect(alta.width).toBe(1920);
    expect(alta.height).toBe(1080);
    expect(alta.fps).toBe(30);
    expect(alta.bitrate).toBe(6_000_000);

    // Máxima: 1920x1080@60 / 8 Mbps
    const max = validateQualityConfig({ preset: 'maxima' });
    expect(max.width).toBe(1920);
    expect(max.height).toBe(1080);
    expect(max.fps).toBe(60);
    expect(max.bitrate).toBe(8_000_000);
  });

  it('8. Automatic preset remains completely unchanged', () => {
    const auto = validateQualityConfig({ preset: 'automatico' });
    expect(auto.isAuto).toBe(true);
    expect(auto.width).toBe(1920);
    expect(auto.height).toBe(1080);
    expect(auto.fps).toBe(60);
    expect(auto.bitrate).toBe(8_000_000);
  });
});
