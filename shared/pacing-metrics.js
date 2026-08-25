/**
 * High-Resolution Frame Pacing & Interval Statistics Engine.
 *
 * Lightweight, zero-dependency metrics collector for measuring:
 * - Capture cadence & jitter
 * - Encoder input/output intervals
 * - Encode durations & queue sizes
 * - Network receive intervals
 * - Viewer presentation intervals & stutter events (>33ms, >50ms, >75ms)
 */

export function createIntervalTracker(windowSize = 120) {
  const intervals = new Float64Array(windowSize);
  let index = 0;
  let count = 0;
  let lastTimestamp = null;
  let lastInterval = 0;

  let late25Count = 0;
  let late33Count = 0;
  let late50Count = 0;

  function sample(timestampMs = performance.now()) {
    if (lastTimestamp !== null) {
      const delta = Math.max(0, timestampMs - lastTimestamp);
      intervals[index] = delta;
      index = (index + 1) % windowSize;
      if (count < windowSize) count++;
      lastInterval = delta;

      if (delta > 25) late25Count++;
      if (delta > 33) late33Count++;
      if (delta > 50) late50Count++;
    }
    lastTimestamp = timestampMs;
    return lastInterval;
  }

  function sampleInterval(deltaMs) {
    if (deltaMs >= 0) {
      intervals[index] = deltaMs;
      index = (index + 1) % windowSize;
      if (count < windowSize) count++;
      lastInterval = deltaMs;

      if (deltaMs > 25) late25Count++;
      if (deltaMs > 33) late33Count++;
      if (deltaMs > 50) late50Count++;
    }
    return lastInterval;
  }

  function getStats() {
    if (count === 0) {
      return {
        avg: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        max: 0,
        min: 0,
        jitter: 0,
        last: 0,
        count: 0,
        late25: 0,
        late33: 0,
        late50: 0,
        histogram: { lt12: 0, b12_20: 0, b20_28: 0, b28_38: 0, b38_50: 0, gt50: 0 },
      };
    }

    const currentSamples = new Float64Array(count);
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let jitterSum = 0;

    let lt12 = 0;
    let b12_20 = 0;
    let b20_28 = 0;
    let b28_38 = 0;
    let b38_50 = 0;
    let gt50 = 0;

    for (let i = 0; i < count; i++) {
      const val = intervals[i];
      currentSamples[i] = val;
      sum += val;
      if (val < min) min = val;
      if (val > max) max = val;
      if (i > 0) jitterSum += Math.abs(val - intervals[i - 1]);

      if (val < 12) lt12++;
      else if (val <= 20) b12_20++;
      else if (val <= 28) b20_28++;
      else if (val <= 38) b28_38++;
      else if (val <= 50) b38_50++;
      else gt50++;
    }

    currentSamples.sort();

    const avg = sum / count;
    const p50 = currentSamples[Math.floor(count * 0.5)];
    const p95 = currentSamples[Math.min(count - 1, Math.floor(count * 0.95))];
    const p99 = currentSamples[Math.min(count - 1, Math.floor(count * 0.99))];
    const jitter = count > 1 ? jitterSum / (count - 1) : 0;

    return {
      avg: Math.round(avg * 100) / 100,
      p50: Math.round(p50 * 100) / 100,
      p95: Math.round(p95 * 100) / 100,
      p99: Math.round(p99 * 100) / 100,
      max: Math.round(max * 100) / 100,
      min: Math.round((min === Infinity ? 0 : min) * 100) / 100,
      jitter: Math.round(jitter * 100) / 100,
      last: Math.round(lastInterval * 100) / 100,
      count,
      late25: late25Count,
      late33: late33Count,
      late50: late50Count,
      histogram: { lt12, b12_20, b20_28, b28_38, b38_50, gt50 },
    };
  }

  function resetWindowCounts() {
    late25Count = 0;
    late33Count = 0;
    late50Count = 0;
  }

  function reset() {
    index = 0;
    count = 0;
    lastTimestamp = null;
    lastInterval = 0;
    resetWindowCounts();
  }

  return {
    sample,
    sampleInterval,
    getStats,
    resetWindowCounts,
    reset,
  };
}

