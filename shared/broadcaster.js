import { iceServers, criarPeer, ajustarEnvio, suportaWebRTC, MORTO } from './rtc.js';
import { createIntervalTracker, createValueTracker } from './pacing-metrics.js';
import {
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  validateQualityConfig,
  RESOLUTION_OPTIONS,
  FPS_OPTIONS,
  MIN_BITRATE,
  MAX_BITRATE,
} from './quality-presets.js';

export {
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  validateQualityConfig,
  RESOLUTION_OPTIONS,
  FPS_OPTIONS,
  MIN_BITRATE,
  MAX_BITRATE,
};

/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Módulo compartilhado entre a Activity (captura dentro do modal, quando o
 * Discord permite) e a página de captura externa (quando não permite). Uma
 * implementação só — duas cópias divergiriam na primeira correção.
 *
 * Sem MediaRecorder porque o container impõe piso de latência: WebCodecs
 * codifica quadro a quadro e envia direto pelo relay.
 *
 * Por cima disso, cada espectador ganha uma tentativa de conexão direta por
 * WebRTC (veja rtc.js). Quando ela fecha, o vídeo daquele espectador para de
 * passar pelo relay e passa a sair daqui num transporte que sabe descartar
 * quadro atrasado em vez de enfileirar. Quando não fecha, nada muda — o
 * caminho abaixo continua sendo o mesmo de sempre, e é ele que garante que
 * ninguém fica sem imagem por causa de um NAT.
 */

/**
 * Níveis do H.264, do mais baixo ao mais alto, com os dois tetos que decidem.
 *
 * Nome de codec do H.264 carrega o nível nos dois últimos dígitos, e nível não
 * é enfeite: é um contrato sobre o tamanho do quadro e sobre quantos
 * macroblocos por segundo o decodificador precisa aguentar. Pedir um nível que
 * não cabe faz o navegador recusar a configuração inteira — e, no nosso caso,
 * cair em VP8, que a 1080p não tem encoder por hardware em máquina nenhuma
 * comum e derruba a taxa de quadros pela metade.
 *
 * Este arquivo pediu `avc1.42E01E` — nível 3.0 — desde sempre. Nível 3.0 aguenta
 * 1620 macroblocos por quadro, uns 720×576. Uma tela 1080p tem 8160. O H.264
 * nunca esteve disponível para compartilhamento de tela; só para câmera, que
 * captura pequeno o bastante para caber. Ninguém tinha por que desconfiar,
 * porque a transmissão funcionava — só que em software.
 */
const NIVEIS_H264 = [
  { nivel: 0x1e, maxFS: 1620, maxMBPS: 40500 }, // 3.0
  { nivel: 0x1f, maxFS: 3600, maxMBPS: 108000 }, // 3.1
  { nivel: 0x20, maxFS: 5120, maxMBPS: 216000 }, // 3.2
  { nivel: 0x28, maxFS: 8192, maxMBPS: 245760 }, // 4.0 — 1080p30 cabe raspando
  { nivel: 0x2a, maxFS: 8704, maxMBPS: 522240 }, // 4.2 — 1080p60 pede este
  { nivel: 0x32, maxFS: 22080, maxMBPS: 589824 }, // 5.0
  { nivel: 0x33, maxFS: 36864, maxMBPS: 983040 }, // 5.1
  { nivel: 0x34, maxFS: 36864, maxMBPS: 2073600 }, // 5.2
];

/**
 * Perfis, do que comprime melhor ao que tem encoder em mais lugares.
 *
 * High entrega mais imagem no mesmo bitrate e é acelerado por hardware em
 * qualquer GPU desta década. Baseline fica por último como rede de segurança:
 * é o que roda onde nada mais roda.
 */
const PERFIS_H264 = ['6400', '4d40', '42e0'];

/** O menor nível que aguenta este quadro nesta taxa. */
export function nivelH264(width, height, fps) {
  const macroblocos = Math.ceil(width / 16) * Math.ceil(height / 16);
  const porSegundo = macroblocos * fps;
  const cabe = NIVEIS_H264.find((n) => macroblocos <= n.maxFS && porSegundo <= n.maxMBPS);
  // Acima de 5.2 não existe nível para pedir; deixa o navegador recusar e o
  // VP8 assumir, que é melhor que montar um nome de codec inválido.
  return (cabe ?? NIVEIS_H264.at(-1)).nivel;
}

/** Troca o nível de um nome de codec H.264. Devolve os outros intactos. */
function comNivel(codec, nivel) {
  if (!codec?.startsWith('avc1.') || codec.length !== 11) return codec;
  return codec.slice(0, 9) + nivel.toString(16).padStart(2, '0');
}

/**
 * Os codecs a tentar, nesta ordem, para este quadro e esta taxa.
 *
 * H.264 primeiro porque quase sempre tem encoder por hardware; VP8 e VP9 são a
 * saída para quem não tem H.264 nenhum. `annexb` vem antes de cada perfil
 * porque dispensa o blob `description`, e o avcC é aceito onde annexb não é.
 */
function candidatos(width, height, fps) {
  const nivel = nivelH264(width, height, fps).toString(16).padStart(2, '0');
  const h264 = PERFIS_H264.flatMap((perfil) => {
    const codec = `avc1.${perfil}${nivel}`;
    return [{ codec, avc: { format: 'annexb' } }, { codec }];
  });
  return [...h264, { codec: 'vp8' }, { codec: 'vp09.00.10.08' }];
}

/**
 * Quão longe da marca da grade um quadro ainda serve para aquela marca.
 *
 * Meio intervalo para cada lado, e meio não é chute: é a maior tolerância que
 * ainda escolhe um quadro só por marca. Mais que isso e dois quadros disputam
 * a mesma vaga; menos e o tremor normal da captura passa a derrubar quadro bom.
 *
 * Este número já foi 15% do intervalo, e foi um erro caro. A 30 fps sobravam
 * 5 ms de folga e ninguém via nada; a 60 fps sobravam 2,5 — menos que o tremor
 * da própria captura de tela. O freio passou a derrubar quadros ao acaso, e a
 * taxa virou cara ou coroa entre 60 e 30. Era isso que fazia 60 fps tremer.
 */
const TOLERANCIA_GRADE = 0.5;

/**
 * Salto que denuncia relógio de origem novo, em intervalos.
 *
 * Trocar de tela, ou uma aba que dormiu e voltou, traz timestamps de outra
 * régua. Quatro intervalos é mais que qualquer engasgo de rede e menos que
 * qualquer troca de fonte de verdade.
 */
const GRADE_PERDIDA = 4;

// Keyframe periódico: seguro contra desync quando nenhum espectador novo entra.
const KEYFRAME_EVERY_MS = 8000;

// Tipos do primeiro byte útil de cada pacote. O áudio anda pelo mesmo socket e
// pelo mesmo cabeçalho do vídeo: um canal só, um formato só, e o servidor
// continua repassando o buffer sem precisar abrir nada.
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;

// 96 kbps em Opus estéreo é transparente para som de aplicativo e de vídeo, e é
// ruído perto dos megabits do vídeo — não vale economizar aqui.
const AUDIO_BITRATE = 96_000;

// Presets de qualidade são importados e re-exportados de ./quality-presets.js

