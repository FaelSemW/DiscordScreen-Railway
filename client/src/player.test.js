/**
 * O relógio do player.
 *
 * O que se testa aqui não é decodificação — é ritmo. Os quadros são capturados
 * em intervalos cravados e chegam em intervalos irregulares; a função deste
 * módulo é devolver o intervalo original na hora de desenhar. Um erro nessa
 * conta não aparece como imagem errada, aparece como solavanco, e solavanco não
 * quebra teste nenhum a menos que alguém escreva estes.
 *
 * Sem navegador: o player só chama `getContext`, `drawImage` e `requestAnimationFrame`.
 * Um canvas de mentira e um relógio na mão cobrem tudo, e cobrem mais depressa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayer } from './player.js';

const BUFFER_MS = 100;
const KEYFRAME = 1;
const DELTA = 2;

let agora = 0;
let pendentes = [];
let desenhados = [];

/** Canvas de mentira: o player só olha getContext, width/height e o retângulo. */
function canvasFalso() {
  return {
    width: 1280,
    height: 720,
    getContext: () => ({
      drawImage: (frame) => desenhados.push(Math.round(frame.timestamp / 1000)),
      fillRect: () => {},
      set fillStyle(_) {},
    }),
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
  };
}

/** Avança o relógio e roda os callbacks de animação que venceram. */
function avancar(ms, passo = 16) {
  const alvo = agora + ms;
  while (agora < alvo) {
    agora = Math.min(alvo, agora + passo);
    const rodando = pendentes;
    pendentes = [];
    for (const cb of rodando) cb(agora);
  }
}

/** Um pacote no formato do relay: [slot][tipo][timestamp][relógio][payload] */
function pacote(tipoDoQuadro, timestampMs) {
  const buffer = new ArrayBuffer(20);
  const view = new DataView(buffer);
  view.setUint8(0, 0);
  view.setUint8(1, tipoDoQuadro);
  view.setFloat64(2, timestampMs * 1000);
  view.setFloat64(10, Date.now());
  return buffer;
}