export function createValueTracker(windowSize = 120) {
  const values = new Float64Array(windowSize);
  let index = 0;
  let count = 0;
  let lastValue = 0;

  function sample(val) {
    values[index] = val;
    index = (index + 1) % windowSize;
    if (count < windowSize) count++;
    lastValue = val;
    return val;
  }

  function getStats() {
    if (count === 0) {
      return { avg: 0, p50: 0, p95: 0, max: 0, min: 0, last: 0, count: 0 };
    }

    const current = new Float64Array(count);
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < count; i++) {
      const v = values[i];
      current[i] = v;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    current.sort();

    return {
      avg: Math.round((sum / count) * 100) / 100,
      p50: Math.round(current[Math.floor(count * 0.5)] * 100) / 100,
      p95: Math.round(current[Math.min(count - 1, Math.floor(count * 0.95))] * 100) / 100,
      max: Math.round(max * 100) / 100,
      min: Math.round((min === Infinity ? 0 : min) * 100) / 100,
      last: lastValue,
      count,
    };
  }

  function reset() {
    index = 0;
    count = 0;
    lastValue = 0;
  }

  return {
    sample,
    getStats,
    reset,
  };
}

export function classifyHitch({
  renderGapMs = 16.67,
  receiveGapMs = 16.67,
  decodeGapMs = 16.67,
  rafGapMs = 16.67,
  canvasDrawMs = 1.0,
  expectedIntervalMs = 16.67,
} = {}) {
  const threshold = Math.max(25, expectedIntervalMs * 1.8);

  // CASE D: Canvas draw execution duration spiked on GPU raster/composition
  if (canvasDrawMs > 16.0) {
    return {
      category: 'CASE D',
      name: 'CANVAS / GPU COMPOSITION',
      description: `ctx.drawImage() demorou ${Math.round(canvasDrawMs)}ms (gargalo de GPU/raster).`,
    };
  }

  // CASE A: Inter-arrival gap on WebSocket / proxy preceded the presentation gap
  if (receiveGapMs > threshold && receiveGapMs >= renderGapMs * 0.7) {
    return {
      category: 'CASE A',
      name: 'NETWORK / ACTIVITY PROXY',
      description: `Buraco na chegada de pacotes (${Math.round(receiveGapMs)}ms) precedeu o atraso.`,
    };
  }

  // CASE B: Decode output inter-arrival gap spiked while network was on time
  if (decodeGapMs > threshold && receiveGapMs <= expectedIntervalMs * 1.5) {
    return {
      category: 'CASE B',
      name: 'DECODER / GPU DECODE',
      description: `VideoDecoder demorou para entregar (${Math.round(decodeGapMs)}ms) com rede estável.`,
    };
  }

  // CASE C: requestAnimationFrame callback was delayed by main thread or iframe throttling
  if (rafGapMs > threshold && decodeGapMs <= expectedIntervalMs * 1.5) {
    return {
      category: 'CASE C',
      name: 'RAF / ACTIVITY MAIN THREAD / COMPOSITOR',
      description: `requestAnimationFrame atrasou (${Math.round(rafGapMs)}ms) com decodificador pronto.`,
    };
  }

  // CASE E: Presentation scheduler pacing or clock synchronization drift
  return {
    category: 'CASE E',
    name: 'PLAYER CLOCK / PRESENTATION SCHEDULER',
    description: `Atraso no relógio ou ritmo do agendador (${Math.round(renderGapMs)}ms).`,
  };
}

