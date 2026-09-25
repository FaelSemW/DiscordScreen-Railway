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
import { BUILD_METADATA } from '../../shared/build-metadata.js';

export { LATENCY_MODES };

export function createPlayer(
  canvas,
  { onError, onTamanho, onNeedKeyframe, getAudioClock, latencyMode = DEFAULT_LATENCY_MODE,
    isPictureInPicture = () => typeof document !== 'undefined' && Boolean(document.pictureInPictureElement),
  } = {},
) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  let decoder = null;
  let needKeyframe = true;
  let lastLagMs = 0;

  let currentLatencyMode = latencyMode;
  let latencyConfig = getLatencyConfig(latencyMode);

  // Métricas de Ritmo (Frame Pacing) e Intervalos — Telemetria Headless Bounding
  const receiveIntervalTracker = createIntervalTracker(120);
  const decodeIntervalTracker = createIntervalTracker(120);
  const renderIntervalTracker = createIntervalTracker(120);
  const rafIntervalTracker = createIntervalTracker(120);
  const canvasDrawTracker = createValueTracker(120);

  const stutterDetector = createStutterDetector({
    candidateThresholdMs: 40,
    severeThresholdMs: 75,
    maxHistory: 25,
  });

  // Long Task Tracking via PerformanceObserver (onde suportado)
  let longTasks10s = [];
  let longTaskObserver = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        const now = performance.now();
        for (const entry of list.getEntries()) {
          longTasks10s.push({ timestamp: now, duration: entry.duration });
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      // Longtask observer não suportado em alguns navegadores/webviews
    }
  }

  function getLongTaskStats() {
    const now = performance.now();
    longTasks10s = longTasks10s.filter((t) => now - t.timestamp <= 10000);
    let longestMs = 0;
    let totalDurationMs = 0;
    for (const t of longTasks10s) {
      if (t.duration > longestMs) longestMs = t.duration;
      totalDurationMs += t.duration;
    }
    return {
      count10s: longTasks10s.length,
      longestMs: Math.round(longestMs * 10) / 10,
      totalDurationMs: Math.round(totalDurationMs * 10) / 10,
    };
  }

  let lastRenderTime = null;
  let lastDecodeTime = null;
  let lastRafTime = null;
  let lastReceiveTimestampUs = null;
  let lastCaptureGapMs = 16.67;
  let lastReceiveGapMs = 16.67;
  let lastDecodeGapMs = 16.67;
  let lastRafGapMs = 16.67;
  let lastCanvasDrawDurationMs = 0;
  let lastChunkWasKeyframe = false;

  let framesReceived = 0;
  let framesDecoded = 0;
  let framesRendered = 0;
  let framesDropped = 0;
  let framesClosed = 0;
  let maxLiveFrames = 0;

  let droppedLateCount = 0;
  let droppedRecoveryCount = 0;
  let videoHeldForPresentation = 0;
  let videoDroppedStale = 0;
  let videoDroppedDecoderPressure = 0;
  let videoDroppedTransportRecovery = 0;
  let videoDroppedOther = 0;
  let hardResyncCount = 0;
  let softCorrectionCount = 0;
  let decoderReconfigureCount = 0;
  let decoderErrors = 0;

  let lastAvDriftMs = 0;
  let lastPresentationLagMs = 0;
  let lastKeyframeAt = 0;

  let keyframeRequestCount = 0;
  let recentKeyframeRequests = [];
  let recentHardResyncs = [];

  function pedirKeyframe() {
    keyframeRequestCount++;
    recentKeyframeRequests.push(performance.now());
    needKeyframe = true;
    onNeedKeyframe?.();
  }

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

  // Jitter / Playback Buffer State Machine
  let playbackState = 'BUILDING';
  let currentTargetBufferMs = latencyConfig.targetBufferMs;
  let currentBufferMs = 0;
  let minBuffer10s = currentTargetBufferMs;
  let maxBuffer10s = currentTargetBufferMs;
  let bufferWindowTimer = performance.now();
  let stabilityTimer = performance.now();

  const fila = [];
  let playbackMediaTimeMs = null;
  let wallClockAnchorMs = null;
  let audioToVideoOffsetMs = null;
  let consecutiveHardResyncs = 0;
  let lastMediaClockSource = 'VIDEO';
  let rafId = null;
  let virgem = true;

  let isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  let newestCandidateFrame = null;
  let newestCandidateMeta = null;

  function onVisibilityChange() {
    if (typeof document === 'undefined') return;
    const isPipActive = isPictureInPicture();
    const nowHidden = document.visibilityState === 'hidden' && !isPipActive;
    if (nowHidden) {
      isHidden = true;
      // BACKGROUND_PRESENTATION_MODE: descarta fila acumulada mantendo no máximo 1 candidato recente
      while (fila.length > 1) {
        const item = fila.shift();
        item.frame.close();
        framesClosed++;
        framesDropped++;
      }
      if (fila.length === 1) {
        if (newestCandidateFrame) {
          newestCandidateFrame.close();
          framesClosed++;
        }
        const last = fila.shift();
        newestCandidateFrame = last.frame;
        newestCandidateMeta = last;
      }
    } else {
      isHidden = false;
      performLiveEdgeRecovery();
    }
  }

  function performLiveEdgeRecovery() {
    // 1. Esvazia fila obsoleta
    esvaziar();

    // 2. Apresenta o candidato mais recente imediatamente para evitar tela preta ou congelamento
    if (newestCandidateFrame) {
      pintar(
        newestCandidateFrame,
        newestCandidateMeta?.isKeyframe ?? false,
        newestCandidateMeta?.captureGapMs ?? 16.67,
      );
      newestCandidateFrame = null;
      newestCandidateMeta = null;
    }

    // 3. Reinicia medições de tempo para convergir no live edge
    playbackState = 'BUILDING';
    playbackMediaTimeMs = null;
    wallClockAnchorMs = null;
    consecutiveHardResyncs = 0;

    // 4. Solicita um keyframe limpo para recuperar continuidade
    pedirKeyframe();

    // 5. Retoma ritmo de RAF suavemente
    agendar();
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('enterpictureinpicture', onVisibilityChange);
    document.addEventListener('leavepictureinpicture', onVisibilityChange);
    document.addEventListener('dcss-pipchange', onVisibilityChange);
  }

  function setLatencyMode(mode) {
    currentLatencyMode = mode;
    latencyConfig = getLatencyConfig(mode);
    currentTargetBufferMs = latencyConfig.targetBufferMs;
    playbackState = 'BUILDING';
    playbackMediaTimeMs = null;
    wallClockAnchorMs = null;
    audioToVideoOffsetMs = null;
    consecutiveHardResyncs = 0;
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
        console.warn('[decoder error]', err.message);
        decoderErrors++;
        pedirKeyframe();
      },
    });

    const candidateConfigs = [
      { ...config },
      (() => { const c = { ...config }; delete c.optimizeForLatency; return c; })(),
      (() => { const c = { ...config }; delete c.hardwareAcceleration; delete c.optimizeForLatency; return c; })(),
    ];

    if (config.codec?.startsWith('avc1.')) {
      candidateConfigs.push({ ...config, avc: { format: 'annexb' } });
      const level = config.codec.slice(9) || '1f';
      candidateConfigs.push({ ...config, codec: `avc1.42e0${level}`, avc: { format: 'annexb' } });
      candidateConfigs.push({ ...config, codec: `avc1.4200${level}`, avc: { format: 'annexb' } });
      candidateConfigs.push({ ...config, codec: `avc1.42e01f`, avc: { format: 'annexb' } });
      candidateConfigs.push({ ...config, codec: `avc1.42001f` });
    }

    let configured = false;
    for (const cand of candidateConfigs) {
      try {
        decoder.configure(cand);
        configured = true;
        break;
      } catch {}
    }

    if (!configured) {
      console.warn(`[player] Não foi possível configurar VideoDecoder para ${config.codec}`);
      decoder = null;
      onError?.(`Codec não suportado por este dispositivo: ${config.codec}`);
      return false;
    }

    needKeyframe = true;
    playbackState = 'BUILDING';
    playbackMediaTimeMs = null;
    wallClockAnchorMs = null;
    audioToVideoOffsetMs = null;
    consecutiveHardResyncs = 0;
    return true;
  }

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

    if (needKeyframe && !isKeyframe) {
      framesDropped++;
      return;
    }

    if (decoder.decodeQueueSize > Math.max(16, latencyConfig.maxDecodeQueue * 2)) {
      framesDropped++;
      droppedRecoveryCount++;
      if (!isKeyframe) {
        pedirKeyframe();
        return;
      }
    }

    try {
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
      console.warn('[decode]', err.message);
      decoderErrors++;
      pedirKeyframe();
    }
  }

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

    const isPipActive = isPictureInPicture();
    if (isPipActive && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      // rAF is suspended in hidden Safari tabs. Present on decoded-frame arrival
      // while native PiP is active instead of depending on a suspended callback.
      esvaziar();
      pintar(frame, isKey, capGap);
      return;
    }
    if (isHidden && !isPipActive) {
      // BACKGROUND_PRESENTATION_MODE: mantém decoder vivo, retendo apenas o frame mais novo
      if (newestCandidateFrame) {
        newestCandidateFrame.close();
        framesClosed++;
        framesDropped++;
      }
      newestCandidateFrame = frame;
      newestCandidateMeta = {
        tsMs,
        isKeyframe: isKey,
        captureGapMs: capGap,
        receivedAt: agora,
      };
      return;
    }

    if (fila.length && tsMs < fila[fila.length - 1].tsMs) {
      esvaziar();
      playbackState = 'BUILDING';
      playbackMediaTimeMs = null;
      wallClockAnchorMs = agora;
    }

    if (fila.length === 0) {
      wallClockAnchorMs = agora;
      playbackMediaTimeMs = tsMs;
    }

    fila.push({ frame, tsMs, isKeyframe: isKey, captureGapMs: capGap, receivedAt: agora });

    const liveFrames = fila.length;
    if (liveFrames > maxLiveFrames) maxLiveFrames = liveFrames;

    // Fila delimitada por idade conforme política de latência ativa
    while (fila.length > 1 && agora - fila[0].receivedAt > latencyConfig.hardMaxBufferMs) {
      const stale = fila.shift();
      stale.frame.close();
      framesClosed++;
      framesDropped++;
      droppedRecoveryCount++;
    }

    while (fila.length > latencyConfig.filaMax) {
      const dropped = fila.shift();
      dropped.frame.close();
      framesClosed++;
      framesDropped++;
      droppedRecoveryCount++;
    }

    agendar();
  }

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

  function passo() {
    rafId = null;
    rafCount++;

    const agora = performance.now();
    lastRafGapMs = lastRafTime !== null ? Math.max(0, agora - lastRafTime) : 16.67;
    lastRafTime = agora;
    rafIntervalTracker.sampleInterval(lastRafGapMs);

    if (!fila.length) return;

    const audioClock = getAudioClock?.();
    let mediaPlaybackTime;

    const audioActive = Boolean(
      audioClock && audioClock.active && audioClock.mediaTimestampMs !== null,
    );

    if (playbackState === 'BUILDING') {
      const oldestTs = fila[0].tsMs;
      const newestTs = fila[fila.length - 1].tsMs;
      const bufferedSpan = newestTs - oldestTs;

      if (
        bufferedSpan >= latencyConfig.startupBufferMs ||
        audioActive ||
        fila.length >= Math.min(10, latencyConfig.filaMax) ||
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

    if (audioActive) {
      lastMediaClockSource = 'AUDIO';
      const rawAudioTime = audioClock.mediaTimestampMs;

      mediaPlaybackTime =
        audioToVideoOffsetMs !== null ? rawAudioTime + audioToVideoOffsetMs : rawAudioTime;

      const oldest = fila[0];
      let avDrift = oldest.tsMs - mediaPlaybackTime;

      // 1. Se o vídeo está massivamente adiantado em relação ao áudio (> hardResyncThresholdMs),
      // é impossível ser jitter normal em transmissão ao vivo: os clocks possuem origens diferentes.
      if (avDrift > latencyConfig.hardResyncThresholdMs) {
        console.warn(
          `[AV_SYNC] Vídeo adiantado além do limiar (${avDrift}ms). Calibrando offset de áudio/vídeo.`,
        );
        audioToVideoOffsetMs = oldest.tsMs - rawAudioTime;
        mediaPlaybackTime = rawAudioTime + audioToVideoOffsetMs;
        avDrift = oldest.tsMs - mediaPlaybackTime;
      }
      // 2. Se o atraso for inaceitável (< -hardResyncThresholdMs)
      else if (avDrift < -latencyConfig.hardResyncThresholdMs) {
        consecutiveHardResyncs++;
        // Na primeira ocorrência, tenta pedir um keyframe novo conforme a arquitetura
        if (consecutiveHardResyncs === 1) {
          console.warn(
            `[HARD_RESYNC] atraso inaceitável (${avDrift}ms), solicitando keyframe para recuperar`,
          );
          hardResyncCount++;
          recentHardResyncs.push(performance.now());
          esvaziar();
          playbackState = 'BUILDING';
          playbackMediaTimeMs = null;
          wallClockAnchorMs = null;
          audioToVideoOffsetMs = null;
          pedirKeyframe();
          return;
        }

        // Se já tentou hard resync e a discrepância persiste, os clocks de captura
        // de áudio e vídeo possuem réguas diferentes. Calibra o offset para não travar
        // em loop infinito descartando todos os quadros!
        console.warn(
          `[AV_SYNC] Discrepância de sincronia persistente (${avDrift}ms, tentativas=${consecutiveHardResyncs}). Calibrando offset de áudio/vídeo.`,
        );
        audioToVideoOffsetMs = oldest.tsMs - rawAudioTime;
        mediaPlaybackTime = rawAudioTime + audioToVideoOffsetMs;
        avDrift = oldest.tsMs - mediaPlaybackTime;
        consecutiveHardResyncs = 0;
      }
      // 3. Sincronização adaptativa suave (drift slew) quando offset já está calibrado
      else if (audioToVideoOffsetMs !== null && Math.abs(avDrift) > 35) {
        const slew = Math.sign(avDrift) * Math.min(Math.abs(avDrift) * 0.05, 1);
        audioToVideoOffsetMs += slew;
        mediaPlaybackTime = rawAudioTime + audioToVideoOffsetMs;
        avDrift = oldest.tsMs - mediaPlaybackTime;
      }
    } else {
      lastMediaClockSource = 'VIDEO';
      audioToVideoOffsetMs = null;
      consecutiveHardResyncs = 0;
      if (playbackMediaTimeMs === null || wallClockAnchorMs === null) {
        playbackMediaTimeMs = fila[0].tsMs;
        wallClockAnchorMs = agora;
      }
      mediaPlaybackTime = playbackMediaTimeMs + (agora - wallClockAnchorMs);
    }

    const newestTs = fila[fila.length - 1].tsMs;
    currentBufferMs = Math.max(0, Math.round(newestTs - mediaPlaybackTime));
    updateAdaptiveBuffer(agora);

    const oldest = fila[0];
    const avDrift = oldest.tsMs - mediaPlaybackTime;
    lastAvDriftMs = Math.round(avDrift);
    lastPresentationLagMs = Math.max(0, Math.round(mediaPlaybackTime - oldest.tsMs));

    let itemParaPintar = null;
    while (fila.length && fila[0].tsMs <= mediaPlaybackTime + 8) {
      const item = fila.shift();
      if (fila.length && fila[0].tsMs <= mediaPlaybackTime + 8) {
        item.frame.close();
        framesClosed++;
        framesDropped++;
        droppedLateCount++;
        videoDroppedStale++;
        softCorrectionCount++;
      } else {
        itemParaPintar = item;
        break;
      }
    }

    if (!itemParaPintar && fila.length) {
      // Quadro futuro legítimo: segurado para próxima RAF quando for devido (não descartado)
      videoHeldForPresentation++;
    }

    if (itemParaPintar) {
      pintar(itemParaPintar.frame, itemParaPintar.isKeyframe, itemParaPintar.captureGapMs);
    }

    if (fila.length) {
      agendar();
    }
  }

  function agendar() {
    if (typeof document !== 'undefined' && isPictureInPicture() && document.visibilityState === 'hidden') {
      rafId ??= setTimeout(passo, 16);
    } else if (typeof requestAnimationFrame !== 'undefined') {
      rafId ??= requestAnimationFrame(passo);
    } else {
      rafId ??= setTimeout(passo, 16);
    }
  }

  function esvaziar(reason = 'recovery') {
    const count = fila.length;
    while (fila.length) {
      const item = fila.shift();
      item.frame.close();
      framesClosed++;
      framesDropped++;
    }
    if (reason === 'recovery') {
      droppedRecoveryCount += count;
      videoDroppedTransportRecovery += count;
    } else if (reason === 'decoder') {
      videoDroppedDecoderPressure += count;
    } else {
      videoDroppedOther += count;
    }
    if (rafId !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
      }
      clearTimeout(rafId);
      rafId = null;
    }
  }

  function pintar(frame, isKeyframe = false, captureGapMs = 16.67) {
    if (!frame || !frame.displayWidth || !frame.displayHeight) {
      frame?.close?.();
      return;
    }

    let mudou = false;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      mudou = true;
    }

    const t0 = performance.now();
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    lastCanvasDrawDurationMs = performance.now() - t0;
    canvasDrawTracker.sample(lastCanvasDrawDurationMs);

    frame.close();
    framesClosed++;
    framesRendered++;
    renCount++;

    const now = performance.now();
    const renderGapMs = lastRenderTime !== null ? Math.max(0, now - lastRenderTime) : 16.67;
    lastRenderTime = now;
    renderIntervalTracker.sampleInterval(renderGapMs);

    const recStats = receiveIntervalTracker.getStats();
    const decStats = decodeIntervalTracker.getStats();
    const renStats = renderIntervalTracker.getStats();
    const rafStats = rafIntervalTracker.getStats();
    const drawStats = canvasDrawTracker.getStats();
    const ltStats = getLongTaskStats();

    const expectedInterval = Math.round(captureGapMs) > 25 ? 33.33 : 16.67;
    const expectedFps = expectedInterval > 25 ? 30 : 60;

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
    keyframeRequestCount = 0;
    recentKeyframeRequests = [];
    recentHardResyncs = [];
    lastLagMs = 0;
    esvaziar();
    playbackState = 'BUILDING';
    playbackMediaTimeMs = null;
    wallClockAnchorMs = null;
    audioToVideoOffsetMs = null;
    consecutiveHardResyncs = 0;
    lastAvDriftMs = 0;
    lastPresentationLagMs = 0;
    lastRenderTime = null;
    lastDecodeTime = null;
    lastRafTime = null;
    lastReceiveTimestampUs = null;
    lastChunkWasKeyframe = false;
    if (newestCandidateFrame) {
      try { newestCandidateFrame.close(); } catch {}
      newestCandidateFrame = null;
      newestCandidateMeta = null;
    }
    virgem = true;
    if (canvas.width && canvas.height) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function getSizes() {
    const rect = canvas.getBoundingClientRect
      ? canvas.getBoundingClientRect()
      : { width: canvas.width || 0, height: canvas.height || 0 };
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

    const oldestQueuedFrameAgeMs =
      fila.length > 0 && fila[0].receivedAt !== undefined
        ? Math.max(0, Math.round(performance.now() - fila[0].receivedAt))
        : 0;
    const lastRenderedFrameAgeMs =
      lastRenderTime !== null ? Math.max(0, Math.round(performance.now() - lastRenderTime)) : null;

    const oneMinAgo = performance.now() - 60000;
    recentHardResyncs = recentHardResyncs.filter((t) => t >= oneMinAgo);
    recentKeyframeRequests = recentKeyframeRequests.filter((t) => t >= oneMinAgo);
    const hardResyncsPerMinute = recentHardResyncs.length;
    const keyframeRequestsPerMinute = recentKeyframeRequests.length;
    const frameBacklogAlarm =
      oldestQueuedFrameAgeMs > 500 ? 'CRITICAL' : oldestQueuedFrameAgeMs > 250 ? 'WARNING' : 'NORMAL';
    const pipelineHealth =
      hardResyncsPerMinute > 2 || keyframeRequestsPerMinute > 6 ? 'DEGRADED' : 'HEALTHY';

    return {
      build: BUILD_METADATA,
      receiveFps,
      decodeFps,
      renderFps,
      rafFps,
      chunksSubmittedSec,
      decodeQueueSize: decoder?.decodeQueueSize ?? 0,
      presentationQueueSize: fila.length,
      oldestQueuedFrameAgeMs,
      lastRenderedFrameAgeMs,
      frameBacklogAlarm,
      hardResyncsPerMinute,
      keyframeRequestsPerMinute,
      pipelineHealth,
      keyframeRequestCount,
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
        videoHeldForPresentation,
        videoDroppedStale,
        videoDroppedDecoderPressure,
        videoDroppedTransportRecovery,
        videoDroppedOther,
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
    getAudioToVideoOffset: () => audioToVideoOffsetMs,
    getKeyframeRequestCount: () => keyframeRequestCount,
    getMetrics,
    takeFrameCount: () => framesRendered,
    getSizes,
    performLiveEdgeRecovery,
    requestKeyframe: pedirKeyframe,
    destroy: () => {
      stop();
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        document.removeEventListener('dcss-pipchange', onVisibilityChange);
        document.removeEventListener('enterpictureinpicture', onVisibilityChange);
        document.removeEventListener('leavepictureinpicture', onVisibilityChange);
      }
      if (longTaskObserver) {
        longTaskObserver.disconnect();
        longTaskObserver = null;
      }
    },
  };
}

function deserialize(c) {
  const width = c.codedWidth || c.width;
  const height = c.codedHeight || c.height;
  const out = {
    codec: c.codec,
    optimizeForLatency: true,
  };

  if (width) out.codedWidth = width;
  if (height) out.codedHeight = height;

  if (c.hardwareAcceleration) {
    out.hardwareAcceleration = c.hardwareAcceleration;
  }

  if (c.description) {
    const bin = atob(c.description);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.description = bytes;
  } else if (c.codec?.startsWith('avc1.')) {
    out.avc = { format: 'annexb' };
  }

  return out;
}