beforeEach(() => {
  agora = 1000;
  pendentes = [];
  desenhados = [];

  vi.spyOn(performance, 'now').mockImplementation(() => agora);
  globalThis.requestAnimationFrame = (cb) => {
    pendentes.push(cb);
    return pendentes.length;
  };
  globalThis.cancelAnimationFrame = () => {};

  // Decodificador de mentira: entrega o quadro na hora, que é o pior caso para
  // o agendamento — nenhum atraso de decodificação para esconder erro de conta.
  globalThis.VideoDecoder = class {
    constructor({ output }) {
      this.output = output;
      this.state = 'unconfigured';
    }
    configure() {
      this.state = 'configured';
    }
    decode(chunk) {
      this.output({
        timestamp: chunk.timestamp,
        displayWidth: 1280,
        displayHeight: 720,
        close: vi.fn(),
      });
    }
    close() {
      this.state = 'closed';
    }
  };
  globalThis.EncodedVideoChunk = class {
    constructor(init) {
      Object.assign(this, init);
    }
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function player(options = {}) {
  const p = createPlayer(canvasFalso(), { latencyMode: 'ultra-low', ...options });
  expect(p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 })).toBe(true);
  return p;
}

describe('ritmo de exibição', () => {
  it('não desenha o quadro na chegada — ele espera a vez', () => {
    const p = player();

    p.push(pacote(KEYFRAME, 0));
    avancar(BUFFER_MS - 32);

    expect(desenhados).toHaveLength(0);
  });

  it('desenha depois da espera combinada', () => {
    const p = player();

    p.push(pacote(KEYFRAME, 0));
    avancar(BUFFER_MS + 32);

    expect(desenhados).toEqual([0]);
  });

  it('devolve o intervalo da captura a quadros que chegaram irregulares', () => {
    const p = player();
    const chegadas = [0, 55, 60, 130, 133]; // rajada e buraco, como numa rede ruim
    const capturas = [0, 33, 66, 99, 132]; // cravados a 30 fps

    // Entrega tudo de uma vez respeitando a hora de chegada de cada um.
    let anterior = 0;
    capturas.forEach((ts, i) => {
      avancar(chegadas[i] - anterior);
      anterior = chegadas[i];
      p.push(pacote(i === 0 ? KEYFRAME : DELTA, ts));
    });

    // Roda até o último quadro ter a vez.
    avancar(BUFFER_MS + 132);

    expect(desenhados).toEqual(capturas);
  });

  it('reancora e desenha na hora quando o quadro perdeu a própria hora', () => {
    const p = player();
    p.push(pacote(KEYFRAME, 0));
    avancar(BUFFER_MS + 16);
    expect(desenhados).toEqual([0]);

    // A rede parou meio segundo: o próximo quadro chega muito depois da hora
    // que a referência antiga previa para ele.
    avancar(500);
    p.push(pacote(DELTA, 33));
    avancar(16);

    // Sem esperar mais nada: apareceu no mesmo instante.
    expect(desenhados).toEqual([0, 33]);
  });

  it('descarta o quadro mais velho quando a fila estoura, e fecha o que descartou', () => {
    const p = player({ latencyMode: 'ultra-low' });
    const fechados = [];
    globalThis.VideoDecoder.prototype.decode = function (chunk) {
      this.output({
        timestamp: chunk.timestamp,
        displayWidth: 1280,
        displayHeight: 720,
        close: () => fechados.push(chunk.timestamp / 1000),
      });
    };

    // Vinte quadros de uma vez, sem deixar o relógio andar: nenhum tem a vez
    // ainda, e a fila tem que se defender sozinha (filaMax: 10 em ultra-low).
    for (let i = 0; i < 20; i++) p.push(pacote(i === 0 ? KEYFRAME : DELTA, i * 33));

    // VideoFrame segura memória de GPU: descartar sem fechar trava a aba.
    expect(fechados.length).toBeGreaterThan(0);
    expect(fechados[0]).toBe(0);
  });

  it('fecha os quadros que ficaram na fila quando a transmissão para', () => {
    const p = player();
    const fechados = [];
    globalThis.VideoDecoder.prototype.decode = function (chunk) {
      this.output({
        timestamp: chunk.timestamp,
        displayWidth: 1280,
        displayHeight: 720,
        close: () => fechados.push(chunk.timestamp / 1000),
      });
    };

    p.push(pacote(KEYFRAME, 0));
    p.push(pacote(DELTA, 33));
    p.stop();

    expect(fechados).toEqual([0, 33]);
  });
});

describe('irregularidade', () => {
  it('começa sem medida, porque ainda não houve janela', () => {
    expect(player().getJitter()).toBeNull();
  });

  it('mede a distancia entre o quadro mais folgado e o mais apertado', () => {
    const p = player();

    for (let i = 0; i < 70; i++) {
      p.push(pacote(i === 0 ? KEYFRAME : DELTA, i * 33));
      const intervalo = i % 2 === 0 ? 53 : 13;
      avancar(intervalo, intervalo);
    }

    expect(p.getJitter()).toBeGreaterThanOrEqual(15);
  });
});

describe('sincronização com Áudio Master Clock', () => {
  it('alinha a renderização do vídeo ao relógio de áudio quando ativo', () => {
    let audioTsMs = 0;
    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: audioTsMs,
      mediaTimestampUs: audioTsMs * 1000,
      bufferAheadMs: 80,
      latencyMs: 30,
    });

    const p = createPlayer(canvasFalso(), { getAudioClock: fakeAudioClock });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    // Envia quadro de vídeo capturado em 100ms
    p.push(pacote(KEYFRAME, 100));

    // Áudio ainda está em 0ms (vídeo adiantado em +100ms): não deve desenhar ainda
    avancar(16);
    expect(desenhados).toHaveLength(0);

    // Áudio avança para 100ms: vídeo deve ser desenhado
    audioTsMs = 100;
    avancar(100);
    expect(desenhados).toEqual([100]);
  });

  it('renderiza quando o vídeo está ligeiramente atrasado (-60ms)', () => {
    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: 160,
      mediaTimestampUs: 160000,
      bufferAheadMs: 80,
      latencyMs: 30,
    });

    const p = createPlayer(canvasFalso(), {
      getAudioClock: fakeAudioClock,
      latencyMode: 'ultra-low',
    });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    // Quadro de 100ms chega quando áudio já está em 160ms (drift = -60ms)
    p.push(pacote(KEYFRAME, 100));
    avancar(16);
    expect(desenhados).toEqual([100]);
  });

  it('descarta quadros obsoletos (>500ms atrasados) e fecha o VideoFrame', () => {
    const fechados = [];
    globalThis.VideoDecoder.prototype.decode = function (chunk) {
      this.output({
        timestamp: chunk.timestamp,
        displayWidth: 1280,
        displayHeight: 720,
        close: () => fechados.push(chunk.timestamp / 1000),
      });
    };

    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: 1000,
      mediaTimestampUs: 1000000,
      bufferAheadMs: 80,
      latencyMs: 30,
    });

    const p = createPlayer(canvasFalso(), {
      getAudioClock: fakeAudioClock,
      latencyMode: 'ultra-low',
    });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    // Quadro de 100ms e 200ms chegam quando o áudio já está em 1000ms (drift = -900ms)
    p.push(pacote(KEYFRAME, 100));
    p.push(pacote(DELTA, 200));
    avancar(16);

    expect(fechados).toContain(100);
  });

  it('aciona hard resync e solicita keyframe quando o atraso é inaceitável (>1800ms)', () => {
    let keyframeRequested = false;
    const fakeAudioClock = () => ({
      active: true,
      mediaTimestampMs: 2500,
      mediaTimestampUs: 2500000,
      bufferAheadMs: 80,
      latencyMs: 30,
    });

    const p = createPlayer(canvasFalso(), {
      getAudioClock: fakeAudioClock,
      onNeedKeyframe: () => {
        keyframeRequested = true;
      },
      latencyMode: 'stable',
    });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    // Quadro de 100ms chega quando o áudio já está em 2500ms (drift = -2400ms)
    p.push(pacote(KEYFRAME, 100));
    avancar(16);

    expect(desenhados).toHaveLength(0);
    expect(keyframeRequested).toBe(true);
  });
});

