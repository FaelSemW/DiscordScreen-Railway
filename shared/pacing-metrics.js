/**
 * Headless High-Resolution Frame Pacing & Hitch Classification Engine.
 *
 * Lightweight, zero-dependency, bounded telemetry collector:
 * - High-resolution interval tracking via Float64Array ring buffers (p50/p95/p99/jitter/maxGap)
 * - Main-thread long task observer
 * - Canvas draw duration tracker
 * - VideoFrame lifetime tracker
 * - Bounded 25-event hitch ring buffer with heuristic root-cause classification
 * - Zero secrets, zero tokens, zero media buffers
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
      return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0, last: 0, count: 0 };
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
      p99: Math.round(current[Math.min(count - 1, Math.floor(count * 0.99))] * 100) / 100,
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

/**
 * Heuristic Hitch Classifier.
 *
 * Categorizes presentation delays into suspected pipeline stages:
 * - CASE A: NETWORK / ACTIVITY PROXY (Ingestion/delivery gap)
 * - CASE B: DECODER / GPU DECODE (Hardware decoder delay or queue backlog)
 * - CASE C: RAF / MAIN THREAD / COMPOSITOR (rAF cadence drop with queued frames)
 * - CASE D: CANVAS / GPU COMPOSITION (Main-thread long task or heavy drawImage)
 * - CASE E: PLAYER CLOCK / SCHEDULER (A/V clock drift or adaptive resync)
 */
export function classifyHitch({
  renderGapMs,
  captureGapMs = 16.67,
  decodeGapMs = 16.67,
  rafGapMs = 16.67,
  canvasDrawMs = 0,
  longestLongTaskMs = 0,
  presentationQueueSize = 0,
  decodeQueueSize = 0,
  expectedIntervalMs = 16.67,
}) {
  const threshold = expectedIntervalMs > 25 ? 45.0 : 25.0;

  // Case D: Canvas Draw / Main-thread long task
  if (longestLongTaskMs >= 30.0 || canvasDrawMs >= 20.0) {
    return {
      code: 'CASE_D',
      name: 'CANVAS / GPU COMPOSITION',
      category: 'Main Thread & Drawing',
      heuristic: true,
      details: `LongTask: ${longestLongTaskMs}ms, Draw: ${canvasDrawMs}ms`,
    };
  }

  // Case C: rAF Throttling / Compositor Cadence Drop
  if (rafGapMs >= threshold + 10.0 && presentationQueueSize > 0) {
    return {
      code: 'CASE_C',
      name: 'RAF / MAIN THREAD / COMPOSITOR',
      category: 'rAF & Browser Compositor',
      heuristic: true,
      details: `rAF Gap: ${rafGapMs}ms with ${presentationQueueSize} frames queued`,
    };
  }

  // Case B: Hardware VideoDecoder Backlog
  if (decodeGapMs >= threshold + 10.0 && decodeQueueSize > 1) {
    return {
      code: 'CASE_B',
      name: 'DECODER / GPU DECODE',
      category: 'Hardware VideoDecoder',
      heuristic: true,
      details: `Decode Gap: ${decodeGapMs}ms, HW Queue: ${decodeQueueSize}`,
    };
  }

  // Case A: Network / Ingestion Delivery Gap
  if (captureGapMs >= threshold) {
    return {
      code: 'CASE_A',
      name: 'NETWORK / ACTIVITY PROXY',
      category: 'Network & Capture Ingestion',
      heuristic: true,
      details: `Source/Capture Gap: ${captureGapMs}ms`,
    };
  }

  // Case E: Player Clock / Adaptive Jitter Correction
  return {
    code: 'CASE_E',
    name: 'PLAYER CLOCK / SCHEDULER',
    category: 'Scheduler & Clock Drift',
    heuristic: true,
    details: `RenderGap: ${renderGapMs}ms (Pacing divergence)`,
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

  const caseCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };

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
    transport = 'Relay (WebSocket)',
  }) {
    const isCandidate = renderGapMs >= candidateThresholdMs;
    const isSevere = renderGapMs >= severeThresholdMs;

    if (isCandidate) {
      totalCandidateStutters++;
      windowCandidateStutters++;
    }
    if (isSevere) {
      totalSevereStutters++;
      windowSevereStutters++;
    }

    if (isCandidate) {
      const suspect = classifyHitch({
        renderGapMs,
        captureGapMs: captureGapMs ?? 16.67,
        decodeGapMs: decodeGapMs ?? 16.67,
        rafGapMs: rafGapMs ?? 16.67,
        canvasDrawMs: canvasDrawMs ?? 0,
        longestLongTaskMs,
        presentationQueueSize,
        decodeQueueSize,
        expectedIntervalMs,
      });

      if (suspect.code === 'CASE_A') caseCounts.A++;
      else if (suspect.code === 'CASE_B') caseCounts.B++;
      else if (suspect.code === 'CASE_C') caseCounts.C++;
      else if (suspect.code === 'CASE_D') caseCounts.D++;
      else if (suspect.code === 'CASE_E') caseCounts.E++;

      // Strict numeric snapshot — NO media buffers, NO secrets
      const snapshot = {
        timestamp: Date.now(),
        renderGapMs: Math.round(renderGapMs * 10) / 10,
        captureGapMs: captureGapMs !== null ? Math.round(captureGapMs * 10) / 10 : null,
        encodeDurationMs: encodeDurationMs !== null ? Math.round(encodeDurationMs * 10) / 10 : null,
        isKeyframe,
        networkLagMs: networkLagMs !== null ? Math.round(networkLagMs) : null,
        receiveGapMs: receiveGapMs !== null ? Math.round(receiveGapMs * 10) / 10 : null,
        decodeGapMs: decodeGapMs !== null ? Math.round(decodeGapMs * 10) / 10 : null,
        rafGapMs: rafGapMs !== null ? Math.round(rafGapMs * 10) / 10 : null,
        canvasDrawMs: canvasDrawMs !== null ? Math.round(canvasDrawMs * 10) / 10 : null,
        decodeQueueSize,
        presentationQueueSize,
        avDriftMs: Math.round(avDriftMs),
        severity: isSevere ? 'severe' : 'candidate',
        primarySuspect: suspect,
        telemetry: {
          expectedIntervalMs,
          expectedFps,
          receiveFps,
          decodeFps,
          renderFps,
          rafFps,
          receiveP95,
          decodeP95,
          renderP95,
          rafP95,
          canvasDrawP95,
          longestLongTaskMs,
          visibilityState,
          hasFocus,
          transport,
        },
      };

      history.unshift(snapshot);
      if (history.length > maxHistory) history.pop();
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
      caseCounts: { ...caseCounts },
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
    caseCounts.A = 0;
    caseCounts.B = 0;
    caseCounts.C = 0;
    caseCounts.D = 0;
    caseCounts.E = 0;
    resetWindow();
  }

  return {
    record,
    getStats,
    resetWindow,
    reset,
  };
}