// Escada de adaptação com prioridade em FLUIDEZ (preserva 60 FPS o máximo possível)
export const ADAPTIVE_LADDER_FLUIDEZ = [
  {
    level: 0,
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 8_000_000,
    label: '1080p 60 FPS • 8.0 Mbps',
  },
  {
    level: 1,
    width: 1600,
    height: 900,
    fps: 60,
    bitrate: 6_000_000,
    label: '900p 60 FPS • 6.0 Mbps',
  },
  {
    level: 2,
    width: 1280,
    height: 720,
    fps: 60,
    bitrate: 4_500_000,
    label: '720p 60 FPS • 4.5 Mbps',
  },
  {
    level: 3,
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 5_000_000,
    label: '1080p 30 FPS • 5.0 Mbps',
  },
  {
    level: 4,
    width: 1600,
    height: 900,
    fps: 30,
    bitrate: 4_000_000,
    label: '900p 30 FPS • 4.0 Mbps',
  },
  {
    level: 5,
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_000_000,
    label: '720p 30 FPS • 2.0 Mbps',
  },
];

// Escada de adaptação com prioridade em QUALIDADE (preserva resolução de tela o máximo possível)
export const ADAPTIVE_LADDER_QUALIDADE = [
  {
    level: 0,
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 8_000_000,
    label: '1080p 60 FPS • 8.0 Mbps',
  },
  {
    level: 1,
    width: 1920,
    height: 1080,
    fps: 45,
    bitrate: 6_500_000,
    label: '1080p 45 FPS • 6.5 Mbps',
  },
  {
    level: 2,
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 5_000_000,
    label: '1080p 30 FPS • 5.0 Mbps',
  },
  {
    level: 3,
    width: 1600,
    height: 900,
    fps: 30,
    bitrate: 4_000_000,
    label: '900p 30 FPS • 4.0 Mbps',
  },
  {
    level: 4,
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_000_000,
    label: '720p 30 FPS • 2.0 Mbps',
  },
];

// Teto de resolução: acima disso banda e CPU disparam sem ganho de legibilidade.
// A imagem é reduzida proporcionalmente, nunca cortada.
const MAX_W = 1920;
const MAX_H = 1080;

const even = (n) => Math.max(2, n - (n % 2));

export function fitWithin(w, h, maxW = MAX_W, maxH = MAX_H) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

/**
 * Restrições do som capturado junto com a tela.
 *
 * Os tratamentos de voz ficam desligados: eles existem para microfone e, em som
 * de aplicativo, cortam justamente o que se queria ouvir.
 */
export function restricoesDeSom() {
  const c = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio) {
    c.restrictOwnAudio = true;
  }
  return c;
}

/**
 * Opções da captura de tela.
 *
 * Exportada porque a prévia da página de captura precisa pedir exatamente o
 * mesmo. Um stream aberto com opções diferentes não serve para transmitir
 * depois: sem faixa de som, ligar o som exigiria escolher a tela de novo — e
 * abrir o seletor duas vezes para o mesmo compartilhamento é o que a prévia
 * existe para evitar.
 *
 * windowAudio: 'window' pede o som da janela escolhida em vez de só o da aba,
 * que é o que destrava transmitir um jogo com o som dele.
 */
export function opcoesTela({ fps = 60, width, height, comSom = false, video } = {}) {
  const targetFps = Number(fps) || 60;
  const targetWidth = Number(width) || (targetFps === 60 ? 1920 : 1600);
  const targetHeight = Number(height) || (targetFps === 60 ? 1080 : 900);
  const opts = {
    video: video ?? {
      frameRate: { ideal: targetFps, max: targetFps },
      width: { ideal: targetWidth, max: 3840 },
      height: { ideal: targetHeight, max: 2160 },
    },
    audio: comSom ? restricoesDeSom() : false,
  };
  if (comSom) {
    opts.windowAudio = 'window';
    opts.systemAudio = 'exclude';
  }
  return opts;
}

/**
 * Motivo pelo qual este navegador não consegue transmitir nada, ou null.
 *
 * Só o que vale para as duas fontes. O que cada uma precisa é pergunta de cada
 * uma — ver `fonteIndisponivel` —, senão faltar `getDisplayMedia` derrubaria
 * também a câmera, que não depende dele.
 */
export function supportError({ requireChromium = false } = {}) {
  if (!window.VideoEncoder || !window.VideoFrame || !window.EncodedVideoChunk) {
    return 'Este navegador não tem WebCodecs, necessário para transmitir. Use Chrome, Edge ou outro navegador Chromium no desktop.';
  }
  // Exigência de produto, não de capacidade: o caminho via <video> funciona em
  // Firefox e Safari, mas a captura sai visivelmente pior.
  if (requireChromium && !window.MediaStreamTrackProcessor) {
    return 'Transmitir exige um navegador Chromium — Chrome, Edge, Brave ou Opera. Nos outros a captura fica com qualidade ruim, então está desabilitada. Você continua podendo assistir.';
  }
  return null;
}

/**
 * Motivo pelo qual esta fonte não pode ser capturada aqui, ou null.
 *
 * Separado do `supportError` porque as duas dependem de APIs diferentes: um
 * celular não tem `getDisplayMedia` e tem `getUserMedia`, e derrubar a página
 * inteira por causa da tela tirava dele a câmera, que funcionaria.
 */