describe('estratégia latest-frame e modos de latência', () => {
  it('em múltiplos quadros vencidos, desenha de forma suave e preserva dependências', () => {
    const p = player({ latencyMode: 'ultra-low' });
    p.push(pacote(KEYFRAME, 0));
    p.push(pacote(DELTA, 33));
    p.push(pacote(DELTA, 66));

    // Avança o relógio além do buffer inicial
    avancar(BUFFER_MS + 100, 16);

    expect(desenhados.length).toBeGreaterThan(0);
  });

  it('permite alternar modos de latência e expõe métricas completas', () => {
    const p = player();
    p.setLatencyMode('ultra-low');

    p.push(pacote(KEYFRAME, 0));
    avancar(80);

    const metrics = p.getMetrics();
    expect(metrics.latencyMode).toBe('ultra-low');
    expect(metrics.framesReceived).toBeGreaterThan(0);
    expect(metrics.sizes.video).toBe('1280×720');
    expect(metrics.pacing).toBeDefined();
    expect(metrics.pacing.renderInterval).toBeDefined();
    expect(metrics.playbackBuffer).toBeDefined();
    expect(metrics.audio).toBeDefined();
  });

  it('suaviza rajadas curtas de rede desenhando quadros em passos subsequentes de RAF', () => {
    const p = player({ latencyMode: 'ultra-low' });

    // 2 quadros chegam na mesma rajada de rede a 60 FPS (ts 0 e 16.6ms)
    p.push(pacote(KEYFRAME, 0));
    p.push(pacote(DELTA, 16.67));

    // Avança até o momento do primeiro quadro (buffer = 100ms)
    avancar(BUFFER_MS, 16.67);
    expect(desenhados).toEqual([0]);

    // Próximo RAF desenha o segundo quadro sem descartá-lo
    avancar(16.67, 16.67);
    expect(desenhados).toEqual([0, 17]);
  });

  it('audio clock offset does not stall video or trigger hard resync loop', () => {
    let mockAudioTimeMs = 50000; // Audio clock is 50 seconds offset from video timestamps
    let keyframeRequested = false;
    const p = player({
      latencyMode: 'stable',
      onNeedKeyframe: () => {
        keyframeRequested = true;
      },
      getAudioClock: () => ({
        active: true,
        mediaTimestampMs: mockAudioTimeMs,
        bufferAheadMs: 500,
      }),
    });

    // 1st keyframe arrives with 50s offset: triggers hard resync and requests keyframe
    p.push(pacote(KEYFRAME, 0));
    avancar(16);
    expect(keyframeRequested).toBe(true);

    // Sender responds with requested keyframe (also on host timeline, e.g. 16.67ms)
    p.push(pacote(KEYFRAME, 16.67));
    p.push(pacote(DELTA, 33.34));

    avancar(1000, 16.67);
    expect(desenhados.length).toBeGreaterThan(0);
  });

  it('audio clock behind video does not stall video playback', () => {
    let mockAudioTimeMs = 0; // Audio clock starts at 0 while video arrives at 50,000ms
    const p = player({
      latencyMode: 'stable',
      getAudioClock: () => ({
        active: true,
        mediaTimestampMs: mockAudioTimeMs,
        bufferAheadMs: 500,
      }),
    });

    p.push(pacote(KEYFRAME, 50000));
    p.push(pacote(DELTA, 50016.67));

    avancar(1000, 16.67);
    expect(desenhados.length).toBeGreaterThan(0);
  });
});