export function createStutterDetector({
  candidateThresholdMs = 40,
  severeThresholdMs = 75,
  maxHistory = 25,
} = {}) {
  const history = [];
  let totalCandidateStutters = 0;
  let totalSevereStutters = 0;
  let windowCandidateStutters = 0;
  let windowSevereStutters = 0;

  const countsByCategory = {
    'CASE A': 0,
    'CASE B': 0,
    'CASE C': 0,
    'CASE D': 0,
    'CASE E': 0,
  };

  function record({
    renderGapMs,
    captureGapMs = null,
    encodeDurationMs = null,
    isKeyframe = false,
    networkLagMs = null,
    receiveGapMs = null,
    decodeGapMs = null,
    rafGapMs = null,
    canvasDrawMs = null,
    decodeQueueSize = 0,
    presentationQueueSize = 0,
    avDriftMs = 0,
    expectedIntervalMs = 16.67,
    expectedFps = 60,
    receiveFps = 0,
    decodeFps = 0,
    renderFps = 0,
    rafFps = 0,
    receiveP95 = 0,
    decodeP95 = 0,
    renderP95 = 0,
    rafP95 = 0,
    canvasDrawP95 = 0,
    longestLongTaskMs = 0,
    visibilityState = 'visible',
    hasFocus = true,
    transport = 'WebSocket (Proxy)',
  }) {
    const dynamicCandidateThreshold = Math.max(candidateThresholdMs, expectedIntervalMs * 2.2);
    const dynamicSevereThreshold = Math.max(severeThresholdMs, expectedIntervalMs * 4.0);

    const isCandidate = renderGapMs >= dynamicCandidateThreshold;
    const isSevere = renderGapMs >= dynamicSevereThreshold;

    if (isCandidate) {
      totalCandidateStutters++;
      windowCandidateStutters++;
    }
    if (isSevere) {
      totalSevereStutters++;
      windowSevereStutters++;
    }

    if (isCandidate) {
      const classification = classifyHitch({
        renderGapMs,
        receiveGapMs: receiveGapMs ?? 16.67,
        decodeGapMs: decodeGapMs ?? 16.67,
        rafGapMs: rafGapMs ?? 16.67,
        canvasDrawMs: canvasDrawMs ?? 1.0,
        expectedIntervalMs,
      });

      countsByCategory[classification.category] = (countsByCategory[classification.category] || 0) + 1;

      const snapshot = {
        id: totalCandidateStutters,
        timestamp: Date.now(),
        timeFormatted: new Date().toLocaleTimeString(),
        expectedFps,
        expectedIntervalMs: Math.round(expectedIntervalMs * 10) / 10,
        renderGapMs: Math.round(renderGapMs * 10) / 10,
        captureGapMs: captureGapMs !== null ? Math.round(captureGapMs * 10) / 10 : null,
        receiveGapMs: receiveGapMs !== null ? Math.round(receiveGapMs * 10) / 10 : null,
        decodeGapMs: decodeGapMs !== null ? Math.round(decodeGapMs * 10) / 10 : null,
        rafGapMs: rafGapMs !== null ? Math.round(rafGapMs * 10) / 10 : null,
        canvasDrawMs: canvasDrawMs !== null ? Math.round(canvasDrawMs * 10) / 10 : null,
        encodeDurationMs: encodeDurationMs !== null ? Math.round(encodeDurationMs * 10) / 10 : null,
        isKeyframe,
        networkLagMs: networkLagMs !== null ? Math.round(networkLagMs) : null,
        receiveFps,
        decodeFps,
        renderFps,
        rafFps,
        receiveP95: Math.round(receiveP95 * 10) / 10,
        decodeP95: Math.round(decodeP95 * 10) / 10,
        renderP95: Math.round(renderP95 * 10) / 10,
        rafP95: Math.round(rafP95 * 10) / 10,
        canvasDrawP95: Math.round(canvasDrawP95 * 10) / 10,
        decodeQueueSize,
        presentationQueueSize,
        avDriftMs: Math.round(avDriftMs),
        longestLongTaskMs: Math.round(longestLongTaskMs),
        visibilityState,
        hasFocus,
        transport,
        severity: isSevere ? 'severe' : 'candidate',
        classification,
      };

      history.unshift(snapshot);
      if (history.length > maxHistory) history.pop();

      // Expor para depuração global
      if (typeof window !== 'undefined') {
        window.__STUTTER_EVENTS = history;
      }

      return snapshot;
    }
    return null;
  }

  function getStats() {
    return {
      totalCandidateStutters,
      totalSevereStutters,
      windowCandidateStutters,
      windowSevereStutters,
      countsByCategory: { ...countsByCategory },
      latestSnapshot: history[0] ?? null,
      history: [...history],
    };
  }

  function resetWindow() {
    windowCandidateStutters = 0;
    windowSevereStutters = 0;
  }

  function reset() {
    history.length = 0;
    totalCandidateStutters = 0;
    totalSevereStutters = 0;
    for (const k of Object.keys(countsByCategory)) countsByCategory[k] = 0;
    resetWindow();
  }

  return {
    record,
    getStats,
    resetWindow,
    reset,
  };
}
