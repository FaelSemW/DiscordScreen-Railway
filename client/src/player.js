import { createIntervalTracker, createStutterDetector } from '../../shared/pacing-metrics.js';
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

  // Métricas para observabilidade e Ritmo de Quadros (Frame Pacing)
  const receiveIntervalTracker = createIntervalTracker(120);
  const renderIntervalTracker = createIntervalTracker(120);
  const stutterDetector = createStutterDetector({
    candidateThresholdMs: 40,
    severeThresholdMs: 75,
    maxHistory: 10,
  });

  let lastRenderTime = null;
  let lastReceiveTimestampUs = null;
  let lastCaptureGapMs = 16.67;
  let lastReceiveGapMs = 16.67;
  let lastChunkWasKeyframe = false;

  let framesReceived = 0;
  let framesDecoded = 0;
  let framesRendered = 0;
  let framesDropped = 0;
  let droppedLateCount = 0;
  let droppedRecoveryCount = 0;
  let lastAvDriftMs = 0;
  let lastPresentationLagMs = 0;
  let lastKeyframeAt = 0;

  let fpsTimer = performance.now();
  let receiveFps = 0;
  let renderFps = 0;
  let decodeFps = 0;
  let recCount = 0;
  let decCount = 0;
  let renCount = 0;

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
    // Reinicia buffer adaptativo
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

    decoder = new VideoDecoder({
      output: onDecodedFrame,
      error: (err) => {
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

    // Teto estrito da fila para proteção contra vazamento de memória (ex: >120 quadros / 2 segundos)
    while (fila.length > latencyConfig.filaMax) {
      const dropped = fila.shift();
      dropped.frame.close();
      framesDropped++;
      droppedRecoveryCount++;
    }

    agendar();
  }

  /**
   * Controlador de Adaptação de Buffer com Histerese.
   * Evita oscilação ajustando a margem de segurança de forma gradual.
   */
  function updateAdaptiveBuffer(now) {
    const recStats = receiveIntervalTracker.getStats();
    const aClock = getAudioClock?.();

    // Se detecta instabilidade de rede ou áudio baixo, expande o buffer gradualmente
    if (recStats.p95 > 35 || (aClock?.active && aClock.bufferAheadMs < 200)) {
      if (currentTargetBufferMs < latencyConfig.maxBufferMs) {
        currentTargetBufferMs = Math.min(latencyConfig.maxBufferMs, currentTargetBufferMs + 100);
        playbackState = 'RECOVERING';
        stabilityTimer = now;
      }
    }
    // Se a rede estiver estável e sem engasgos por mais de 20s, relaxa o buffer devagar
    else if (now - stabilityTimer > 20000 && recStats.p95 <= 25) {
      if (currentTargetBufferMs > latencyConfig.minBufferMs) {
        currentTargetBufferMs = Math.max(latencyConfig.minBufferMs, currentTargetBufferMs - 25);
        stabilityTimer = now;
      }
      playbackState = currentBufferMs < 300 ? 'LOW' : 'STABLE';
    } else {
      playbackState = currentBufferMs < 300 ? 'LOW' : 'STABLE';
    }

    // Janela deslizante de 10s para min/max buffer
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
   * Renderiza 1 quadro por VSync sincronizado com o Áudio Master Clock (ou Relógio de Vídeo).
   */
  function passo() {
    rafId = null;
    const agora = performance.now();

    if (!fila.length) return;

    const audioClock = getAudioClock?.();
    let mediaPlaybackTime;

    // 1. Fase de Startup Buffer (acumula colchão antes de começar para evitar micro-pausas)
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
      // Sem áudio: relógio de vídeo autônomo suave
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

    // B. Apresentação Otimizada e Descarte Imediato de Quadros Obsoletos:
    // Se múltiplos quadros já venceram para este VSync (ex: stream 60fps em display 30Hz ou após jitter de rAF),
    // avança a fila descartando quadros intermediários obsoletos (fechando seus VideoFrames) e desenha o mais recente.
    let itemParaPintar = null;
    while (fila.length && fila[0].tsMs <= mediaPlaybackTime + 8) {
      const item = fila.shift();
      if (fila.length && fila[0].tsMs <= mediaPlaybackTime + 8) {
        item.frame.close();
        framesDropped++;
        droppedLateCount++;
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

    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    frame.close();
    framesRendered++;
    renCount++;

    const now = performance.now();
    const renderGapMs = lastRenderTime !== null ? Math.max(0, now - lastRenderTime) : 16.67;
    lastRenderTime = now;
    renderIntervalTracker.sampleInterval(renderGapMs);

    stutterDetector.record({
      renderGapMs,
      captureGapMs,
      encodeDurationMs: null,
      isKeyframe,
      networkLagMs: lastLagMs,
      receiveGapMs: lastReceiveGapMs,
      decodeQueueSize: decoder?.decodeQueueSize ?? 0,
      presentationQueueSize: fila.length,
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
      recCount = 0;
      decCount = 0;
      renCount = 0;
      fpsTimer = now;
      receiveIntervalTracker.resetWindowCounts();
      renderIntervalTracker.resetWindowCounts();
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
    };
  }

  function getMetrics() {
    const aClock = getAudioClock?.();
    const recStats = receiveIntervalTracker.getStats();
    const renStats = renderIntervalTracker.getStats();
    const stutStats = stutterDetector.getStats();

    return {
      receiveFps,
      decodeFps,
      renderFps,
      decodeQueueSize: decoder?.decodeQueueSize ?? 0,
      presentationQueueSize: fila.length,
      framesReceived,
      framesDecoded,
      framesRendered,
      framesDropped,
      droppedLate: droppedLateCount,
      droppedRecovery: droppedRecoveryCount,
      videoLagMs: lastLagMs,
      presentationLagMs: lastPresentationLagMs,
      avDriftMs: lastAvDriftMs,
      clockSource: aClock?.active ? 'AUDIO' : lastMediaClockSource,
      lastKeyframeAgeMs: lastKeyframeAt ? Math.round(performance.now() - lastKeyframeAt) : null,
      latencyMode: currentLatencyMode,
      sizes: getSizes(),
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
      video: {
        queuedFrames: fila.length,
        presentationLagMs: lastPresentationLagMs,
        renderFps,
        renderGapP95: renStats.p95,
        droppedLate: droppedLateCount,
        droppedRecovery: droppedRecoveryCount,
      },
      streamLatency: {
        estimatedEndToEndMs: Math.round(lastLagMs + currentBufferMs),
        targetRange: '700-1500 ms',
        maxAllowedMs: latencyConfig.hardMaxBufferMs || 2000,
      },
      pacing: {
        receiveInterval: recStats,
        renderInterval: renStats,
        stutter: stutStats,
      },
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
