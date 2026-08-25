import { describe, it, expect } from 'vitest';
import {
  usToMs,
  msToUs,
  sToMs,
  msToS,
  sToUs,
  usToS,
  LATENCY_MODES,
  DEFAULT_LATENCY_MODE,
  getLatencyConfig,
} from './latency-policy.js';

describe('shared/latency-policy', () => {
  it('converts microsecond, millisecond and second units accurately', () => {
    expect(usToMs(1000)).toBe(1);
    expect(usToMs('invalid')).toBe(0);
    expect(usToMs(null)).toBe(0);

    expect(msToUs(1)).toBe(1000);
    expect(msToUs('invalid')).toBe(0);
    expect(msToUs(undefined)).toBe(0);

    expect(sToMs(1)).toBe(1000);
    expect(sToMs('invalid')).toBe(0);

    expect(msToS(1000)).toBe(1);
    expect(msToS('invalid')).toBe(0);

    expect(sToUs(1)).toBe(1_000_000);
    expect(sToUs('invalid')).toBe(0);

    expect(usToS(1_000_000)).toBe(1);
    expect(usToS('invalid')).toBe(0);
  });

  it('retrieves latency modes and falls back to default stable mode', () => {
    expect(DEFAULT_LATENCY_MODE).toBe('stable');

    const stable = getLatencyConfig('stable');
    expect(stable.id).toBe('stable');
    expect(stable.targetBufferMs).toBe(1000);
    expect(stable.startupBufferMs).toBe(800);
    expect(stable.filaMax).toBe(120);

    const balanced = getLatencyConfig('balanced');
    expect(balanced.id).toBe('balanced');
    expect(balanced.targetBufferMs).toBe(600);

    const ultraLow = getLatencyConfig('ultra-low');
    expect(ultraLow.id).toBe('ultra-low');
    expect(ultraLow.targetBufferMs).toBe(150);

    const fallback = getLatencyConfig('unknown_mode_name');
    expect(fallback.id).toBe(LATENCY_MODES.stable.id);
  });
});