export function fonteIndisponivel(fonte) {
  if (fonte === 'camera') {
    return navigator.mediaDevices?.getUserMedia
      ? null
      : 'Este navegador não permite acesso à câmera.';
  }
  return navigator.mediaDevices?.getDisplayMedia
    ? null
    : 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl        endpoint do relay, com o token de transmissor
 * @param {string} [opts.preset]     'automatico' | 'economia' | 'equilibrado' | 'alta' | 'maxima' | 'personalizado'
 * @param {'fluidez'|'qualidade'} [opts.priority] prioridade de adaptação
 * @param {number} [opts.bitrate]    bits por segundo (quando personalizado)
 * @param {number} [opts.fps]        taxa de quadros alvo (quando personalizado)
 * @param {boolean} [opts.audio]     capturar também o som do computador
 * @param {'tela'|'camera'} [opts.fonte]  de onde vem o vídeo
 * @param {(info:object)=>void} [opts.onStatus]  codec/resolução/caminho de captura
 * @param {(stats:object)=>void} [opts.onStats]  estatísticas detalhadas de transmissão
 * @param {(reason:string)=>void} [opts.onEnd]   encerrou (por qualquer motivo)
 * @param {(msg:string)=>void} [opts.onAviso]    algo mudou sem ser erro
 */
export function createBroadcaster(opts) {
  const {
    wsUrl,
    apiBase = '',
    preset = 'automatico',
    priority = 'fluidez',
    bitrate: rawBitrate,
    fps: rawFps,
    audio = false,
    fonte = 'tela',
    streamPronto = null,
    deviceId = null,
    maxReconnectAttempts = 5,
    onStatus,
    onStats,
    onEnd,
    onAviso,
  } = opts;

  let currentPreset = preset;
  if (!opts.preset && (opts.bitrate !== undefined || opts.fps !== undefined)) {
    currentPreset = 'personalizado';
  }

  let currentPriority = priority;
  let currentLadder =
    currentPriority === 'qualidade' ? ADAPTIVE_LADDER_QUALIDADE : ADAPTIVE_LADDER_FLUIDEZ;
  let adaptiveLevel = 0;
  let overloadCount = 0;
  let stableCount = 0;
  let cooldownSec = 0;
  let adaptiveReason = '';
  let bitrate;
  let fps;
  let targetWidth;
  let targetHeight;

  // Determina taxa, bitrate e dimensões iniciais
  if (
    currentPreset &&
    QUALITY_PRESETS[currentPreset] &&
    !QUALITY_PRESETS[currentPreset].isCustom &&
    !QUALITY_PRESETS[currentPreset].isAuto
  ) {
    bitrate = QUALITY_PRESETS[currentPreset].bitrate;
    fps = QUALITY_PRESETS[currentPreset].fps;
    targetWidth = QUALITY_PRESETS[currentPreset].width;
    targetHeight = QUALITY_PRESETS[currentPreset].height;
  } else if (currentPreset === 'automatico') {
    bitrate = currentLadder[0].bitrate;
    fps = currentLadder[0].fps;
    targetWidth = currentLadder[0].width;
    targetHeight = currentLadder[0].height;
  } else {
    const customConfig = validateQualityConfig({
      preset: 'personalizado',
      resolution: opts.resolution || opts.res,
      width: opts.width,
      height: opts.height,
      fps: rawFps ?? opts.fps,
      bitrate: rawBitrate ?? opts.bitrate,
    });
    bitrate = customConfig.bitrate;
    fps = customConfig.fps;
    targetWidth = customConfig.width;
    targetHeight = customConfig.height;
  }

  let ws = null;
  let stream = null;
  let encoder = null;
  let reader = null;
  let audioEncoder = null;
  let audioReader = null;
  let somBloqueado = false;
  let video = null;
  let config = null;
  let stage = null;
  let stageCtx = null;

  const peers = new Map(); // peerId -> RTCPeerConnection
  let enviarChunks = true;
  let configEnviada = false;

  let running = false;
  let mySlot = 0;
  let wantKeyframe = true;
  let lastKeyframeAt = 0;
  let srcW = 0;
  let srcH = 0;
  let proximaMarca = null;
  let afogado = false;

  let capturePath = 'UNKNOWN';
  let framesRead = 0;
  let lastTrackSettings = {};
  let lastTrackCapabilities = null;

  // Contadores e métricas de desempenho e ritmo de quadros (Frame Pacing) em tempo real (300 quadros para histograma)
  const captureTracker = createIntervalTracker(300);
  const encoderInputTracker = createIntervalTracker(120);
  const encoderOutputTracker = createIntervalTracker(120);
  const encodeDurationTracker = createValueTracker(120);
  const encodeQueueTracker = createValueTracker(120);
  const encoderToSendDelayTracker = createValueTracker(120);

  let framesEntrada = 0;
  let framesInputToEncoder = 0;
  let framesEncoded = 0;
  let framesSent = 0;
  let droppedBeforeEncode = 0;
  let droppedPressure = 0;
  let droppedNetworkFrames = 0;

  let keyframeChunksCount = 0;
  let keyframeBytesTotal = 0;
  let deltaChunksCount = 0;
  let deltaBytesTotal = 0;

  let ultimoTsMs = null;

  let videoBytesEncoded = 0;
  let audioBytesEncoded = 0;
  let totalBytesSent = 0;
  let lastStatsTime = performance.now();

  const encodeSamples = [];
  let avgEncodeDurationMs = 0;
  let p95EncodeDurationMs = 0;
  let lastEncodeStart = 0;

  let startedAt = 0;
  let viewers = 0;
  let statsTimer = null;

  function updateEncodeTiming(duration) {
    encodeSamples.push(duration);
    if (encodeSamples.length > 60) encodeSamples.shift();
    const sorted = [...encodeSamples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    avgEncodeDurationMs = sorted.length ? sum / sorted.length : 0;
    const p95Idx = Math.floor(sorted.length * 0.95);
    p95EncodeDurationMs = sorted.length ? sorted[Math.min(sorted.length - 1, p95Idx)] : 0;
  }

  function classifyLimiter() {
    const targetFps = fps;
    const trackFps =
      stream?.getVideoTracks()[0]?.getSettings?.()?.frameRate ?? lastTrackSettings.frameRate;

    if (trackFps && trackFps <= 31 && targetFps >= 50) {
      return 'SOURCE_30FPS';
    }
    if (framesRead >= targetFps * 0.85 && framesInputToEncoder < targetFps * 0.7) {
      return 'APPLICATION_THROTTLE';
    }
    if (
      framesEntrada < targetFps * 0.7 &&
      (encoder?.encodeQueueSize ?? 0) === 0 &&
      avgEncodeDurationMs < 16
    ) {
      return 'SOURCE_30FPS';
    }
    if (encoder && ((encoder.encodeQueueSize ?? 0) > 2 || avgEncodeDurationMs > 20)) {
      return 'ENCODER';
    }
    if (ws && (ws.bufferedAmount ?? 0) > 1_000_000) {
      return 'NETWORK';
    }
    return 'NONE';
  }

  function classifyHealth() {
    const targetFps = fps;
    const wsBuf = ws?.bufferedAmount ?? 0;
    const qStats = encodeQueueTracker.getStats();
    const encOutStats = encoderOutputTracker.getStats();

    if (
      framesEncoded >= targetFps * 0.9 &&
      wsBuf < 150_000 &&
      avgEncodeDurationMs < 16 &&
      (encOutStats.p95 <= 25 || targetFps < 50)
    ) {
      return 'Excelente';
    }
    if (framesEncoded >= targetFps * 0.8 && wsBuf < 600_000 && encOutStats.p95 <= 35) {
      return 'Boa';
    }
    if (
      framesEntrada >= targetFps * 0.8 &&
      (framesEncoded < targetFps * 0.7 ||
        avgEncodeDurationMs > 25 ||
        qStats.p95 > 2 ||
        encOutStats.p95 > 45)
    ) {
      return 'Limitada pelo PC';
    }
    if (framesEntrada < targetFps * 0.7) {
      return 'Limitada pela captura';
    }
    if (wsBuf > 1_000_000 || droppedNetworkFrames > 0) {
      return 'Limitada pela rede';
    }
    return 'Boa';
  }

  function applyAdaptiveLevel() {
    const target = currentLadder[adaptiveLevel];
    fps = target.fps;
    bitrate = target.bitrate;
    proximaMarca = null;
    afogado = false;

    if (encoder?.state === 'configured') {
      config = { ...config, bitrate, framerate: fps };
      try {
        encoder.configure(config);
        wantKeyframe = true;
      } catch (err) {
        console.warn('[adaptive encoder configure]', err.message);
      }
    }

    stream
      ?.getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: fps, max: fps } })
      .catch(() => {});
    for (const pc of peers.values()) ajustarEnvio(pc, { bitrate, fonte, fps });
  }

  async function start() {
    stream = streamPronto ?? (fonte === 'camera' ? await capturarCamera() : await capturarTela());

    const track = stream.getVideoTracks()[0];
    if (!track) {
      cleanup();
      throw new Error('Nenhuma faixa de vídeo encontrada na captura.');
    }

    // Motion contentHint destrava Chromium para 60 FPS em captura de tela e jogos
    track.contentHint = 'motion';
    track.addEventListener('ended', () =>
      stop(
        fonte === 'camera'
          ? 'A câmera foi desligada.'
          : 'Você parou o compartilhamento pelo navegador.',
      ),
    );

    // Aplica constraints explicitamente na faixa para assegurar que o capturador do Chromium opere na taxa desejada
    try {
      await track.applyConstraints({ frameRate: { ideal: fps, max: fps } });
    } catch (err) {
      console.warn('[track.applyConstraints ideal+max error, tentando fallback]', err?.message);
      try {
        await track.applyConstraints({ frameRate: fps });
      } catch (fallbackErr) {
        console.warn('[track.applyConstraints fallback error]', fallbackErr?.message);
      }
    }

    const s = track.getSettings();
    lastTrackSettings = s || {};
    lastTrackCapabilities =
      typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;

    console.info('[CAPTURE TRACK READY]', {
      width: s.width,
      height: s.height,
      frameRate: s.frameRate,
      displaySurface: s.displaySurface,
      resizeMode: s.resizeMode,
      capabilities: lastTrackCapabilities
        ? {
            frameRateMin: lastTrackCapabilities.frameRate?.min,
            frameRateMax: lastTrackCapabilities.frameRate?.max,
          }
        : null,
    });

    const target = fitWithin(s.width ?? 1280, s.height ?? 720);

    config = await pickConfig(target.width, target.height);
    if (!config) {
      cleanup();
      throw new Error('Nenhum codec de vídeo suportado por este navegador.');
    }

    await connect();

    encoder = new VideoEncoder({
      output: onEncoded,
      error: (err) => stop(`Erro no encoder: ${err.message}`),
    });
    encoder.configure(config);

    ws.send(JSON.stringify({ type: 'start' }));

    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    srcW = 0;
    srcH = 0;
    startedAt = Date.now();
    lastStatsTime = performance.now();

    onStatus?.({
      codec: config.codec,
      width: config.width,
      height: config.height,
      direct: Boolean(typeof window !== 'undefined' && window.MediaStreamTrackProcessor),
    });

    statsTimer = setInterval(() => {
      const now = performance.now();
      const elapsedSec = Math.max(0.1, (now - lastStatsTime) / 1000);
      lastStatsTime = now;

      if (cooldownSec > 0) cooldownSec--;

      const capStats = captureTracker.getStats();
      const encInStats = encoderInputTracker.getStats();
      const encOutStats = encoderOutputTracker.getStats();
      const qStats = encodeQueueTracker.getStats();
      const encDurStats = encodeDurationTracker.getStats();
      const sendDelayStats = encoderToSendDelayTracker.getStats();

      // Controle adaptativo de qualidade
      if (currentPreset === 'automatico' && running) {
        const targetFps = currentLadder[adaptiveLevel].fps;
        const isOverloaded =
          (framesEncoded < targetFps * 0.7 && framesEntrada >= targetFps * 0.8) ||
          (encoder?.encodeQueueSize ?? 0) > 3 ||
          qStats.p95 > 2.5 ||
          (encOutStats.p95 > 45 && targetFps >= 50) ||
          avgEncodeDurationMs > 25 ||
          (ws?.bufferedAmount ?? 0) > 2 * 1024 * 1024;

        const isStable =
          framesEncoded >= targetFps * 0.95 &&
          avgEncodeDurationMs < 14 &&
          (encoder?.encodeQueueSize ?? 0) <= 1 &&
          qStats.p95 <= 1 &&
          (encOutStats.p95 <= 25 || targetFps < 50) &&
          (ws?.bufferedAmount ?? 0) < 256 * 1024;

        if (isOverloaded) {
          overloadCount++;
          stableCount = 0;
          if (overloadCount >= 5 && cooldownSec === 0 && adaptiveLevel < currentLadder.length - 1) {
            adaptiveLevel++;
            cooldownSec = 15;
            overloadCount = 0;
            adaptiveReason = 'Ajustado automaticamente para manter a fluidez da transmissão.';
            applyAdaptiveLevel();
          }
        } else if (isStable) {
          stableCount++;
          overloadCount = 0;
          if (stableCount >= 20 && cooldownSec === 0 && adaptiveLevel > 0) {
            adaptiveLevel--;
            cooldownSec = 20;
            stableCount = 0;
            adaptiveReason = 'Restaurando qualidade após período de estabilidade.';
            applyAdaptiveLevel();
          }
        } else {
          overloadCount = Math.max(0, overloadCount - 1);
          stableCount = Math.max(0, stableCount - 1);
        }
      }

      const encodedBitrateBps = Math.round((videoBytesEncoded * 8) / elapsedSec);
      const sentTotalBitrateBps = Math.round((totalBytesSent * 8) / elapsedSec);
      const trackSettings = stream?.getVideoTracks()[0]?.getSettings?.() ?? lastTrackSettings;
      const targetLevel =
        currentPreset === 'automatico'
          ? currentLadder[0]
          : { fps, bitrate, width: config?.width, height: config?.height };

      const avgKeyframeSize =
        keyframeChunksCount > 0 ? Math.round(keyframeBytesTotal / keyframeChunksCount) : 0;
      const avgDeltaSize =
        deltaChunksCount > 0 ? Math.round(deltaBytesTotal / deltaChunksCount) : 0;

      onStats?.({
        viewers,
        preset: currentPreset,
        isAuto: currentPreset === 'automatico',
        adaptiveLevel,
        target: {
          fps: targetLevel.fps,
          bitrate: targetLevel.bitrate,
          width: targetLevel.width ?? config?.width,
          height: targetLevel.height ?? config?.height,
          label: `${targetLevel.width ?? 1920}×${targetLevel.height ?? 1080} • ${targetLevel.fps} FPS • ${(targetLevel.bitrate / 1e6).toFixed(1)} Mbps`,
        },
        current: {
          fps,
          bitrate,
          width: config?.width,
          height: config?.height,
          label: `${config?.width ?? 1280}×${config?.height ?? 720} • ${fps} FPS • ${(bitrate / 1e6).toFixed(1)} Mbps`,
        },
        capture: {
          requestedFps: targetLevel.fps,
          trackFps: trackSettings.frameRate ?? fps,
          capturedFps: framesEntrada,
          framesRead,
          framesSkipped: droppedBeforeEncode,
          path: capturePath,
          width: trackSettings.width,
          height: trackSettings.height,
          surface: trackSettings.displaySurface ?? 'screen',
          avgIntervalMs: capStats.avg,
          p50IntervalMs: capStats.p50,
          p95IntervalMs: capStats.p95,
          p99IntervalMs: capStats.p99,
          maxIntervalMs: capStats.max,
          jitterMs: capStats.jitter,
          histogram: capStats.histogram,
          late25: capStats.late25,
          late33: capStats.late33,
          late50: capStats.late50,
        },
        encoder: {
          inputFps: framesInputToEncoder,
          outputFps: framesEncoded,
          inputGapAvgMs: encInStats.avg,
          queueSize: encoder?.encodeQueueSize ?? 0,
          queueAvg: qStats.avg,
          queueP95: qStats.p95,
          queueMax: qStats.max,
          avgEncodeMs: Math.round(avgEncodeDurationMs * 10) / 10,
          p95EncodeMs: Math.round(p95EncodeDurationMs * 10) / 10,
          maxEncodeMs: encDurStats.max,
          outputGapAvgMs: encOutStats.avg,
          outputGapP95Ms: encOutStats.p95,
          outputGapMaxMs: encOutStats.max,
          keyframesCount: keyframeChunksCount,
          avgKeyframeBytes: avgKeyframeSize,
          avgDeltaBytes: avgDeltaSize,
          droppedBeforeEncode,
          droppedPressure,
        },
        bitrate: {
          configuredBps: bitrate,
          encodedBps: encodedBitrateBps,
          sentTotalBps: sentTotalBitrateBps,
          sentVideoBps: Math.round((videoBytesEncoded * 8) / elapsedSec),
          sentAudioBps: Math.round((audioBytesEncoded * 8) / elapsedSec),
        },
        network: {
          wsBufferedBytes: ws?.bufferedAmount ?? 0,
          sentFps: framesSent,
          droppedNetworkFrames,
          encoderToSendDelayP95Ms: sendDelayStats.p95,
        },
        health: classifyHealth(),
        limiter: classifyLimiter(),
        reason: adaptiveReason,
        seconds: Math.floor((Date.now() - startedAt) / 1000),
        // Campos legados para compatibilidade:
        fps: framesEncoded,
        fpsEntrada: framesEntrada,
        mbps: sentTotalBitrateBps / 1e6,
      });

      // Zera contadores do intervalo
      framesEntrada = 0;
      framesInputToEncoder = 0;
      framesEncoded = 0;
      framesSent = 0;
      framesRead = 0;
      droppedBeforeEncode = 0;
      videoBytesEncoded = 0;
      audioBytesEncoded = 0;
      totalBytesSent = 0;
      captureTracker.resetWindowCounts();
      encoderInputTracker.resetWindowCounts();
      encoderOutputTracker.resetWindowCounts();
    }, 1000);

    pump(track);
    const audioTrack = prepararSom(track, stream);
    if (audioTrack) pumpAudio(audioTrack);

    return stream;
  }

  function capturarTela() {
    return navigator.mediaDevices.getDisplayMedia(opcoesCaptura());
  }

  /**
   * Câmera, sempre sem som.
   *
   * O microfone fica de fora de propósito: a voz já anda pela call do Discord,
   * com cancelamento de eco que aqui não existe. Somá-la devolveria a mesma
   * pessoa duas vezes, fora de sincronia — e o `prepararSom` nem chega a rodar,
   * porque sem faixa de áudio no stream ele retorna null.
   *
   * 720p de teto porque câmera não tem texto a preservar: acima disso é banda
   * gasta em ruído de sensor, e o teto de 1080p do `fitWithin` nem entra em
   * jogo.
   */
  function capturarCamera() {
    return navigator.mediaDevices.getUserMedia({
      video: {
        // `exact` de propósito: escolher uma câmera e receber outra porque a
        // pedida sumiu é pior que a falha, que ao menos diz o que houve.
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: fps, max: fps },
      },
      audio: false,
    });
  }

  /**
   * Restrições da captura de som.
   *
   * Os tratamentos de voz ficam desligados: existem para microfone e, em som de
   * aplicativo, cortam justamente o que se queria ouvir.
   *
   * restrictOwnAudio tira da captura o que esta própria página está tocando —
   * sem ele, quem transmite enquanto assiste a outra tela devolveria o som dela
   * de volta para a sala, em laço. É experimental, então vai sob detecção.
   */

  /**
   * Opções da captura de tela.
   *
   * `windowAudio` e `systemAudio` são membros de DisplayMediaStreamOptions —
   * irmãos de `audio` e `video`, não constraints. Dentro do objeto de `audio`,
   * que era onde `systemAudio` estava, os dois são ignorados em silêncio.
   *
   * O par pedido é sempre o mesmo, porque a superfície só se conhece depois da
   * escolha: escopar o som à janela e recusar a mistura do sistema. É o mesmo
   * veto do prepararSom, aplicado antes de o som existir — quem escolhe a tela
   * inteira volta sem faixa nenhuma, em vez de com uma que precisa ser morta.
   */
  const opcoesCaptura = (over) =>
    opcoesTela({
      fps,
      width: targetWidth,
      height: targetHeight,
      comSom: audio,
      ...over,
    });

  /**
   * Dá para confiar no som que veio junto de uma janela?
   *
   * Não existe pergunta direta: opção de captura desconhecida é ignorada sem
   * erro, e `getSupportedConstraints` não lista `windowAudio` nem `systemAudio`
   * porque nenhum dos dois é constraint. `restrictOwnAudio` é, e é bem mais
   * nova que os dois — onde ela existe, a pilha de captura é atual o bastante
   * para obedecer ao `systemAudio: 'exclude'` que sempre pedimos. E se a
   * exclusão foi obedecida, uma faixa que chegou numa janela não pode ser a
   * mistura do sistema: só sobra o som daquela janela.
   *
   * Errar para menos custa o comportamento antigo, só aba. Errar para mais
   * devolveria a call em eco — por isso a prova é a feature mais nova das três,
   * e não a mais antiga.
   */
  function somDeJanelaConfiavel() {
    return Boolean(navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio);
  }

  /**
   * Devolve a faixa de som, ou null quando ela traria a call de volta em eco.
   *
   * O nó: o som do sistema é capturado como uma mistura única. "Som da tela
   * inteira" é sempre "som do sistema INTEIRO", com a saída do Discord dentro —
   * e a call inteira se escuta, com atraso.
   *
   * Duas superfícies escapam disso. Aba, que sempre foi isolada por construção:
   * o som sai só dali e o Discord nunca entra. E janela, desde que o navegador
   * aceite escopar o som ao processo dela — é o que `windowAudio: 'window'`
   * pede em opcoesCaptura, e é o que destrava transmitir um jogo com o som do
   * jogo, que antes era impossível por aqui.
   *
   * Fora dessas duas a faixa morre aqui, antes de sair da máquina — e aí sim
   * acende o `somBloqueado`, porque veio som e ele foi barrado.
   *
   * Vir sem faixa nenhuma é silêncio, não erro: o som é sempre pedido, e é a
   * caixa "Compartilhar o áudio" do seletor que decide. Quem a deixou desmarcada
   * escolheu transmitir sem som, e avisar disso seria acusar a escolha.
   */
  function prepararSom(videoTrack, capturado) {
    if (!audio) return null;

    const faixa = capturado.getAudioTracks()[0];
    if (!faixa) return null;

    const superficie = videoTrack.getSettings?.().displaySurface;
    if (somIsolado(superficie)) {
      somBloqueado = false;
      return faixa;
    }

    faixa.stop();
    capturado.removeTrack(faixa);

    somBloqueado = true;
    onAviso?.(avisoSemSom(superficie));
    return null;
  }

  /** A superfície escolhida entrega som sem levar o Discord junto? */
  function somIsolado(superficie) {
    if (superficie === 'browser') return true;
    return superficie === 'window' && somDeJanelaConfiavel();
  }

  /** Por que o som que veio foi barrado, e por onde sair disso. */
  function avisoSemSom(superficie) {
    const saida = ' Ou use "Som de uma aba ou janela" para escolher a fonte.';

    // Janela só chega aqui quando o navegador não sabe escopar o som a ela.
    if (superficie === 'window') {
      return (
        'Este navegador não isola o som por janela, e o som do computador traria o Discord ' +
        'junto. Transmitindo sem som.' +
        saida
      );
    }
    if (superficie === 'monitor') {
      const comoLevar = somDeJanelaConfiavel()
        ? ' Compartilhe o jogo como janela para levar o som dele.'
        : '';
      return (
        'A tela inteira carrega o som do Discord junto, e a call se ouviria em eco. ' +
        'Transmitindo sem som.' +
        comoLevar +
        saida
      );
    }
    return 'Não deu para confirmar de onde vinha esse som, então ele foi removido.' + saida;
  }

  /**
   * Troca só a fonte do som, sem tocar no vídeo.
   *
   * É o que torna som e tela inteira compatíveis: o vídeo continua sendo a tela
   * escolhida e o som passa a vir de uma aba ou de uma janela, que são as
   * fontes isoladas. A segunda janela de escolha é o preço, e é um preço
   * honesto — o navegador não tem como adivinhar de qual aplicativo o som
   * deveria vir.
   */
  async function trocarSom() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const escolha = await navigator.mediaDevices.getDisplayMedia(
      opcoesCaptura({ video: true, comSom: true }),
    );

    const faixa = escolha.getAudioTracks()[0];
    const superficie = escolha.getVideoTracks()[0]?.getSettings?.().displaySurface;

    // O vídeo desta escolha não interessa: viemos só pelo som.
    escolha.getVideoTracks().forEach((t) => t.stop());

    if (!faixa) {
      escolha.getTracks().forEach((t) => t.stop());
      throw new Error(
        somDeJanelaConfiavel()
          ? 'Essa escolha veio sem som. Escolha uma aba ou a janela do aplicativo e marque "Compartilhar o áudio".'
          : 'Essa escolha veio sem som. Escolha uma aba e marque "Compartilhar o áudio da guia".',
      );
    }

    if (!somIsolado(superficie)) {
      faixa.stop();
      throw new Error(
        superficie === 'window'
          ? 'Este navegador não isola o som por janela. Escolha uma aba.'
          : 'Tela inteira traria o Discord junto e a call se ouviria. Escolha uma aba ou a janela do aplicativo.',
      );
    }

    // Encerra o laço anterior antes de abrir outro, senão os dois alimentam o
    // mesmo encoder e a fila estoura.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {
        // Fechar o que já se fechou sozinho lança; não há nada a desfazer.
      }
    }
    audioEncoder = null;

    somBloqueado = false;
    faixa.addEventListener('ended', () => onAviso?.('A fonte do som foi fechada.'));
    pumpAudio(faixa);
    return faixa;
  }

  // -------------------------------------------------------------------- áudio

  /**
   * Captura, codifica e envia o som.
   *
   * O AudioEncoder recebe os blocos no tamanho que o sistema entregar e devolve
   * pacotes Opus de 20 ms — não é preciso reagrupar nada por fora. Cada pacote
   * se decodifica sozinho, então não existe aqui o equivalente ao keyframe.
   */
  async function pumpAudio(track) {
    if (!window.AudioEncoder || !window.MediaStreamTrackProcessor) return;

    const s = track.getSettings();
    const sampleRate = s.sampleRate || 48_000;
    const numberOfChannels = Math.min(2, s.channelCount || 2);

    try {
      audioEncoder = new AudioEncoder({
        output: onAudioEncoded,
        // Som é acessório: se o encoder cair, a tela continua no ar.
        error: (err) => console.warn('[audio encoder]', err.message),
      });
      audioEncoder.configure({
        codec: 'opus',
        sampleRate,
        numberOfChannels,
        bitrate: AUDIO_BITRATE,
      });
    } catch (err) {
      console.warn('[audio encoder]', err.message);
      audioEncoder = null;
      return;
    }

    // O mesmo caminho do vídeo: quem chega depois recebe isto ao pedir a tela.
    ws?.send(
      JSON.stringify({
        type: 'audio-config',
        config: { codec: 'opus', sampleRate, numberOfChannels },
      }),
    );

    audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let dados;
      try {
        const { done, value } = await audioReader.read();
        if (done) break;
        dados = value;
      } catch {
        break;
      }

      if (audioEncoder?.state === 'configured') {
        try {
          audioEncoder.encode(dados);
        } catch (err) {
          console.warn('[audio encode]', err.message);
        }
      }
      dados.close();
    }
  }

  function onAudioEncoded(chunk) {
    if (ws?.readyState !== WebSocket.OPEN) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    audioBytesEncoded += chunk.byteLength;
    const buf = empacotar(TIPO_AUDIO, chunk.timestamp ?? 0, data);
    ws.send(buf);
    totalBytesSent += buf.byteLength;
  }

  async function pickConfig(width, height) {
    for (const candidate of candidatos(width, height, fps)) {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        for (const realtime of [true, false]) {
          for (const constante of [true, false]) {
            const cfg = { ...candidate, width, height, bitrate, framerate: fps };
            cfg.hardwareAcceleration = hw;
            if (realtime) cfg.latencyMode = 'realtime';
            if (constante) cfg.bitrateMode = 'constant';
            try {
              const { supported } = await VideoEncoder.isConfigSupported(cfg);
              if (supported) return cfg;
            } catch {
              // candidato inválido neste navegador; tenta o próximo
            }
          }
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ captura

  function pump(track) {
    if (
      typeof MediaStreamTrackProcessor !== 'undefined' ||
      (typeof window !== 'undefined' && window.MediaStreamTrackProcessor)
    ) {
      capturePath = 'TRACK_PROCESSOR';
      pumpDirect(track);
    } else {
      const hasRvfc =
        typeof HTMLVideoElement !== 'undefined' &&
        typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
      capturePath = hasRvfc ? 'VIDEO_FRAME_CALLBACK' : 'RAF_FALLBACK';
      if (!hasRvfc) {
        console.warn(
          '[RAF FALLBACK ACTIVE] MediaStreamTrackProcessor and requestVideoFrameCallback unavailable',
        );
      }
      pumpViaVideo();
    }
  }

  /** Chromium: acesso direto aos quadros, sem cópia intermediária. */
  async function pumpDirect(track) {
    const MSTProcessor =
      typeof MediaStreamTrackProcessor !== 'undefined'
        ? MediaStreamTrackProcessor
        : window.MediaStreamTrackProcessor;
    reader = new MSTProcessor({ track }).readable.getReader();
    while (running) {
      let frame;
      try {
        const { done, value } = await reader.read();
        if (done) break;
        frame = value;
      } catch {
        break;
      }
      framesRead++;
      if (!encodeFrame(frame)) break;
    }
  }

  /** Demais navegadores: extrai os quadros de um <video> alimentado pela stream. */
  function pumpViaVideo() {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    Object.assign(video.style, {
      position: 'fixed',
      left: '-9999px',
      width: '2px',
      height: '2px',
      opacity: '0',
    });
    document.body.append(video);
    video.play().catch(() => {});

    const t0 = performance.now();
    const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
    const minGap = 1000 / (fps + 2);
    let lastAt = 0;

    const schedule = () => {
      if (!running) return;
      if (hasRvfc) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };

    const tick = () => {
      if (!running) return;
      if (video.paused) video.play().catch(() => {});
      if (video.readyState < 2 || !video.videoWidth) return schedule();

      const now = performance.now();
      if (!hasRvfc && now - lastAt < minGap) return schedule();
      lastAt = now;

      let frame;
      try {
        frame = new VideoFrame(video, { timestamp: (now - t0) * 1000 });
      } catch {
        return schedule();
      }
      framesRead++;
      encodeFrame(frame);
      schedule();
    };

    schedule();
  }

  function encodeFrame(frame) {
    if (!running || encoder?.state !== 'configured') {
      frame.close();
      return false;
    }

    if (!enviarChunks && configEnviada) {
      frame.close();
      return true;
    }

    const now = performance.now();
    captureTracker.sample(now);
    framesEntrada++;

    const currentQueue = encoder.encodeQueueSize;
    encodeQueueTracker.sample(currentQueue);

    // Backpressure com histerese: entra em apuros com a fila acima de 2 e só sai quando ela desce a 1
    if (currentQueue > (afogado ? 1 : 2)) {
      afogado = true;
      droppedPressure++;
      frame.close();
      return true;
    }
    afogado = false;

    // Ritmo de quadros (Frame Pacing):
    const targetIntervalMs = 1000 / fps;
    const tsMs = (frame.timestamp ?? 0) / 1000;

    if (fps < 55) {
      if (
        proximaMarca === null ||
        tsMs < proximaMarca - targetIntervalMs * GRADE_PERDIDA ||
        tsMs > proximaMarca + targetIntervalMs * GRADE_PERDIDA
      ) {
        proximaMarca = tsMs;
      }
      if (tsMs < proximaMarca - targetIntervalMs * TOLERANCIA_GRADE) {
        droppedBeforeEncode++;
        frame.close();
        return true;
      }
      proximaMarca += targetIntervalMs;
      if (proximaMarca < tsMs) proximaMarca = tsMs + targetIntervalMs;
    } else {
      if (ultimoTsMs === null || tsMs < ultimoTsMs - 1000 || tsMs > ultimoTsMs + 2000) {
        ultimoTsMs = tsMs;
      } else if (tsMs <= ultimoTsMs) {
        droppedBeforeEncode++;
        frame.close();
        return true;
      }
      ultimoTsMs = tsMs;
    }

    const timestamp = frame.timestamp ?? performance.now() * 1000;
    syncSize(frame);

    const nowWall = Date.now();
    if (nowWall - lastKeyframeAt > KEYFRAME_EVERY_MS) wantKeyframe = true;

    framesInputToEncoder++;
    encoderInputTracker.sample(now);
    lastEncodeStart = now;

    let out = frame;
    if (stage) {
      stageCtx.drawImage(frame, 0, 0, stage.width, stage.height);
      frame.close();
      out = new VideoFrame(stage, { timestamp });
    }

    try {
      encoder.encode(out, { keyFrame: wantKeyframe });
      if (wantKeyframe) {
        lastKeyframeAt = nowWall;
        wantKeyframe = false;
      }
    } catch (err) {
      console.error('[encode]', err);
    }

    out.close();
    return true;
  }

  /**
   * Mantém o encoder casado com o tamanho real da fonte.
   */
  function syncSize(frame) {
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    if (!sw || !sh || (sw === srcW && sh === srcH)) return;

    srcW = sw;
    srcH = sh;
    const target = fitWithin(sw, sh);

    if (target.width !== config.width || target.height !== config.height) {
      const anterior = config;
      config = {
        ...config,
        ...target,
        codec: comNivel(config.codec, nivelH264(target.width, target.height, fps)),
      };

      try {
        encoder.configure(config);
      } catch (err) {
        console.warn('[encoder] nivel recusado, mantendo a configuracao anterior:', err.message);
        config = anterior;
        return;
      }
      wantKeyframe = true;
      onStatus?.({
        codec: config.codec,
        width: config.width,
        height: config.height,
        direct: Boolean(window.MediaStreamTrackProcessor),
      });
    }

    if (target.width === sw && target.height === sh) {
      stage = null;
      stageCtx = null;
    } else {
      stage = document.createElement('canvas');
      stage.width = target.width;
      stage.height = target.height;
      stageCtx = stage.getContext('2d', { alpha: false, desynchronized: true });
    }
  }

  function onEncoded(chunk, metadata) {
    if (ws?.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    encoderOutputTracker.sample(now);
    framesEncoded++;

    if (lastEncodeStart > 0) {
      const dur = now - lastEncodeStart;
      encodeDurationTracker.sample(dur);
      updateEncodeTiming(dur);
    }

    if (chunk.type === 'key') {
      keyframeChunksCount++;
      keyframeBytesTotal += chunk.byteLength;
    } else {
      deltaChunksCount++;
      deltaBytesTotal += chunk.byteLength;
    }

    if (metadata?.decoderConfig) {
      ws.send(JSON.stringify({ type: 'config', config: serializeConfig(metadata.decoderConfig) }));
      configEnviada = true;
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    videoBytesEncoded += chunk.byteLength;

    const buf = empacotar(
      chunk.type === 'key' ? TIPO_KEYFRAME : TIPO_DELTA,
      chunk.timestamp ?? 0,
      data,
    );

    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      droppedNetworkFrames++;
    } else {
      const sendStart = performance.now();
      ws.send(buf);
      encoderToSendDelayTracker.sample(performance.now() - sendStart);
      framesSent++;
      totalBytesSent += buf.byteLength;
    }
  }

  /**
   * [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
   *
   * O slot vem carimbado na origem para o servidor repassar o buffer intacto, e
   * o relógio de envio é o que permite medir o atraso do outro lado. Áudio e
   * vídeo compartilham o formato: o tipo é a única coisa que os distingue.
   */
  function empacotar(tipo, timestamp, data) {
    const buf = new ArrayBuffer(18 + data.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, mySlot);
    view.setUint8(1, tipo);
    view.setFloat64(2, timestamp);
    view.setFloat64(10, Date.now());
    new Uint8Array(buf, 18).set(data);
    return buf;
  }

  function serializeConfig(dc) {
    const out = { codec: dc.codec, codedWidth: dc.codedWidth, codedHeight: dc.codedHeight };
    if (dc.description) {
      const b = new Uint8Array(
        dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer,
      );
      let bin = '';
      for (const x of b) bin += String.fromCharCode(x);
      out.description = btoa(bin);
    }
    return out;
  }

  // ---------------------------------------------------------------- websocket

  let wsPingTimer = null;
  let reconnectAttempts = 0;
  let isReconnecting = false;
  let reconnectTimeout = null;

  function scheduleWsReconnect() {
    if (!running) return;
    if (maxReconnectAttempts === 0) {
      stop('Conexão com o servidor caiu.');
      return;
    }
    if (reconnectAttempts >= maxReconnectAttempts) {
      stop('Conexão com o servidor caiu após várias tentativas.');
      return;
    }
    isReconnecting = true;
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 8000);
    console.log(`[broadcaster ws] tentativa de reconexão ${reconnectAttempts}/${maxReconnectAttempts} em ${delay}ms...`);
    onAviso?.(`Reconectando ao servidor (${reconnectAttempts}/${maxReconnectAttempts})…`);

    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(async () => {
      if (!running) return;
      try {
        await connect();
        if (running && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'start' }));
          if (config) ws.send(JSON.stringify({ type: 'config', config }));
          if (audioConfig) ws.send(JSON.stringify({ type: 'audio-config', config: audioConfig }));
          wantKeyframe = true;
          onAviso?.('Conexão restabelecida com o servidor.');
        }
      } catch {
        isReconnecting = false;
        scheduleWsReconnect();
      }
    }, delay);
    reconnectTimeout.unref?.();
  }

  function connect() {
    return new Promise((resolve, reject) => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      } catch {
        // ignore
      }

      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Não foi possível falar com o servidor (timeout).'));
      }, 10_000);
      timeout.unref?.();

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        reconnectAttempts = 0;
        isReconnecting = false;

        clearInterval(wsPingTimer);
        wsPingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
          }
        }, 20_000);
        wsPingTimer.unref?.();

        resolve();
      });

      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === 'ping') {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp || Date.now() }));
          }
        } else if (msg.type === 'pong') {
          // keepalive confirmada
        } else if (msg.type === 'slot') mySlot = msg.slot;
        else if (msg.type === 'state') viewers = msg.viewers;
        // Alguém entrou na sala e precisa de um ponto de partida.
        else if (msg.type === 'need-keyframe') wantKeyframe = true;
        else if (msg.type === 'rtc-want') abrirPeer(msg.peer);
        else if (msg.type === 'rtc') receberRtc(msg.peer, msg.payload);
        else if (msg.type === 'rtc-bye') fecharPeer(msg.peer);
        // Ninguém mais depende do relay para esta transmissão (ou voltou a
        // depender). Ver a nota em encodeFrame.
        else if (msg.type === 'chunks') enviarChunks = msg.on !== false;
        else if (msg.type === 'stop-request')
          stop(msg.motivo ?? 'Transmissão encerrada pela atividade.');
        else if (msg.type === 'error') {
          if (running) stop(msg.message);
          else {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        if (!running) reject(new Error('Falha ao conectar no servidor.'));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        clearInterval(wsPingTimer);
        wsPingTimer = null;
        if (running && !isReconnecting) scheduleWsReconnect();
      });
    });
  }

  // -------------------------------------------------------------------- parar

  // ------------------------------------------------------------ ao vivo

  // ------------------------------------------------------------------ WebRTC

  function enviarRtc(peerId, payload) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'rtc', peer: peerId, payload }));
  }

  /**
   * Abre a conexão direta com um espectador e manda a oferta.
   *
   * Quem oferece é sempre este lado, porque é este lado que tem a mídia: uma
   * oferta feita por quem só recebe teria que descrever faixas que ela não tem,
   * e obrigaria a uma segunda negociação assim que as faixas chegassem.
   */
  async function abrirPeer(peerId) {
    if (!peerId || !suportaWebRTC() || !stream || peers.has(peerId)) return;

    try {
      const ice = await iceServers(apiBase);
      // O await acima é longo o bastante para a transmissão ter acabado.
      if (!running || !stream || peers.has(peerId)) return;

      const pc = criarPeer({
        ice,
        onIce: (candidate) => enviarRtc(peerId, { kind: 'ice', candidate }),
        onEstado: (estado) => {
          if (MORTO.has(estado)) fecharPeer(peerId);
        },
      });
      peers.set(peerId, pc);

      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      enviarRtc(peerId, { kind: 'offer', sdp: pc.localDescription });

      // Depois do setLocalDescription: antes dele os encodings ainda não
      // existem, e o ajuste se perderia sem erro nenhum.
      await ajustarEnvio(pc, { bitrate, fonte, fps });
    } catch (err) {
      console.warn('[rtc] oferta falhou:', err.message);
      fecharPeer(peerId);
    }
  }

  async function receberRtc(peerId, payload) {
    const pc = peers.get(peerId);
    if (!pc || !payload) return;

    try {
      if (payload.kind === 'answer' && payload.sdp) {
        await pc.setRemoteDescription(payload.sdp);
      } else if (payload.kind === 'ice' && payload.candidate) {
        await pc.addIceCandidate(payload.candidate);
      }
    } catch (err) {
      // Candidato que chega antes da descrição remota é normal e recuperável;
      // derrubar a conexão por causa dele custaria uma renegociação inteira.
      console.warn('[rtc]', err.message);
    }
  }

  function fecharPeer(peerId) {
    const pc = peers.get(peerId);
    if (!pc) return;
    peers.delete(peerId);
    try {
      pc.close();
    } catch {
      // Fechar o que já se fechou lança e não há nada a desfazer.
    }
  }

  function fecharPeers() {
    for (const peerId of [...peers.keys()]) fecharPeer(peerId);
    enviarChunks = true;
  }

  /**
   * Troca a faixa de vídeo das conexões diretas sem renegociar.
   *
   * replaceTrack não mexe no SDP: quem assiste continua na mesma conexão e só
   * vê a imagem mudar. Renegociar aqui custaria um ICE novo por espectador —
   * segundos de tela parada em troca de nada.
   */
  async function trocarNosPeers(novo) {
    for (const pc of peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== novo.kind) continue;
        try {
          await sender.replaceTrack(novo);
        } catch {
          // Navegador que não troca a faixa segue com a antiga, que morreu com
          // o stream: aquele espectador cai para o relay pelo caminho normal.
        }
      }
    }
  }

  /**
   * Troca a tela compartilhada sem derrubar a transmissão.
   *
   * A conexão, o encoder e o slot continuam os mesmos — quem assiste só vê a
   * imagem mudar, sem piscar nem reconectar.
   */
  async function changeScreen() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const fresh = await navigator.mediaDevices.getDisplayMedia(opcoesCaptura());

    const previous = stream;
    const previousReader = reader;

    stream = fresh;
    const track = fresh.getVideoTracks()[0];
    track.contentHint = 'text';
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    // Encerra o loop anterior antes de abrir outro, senão os dois disputam o
    // encoder e a fila estoura.
    reader = null;
    await previousReader?.cancel().catch(() => {});
    previous?.getTracks().forEach((t) => t.stop());

    // Zera o tamanho conhecido: a tela nova quase certamente tem outro, e é o
    // syncSize que reconfigura o encoder.
    srcW = 0;
    srcH = 0;
    wantKeyframe = true;
    // A tela nova traz o próprio relógio de captura: cobrar da grade antiga
    // derrubaria quadros por uma diferença que não significa nada.
    proximaMarca = null;
    afogado = false;

    if (video) {
      video.srcObject = fresh;
      video.play().catch(() => {});
    } else {
      pumpDirect(track);
    }

    // A tela nova traz a própria faixa de som; a antiga morreu com o stream.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    const novoAudio = prepararSom(track, fresh);
    if (novoAudio && audioEncoder) pumpAudio(novoAudio);

    await trocarNosPeers(track);
    if (novoAudio) await trocarNosPeers(novoAudio);

    return fresh;
  }

  /** Ajusta qualidade, taxa de quadros e presets com a transmissão no ar. */
  function setQuality({
    preset: nextPreset,
    priority: nextPriority,
    resolution: nextResolution,
    bitrate: nextBitrate,
    fps: nextFps,
    width: _nextWidth,
    height: _nextHeight,
  } = {}) {
    if (nextPreset && QUALITY_PRESETS[nextPreset]) {
      currentPreset = nextPreset;
      if (nextPriority) currentPriority = nextPriority;
      currentLadder =
        currentPriority === 'qualidade' ? ADAPTIVE_LADDER_QUALIDADE : ADAPTIVE_LADDER_FLUIDEZ;
      adaptiveLevel = 0;
      overloadCount = 0;
      stableCount = 0;
      cooldownSec = 0;
      adaptiveReason = '';

      if (currentPreset !== 'automatico' && currentPreset !== 'personalizado') {
        const p = QUALITY_PRESETS[currentPreset];
        nextBitrate = p.bitrate;
        nextFps = p.fps;
        targetWidth = p.width;
        targetHeight = p.height;
      } else if (currentPreset === 'personalizado') {
        const customValidated = validateQualityConfig({
          preset: 'personalizado',
          resolution: nextResolution,
          width: _nextWidth,
          height: _nextHeight,
          fps: nextFps ?? fps,
          bitrate: nextBitrate ?? bitrate,
        });
        nextBitrate = customValidated.bitrate;
        nextFps = customValidated.fps;
        targetWidth = customValidated.width;
        targetHeight = customValidated.height;
      }
    }

    if (nextBitrate) bitrate = nextBitrate;
    if (nextFps && nextFps !== fps) {
      fps = nextFps;
      proximaMarca = null;
      afogado = false;
    }

    if (encoder?.state !== 'configured') return;

    config = { ...config, bitrate, framerate: fps };
    encoder.configure(config);
    wantKeyframe = true;

    // Pedir a taxa nova à própria captura
    stream
      ?.getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: fps, max: fps } })
      .catch(() => {});

    for (const pc of peers.values()) ajustarEnvio(pc, { bitrate, fonte, fps });
  }

  const getSettings = () => ({
    preset: currentPreset,
    priority: currentPriority,
    bitrate,
    fps,
    isAuto: currentPreset === 'automatico',
    adaptiveLevel,
    target:
      currentPreset === 'automatico'
        ? currentLadder[0]
        : { fps, bitrate, width: config?.width, height: config?.height },
    current: { fps, bitrate, width: config?.width, height: config?.height },
  });

  function cleanup() {
    fecharPeers();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video?.remove();
    video = null;
  }

  function stop(reason) {
    const wasRunning = running;
    running = false;
    isReconnecting = false;

    clearInterval(wsPingTimer);
    wsPingTimer = null;
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;

    clearInterval(statsTimer);
    statsTimer = null;

    reader?.cancel().catch(() => {});
    reader = null;
    audioReader?.cancel().catch(() => {});
    audioReader = null;

    for (const e of [encoder, audioEncoder]) {
      if (e?.state === 'configured') {
        try {
          e.close();
        } catch {
          // Fechar o que já se fechou sozinho
        }
      }
    }
    encoder = null;
    audioEncoder = null;

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    }
    ws = null;

    cleanup();
    if (wasRunning) onEnd?.(reason ?? '');
  }

  return {
    start,
    stop,
    changeScreen,
    trocarSom,
    setQuality,
    getSettings,
    temSom: () => Boolean(audioEncoder),
    somBloqueado: () => somBloqueado,
    isRunning: () => running,
  };
}
