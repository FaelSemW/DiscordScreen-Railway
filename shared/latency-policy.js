/**
 * Centralized Latency Policy & Media Timeline Conversion Helpers.
 *
 * Provides a bounded jitter/playback buffer configuration and centralized unit
 * conversions for WebCodecs (us), performance.now (ms), and WebAudio (s).
 */

// ------------------------------------------------------------------- Unit Helpers

export function usToMs(us) {
  return typeof us === 'number' ? us / 1000 : 0;
}

export function msToUs(ms) {
  return typeof ms === 'number' ? ms * 1000 : 0;
}

export function sToMs(s) {
  return typeof s === 'number' ? s * 1000 : 0;
}

export function msToS(ms) {
  return typeof ms === 'number' ? ms / 1000 : 0;
}

export function sToUs(s) {
  return typeof s === 'number' ? s * 1_000_000 : 0;
}

export function usToS(us) {
  return typeof us === 'number' ? us / 1_000_000 : 0;
}

// ------------------------------------------------------------------- Latency Modes

export const LATENCY_MODES = {
  stable: {
    id: 'stable',
    name: 'ESTÁVEL',
    description: 'Prioriza fluidez máxima e estabilidade de áudio/vídeo (Buffer ~700-1500ms).',
    startupBufferMs: 800,
    targetBufferMs: 1000,
    minBufferMs: 700,
    maxBufferMs: 1600,
    hardMaxBufferMs: 2000,
    audioAheadTargetMs: 500,
    audioMaxHorizonMs: 1800,
    audioStartupColchaoSec: 0.4,
    lateRenderThresholdMs: 40,
    lateGentleCatchupThresholdMs: 100,
    lateSmoothCatchupThresholdMs: 250,
    lateSelectiveDropThresholdMs: 500,
    hardResyncThresholdMs: 1800,
    filaMax: 120, // Suporta até ~2s de fila a 60 FPS
    maxDecodeQueue: 8,
  },
  balanced: {
    id: 'balanced',
    name: 'EQUILIBRADA',
    description: 'Equilíbrio entre resposta rápida e amortecimento de rede (Buffer ~400-800ms).',
    startupBufferMs: 400,
    targetBufferMs: 600,
    minBufferMs: 400,
    maxBufferMs: 1000,
    hardMaxBufferMs: 1200,
    audioAheadTargetMs: 250,
    audioMaxHorizonMs: 1000,
    audioStartupColchaoSec: 0.2,
    lateRenderThresholdMs: 30,
    lateGentleCatchupThresholdMs: 80,
    lateSmoothCatchupThresholdMs: 180,
    lateSelectiveDropThresholdMs: 350,
    hardResyncThresholdMs: 1000,
    filaMax: 60,
    maxDecodeQueue: 6,
  },
  'ultra-low': {
    id: 'ultra-low',
    name: 'ULTRA BAIXA',
    description: 'Menor atraso possível com descarte agressivo de atrasos (Buffer ~100-300ms).',
    startupBufferMs: 100,
    targetBufferMs: 150,
    minBufferMs: 80,
    maxBufferMs: 300,
    hardMaxBufferMs: 500,
    audioAheadTargetMs: 80,
    audioMaxHorizonMs: 400,
    audioStartupColchaoSec: 0.08,
    lateRenderThresholdMs: 20,
    lateGentleCatchupThresholdMs: 50,
    lateSmoothCatchupThresholdMs: 100,
    lateSelectiveDropThresholdMs: 180,
    hardResyncThresholdMs: 450,
    filaMax: 10,
    maxDecodeQueue: 4,
  },
};

export const DEFAULT_LATENCY_MODE = 'stable';

export function getLatencyConfig(mode = DEFAULT_LATENCY_MODE) {
  return LATENCY_MODES[mode] || LATENCY_MODES.stable;
}
