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
  let streamDest = null;
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

    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    try {
      ctx = new AudioCtx({ latencyHint: 'interactive', sampleRate: config.sampleRate });
    } catch {
      try {
        ctx = new AudioCtx({ latencyHint: 'interactive' });
      } catch {
        ctx = new AudioCtx();
      }
    }
    ctx.onstatechange = () => {
      const state = ctx?.state || 'closed';
      console.info('[audio] AudioContext state:', state);
      onStateChange?.(state);
    };
    ganho = ctx.createGain();
    ganho.gain.value = nivel;
    ganho.connect(ctx.destination);
    try {
      streamDest = ctx.createMediaStreamDestination();
      ganho.connect(streamDest);
    } catch {
      streamDest = null;
    }

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

    // Se o AudioContext está suspended, notifica o UI antes de tentar agendar
    if (ctx.state === 'suspended') {
      onStateChange?.('suspended');
      // Tenta resumir — vai funcionar se já houve gesto do usuário
      ctx.resume().then(() => {
        onStateChange?.(ctx?.state || 'closed');
      }).catch(() => {});
    }

    const canais = dados.numberOfChannels;
    const sampleRate = dados.sampleRate;
    const mediaTimestampUs = dados.timestamp ?? 0;
    const buffer = ctx.createBuffer(canais, dados.numberOfFrames, sampleRate);
    for (let c = 0; c < canais; c++) {
      dados.copyTo(buffer.getChannelData(c), { planeIndex: c, format: 'f32-planar' });
    }
    dados.close();

    // Se o contexto está suspenso, ctx.currentTime não avança.
    // Agendar com base num clock congelado resulta em silêncio infinito.
    // Nesse caso, descartamos sem contar como underrun — será retomado pelo resume.
    if (ctx.state === 'suspended') return;

    const agora = ctx.currentTime;
    const bufferDuration = buffer.duration;

    // Se o ponteiro proximo ficou para trás (buffer underrun ou inicialização):
    // Reinicia exatamente a partir de agora + colchão da política de latência
    if (proximo < agora) {
      proximo = agora + (currentLatency?.audioStartupColchaoSec ?? 0.04);
    }
    // Se por qualquer flutuação de rede o buffer acumulado ultrapassou 0.5s:
    // Puxa suavemente de volta para agora + 0.08s para evitar silêncio prolongado
    else if (proximo - agora > 0.5) {
      proximo = agora + 0.08;
    }

    const startTime = proximo;
    const endTime = startTime + bufferDuration;

    const fonte = ctx.createBufferSource();
    fonte.buffer = buffer;
    fonte.connect(ganho);
    fonte.start(startTime);
    proximo += bufferDuration;
    tocou = true;

    scheduledChunks.push({ startTime, duration: bufferDuration, mediaTimestampUs, endTime });

    // Limpa chunks já reproduzidos há mais de 1.0s para economizar memória mantendo histórico
    while (scheduledChunks.length && scheduledChunks[0].endTime < agora - 1.0) {
      scheduledChunks.shift();
    }
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
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn('[audio] Falha no resume:', err.message);
      }
    }
    // Se ainda suspended, tenta mais uma vez após pequena espera
    if (ctx && ctx.state === 'suspended') {
      await new Promise((r) => setTimeout(r, 50));
      try {
        await ctx?.resume();
      } catch {}
    }
    // No iOS Safari e alguns navegadores mobile, um buffer silencioso deve ser
    // tocado dentro do gesto para engajar a saída de áudio do sistema operacional
    if (ctx && ctx.state === 'running') {
      try {
        const dummyBuffer = ctx.createBuffer(1, 1, 22050);
        const dummySrc = ctx.createBufferSource();
        dummySrc.buffer = dummyBuffer;
        dummySrc.connect(ctx.destination);
        dummySrc.start(0);
      } catch {}
    }
    const ok = Boolean(ctx && ctx.state === 'running');
    onStateChange?.(ctx?.state || 'closed');
    // Após resumir com sucesso, reseta o proximo para que o áudio comece do agora
    if (ok && proximo > 0 && proximo < ctx.currentTime) {
      proximo = 0; // Força reset na próxima chamada de agendar
    }
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
    streamDest = null;
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
    getMediaStreamTrack: () => streamDest?.stream?.getAudioTracks()?.[0] || null,
    getMediaStream: () => streamDest?.stream || null,
    setVolume,
    setLatencyMode,
    getAudioClock,
    temSom: () => tocou,
    getLag: () => lastLagMs,
    getUnderruns: () => underrunCount,
    getChunksReceived: () => chunksReceivedCount,
    // Reseta o ponteiro de agendamento para forçar retomada imediata após unlock
    _resetClock: () => { proximo = 0; },
  };
}
