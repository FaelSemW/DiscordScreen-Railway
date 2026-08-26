/**
 * Definições canônicas de presets de qualidade para transmissão de tela.
 *
 * Fonte única de verdade compartilhada entre:
 * 1. Discord Activity
 * 2. Website principal
 * 3. Página externa de captura (share.html / share.js)
 * 4. Desktop Electron
 */

export const QUALITY_PRESETS = {
  automatico: {
    id: 'automatico',
    preset: 'automatico',
    name: 'Automático',
    label: 'Automático',
    description: 'Ajusta a qualidade automaticamente',
    details: 'Ajusta a qualidade automaticamente',
    isAuto: true,
    fps: 60,
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
  },
  economia: {
    id: 'economia',
    preset: 'economia',
    name: 'Economia',
    label: 'Economia',
    description: '720p · 30 FPS · 2 Mbps',
    details: '720p · 30 FPS · 2 Mbps',
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_000_000,
    priority: 'estabilidade',
  },
  equilibrado: {
    id: 'equilibrado',
    preset: 'equilibrado',
    name: 'Equilibrado',
    label: 'Equilibrado',
    description: '900p · 30 FPS · 4 Mbps',
    details: '900p · 30 FPS · 4 Mbps',
    width: 1600,
    height: 900,
    fps: 30,
    bitrate: 4_000_000,
    priority: 'equilibrado',
  },
  alta: {
    id: 'alta',
    preset: 'alta',
    name: 'Alta',
    label: 'Alta',
    description: '1080p · 30 FPS · 6 Mbps',
    details: '1080p · 30 FPS · 6 Mbps',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 6_000_000,
    priority: 'qualidade',
  },
  maxima: {
    id: 'maxima',
    preset: 'maxima',
    name: 'Máxima',
    label: 'Máxima',
    description: '1080p · 60 FPS · 8 Mbps',
    details: '1080p · 60 FPS · 8 Mbps',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 8_000_000,
    priority: 'fluidez',
  },
  personalizado: {
    id: 'personalizado',
    preset: 'personalizado',
    name: 'Personalizado',
    label: 'Personalizado',
    description: 'Escolher resolução, FPS e bitrate',
    details: 'Escolher resolução, FPS e bitrate',
    isCustom: true,
  },
};

export const DEFAULT_PRESET = 'equilibrado';

export const RESOLUTION_OPTIONS = {
  '720p': { width: 1280, height: 720, label: '720p (1280x720)' },
  '900p': { width: 1600, height: 900, label: '900p (1600x900)' },
  '1080p': { width: 1920, height: 1080, label: '1080p (1920x1080)' },
};

export const FPS_OPTIONS = [30, 60];

export const MIN_BITRATE = 500_000; // 0.5 Mbps
export const MAX_BITRATE = 20_000_000; // 20 Mbps

/**
 * Valida e normaliza a configuração de qualidade de transmissão.
 * Garante que valores seguros e suportados sejam sempre retornados.
 */
export function validateQualityConfig(config) {
  const presetKey = config?.preset || DEFAULT_PRESET;
  const basePreset = QUALITY_PRESETS[presetKey] || QUALITY_PRESETS[DEFAULT_PRESET];

  if (!basePreset.isCustom) {
    return {
      preset: basePreset.id,
      id: basePreset.id,
      name: basePreset.name,
      label: basePreset.label,
      description: basePreset.description,
      width: basePreset.width,
      height: basePreset.height,
      fps: basePreset.fps,
      bitrate: basePreset.bitrate,
      priority: basePreset.priority,
      isAuto: Boolean(basePreset.isAuto),
    };
  }

  // Personalizado
  const resKey = config?.resolution || (config?.height ? `${config.height}p` : '900p');
  const res = RESOLUTION_OPTIONS[resKey] || RESOLUTION_OPTIONS['900p'];
  const fps = FPS_OPTIONS.includes(Number(config?.fps)) ? Number(config.fps) : 30;
  const rawBitrate = Number(config?.bitrate);
  const bitrate = Math.min(
    MAX_BITRATE,
    Math.max(MIN_BITRATE, isNaN(rawBitrate) ? 4_000_000 : rawBitrate)
  );

  return {
    preset: 'personalizado',
    id: 'personalizado',
    name: 'Personalizado',
    label: 'Personalizado',
    description: `${resKey} · ${fps} FPS · ${(bitrate / 1_000_000).toFixed(1)} Mbps`,
    resolution: resKey,
    width: res.width,
    height: res.height,
    fps,
    bitrate,
    isCustom: true,
  };
}
