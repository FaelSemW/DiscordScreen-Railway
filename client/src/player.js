import {
  createIntervalTracker,
  createValueTracker,
  createStutterDetector,
} from '../../shared/pacing-metrics.js';
import {
  getLatencyConfig,
  DEFAULT_LATENCY_MODE,
  LATENCY_MODES,
  usToMs,
} from '../../shared/latency-policy.js';

export { LATENCY_MODES };

export function createPlayer(
  canvas,
  { onError, onTamanho, onNeedKeyframe, getAudioClock, latencyMode = DEFAULT_LATENCY_MODE } = {},
) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  let decoder = null;
  let needKeyframe = true;
  let lastLagMs = 0;

  let currentLatencyMode = latencyMode;
  let latencyConfig = getLatencyConfig(latencyMode);

  // Rastreadores de Intervalos em Alta Resolução (Pacing & Cadência)
  const receiveIntervalTracker = createIntervalTracker(120);
  const decodeIntervalTracker = createIntervalTracker(120);
  const renderIntervalTracker = createIntervalTracker(120);
  const rafIntervalTracker = createIntervalTracker(120);
  const canvasDrawTracker = createValueTracker(120);

  const stutterDetector = createStutterDetector({
    candidateThresholdMs: 35,
    severeThresholdMs: 70,
    maxHistory: 25,
  });

  let lastRenderTime = null;
  let lastDecodeTime = null;
  let lastRafTime = null;
  let lastReceiveTimestampUs = null;
  let lastCaptureGapMs = 16.67;
  let lastReceiveGapMs = 16.67;
  let lastDecodeGapMs = 16.67;
  let lastRafGapMs = 16.67;
  let lastCanvasDrawDurationMs = 0.5;
  let lastChunkWasKeyframe = false;

  let framesReceived = 0;
  let framesDecoded = 0;
  let framesRendered = 0;
  let framesDropped = 0;
  let framesClosed = 0;
  let maxLiveFrames = 0;
  let droppedLateCount = 0;
  let droppedRecoveryCount = 0;
  let chunksSubmitted = 0;
  let decoderReconfigureCount = 0;
  let decoderErrors = 0;
  let hardResyncCount = 0;
  let softCorrectionCount = 0;

  let lastAvDriftMs = 0;
  let lastPresentationLagMs = 0;
  let lastKeyframeAt = 0;

  let fpsTimer = performance.now();
  let receiveFps = 0;
  let renderFps = 0;
  let decodeFps = 0;
  let rafFps = 0;
  let chunksSubmittedSec = 0;

  let recCount = 0;
  let decCount = 0;
  let renCount = 0;
  let rafCount = 0;
  let chunkCount = 0;

  // Observador de Tarefas Longas (Main Thread Long Tasks)
  const longTaskEntries = [];
  let longTaskObserver = null;
  if (typeof globalThis.PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        const now = performance.now();
        for (const entry of list.getEntries()) {
          longTaskEntries.push({ duration: entry.duration, at: now });
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      // PerformanceObserver não suportado no contexto
    }
  }

  function getLongTaskStats() {
    const now = performance.now();
    // Janela deslizante de 10 segundos
    while (longTaskEntries.length && now - longTaskEntries[0].at > 10000) {
      longTaskEntries.shift();
    }
    let longest = 0;
    let total = 0;
    for (const item of longTaskEntries) {
      if (item.duration > longest) longest = item.duration;
      total += item.duration;
    }
    return {
      count10s: longTaskEntries.length,
      longestMs: Math.round(longest * 10) / 10,
      totalDurationMs: Math.round(total * 10) / 10,
    };
  }

  // Jitter / Playback Buffer State Machine
  // Estados: 'BUILDING' | 'STABLE' | 'LOW' | 'RECOVERING'
  let playbackState = 'BUILDING';
  let currentTargetBufferMs = latencyConfig.targetBufferMs;
  let currentBufferMs = 0;
  let minBuffer10s = currentTargetBufferMs;
  let maxBuffer10s = currentTargetBufferMs;
  let bufferWindowTimer = performance.now();
  let stabilityTimer = performance.now();

  // Fila ordenada de quadros decodificados aguardando a vez
  // Cada item: { frame, tsMs, isKeyframe, captureGapMs }
  const fila = [];
  let playbackMediaTimeMs = null;
  let wallClockAnchorMs = null;
  let lastMediaClockSource = 'VIDEO';
  let rafId = null;
  let virgem = true;

  function setLatencyMode(mode) {
    currentLatencyMode = mode;
    latencyConfig = getLatencyConfig(mode);
    currentTargetBufferMs = latencyConfig.targetBufferMs;
    playbackState = 'BUILDING';
    playbackMediaTimeMs = null;
    wallClockAnchorMs = null;
  }

  function start(rawConfig) {
    stop();

    if (typeof globalThis.VideoDecoder === 'undefined') {
      onError?.('Este navegador não tem WebCodecs — não é possível assistir.');
      return false;
    }

    const config = deserialize(rawConfig);
    decoderReconfigureCount++;

    decoder = new VideoDecoder({
      output: onDecodedFrame,
      error: (err) => {
        decoderErrors++;
        console.warn('[decoder error]', err.message);
        needKeyframe = true;
        onNeedKeyframe?.();
      },
    });

    try {
      decoder.configure(config);
    } catch {
      onError?.(`Codec não suportado por este navegador: ${config.codec}`);
      decoder = null;
      return false;
    }

    needKeyframe = true;
    playbackState = 'BUILDING';
    playbackMediaTimeMs = null;
    wallClockAnchorMs = null;
    return true;
  }

  /**
   * Recebe pacote do WebSocket relay.
   * Formato: [1B slot][1B tipo][8B timestamp][8B envio][payload]
   */
  function push(buffer) {
    if (!decoder || decoder.state !== 'configured') return;

    framesReceived++;
    recCount++;

    const now = performance.now();
    lastReceiveGapMs = receiveIntervalTracker.sample(now);

    const view = new DataView(buffer);
    const isKeyframe = view.getUint8(1) === 1;
    const timestampUs = view.getFloat64(2);
    const sentAt = view.getFloat64(10);
    lastLagMs = Math.max(0, Date.now() - sentAt);
    lastChunkWasKeyframe = isKeyframe;

    if (lastReceiveTimestampUs !== null) {
      lastCaptureGapMs = Math.max(0, usToMs(timestampUs - lastReceiveTimestampUs));
    }
    lastReceiveTimestampUs = timestampUs;

    updateFpsMetrics();

    if (isKeyframe) {
      lastKeyframeAt = performance.now();
    }

    // Decoder frio só aceita keyframe
    if (needKeyframe && !isKeyframe) {
      framesDropped++;
      return;
    }

    // Backlog do hardware: só descarta se exceder o limite de decodificação do hardware
    if (decoder.decodeQueueSize > latencyConfig.maxDecodeQueue) {
      framesDropped++;
      droppedRecoveryCount++;
      if (!isKeyframe) {
        needKeyframe = true;
        onNeedKeyframe?.();
        return;
      }
    }

    try {
      chunksSubmitted++;
      chunkCount++;
      decoder.decode(
        new EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp: timestampUs,
          data: new Uint8Array(buffer, 18),
        }),
      );
      needKeyframe = false;
    } catch (err) {
      decoderErrors++;
      console.warn('[decode]', err.message);
      needKeyframe = true;
      onNeedKeyframe?.();
    }
  }

  /**
   * Saída do VideoDecoder: quadro decodificado pronto para ser adicionado ao buffer de reprodução.
   */
  function onDecodedFrame(frame) {
    framesDecoded++;
    decCount++;

    const agora = performance.now();
    lastDecodeGapMs = lastDecodeTime !== null ? Math.max(0, agora - lastDecodeTime) : 16.67;
    lastDecodeTime = agora;
    decodeIntervalTracker.sampleInterval(lastDecodeGapMs);

    const tsMs = usToMs(frame.timestamp ?? 0);
    const isKey = lastChunkWasKeyframe;
    const capGap = lastCaptureGapMs;

    // Se a timeline saltar para trás (recomeço de transmissão), reinicia âncoras
    if (fila.length && tsMs < fila[fila.length - 1].tsMs) {
      esvaziar();
      playbackState = 'BUILDING';
      playbackMediaTimeMs = null;
      wallClockAnchorMs = agora;
    }

    // Se a fila estava vazia (início ou recomeço após pausa/congelamento),
    // ancora a reprodução diretamente no timestamp do novo quadro
    if (fila.length === 0) {
      wallClockAnchorMs = agora;
      playbackMediaTimeMs = tsMs;
    }

    fila.push({ frame, tsMs, isKeyframe: isKey, captureGapMs: capGap });
    maxLiveFrames = Math.max(maxLiveFrames, fila.length);

    // Teto estrito da fila para proteção contra vazamento de memória (ex: >120 quadros / 2 segundos)
    while (fila.length > latencyConfig.filaMax) {
      const dropped = fila.shift();
      dropped.frame.close();
      framesClosed++;
      framesDropped++;
      droppedRecoveryCount++;
    }

    agendar();
  }

  /**
   * Controlador de Adaptação de Buffer com Histerese.
   */
  function updateAdaptiveBuffer(now) {
    const recStats = receiveIntervalTracker.getStats();
    const aClock = getAudioClock?.();

    if (recStats.p95 > 35 || (aClock?.active && aClock.bufferAheadMs < 200)) {
      if (currentTargetBufferMs < latencyConfig.maxBufferMs) {
        currentTargetBufferMs = Math.min(latencyConfig.maxBufferMs, currentTargetBufferMs + 100);
        playbackState = 'RECOVERING';
        stabilityTimer = now;
      }
    } else if (now - stabilityTimer > 20000 && recStats.p95 <= 25) {
      if (currentTargetBufferMs > latencyConfig.minBufferMs) {
        currentTargetBufferMs = Math.max(latencyConfig.minBufferMs, currentTargetBufferMs - 25);
        stabilityTimer = now;
      }
      playbackState = currentBufferMs < 300 ? 'LOW' : 'STABLE';
    } else {
      playbackState = currentBufferMs < 300 ? 'LOW' : 'STABLE';
    }

    if (now - bufferWindowTimer >= 10000) {
      minBuffer10s = currentBufferMs;
      maxBuffer10s = currentBufferMs;
      bufferWindowTimer = now;
    } else {
      minBuffer10s = Math.min(minBuffer10s, currentBufferMs);
      maxBuffer10s = Math.max(maxBuffer10s, currentBufferMs);
    }
  }

  /**
   * Laço de renderização alinhado ao refresh do monitor (RAF).
   */
  function passo() {
    rafId = null;
    const agora = performance.now();
    rafCount++;

    lastRafGapMs = lastRafTime !== null ? Math.max(0, agora - lastRafTime) : 16.67;
    lastRafTime = agora;
    rafIntervalTracker.sampleInterval(lastRafGapMs);

    if (!fila.length) return;

    const audioClock = getAudioClock?.();
    let mediaPlaybackTime;

    // 1. Fase de Startup Buffer
    if (playbackState === 'BUILDING') {
      const oldestTs = fila[0].tsMs;
      const newestTs = fila[fila.length - 1].tsMs;
      const bufferedSpan = newestTs - oldestTs;
      const audioActive = Boolean(
        audioClock && audioClock.active && audioClock.mediaTimestampMs !== null,
      );

      if (
        bufferedSpan >= latencyConfig.startupBufferMs ||
        audioActive ||
        fila.length >= 30 ||
        (wallClockAnchorMs !== null && agora - wallClockAnchorMs >= latencyConfig.startupBufferMs)
      ) {
        playbackState = 'STABLE';
        playbackMediaTimeMs = oldestTs;
        wallClockAnchorMs = agora;
      } else {
        wallClockAnchorMs ??= agora;
        agendar();
        return;
      }
    }

    // 2. Determinação do Relógio Mestre
    if (audioClock && audioClock.active && audioClock.mediaTimestampMs !== null) {
      mediaPlaybackTime = audioClock.mediaTimestampMs;
      lastMediaClockSource = 'AUDIO';
    } else {
      lastMediaClockSource = 'VIDEO';
      if (playbackMediaTimeMs === null || wallClockAnchorMs === null) {
        playbackMediaTimeMs = fila[0].tsMs;
        wallClockAnchorMs = agora;
      }
      mediaPlaybackTime = playbackMediaTimeMs + (agora - wallClockAnchorMs);
    }

    // 3. Atualiza profundidade atual do buffer
    const newestTs = fila[fila.length - 1].tsMs;
    currentBufferMs = Math.max(0, Math.round(newestTs - mediaPlaybackTime));
    updateAdaptiveBuffer(agora);

    // 4. Política de Apresentação e Atrasos
    const oldest = fila[0];
    const avDrift = oldest.tsMs - mediaPlaybackTime;
    lastAvDriftMs = Math.round(avDrift);
    lastPresentationLagMs = Math.max(0, Math.round(mediaPlaybackTime - oldest.tsMs));

    // A. Hard Resync (>1800-2000ms de atraso severo): recuperação de emergência
    if (avDrift < -latencyConfig.hardResyncThresholdMs) {
      hardResyncCount++;
      console.warn(
        `[HARD_RESYNC] atraso inaceitável (${avDrift}ms), solicitando keyframe para recuperar`,
      );
      esvaziar();
      playbackState = 'BUILDING';
      playbackMediaTimeMs = null;
      wallClockAnchorMs = null;
      needKeyframe = true;
      onNeedKeyframe?.();
      return;
    }

    // B. Apresentação Otimizada e Descarte Imediato de Quadros Obsoletos
    let itemParaPintar = null;
    while (fila.length && fila[0].tsMs <= mediaPlaybackTime + 8) {
      const item = fila.shift();
      if (fila.length && fila[0].tsMs <= mediaPlaybackTime + 8) {
        item.frame.close();
        framesClosed++;
        framesDropped++;
        droppedLateCount++;
        softCorrectionCount++;
      } else {
        itemParaPintar = item;
        break;
      }
    }

    if (itemParaPintar) {
      pintar(itemParaPintar.frame, itemParaPintar.isKeyframe, itemParaPintar.captureGapMs);
    }

    if (fila.length) {
      agendar();
    }
  }

  function agendar() {
    rafId ??= requestAnimationFrame(passo);
  }

  function esvaziar() {
    while (fila.length) {
      const item = fila.shift();
      item.frame.close();
      framesClosed++;
      framesDropped++;
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function pintar(frame, isKeyframe = false, captureGapMs = 16.67) {
    let mudou = false;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      mudou = true;
    }

    const tStart = performance.now();
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    lastCanvasDrawDurationMs = Math.max(0, performance.now() - tStart);
    canvasDrawTracker.sample(lastCanvasDrawDurationMs);

    frame.close();
    framesClosed++;
    framesRendered++;
    renCount++;

    const now = performance.now();
    const renderGapMs = lastRenderTime !== null ? Math.max(0, now - lastRenderTime) : 16.67;
    lastRenderTime = now;
    renderIntervalTracker.sampleInterval(renderGapMs);

    const ltStats = getLongTaskStats();
    const renStats = renderIntervalTracker.getStats();
    const recStats = receiveIntervalTracker.getStats();
    const decStats = decodeIntervalTracker.getStats();
    const rafStats = rafIntervalTracker.getStats();
    const drawStats = canvasDrawTracker.getStats();

    const expectedInterval = lastCaptureGapMs > 0 && lastCaptureGapMs < 100 ? lastCaptureGapMs : 16.67;
    const expectedFps = Math.round(1000 / expectedInterval);

    stutterDetector.record({
      renderGapMs,
      captureGapMs,
      encodeDurationMs: null,
      isKeyframe,
      networkLagMs: lastLagMs,
      receiveGapMs: lastReceiveGapMs,
      decodeGapMs: lastDecodeGapMs,
      rafGapMs: lastRafGapMs,
      canvasDrawMs: lastCanvasDrawDurationMs,
      decodeQueueSize: decoder?.decodeQueueSize ?? 0,
      presentationQueueSize: fila.length,
      avDriftMs: lastAvDriftMs,
      expectedIntervalMs: expectedInterval,
      expectedFps,
      receiveFps,
      decodeFps,
      renderFps,
      rafFps,
      receiveP95: recStats.p95,
      decodeP95: decStats.p95,
      renderP95: renStats.p95,
      rafP95: rafStats.p95,
      canvasDrawP95: drawStats.p95,
      longestLongTaskMs: ltStats.longestMs,
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'visible',
      hasFocus: typeof document !== 'undefined' && document.hasFocus ? document.hasFocus() : true,
      transport: 'Relay (WebSocket)',
    });

    updateFpsMetrics();

    if (virgem || mudou) {
      virgem = false;
      onTamanho?.({ width: canvas.width, height: canvas.height });
    }
  }

  function updateFpsMetrics() {
    const now = performance.now();
    if (now - fpsTimer >= 1000) {
      const elapsed = (now - fpsTimer) / 1000;
      receiveFps = Math.round(recCount / elapsed);
      decodeFps = Math.round(decCount / elapsed);
      renderFps = Math.round(renCount / elapsed);
      rafFps = Math.round(rafCount / elapsed);
      chunksSubmittedSec = Math.round(chunkCount / elapsed);

      recCount = 0;
      decCount = 0;
      renCount = 0;
      rafCount = 0;
      chunkCount = 0;
      fpsTimer = now;

      receiveIntervalTracker.resetWindowCounts();
      decodeIntervalTracker.resetWindowCounts();
      renderIntervalTracker.resetWindowCounts();
      rafIntervalTracker.resetWindowCounts();
      stutterDetector.resetWindow();
    }
  }

  function stop() {
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close();
      } catch {
        // Fechar o que já fechou
      }
    }
    decoder = null;
    needKeyframe = true;
    lastLagMs = 0;
    esvaziar();
    playbackState = 'BUILDING';
    playbackMediaTimeMs = null;
    wallClockAnchorMs = null;
    lastAvDriftMs = 0;
    lastPresentationLagMs = 0;
    lastRenderTime = null;
    lastDecodeTime = null;
    lastRafTime = null;
    lastReceiveTimestampUs = null;
    if (canvas.width && canvas.height) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function getSizes() {
    const rect = canvas.getBoundingClientRect();
    return {
      video: `${canvas.width}×${canvas.height}`,
      box: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      cssWidth: Math.round(rect.width),
      cssHeight: Math.round(rect.height),
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      viewport:
        typeof window !== 'undefined' ? `${window.innerWidth}×${window.innerHeight}` : '1920×1080',
    };
  }

  function getMetrics() {
    const aClock = getAudioClock?.();
    const recStats = receiveIntervalTracker.getStats();
    const decStats = decodeIntervalTracker.getStats();
    const renStats = renderIntervalTracker.getStats();
    const rafStats = rafIntervalTracker.getStats();
    const drawStats = canvasDrawTracker.getStats();
    const stutStats = stutterDetector.getStats();
    const ltStats = getLongTaskStats();
    const sizes = getSizes();

    const currentlyLiveFrames = Math.max(0, framesDecoded - framesClosed);

    return {
      receiveFps,
      decodeFps,
      renderFps,
      rafFps,
      chunksSubmittedSec,
      decodeQueueSize: decoder?.decodeQueueSize ?? 0,
      presentationQueueSize: fila.length,
      framesReceived,
      framesDecoded,
      framesRendered,
      framesDropped,
      framesClosed,
      currentlyLiveFrames,
      maxLiveFrames,
      droppedLate: droppedLateCount,
      droppedRecovery: droppedRecoveryCount,
      hardResyncCount,
      softCorrectionCount,
      decoderReconfigureCount,
      decoderErrors,
      videoLagMs: lastLagMs,
      presentationLagMs: lastPresentationLagMs,
      avDriftMs: lastAvDriftMs,
      clockSource: aClock?.active ? 'AUDIO' : lastMediaClockSource,
      lastKeyframeAgeMs: lastKeyframeAt ? Math.round(performance.now() - lastKeyframeAt) : null,
      latencyMode: currentLatencyMode,
      sizes,
      network: {
        receiveFps,
        packetsSec: receiveFps,
        p50: recStats.p50,
        p95: recStats.p95,
        p99: recStats.p99,
        maxGap: recStats.max,
        jitter: recStats.jitter,
        transport: 'Relay (WebSocket)',
      },
      decoder: {
        decodeFps,
        chunksSubmittedSec,
        decodeQueueSize: decoder?.decodeQueueSize ?? 0,
        p50: decStats.p50,
        p95: decStats.p95,
        p99: decStats.p99,
        maxGap: decStats.max,
        reconfigures: decoderReconfigureCount,
        errors: decoderErrors,
      },
      presentation: {
        renderFps,
        queuedFrames: fila.length,
        droppedTotal: framesDropped,
        droppedLate: droppedLateCount,
        droppedRecovery: droppedRecoveryCount,
        p50: renStats.p50,
        p95: renStats.p95,
        p99: renStats.p99,
        maxGap: renStats.max,
        hardResyncCount,
        softCorrectionCount,
        avDriftMs: lastAvDriftMs,
        presentationLagMs: lastPresentationLagMs,
      },
      raf: {
        rafFps,
        p50: rafStats.p50,
        p95: rafStats.p95,
        p99: rafStats.p99,
        maxGap: rafStats.max,
        visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'visible',
        hidden: typeof document !== 'undefined' ? document.hidden : false,
        hasFocus: typeof document !== 'undefined' && document.hasFocus ? document.hasFocus() : true,
      },
      mainThread: {
        longTasks10s: ltStats.count10s,
        longestTaskMs: ltStats.longestMs,
        totalLongTaskDurationMs: ltStats.totalDurationMs,
      },
      canvas: {
        drawAvgMs: drawStats.avg,
        drawP50Ms: drawStats.p50,
        drawP95Ms: drawStats.p95,
        drawMaxMs: drawStats.max,
        backingRes: `${sizes.backingWidth}×${sizes.backingHeight}`,
        cssRes: `${sizes.cssWidth}×${sizes.cssHeight}`,
        dpr: sizes.dpr,
        viewport: sizes.viewport,
      },
      videoFrameLifetime: {
        decoded: framesDecoded,
        rendered: framesRendered,
        dropped: framesDropped,
        closed: framesClosed,
        currentlyLive: currentlyLiveFrames,
        maxLive: maxLiveFrames,
      },
      playbackBuffer: {
        targetMs: currentTargetBufferMs,
        currentMs: currentBufferMs,
        min10s: minBuffer10s,
        max10s: maxBuffer10s,
        state: playbackState,
      },
      audio: {
        clockSource: aClock?.active ? 'AUDIO' : 'VIDEO',
        bufferedMs: aClock?.bufferAheadMs ? Math.round(aClock.bufferAheadMs) : 0,
        underruns: aClock?.underrunCount ?? 0,
        avDriftMs: lastAvDriftMs,
      },
      streamLatency: {
        estimatedEndToEndMs: Math.round(lastLagMs + currentBufferMs),
        targetRange: '700-1500 ms',
        maxAllowedMs: latencyConfig.hardMaxBufferMs || 2000,
      },
      pacing: {
        receiveInterval: recStats,
        decodeInterval: decStats,
        renderInterval: renStats,
        rafInterval: rafStats,
        stutter: stutStats,
      },
      stutterEvents: stutStats.history,
    };
  }

  return {
    start,
    push,
    stop,
    setLatencyMode,
    getLag: () => lastLagMs,
    getJitter: () =>
      receiveIntervalTracker.getStats().avg === 0
        ? null
        : Math.round(receiveIntervalTracker.getStats().jitter),
    getAvDrift: () => lastAvDriftMs,
    getMetrics,
    takeFrameCount: () => framesRendered,
    getSizes,
  };
}

function deserialize(c) {
  const out = {
    codec: c.codec,
    codedWidth: c.codedWidth,
    codedHeight: c.codedHeight,
    optimizeForLatency: true,
  };

  if (c.description) {
    const bin = atob(c.description);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.description = bytes;
  }

  return out;
}
