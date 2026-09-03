import {
  getLatencyConfig,
  DEFAULT_LATENCY_MODE,
  msToS,
  sToMs,
  usToMs,
  sToUs,
} from '../../shared/latency-policy.js';

export function createAudio({ onError, onStateChange, volume = 1, latencyMode = DEFAULT_LATENCY_MODE } = {}) {
  let ctx = null;
  let decoder = null;
  let ganho = null;
  let proximo = 0;
  let nivel = volume;
  let tocou = false;
  let lastLagMs = 0;
  let underrunCount = 0;
  let chunksReceivedCount = 0;

  let currentLatency = getLatencyConfig(latencyMode);

  // Rastreamento dos chunks agendados para expor a linha do tempo do áudio ao Player
  // Cada item: { startTime, duration, mediaTimestampUs, endTime }
  const scheduledChunks = [];

  function setLatencyMode(mode) {
    currentLatency = getLatencyConfig(mode);
  }

  function start(config) {
    stop();

    if (
      typeof globalThis.AudioDecoder === 'undefined' ||
      typeof globalThis.AudioContext === 'undefined'
    ) {
      onError?.('Este navegador não toca o áudio da transmissão.');
      return false;
    }

    ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: config.sampleRate });
    ctx.onstatechange = () => {
      onStateChange?.(ctx?.state || 'closed');
    };
    ganho = ctx.createGain();
    ganho.gain.value = nivel;
    ganho.connect(ctx.destination);

    decoder = new AudioDecoder({
      output: agendar,
      error: (err) => console.warn('[audio]', err.message),
    });

    try {
      decoder.configure({
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
      });
    } catch {
      onError?.(`Áudio em formato não suportado: ${config.codec}`);
      decoder = null;
      return false;
    }

    proximo = 0;
    tocou = false;
    underrunCount = 0;
    scheduledChunks.length = 0;
    onStateChange?.(ctx.state);
    return true;
  }

  /** Pacote empacotado: [1B slot][1B tipo][8B timestamp][8B envio][payload] */
  function push(buffer) {
    if (!decoder || decoder.state !== 'configured') return;

    chunksReceivedCount++;
    const view = new DataView(buffer);
    const timestampUs = view.getFloat64(2);
    const sentAt = view.getFloat64(10);
    lastLagMs = Math.max(0, Date.now() - sentAt);

    try {
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key', // Todo pacote Opus se decodifica sozinho.
          timestamp: timestampUs,
          data: new Uint8Array(buffer, 18),
        }),
      );
    } catch (err) {
      console.warn('[audio decode]', err.message);
    }
  }

  function agendar(dados) {
    if (!ctx) return dados.close();

    const canais = dados.numberOfChannels;
    const sampleRate = dados.sampleRate;
    const mediaTimestampUs = dados.timestamp ?? 0;
    const buffer = ctx.createBuffer(canais, dados.numberOfFrames, sampleRate);
    for (let c = 0; c < canais; c++) {
      dados.copyTo(buffer.getChannelData(c), { planeIndex: c, format: 'f32-planar' });
    }
    dados.close();

    const agora = ctx.currentTime;
    const startupColchaoSec = currentLatency.audioStartupColchaoSec || 0.15;
    const maxHorizonSec = msToS(currentLatency.audioMaxHorizonMs || 600);
    const targetAheadSec = msToS(currentLatency.audioAheadTargetMs || 150);

    // Fila secou (engasgo ou início): recomeça de agora + colchão suave.
    if (proximo < agora + 0.01) {
      if (tocou && proximo > 0 && proximo < agora) {
        underrunCount++;
      }
      proximo = agora + startupColchaoSec;
    }
    // Fila acumulou atraso além do teto máximo permitido: recupera suavemente
    else if (proximo - agora > maxHorizonSec) {
      proximo = agora + targetAheadSec;
    }

    const duration = buffer.duration;
    const startTime = proximo;
    const endTime = startTime + duration;

    const fonte = ctx.createBufferSource();
    fonte.buffer = buffer;
    fonte.connect(ganho);
    fonte.start(startTime);
    proximo += duration;
    tocou = true;

    scheduledChunks.push({ startTime, duration, mediaTimestampUs, endTime });

    // Limpa chunks já reproduzidos há mais de 1.0s para economizar memória mantendo histórico
    while (scheduledChunks.length && scheduledChunks[0].endTime < agora - 1.0) {
      scheduledChunks.shift();
    }

    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  /**
   * Retorna a posição do relógio mestre de áudio na linha do tempo da mídia.
   */
  function getAudioClock() {
    if (!ctx || !tocou || scheduledChunks.length === 0) {
      return {
        active: false,
        mediaTimestampUs: null,
        mediaTimestampMs: null,
        bufferAheadMs: 0,
        underrunCount,
        clockSource: 'AUDIO',
        latencyMs: lastLagMs,
      };
    }

    const agora = ctx.currentTime;
    const bufferAheadMs = Math.max(0, sToMs(proximo - agora));

    // Encontra o chunk ativo no momento da reprodução
    let match = null;
    for (let i = scheduledChunks.length - 1; i >= 0; i--) {
      const chunk = scheduledChunks[i];
      if (chunk.startTime <= agora && agora <= chunk.endTime) {
        match = chunk;
        break;
      }
    }

    if (!match) {
      // Se está no intervalo entre chunks ou adiantado, usa o chunk mais recente
      match = scheduledChunks[scheduledChunks.length - 1];
    }

    if (!match) {
      return {
        active: false,
        mediaTimestampUs: null,
        mediaTimestampMs: null,
        bufferAheadMs,
        underrunCount,
        clockSource: 'AUDIO',
        latencyMs: lastLagMs,
      };
    }

    // Calcula a posição física real da apresentação: se ainda não chegou em startTime,
    // o tempo físico reflete a distância negativa até o início da emissão sonora.
    let elapsedInChunkSec;
    if (agora < match.startTime) {
      elapsedInChunkSec = agora - match.startTime;
    } else {
      elapsedInChunkSec = Math.min(match.duration, agora - match.startTime);
    }
    const mediaTimestampUs = match.mediaTimestampUs + sToUs(elapsedInChunkSec);
    const mediaTimestampMs = usToMs(mediaTimestampUs);

    return {
      active: true,
      mediaTimestampUs,
      mediaTimestampMs,
      bufferAheadMs,
      underrunCount,
      clockSource: 'AUDIO',
      latencyMs: lastLagMs,
    };
  }

  function setVolume(valor) {
    nivel = Math.min(2, Math.max(0, valor));
    if (ganho && ctx) {
      ganho.gain.setTargetAtTime(nivel, ctx.currentTime, 0.02);
    }
  }

  async function resume() {
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn('[audio] Falha no resume:', err.message);
      }
    }
    const ok = Boolean(ctx && ctx.state === 'running');
    onStateChange?.(ctx?.state || 'closed');
    return ok;
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

    ctx?.close().catch(() => {});
    ctx = null;
    ganho = null;
    proximo = 0;
    tocou = false;
    underrunCount = 0;
    chunksReceivedCount = 0;
    scheduledChunks.length = 0;
    onStateChange?.('closed');
  }

  return {
    start,
    push,
    stop,
    resume,
    isSuspended: () => Boolean(ctx && ctx.state === 'suspended'),
    getState: () => ctx?.state || 'closed',
    setVolume,
    setLatencyMode,
    getAudioClock,
    temSom: () => tocou,
    getLag: () => lastLagMs,
    getUnderruns: () => underrunCount,
    getChunksReceived: () => chunksReceivedCount,
  };
}
