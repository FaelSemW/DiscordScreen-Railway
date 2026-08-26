import './style.css';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { createPlayer } from './player.js';
import { createAudio } from './audio.js';
import { createBroadcaster } from '../../shared/broadcaster.js';
import {
  iceServers,
  criarPeer,
  suportaWebRTC,
  resumoPeer,
  MORTO,
  PRAZO_CONEXAO_MS,
} from '../../shared/rtc.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
// O Discord injeta frame_id/instance_id na URL do iframe. Sem eles, estamos
// rodando direto no navegador — modo de desenvolvimento.
const inDiscord = params.has('frame_id');

// Dentro da Activity todo tráfego precisa passar pelo proxy do Discord.
const P = inDiscord ? '/.proxy' : '';

if (typeof window !== 'undefined') {
  window.__DIAGNOSTICS = window.__DIAGNOSTICS || { fullGridRebuilds: 0, videoSizeChanges: 0 };
}

// Um decoder e um canvas por transmissor, indexados pelo slot que o servidor
// atribuiu. Os canvas vivem fora do DOM entre renderizações e são movidos para
// dentro do tile de cada pessoa — detachar não apaga o conteúdo nem invalida o
// contexto 2D, então os decoders seguem desenhando sem saber de nada.
const streams = new Map(); // slot -> { userId, canvas, player }

// Transmissões anunciadas pelo servidor, assistidas ou não. Assistir é opt-in:
// sem pedir, o servidor nem envia os quadros — a economia de banda depende
// disso, filtrar só na exibição gastaria a mesma saída.
const available = new Map(); // slot -> { userId, config }
const watching = new Set(); // slots que eu pedi para assistir

// Quem tem aba de captura aberta, segundo o servidor. É o que decide entre
// falar com a aba existente e abrir outra.
const abas = new Set();

let sdk = null;
let session = null;
let clientId = null;
let ws = null;
let participants = [];
let reconnectDelay = 1000;
let lagTimer = null;
// Transmissão nascida aqui dentro, quando o Discord permite capturar no iframe.
let myBroadcast = null;
// Volume de tudo que chega, de 0 a 1. Vale para todas as telas e sobrevive a
// trocar de sala: é preferência de quem assiste, não estado de uma transmissão.
// Zero é o mudo — um número só, em vez de dois estados que precisam concordar.
let volume = Math.min(1, Math.max(0, Number(read('volume') ?? 1)));

/**
 * Volume de cada pessoa, separado do volume geral.
 *
 * Como no Discord: o cursor do dock é o volume de tudo, e cada transmissão tem
 * o seu, guardado por pessoa e não por sessão — quem sempre chega alto demais
 * continua ajustado amanhã. O que sai no alto-falante é o produto dos dois.
 */
const volumePessoa = lerVolumes();

function lerVolumes() {
  try {
    return new Map(Object.entries(JSON.parse(read('volumePessoa') ?? '{}')));
  } catch {
    return new Map();
  }
}

const gravarVolumes = () => store('volumePessoa', JSON.stringify(Object.fromEntries(volumePessoa)));

const volumeEfetivo = (userId) => volume * (volumePessoa.get(userId) ?? 1);

/** Reaplica o volume de um stream depois de qualquer um dos dois mudar. */
function aplicarVolume(slot) {
  const s = streams.get(slot);
  if (!s) return;
  s.audio?.setVolume(volumeEfetivo(s.userId));
  // Pela conexão direta o som sai do próprio <video>, e não do decodificador
  // de áudio — o mesmo controle precisa alcançar os dois.
  if (s.video) s.video.volume = Math.min(1, volumeEfetivo(s.userId));
}
// Para onde o botão de silenciar volta. Sem isto, desmutar cairia sempre em
// 100%, ignorando o ajuste que a pessoa tinha feito.
let volumeAntes = volume || 1;
// Qual tela está no palco, e se ela ocupa tudo. Guardados fora do render
// porque a grade é reconstruída a cada mudança de estado da sala, e a escolha
// de quem assiste precisa sobreviver a isso.
let activeSlot = null;
let telaCheia = false;
// O que o link da atividade pediu: qual tela no palco e se já em tela cheia.
// Não dá para aplicar no arranque — a sala ainda não tem transmissão nenhuma, e
// o render zera a escolha justamente nesse estado. Fica guardado até a tela
// aparecer.
// Não tem prazo de propósito. Tinha, e era uma corrida perdida: se o estado da
// sala demorasse — aba aberta em segundo plano, WebSocket lento, ninguém
// transmitindo ainda — a intenção morria antes de poder ser cumprida, e a
// pessoa caía no convite que o link existia para pular. Ela se apaga sozinha ao
// ser usada, que é a única condição que importa.
let chegada = null;

// Preferências de exibição e latência
let currentFitMode = read('fitMode') || 'contain';
let currentLatencyMode = read('latencyMode') || 'stable';
let debugOverlayTimer = null;

function applyFitMode(mode) {
  currentFitMode = mode;
  store('fitMode', mode);
  const app = $('app');
  if (app) {
    app.classList.remove('fit-contain', 'fit-cover', 'fit-original');
    app.classList.add(`fit-${mode}`);
  }

  $('btnFitContain')?.classList.toggle('active', mode === 'contain');
  $('btnFitCover')?.classList.toggle('active', mode === 'cover');
  $('btnFitOriginal')?.classList.toggle('active', mode === 'original');
}

function applyLatencyMode(mode) {
  currentLatencyMode = mode;
  store('latencyMode', mode);
  const sel = $('latencySelect');
  if (sel && sel.value !== mode) sel.value = mode;

  for (const s of streams.values()) {
    s.player?.setLatencyMode(mode);
    s.audio?.setLatencyMode(mode);
  }
}

function toggleDebugOverlay() {
  const overlay = $('debugOverlay');
  if (!overlay) return;
  const isHidden = overlay.hidden;
  overlay.hidden = !isHidden;

  if (overlay.hidden) {
    clearInterval(debugOverlayTimer);
    debugOverlayTimer = null;
  } else {
    updateDebugOverlay();
    debugOverlayTimer = setInterval(updateDebugOverlay, 250);
  }
}

function updateDebugOverlay() {
  const overlay = $('debugOverlay');
  if (!overlay || overlay.hidden) return;

  const s = activeSlot !== null ? streams.get(activeSlot) : [...streams.values()][0];
  if (!s || !s.player) {
    if ($('dbg-net-pkts')) $('dbg-net-pkts').textContent = '0 / 0 fps';
    if ($('dbg-net-p50-p95-p99')) $('dbg-net-p50-p95-p99').textContent = '0 / 0 / 0 ms';
    if ($('dbg-net-max-gap')) $('dbg-net-max-gap').textContent = '0 ms';
    if ($('dbg-dec-chunks')) $('dbg-dec-chunks').textContent = '0/s · Q: 0';
    if ($('dbg-dec-fps')) $('dbg-dec-fps').textContent = '0 fps';
    if ($('dbg-dec-p50-p95-p99')) $('dbg-dec-p50-p95-p99').textContent = '0 / 0 / 0 ms';
    if ($('dbg-dec-max-gap')) $('dbg-dec-max-gap').textContent = '0 ms';
    if ($('dbg-dec-reconfig-err')) $('dbg-dec-reconfig-err').textContent = '0 / 0';
    if ($('dbg-pres-q')) $('dbg-pres-q').textContent = '0';
    if ($('dbg-pres-fps')) $('dbg-pres-fps').textContent = '0 fps';
    if ($('dbg-pres-p50-p95-p99')) $('dbg-pres-p50-p95-p99').textContent = '0 / 0 / 0 ms';
    if ($('dbg-pres-max-gap')) $('dbg-pres-max-gap').textContent = '0 ms';
    if ($('dbg-pres-drops')) $('dbg-pres-drops').textContent = '0 / 0';
    if ($('dbg-pres-drift-lat')) $('dbg-pres-drift-lat').textContent = '0 ms / 0 ms';
    if ($('dbg-pres-resync')) $('dbg-pres-resync').textContent = '0 / 0';
    if ($('dbg-raf-fps')) $('dbg-raf-fps').textContent = '0 Hz';
    if ($('dbg-raf-p50-p95-p99')) $('dbg-raf-p50-p95-p99').textContent = '0 / 0 / 0 ms';
    if ($('dbg-raf-max-gap')) $('dbg-raf-max-gap').textContent = '0 ms';
    if ($('dbg-raf-context')) $('dbg-raf-context').textContent = 'visible · focused';
    if ($('dbg-mt-tasks10s')) $('dbg-mt-tasks10s').textContent = '0 (Max: 0ms)';
    if ($('dbg-canvas-draw')) $('dbg-canvas-draw').textContent = '0.0 / 0.0 / 0.0 ms';
    if ($('dbg-canvas-res')) $('dbg-canvas-res').textContent = '— / —';
    if ($('dbg-canvas-dpr-vp')) $('dbg-canvas-dpr-vp').textContent = '1.0 / —';
    if ($('dbg-stutter-counts')) $('dbg-stutter-counts').textContent = 'A:0 B:0 C:0 D:0 E:0';
    if ($('dbg-stutter-latest')) $('dbg-stutter-latest').textContent = 'Aguardando fluxo...';
    return;
  }

  const m = s.player.getMetrics();
  const a = s.audio?.getAudioClock();
  const n = m.network || {};
  const d = m.decoder || {};
  const pr = m.presentation || {};
  const rf = m.raf || {};
  const mt = m.mainThread || {};
  const cv = m.canvas || {};
  const st = m.pacing?.stutter || {};

  const statusBadge = $('dbg-stream-status');
  if (statusBadge) {
    if (m.playbackBuffer?.state === 'LOW') {
      statusBadge.textContent = 'Buffer baixo (ajustando)';
      statusBadge.className = 'badge badge-warning';
    } else if (m.playbackBuffer?.state === 'RECOVERING') {
      statusBadge.textContent = 'Adaptando buffer contra jitter';
      statusBadge.className = 'badge badge-warning';
    } else {
      statusBadge.textContent = 'Transmissão estável';
      statusBadge.className = 'badge badge-stable';
    }
  }

  // 1. Rede
  if ($('dbg-net-pkts'))
    $('dbg-net-pkts').textContent = `${n.receiveFps ?? 0} fps · Áudio: ${a?.active ? 'Ativo' : 'Inativo'}`;
  if ($('dbg-net-p50-p95-p99'))
    $('dbg-net-p50-p95-p99').textContent = `${n.p50 ?? 0} / ${n.p95 ?? 0} / ${n.p99 ?? 0} ms`;
  if ($('dbg-net-max-gap'))
    $('dbg-net-max-gap').textContent = `${n.maxGap ?? 0} ms (Jitter: ${n.jitter ?? 0}ms)`;
  if ($('dbg-net-transport')) $('dbg-net-transport').textContent = n.transport || 'WebSocket (Relay)';

  // 2. Decodificador
  if ($('dbg-dec-chunks'))
    $('dbg-dec-chunks').textContent = `${d.chunksSubmittedSec ?? 0}/s · Fila HW: ${d.decodeQueueSize ?? 0}`;
  if ($('dbg-dec-fps')) $('dbg-dec-fps').textContent = `${d.decodeFps ?? 0} fps`;
  if ($('dbg-dec-p50-p95-p99'))
    $('dbg-dec-p50-p95-p99').textContent = `${d.p50 ?? 0} / ${d.p95 ?? 0} / ${d.p99 ?? 0} ms`;
  if ($('dbg-dec-max-gap')) $('dbg-dec-max-gap').textContent = `${d.maxGap ?? 0} ms`;
  if ($('dbg-dec-reconfig-err'))
    $('dbg-dec-reconfig-err').textContent = `${d.reconfigures ?? 0} reconfigs · ${d.errors ?? 0} erros`;

  // 3. Apresentação & Scheduler
  if ($('dbg-pres-q')) $('dbg-pres-q').textContent = String(pr.queuedFrames ?? 0);
  if ($('dbg-pres-fps')) $('dbg-pres-fps').textContent = `${pr.renderFps ?? 0} fps`;
  if ($('dbg-pres-p50-p95-p99'))
    $('dbg-pres-p50-p95-p99').textContent = `${pr.p50 ?? 0} / ${pr.p95 ?? 0} / ${pr.p99 ?? 0} ms`;
  if ($('dbg-pres-max-gap')) $('dbg-pres-max-gap').textContent = `${pr.maxGap ?? 0} ms`;
  if ($('dbg-pres-drops'))
    $('dbg-pres-drops').textContent = `${pr.droppedLate ?? 0} atraso · ${pr.droppedRecovery ?? 0} rec (Total: ${pr.droppedTotal ?? 0})`;
  if ($('dbg-pres-drift-lat'))
    $('dbg-pres-drift-lat').textContent = `Drift: ${pr.avDriftMs ?? 0}ms · E2E: ${m.streamLatency?.estimatedEndToEndMs ?? 0}ms`;
  if ($('dbg-pres-resync'))
    $('dbg-pres-resync').textContent = `Hard: ${pr.hardResyncCount ?? 0} · Soft: ${pr.softCorrectionCount ?? 0}`;

  // 4. rAF & Contexto
  if ($('dbg-raf-fps')) $('dbg-raf-fps').textContent = `${rf.rafFps ?? 0} Hz`;
  if ($('dbg-raf-p50-p95-p99'))
    $('dbg-raf-p50-p95-p99').textContent = `${rf.p50 ?? 0} / ${rf.p95 ?? 0} / ${rf.p99 ?? 0} ms`;
  if ($('dbg-raf-max-gap')) $('dbg-raf-max-gap').textContent = `${rf.maxGap ?? 0} ms`;
  if ($('dbg-raf-context'))
    $('dbg-raf-context').textContent = `${rf.visibilityState || 'visible'} · ${rf.hasFocus ? 'focused' : 'unfocused'}`;

  // 5. Main Thread & Canvas
  if ($('dbg-mt-tasks10s'))
    $('dbg-mt-tasks10s').textContent = `${mt.longTasks10s ?? 0} (Max: ${mt.longestTaskMs ?? 0}ms · Total: ${mt.totalLongTaskDurationMs ?? 0}ms)`;
  if ($('dbg-canvas-draw'))
    $('dbg-canvas-draw').textContent = `${cv.drawAvgMs ?? 0} / ${cv.drawP95Ms ?? 0} / ${cv.drawMaxMs ?? 0} ms`;
  if ($('dbg-canvas-res')) $('dbg-canvas-res').textContent = `${cv.backingRes || '—'} (CSS: ${cv.cssRes || '—'})`;
  if ($('dbg-canvas-dpr-vp')) $('dbg-canvas-dpr-vp').textContent = `DPR ${cv.dpr || 1} · VP ${cv.viewport || '—'}`;

  // 6. Stutter Classifier
  if ($('dbg-stutter-counts')) {
    const c = st.caseCounts || { A: 0, B: 0, C: 0, D: 0, E: 0 };
    $('dbg-stutter-counts').innerHTML = `<span class="badge-case-a">A:${c.A}</span> <span class="badge-case-b">B:${c.B}</span> <span class="badge-case-c">C:${c.C}</span> <span class="badge-case-d">D:${c.D}</span> <span class="badge-case-e">E:${c.E}</span>`;
  }

  if ($('dbg-stutter-latest')) {
    const hist = m.stutterEvents || [];
    if (hist.length === 0) {
      $('dbg-stutter-latest').textContent = 'Nenhum engasgo detectado na sessão.';
    } else {
      const snap = hist[0];
      const caseLabel = snap.primarySuspect ? `[${snap.primarySuspect.code}] ${snap.primarySuspect.name}` : 'Desconhecido';
      $('dbg-stutter-latest').innerHTML = `<b>${caseLabel}</b><br>RenderGap: ${snap.renderGapMs}ms · rAFGap: ${snap.rafGapMs ?? '?'}ms<br>DecGap: ${snap.decodeGapMs ?? '?'}ms · RecGap: ${snap.receiveGapMs ?? '?'}ms<br>LongTask: ${snap.longestLongTaskMs ?? 0}ms · Fila: ${snap.presentationQueueSize}`;
    }
  }
}

function getStutterLog() {
  const s = activeSlot !== null ? streams.get(activeSlot) : [...streams.values()][0];
  const m = s?.player ? s.player.getMetrics() : null;
  const a = s?.audio?.getAudioClock() ?? null;

  return {
    capturedAt: new Date().toISOString(),
    inDiscord,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'headless',
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    viewport: typeof window !== 'undefined' ? `${window.innerWidth}×${window.innerHeight}` : '1920×1080',
    activeSlot,
    availableSlots: [...available.keys()],
    streamActive: Boolean(s && s.player),
    metrics: m,
    audioClock: a
      ? {
          active: a.active,
          bufferAheadMs: Math.round(a.bufferAheadMs),
          underrunCount: a.underrunCount,
        }
      : null,
    recentStutterEvents: m?.stutterEvents || [],
  };
}

function copyStutterLog() {
  const log = getStutterLog();
  const text = JSON.stringify(log, null, 2);

  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      toast('Relatório de diagnóstico copiado para a área de transferência!');
    }).catch(() => {
      if (typeof prompt !== 'undefined') {
        prompt('Copie o relatório JSON abaixo:', text);
      } else {
        console.log('[DIAGNOSTIC_REPORT_JSON]', text);
      }
    });
  } else if (typeof prompt !== 'undefined') {
    prompt('Copie o relatório JSON abaixo:', text);
  } else {
    console.log('[DIAGNOSTIC_REPORT_JSON]', text);
  }
  return log;
}

if (typeof window !== 'undefined') {
  window.getStutterLog = getStutterLog;
  window.copyStutterLog = copyStutterLog;
}

// ------------------------------------------------------------------- helpers

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

function setEmpty(title, text) {
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
}

/** Cor estável por usuário — mesma pessoa, mesma cor, em qualquer sessão. */
function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 42%)`;
}

/**
 * Avatares passam pelo nosso próprio servidor, não pelo CDN do Discord.
 *
 * O CSP da Activity bloqueia cdn.discordapp.com, e o proxy do Discord só
 * repassa domínios mapeados no portal do desenvolvedor — sem esse mapeamento a
 * foto caía sempre nas iniciais. Pela nossa rota a URL é a mesma dentro e fora
 * da Activity, e não depende de configuração que ninguém lembra de fazer.
 */
function avatarUrl(p) {
  if (!p.avatar) return null;
  return `${P}/api/avatar/${p.id}/${p.avatar}`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
}

/** Todas as transmissões de uma pessoa — hoje até duas: a tela e a câmera. */
const slotsOf = (userId) =>
  [...available.entries()].filter(([, a]) => a.userId === userId).map(([slot]) => slot);

/**
 * O que o grid desenha: uma entrada por transmissão, mais uma por pessoa que
 * não está transmitindo.
 *
 * Antes era uma entrada por pessoa, com o slot deduzido dela. Bastava enquanto
 * ninguém podia ter duas — a partir da câmera, a segunda transmissão
 * simplesmente não aparecia, e o motivo não ficava visível em lugar nenhum.
 */
function entradasDoGrid() {
  const saida = [];
  for (const p of participants) {
    const slots = p.broadcasting ? slotsOf(p.id) : [];
    if (!slots.length) saida.push({ p, slot: null });
    else for (const slot of slots) saida.push({ p, slot });
  }
  return saida;
}

/**
 * O nó que mostra esta transmissão agora: canvas do relay ou vídeo da conexão
 * direta. Só um dos dois está no DOM por vez, e trocar de um para o outro é o
 * que a mudança de transporte faz de visível.
 */
const noDe = (s) => (s.viaRtc ? s.video : s.canvas);

/** Resolução nativa, venha de onde vier. Zero enquanto nada foi desenhado. */
function medidaDe(s) {
  if (s.viaRtc) return { w: s.video.videoWidth, h: s.video.videoHeight };
  return { w: s.canvas.width, h: s.canvas.height };
}

function watchSlot(slot) {
  const info = available.get(slot);
  if (!info) return;
  watching.add(slot);
  ws?.send(JSON.stringify({ type: 'watch', slot }));
  // O config pode já ter chegado; se não, ele chega logo e dispara o start.
  if (info.config) {
    openStream(slot, info.userId);
    startStream(slot, info.config);
  }
  renderGrid();
}

function unwatchSlot(slot) {
  watching.delete(slot);
  ws?.send(JSON.stringify({ type: 'unwatch', slot }));
  closeStream(slot);
  renderGrid();
  renderBar();
}

// --------------------------------------------------------------------- grade

/** Colunas aproximando o layout da call do Discord: quadrado, crescendo em passos. */
function columnsFor(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

// Largura da barra lateral. É preferência de quem assiste, não estado da sala —
// por isso vive no localStorage, e não no servidor.
const STRIP_DEFAULT = 300;
const STRIP_MIN = 200;
let stripW = Number(read('stripW')) || STRIP_DEFAULT;

const divider = document.createElement('div');
divider.className = 'divider';
divider.title = 'Arraste para redimensionar · duplo clique restaura';

/** Aplica a largura guardada, respeitando o teto da janela atual. */
function applyStrip() {
  // O teto acompanha a janela: uma largura guardada grande demais engoliria o
  // palco depois de alguém encolher o Discord.
  const max = Math.max(STRIP_MIN, $('grid').clientWidth * 0.45);
  const largura = `${Math.round(Math.min(max, stripW))}px`;
  $('grid').style.setProperty('--strip', largura);
  // Também no #app: a barra de controles é irmã da grade, não filha, e precisa
  // da mesma medida para se centrar no palco em vez de na janela.
  $('app').style.setProperty('--strip', largura);
}

function setStrip(px) {
  stripW = Math.max(STRIP_MIN, Math.round(px));
  applyStrip();
  store('stripW', String(stripW));
}

divider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  divider.classList.add('dragging');

  // Os ouvintes vão na janela, não no divisor: a grade é reconstruída a cada
  // mudança de estado da sala, e o arrasto não pode morrer no meio disso.
  // 21px = os 16 de padding da grade mais a meia largura do divisor.
  const move = (ev) => setStrip($('grid').getBoundingClientRect().right - ev.clientX - 21);
  const up = () => {
    divider.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

divider.addEventListener('dblclick', () => setStrip(STRIP_DEFAULT));
window.addEventListener('resize', () => inRoom() && applyStrip());

/**
 * Duas formas de mostrar a sala, e o que decide é ter alguém transmitindo.
 *
 * Sem transmissão, uma grade de pessoas — a sala de espera. Com transmissão, um
 * palco: a tela escolhida ocupa a área principal e, ao lado, ficam as outras
 * telas em cima e as pessoas embaixo. Dar a grade inteira à tela esconderia
 * quem está junto, e é a call que se perde nisso.
 */
function renderGrid() {
  if (typeof window !== 'undefined' && window.__DIAGNOSTICS) {
    window.__DIAGNOSTICS.fullGridRebuilds = (window.__DIAGNOSTICS.fullGridRebuilds || 0) + 1;
  }
  const grid = $('grid');

  // Fora de uma sala quem manda é o lobby. Sem esta guarda, o render disparado
  // pelo fechamento do WebSocket mostrava o painel "Ninguém na sala" por cima
  // da lista de salas.
  if (!inRoom()) {
    grid.hidden = true;
    $('empty').hidden = true;
    $('fullscreen').hidden = true;
    $('watchSite').hidden = true;
    $('app').classList.remove('cheia', 'flutua', 'palco');
    return;
  }

  const hasPeople = participants.length > 0;
  $('empty').hidden = hasPeople;
  grid.hidden = !hasPeople;

  const casters = participants.filter((p) => p.broadcasting);

  if (!casters.length) {
    activeSlot = null;
    telaCheia = false;
  } else if (activeSlot === null || !available.has(activeSlot)) {
    // Sempre há uma tela em destaque quando existe transmissão: chegar numa
    // sala com tela no ar e ver só avatares esconderia o que importa.
    activeSlot = entradasDoGrid().find((e) => e.slot !== null)?.slot ?? null;
  }

  // Quem chegou pelo link da atividade já pediu para assistir lá atrás: parar
  // num convite de "Assistir tela" seria cobrar o mesmo clique duas vezes.
  //
  // A tela pedida tem preferência, mas não é condição. Ela pode não vir no link
  // (atividade com bundle antigo em cache) ou não ter chegado ainda neste
  // render — e em nenhum dos dois casos vale desistir e mostrar o convite,
  // porque a escolha automática logo acima já garante uma tela válida no palco.
  //
  // Só espera enquanto não houver tela nenhuma: aí não há o que assistir, e a
  // intenção fica de pé até alguém transmitir ou o prazo dela vencer.
  if (chegada && activeSlot === null) {
    console.info('[sala] link pediu para assistir, mas ninguém está transmitindo ainda');
  }

  if (chegada && activeSlot !== null) {
    const pedida = chegada.slot;
    const alvo = pedida !== null && available.has(pedida) ? pedida : activeSlot;
    console.info('[sala] assistindo automaticamente', {
      pedida,
      alvo,
      slots: [...available.keys()],
    });
    // Zerado antes de qualquer coisa: watchSlot renderiza de novo, e a segunda
    // passada não pode reabrir este mesmo caminho.
    const cheia = chegada.cheia;
    chegada = null;

    activeSlot = alvo;
    telaCheia = cheia;
    // Adiado porque watchSlot chama renderGrid, e estamos dentro de um.
    if (!watching.has(alvo)) queueMicrotask(() => watchSlot(alvo));
  }

  const noPalco = activeSlot !== null;
  $('fullscreen').hidden = !noPalco;
  // A classe vai no #app, e não na grade: quem sai do layout são as barras, que
  // são irmãs dela. Fica acima do `return` de sala vazia — senão as barras
  // continuariam flutuando sobre o painel de "ninguém na sala".
  $('app').classList.toggle('cheia', noPalco && telaCheia);
  // Dentro da sala as barras sempre flutuam, tendo transmissão ou não: a barra
  // não deve pular de lugar quando alguém começa a transmitir, e um dock que
  // muda de posição sozinho é a mesma barra parecendo duas.
  $('app').classList.add('flutua');
  // Sumir por ócio, porém, só faz sentido com imagem embaixo — é a imagem que
  // se quer descobrir. Sobre uma grade de avatares o sumiço não revelaria nada
  // e só faria os controles parecerem quebrados.
  $('app').classList.toggle('palco', noPalco);
  $('fullscreen').classList.toggle('on', telaCheia);
  // A dica e o nome acessível andam juntos: o botão faz duas coisas conforme o
  // estado, e anunciar sempre a mesma coisa mentiria para quem usa leitor.
  const rotulo = telaCheia ? 'Sair da tela cheia' : 'Tela cheia';
  $('fullscreen').dataset.tip = rotulo;
  $('fullscreen').setAttribute('aria-label', rotulo);

  // Só em tela cheia, e só dentro do Discord: é ali que a moldura da atividade
  // aperta, e no site a pessoa já está onde o botão levaria. A dica sai daqui,
  // e não do clique, porque o palco também entra em tela cheia pelo clique no
  // tile — dois caminhos, um lugar só para avisar.
  const podeIrAoSite = inDiscord && noPalco && Boolean(origemDoSite());
  $('watchSite').hidden = !podeIrAoSite;

  if (!hasPeople) return;

  grid.classList.toggle('palco', noPalco);
  grid.classList.toggle('cheia', noPalco && telaCheia);

  // Com a lateral no ar, a contagem no topo repete o que está logo ali — e
  // custa uma faixa inteira de altura, que é o que falta para a tela. Vazia, a
  // barra de cima se recolhe sozinha.
  $('people').hidden = noPalco && !telaCheia;

  // Os canvas são reanexados abaixo; removê-los daqui não perde o conteúdo.
  grid.replaceChildren();

  if (!noPalco) {
    const entradas = entradasDoGrid();
    grid.style.setProperty('--cols', columnsFor(entradas.length));
    grid.append(...entradas.map((e) => buildTile(e.p, { slot: e.slot }).el));
    return;
  }

  const dono = available.get(activeSlot)?.userId;
  const emCena = participants.find((p) => p.id === dono) ?? {
    id: dono ?? 'desconhecido',
    name: 'Transmitindo',
    broadcasting: true,
  };
  // O slot em destaque, e não o da pessoa: cada transmissão tem um nó de canvas
  // só, então montar o palco com o slot errado o arranca do tile que o estava
  // mostrando — e um dos dois fica preto, conforme a ordem do desenho.
  grid.append(buildTile(emCena, { palco: true, slot: activeSlot }).el);

  if (telaCheia) return;

  applyStrip();
  grid.append(divider, buildSidebar());
}

/**
 * Barra lateral: as outras telas em cima, as pessoas embaixo.
 *
 * Telas primeiro porque é o que se olha; pessoas depois porque é o que se
 * confere. Cada uma no formato que merece — a tela como miniatura, a pessoa
 * como linha, que cabe muito mais gente no mesmo espaço.
 */
function buildSidebar() {
  const barra = document.createElement('aside');
  barra.className = 'sidebar';

  // Por transmissão, e não por pessoa: quem divide tela e câmera tem duas
  // miniaturas aqui, e a que está no palco é a única que não se repete.
  const outras = entradasDoGrid().filter((e) => e.slot !== null && e.slot !== activeSlot);
  if (outras.length) {
    barra.append(secaoTitulo(outras.length === 1 ? 'Outra transmissão' : 'Outras transmissões'));
    for (const e of outras) barra.append(buildTile(e.p, { slot: e.slot }).el);
  }

  barra.append(contagemPessoas());

  // semVideo é obrigatório aqui: o canvas de cada transmissão é um nó de DOM
  // só, e anexá-lo neste tile o arrancaria do palco — que ficaria preto
  // enquanto a miniatura ao lado mostrava a tela.
  const gente = document.createElement('div');
  gente.className = 'sidebar-people';
  for (const p of participants) gente.append(buildTile(p, { semVideo: true }).el);
  barra.append(gente);

  return barra;
}

function secaoTitulo(texto) {
  const t = document.createElement('h2');
  t.className = 'sidebar-title';
  t.textContent = texto;
  return t;
}

/**
 * Quantas pessoas na sala, na mesma pílula usada no resto da interface.
 *
 * Era um título em caixa alta, que gastava uma faixa inteira da lateral para
 * dizer o que um número diz — e a lateral é justamente onde falta espaço.
 */
function contagemPessoas() {
  const chip = document.createElement('div');
  chip.className = 'sidebar-count';
  chip.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
    '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  chip.append(document.createTextNode(String(participants.length)));
  chip.title =
    participants.length === 1 ? '1 pessoa na sala' : `${participants.length} pessoas na sala`;
  return chip;
}

/**
 * Um tile: a tela de quem transmite, ou o avatar de quem só assiste.
 *
 * `palco` distingue o tile em destaque dos da lateral, e é o que decide o que o
 * clique faz: no palco, alterna tela cheia; na lateral, promove aquela tela.
 *
 * `semVideo` força o avatar mesmo para quem está transmitindo. É o que permite
 * a mesma pessoa aparecer no palco e na lista de pessoas sem que os dois
 * disputem o único canvas daquela transmissão.
 */
function buildTile(p, { palco = false, semVideo = false, slot: slotDado = null } = {}) {
  // O slot é obrigatório para quem quer vídeo, e não deduzido da pessoa: com
  // duas fontes por pessoa não existe "a transmissão dela". Quem passa
  // `semVideo` quer só o avatar, e aí não há slot para acertar.
  const slot = p.broadcasting && !semVideo ? slotDado : null;
  const stream = slot !== null ? streams.get(slot) : null;
  const isMe = p.id === session?.user?.id;

  const tile = document.createElement('div');
  tile.className = p.broadcasting ? 'tile sharing' : 'tile';
  if (palco) tile.classList.add('tile-palco');
  if (slot !== null) tile.dataset.slot = String(slot);

  // Com a forma do vídeo no próprio tile, a moldura passa a abraçar a imagem.
  // Sem isto, uma tela 16:9 dentro de um palco largo e baixo encolhia até caber
  // na altura e sobrava um retângulo preto ocupando metade da área.
  const medida = stream ? medidaDe(stream) : null;
  if (palco && medida?.w) {
    tile.style.aspectRatio = `${medida.w} / ${medida.h}`;
  }

  // Sem rótulo, dois tiles da mesma pessoa lado a lado no grid não se
  // distinguem até alguém clicar em um deles.
  if (slot !== null && available.get(slot)?.fonte === 'camera') {
    const marca = document.createElement('span');
    marca.className = 'tile-fonte';
    marca.textContent = 'Câmera';
    tile.append(marca);
  }

  const aoClicar = () => {
    if (palco) telaCheia = !telaCheia;
    else activeSlot = slot;
    renderGrid();
  };

  if (stream) {
    tile.append(noDe(stream));
    tile.title = palco
      ? telaCheia
        ? 'Clique para sair da tela cheia'
        : 'Clique para ver em tela cheia'
      : 'Clique para ver em destaque';
    tile.addEventListener('click', aoClicar);
    // Botão direito para largar a tela, sem precisar caçar controle.
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTileMenu(e.clientX, e.clientY, slot, p.name);
    });

    // Entre pedir para assistir e o primeiro quadro chegar existe uma espera
    // real: sem este aviso ela é indistinguível de um travamento.
    if (!stream.started) tile.append(buildLoading());

    // O clique direito pode ser capturado pelo cliente do Discord antes de
    // chegar aqui, então o botão visível é o caminho garantido.
    const stop = document.createElement('button');
    stop.className = 'tile-stop';
    stop.dataset.tip = 'Parar de assistir';
    stop.setAttribute('aria-label', `Parar de assistir ${p.name}`);
    stop.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    stop.addEventListener('click', (e) => {
      e.stopPropagation();
      unwatchSlot(slot);
    });
    tile.append(stop);
  } else if (slot !== null) {
    // O convite tem botão próprio, que para o clique antes de chegar no tile.
    if (!palco) tile.addEventListener('click', aoClicar);
    tile.append(buildWatchPrompt(slot, p.name, isMe));
  } else {
    tile.append(buildAvatar(p));
  }

  const footer = document.createElement('div');
  footer.className = 'tile-footer';

  const badge = document.createElement('div');
  badge.className = 'tile-name';
  if (p.broadcasting) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    badge.append(dot);
  }
  badge.append(document.createTextNode(p.name));
  footer.append(badge);

  if (slot !== null) footer.append(buildWatchers(slot));
  tile.append(footer);

  if (isMe) {
    const you = document.createElement('span');
    you.className = 'tile-you';
    you.textContent = 'você';
    tile.append(you);
  }

  return { el: tile, slot };
}

/** Espera pelo primeiro quadro. Sai sozinha quando o decoder desenha. */
function buildLoading() {
  const wrap = document.createElement('div');
  wrap.className = 'tile-loading';
  wrap.innerHTML = '<span class="spinner"></span>';
  wrap.append(document.createTextNode('Conectando…'));
  return wrap;
}

/** Quantas pessoas assistem esta tela; a lista aparece ao passar o mouse. */
function buildWatchers(slot) {
  const people = available.get(slot)?.watchers ?? [];

  const badge = document.createElement('div');
  badge.className = 'tile-watchers';
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/></svg>';
  badge.append(document.createTextNode(String(people.length)));
  badge.title = people.length === 1 ? '1 pessoa assistindo' : `${people.length} pessoas assistindo`;

  const list = document.createElement('div');
  list.className = 'hover-list';

  if (!people.length) {
    const empty = document.createElement('span');
    empty.className = 'hover-empty';
    empty.textContent = 'Ninguém assistindo';
    list.append(empty);
  } else {
    for (const w of people) {
      const row = document.createElement('span');
      row.className = 'hover-row';
      row.append(buildAvatar(w));
      // textContent, nunca innerHTML: o nome vem do Discord, é conteúdo de terceiro.
      row.append(document.createTextNode(w.name));
      list.append(row);
    }
  }

  badge.append(list);
  return badge;
}

/** Tela cinza com o convite para assistir — nada é baixado até clicar. */
function buildWatchPrompt(slot, name, isMe) {
  const camera = available.get(slot)?.fonte === 'camera';
  const wrap = document.createElement('div');
  wrap.className = 'watch-prompt';

  const btn = document.createElement('button');
  btn.className = 'btn go';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v11H3z"/><path d="M8 20h8"/></svg>';
  btn.append(
    document.createTextNode(
      camera
        ? isMe
          ? 'Ver minha câmera'
          : 'Assistir câmera'
        : isMe
          ? 'Ver minha tela'
          : 'Assistir tela',
    ),
  );
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    watchSlot(slot);
  });

  const who = document.createElement('span');
  who.className = 'watch-who';
  // Ver a própria tela é conferência, não bisbilhotice: o texto precisa dizer
  // que o que está no ar é a sua, não a de outra pessoa com o seu nome.
  who.textContent = isMe
    ? 'Sua transmissão está no ar'
    : `${name} está ${camera ? 'com a câmera ligada' : 'transmitindo'}`;

  wrap.append(btn, who);
  return wrap;
}

// -------------------------------------------------------------------- perfil

function renderProfileButton() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  // A identidade vive só no cabeçalho do lobby agora: bolinha com nome.
  const name = document.createElement('span');
  name.textContent = me.name;
  $('lobbyUser').replaceChildren(buildAvatar({ ...me, id: session.user.id }), name);
  $('lobbyUser').hidden = false;
}

$('lobbyUser').addEventListener('click', openProfile);

function openProfile() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  $('profileAvatar').replaceChildren(buildAvatar({ ...me, id: session.user.id }));
  $('profileName').textContent = me.name;
  $('profileId').textContent = inDiscord ? `Discord · ${session.user.id}` : 'modo local';
  $('profileInput').value = me.name;

  $('profileModal').hidden = false;
  $('profileInput').focus();
  $('profileInput').select();
}

const closeProfile = () => {
  $('profileModal').hidden = true;
};

$('profileCancel').addEventListener('click', closeProfile);

$('profileModal').addEventListener('click', (e) => {
  if (e.target === $('profileModal')) closeProfile();
});

$('profileInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('profileSave').click();
});

$('profileSave').addEventListener('click', () => {
  const name = $('profileInput').value.replace(/\s+/g, ' ').trim().slice(0, 32);
  if (name) {
    session.user.name = name;
    storeName(name);
    ws?.send(JSON.stringify({ type: 'rename', name }));
    renderProfileButton();
  }
  closeProfile();
});

/**
 * O apelido vive no localStorage, não no servidor.
 *
 * Os acessos vão em try/catch porque dentro de um iframe de terceiro o
 * armazenamento pode estar particionado ou bloqueado — e perder o apelido é
 * bem melhor do que a sala não abrir.
 */
const storedName = () => read('displayName');
const storeName = (name) => store('displayName', name);

/** Menu de contexto do tile. Some ao primeiro clique ou tecla em qualquer lugar. */
function openTileMenu(x, y, slot, name) {
  document.querySelector('.tile-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'tile-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // O cursor só aparece onde há som para ajustar: oferecer um controle que não
  // faz nada é pior do que não oferecer nenhum.
  const stream = streams.get(slot);
  if (stream?.audio) menu.append(buildMenuVolume(stream.userId, name, slot));

  const item = document.createElement('button');
  item.textContent = `Parar de assistir ${name}`;
  item.addEventListener('click', () => {
    menu.remove();
    unwatchSlot(slot);
  });

  menu.append(item);
  document.body.append(menu);

  // Mantém o menu dentro da janela quando o clique acontece perto das bordas.
  const box = menu.getBoundingClientRect();
  if (x + box.width > window.innerWidth) menu.style.left = `${window.innerWidth - box.width - 8}px`;
  if (y + box.height > window.innerHeight)
    menu.style.top = `${window.innerHeight - box.height - 8}px`;

  // setTimeout: sem ele, o próprio clique que abriu o menu já o fecharia.
  setTimeout(() => {
    const close = (e) => {
      // pointerdown dispara ANTES do click. Sem esta guarda, clicar no item
      // removia o menu do DOM e o click nunca chegava ao botão — era por isso
      // que "parar de assistir" não fazia nada.
      if (e.type === 'pointerdown' && menu.contains(e.target)) return;
      menu.remove();
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
  }, 0);
}

/** Cursor de volume de uma pessoa, no menu do botão direito. */
function buildMenuVolume(userId, name, slot) {
  const bloco = document.createElement('div');
  bloco.className = 'menu-volume';

  const rotulo = document.createElement('span');
  rotulo.className = 'menu-volume-nome';
  // textContent, nunca innerHTML: nome vem do Discord, é conteúdo de terceiro.
  rotulo.textContent = `Volume de ${name}`;

  const linha = document.createElement('div');
  linha.className = 'menu-volume-linha';

  const barra = document.createElement('input');
  barra.type = 'range';
  barra.min = '0';
  barra.max = '200';
  barra.step = '5';
  barra.setAttribute('aria-label', `Volume de ${name}`);

  const valor = document.createElement('span');
  valor.className = 'menu-volume-valor';

  const mostrar = () => {
    valor.textContent = `${barra.value}%`;
  };

  barra.value = String(Math.round((volumePessoa.get(userId) ?? 1) * 100));
  mostrar();

  barra.addEventListener('input', () => {
    const nivel = Number(barra.value) / 100;
    // 100% é o padrão: não guardar significa "nunca foi mexido", e é o que
    // mantém o armazenamento pequeno depois de muita gente passar pela sala.
    if (nivel === 1) volumePessoa.delete(userId);
    else volumePessoa.set(userId, nivel);
    gravarVolumes();
    aplicarVolume(slot);
    mostrar();
  });

  linha.append(barra, valor);
  bloco.append(rotulo, linha);
  return bloco;
}

function buildAvatar(p) {
  const url = avatarUrl(p);

  const fallback = () => {
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.background = colorFor(p.id);
    div.textContent = initials(p.name);
    return div;
  };

  if (!url) return fallback();

  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = url;
  img.alt = p.name;
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

/**
 * Quem está na sala, listado na pílula do topo.
 *
 * Com telas no ar a grade passa a ser delas, então é aqui que ainda dá para ver
 * a sala inteira — inclusive quem só assiste.
 */
function buildPeopleList() {
  const list = document.createElement('div');
  list.className = 'hover-list';

  if (!participants.length) {
    const empty = document.createElement('span');
    empty.className = 'hover-empty';
    empty.textContent = 'Ninguém na sala';
    list.append(empty);
    return list;
  }

  for (const p of participants) {
    const row = document.createElement('span');
    row.className = 'hover-row';
    if (p.broadcasting) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      row.append(dot);
    }
    // textContent, nunca innerHTML: nome vem do Discord, é conteúdo de terceiro.
    row.append(document.createTextNode(p.id === session?.user?.id ? `${p.name} (você)` : p.name));
    list.append(row);
  }

  return list;
}

function renderBar() {
  $('people').replaceChildren();
  $('people').insertAdjacentHTML(
    'afterbegin',
    '<svg viewBox="0 0 24 24"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
      '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
      '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  );
  $('people').append(document.createTextNode(String(participants.length)));
  $('people').append(buildPeopleList());

  const casters = participants.filter((p) => p.broadcasting);

  const minhas = minhasFontes();
  const telaNoAr = minhas.has('tela') || Boolean(myBroadcast);
  const cameraNoAr = minhas.has('camera');

  const btn = $('share');
  btn.classList.toggle('live', telaNoAr);
  btn.disabled = false;

  const rotuloShare = telaNoAr ? 'Parar tela' : 'Compartilhar tela';
  btn.dataset.tip = rotuloShare;
  btn.setAttribute('aria-label', rotuloShare);

  // A câmera tem botão próprio, com o mesmo par ligar/desligar da tela — e a
  // mesma aparência: são a mesma ação em duas fontes, e pintar só uma delas
  // dizia que a outra era secundária.
  const cam = $('camera');
  cam.classList.toggle('live', cameraNoAr);
  const rotuloCam = cameraNoAr ? 'Desligar câmera' : 'Ligar câmera';
  cam.dataset.tip = rotuloCam;
  cam.setAttribute('aria-label', rotuloCam);

  // O controle de som só existe quando há som para controlar.
  const temSom = [...streams.values()].some((s) => s.audio);
  $('volumeBox').hidden = !temSom;
  renderVolume();

  const noPalco = activeSlot !== null;
  if ($('fitControls')) $('fitControls').hidden = !noPalco;
  if ($('latencyBox')) $('latencyBox').hidden = !noPalco;
  if ($('statsToggle')) $('statsToggle').hidden = !noPalco;
  if ($('fullscreen')) $('fullscreen').hidden = !noPalco;

  renderProfileButton();

  $('pWho').textContent = casters.length ? casters.map((p) => p.name).join(', ') : 'ninguém';
}

// ------------------------------------------------------------------- streams

/** Prepara o lugar do transmissor; o decoder só nasce quando o config chega. */
function openStream(slot, userId) {
  closeStream(slot);

  const canvas = document.createElement('canvas');

  // O elemento de vídeo da conexão direta. Nasce junto e fica fora do DOM até
  // ela fechar; criá-lo só na hora custaria um quadro preto no meio da troca.
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // A política de autoplay recusa vídeo com som antes de qualquer gesto. Entrar
  // mudo e abrir o som quando ele chega é o que evita o play() rejeitado —
  // aplicarVolume, logo abaixo, é quem devolve o volume de verdade.
  video.muted = true;

  const s = {
    userId,
    canvas,
    video,
    pc: null,
    viaRtc: false,
    prazoRtc: null,
    started: false,
    player: null,
    audio: null,
  };

  s.player = createPlayer(canvas, {
    onError: (m) => toast(m, true),
    onTamanho: (dim) => {
      s.started = true;
      if (typeof window !== 'undefined' && window.__DIAGNOSTICS) {
        window.__DIAGNOSTICS.videoSizeChanges = (window.__DIAGNOSTICS.videoSizeChanges || 0) + 1;
      }
      const tile = document.querySelector(`.tile[data-slot="${slot}"]`);
      if (tile) {
        const loading = tile.querySelector('.tile-loading');
        if (loading) loading.remove();

        if (tile.classList.contains('tile-palco') && dim?.width && dim?.height) {
          tile.style.aspectRatio = `${dim.width} / ${dim.height}`;
        }
      }
    },
    onNeedKeyframe: () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'need-keyframe', slot }));
      }
    },
    getAudioClock: () => s.audio?.getAudioClock(),
    latencyMode: currentLatencyMode,
  });

  streams.set(slot, s);
}

/** Liga o som desta transmissão. Chamado quando a config de áudio chega. */
function startAudio(slot, config) {
  const s = streams.get(slot);
  if (!s) return;

  s.audio?.stop();
  s.audio = createAudio({
    onError: (m) => toast(m, true),
    volume: volumeEfetivo(s.userId),
    latencyMode: currentLatencyMode,
  });
  if (!s.audio.start(config)) {
    s.audio = null;
    return;
  }
  renderBar();
}

function startStream(slot, config) {
  const s = streams.get(slot);
  if (!s) return;
  // A conexão direta está entregando: montar o decodificador do relay agora
  // gastaria memória de GPU para desenhar num canvas que ninguém está vendo.
  if (s.viaRtc) return;
  if (!s.player.start(config)) return;
  renderGrid();
  renderBar();
  ensureStatsTimer();
}

function closeStream(slot) {
  const s = streams.get(slot);
  if (!s) return;
  s.player.stop();
  s.audio?.stop();
  fecharPeer(s);
  s.canvas.remove();
  s.video.remove();
  streams.delete(slot);
  // Quem estava no palco saiu: renderGrid escolhe a próxima na próxima passada.
  if (activeSlot === slot) activeSlot = null;
}

function endStream(slot) {
  if (!streams.has(slot)) return;
  closeStream(slot);

  if (streams.size === 0) {
    clearInterval(lagTimer);
    lagTimer = null;
    for (const id of ['pLag', 'pFps', 'pRes']) $(id).textContent = '—';
  }

  renderGrid();
  renderBar();
}

function closeAllStreams() {
  for (const slot of [...streams.keys()]) closeStream(slot);
  clearInterval(lagTimer);
  lagTimer = null;
}

/**
 * O painel mostra os números de um stream por vez: o ampliado, ou o primeiro.
 * Somar latências de fontes diferentes não significaria nada.
 */
// -------------------------------------------------------------- WebRTC

/**
 * A oferta chegou: monta a resposta e espera os quadros.
 *
 * Quem assiste nunca oferece, só responde — a mídia está do outro lado, e é
 * quem tem a mídia que sabe descrevê-la. Enquanto esta negociação acontece, o
 * relay segue entregando normalmente: a troca só acontece no primeiro quadro
 * que chegar de fato pela conexão direta, e não um instante antes.
 */
async function receberOferta(slot, sdp) {
  const s = streams.get(slot);
  if (!s || !suportaWebRTC()) return;

  // Oferta nova para um slot que já tinha conexão significa que o outro lado
  // recomeçou; a antiga não vai voltar a entregar nada.
  fecharPeer(s);

  try {
    const ice = await iceServers(P);
    // Deu tempo de a transmissão acabar enquanto a lista vinha.
    if (streams.get(slot) !== s) return;

    const pc = criarPeer({
      ice,
      onIce: (candidate) => enviarRtc(slot, { kind: 'ice', candidate }),
      onEstado: (estado) => {
        if (MORTO.has(estado)) desistirDoRtc(slot);
      },
      onTrack: (e) => {
        const [remoto] = e.streams;
        if (!remoto || s.video.srcObject === remoto) return;
        s.video.srcObject = remoto;
        s.video.play().catch(() => {});
      },
    });
    s.pc = pc;

    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    enviarRtc(slot, { kind: 'answer', sdp: pc.localDescription });

    // O sinal de que deu certo é quadro na tela, não estado de conexão: um peer
    // "connected" que não entrega nada é indistinguível de um travamento, e é
    // exatamente o que este caminho existe para evitar.
    s.video.addEventListener('loadeddata', () => assumirRtc(slot), { once: true });

    clearTimeout(s.prazoRtc);
    s.prazoRtc = setTimeout(() => {
      if (!s.viaRtc) desistirDoRtc(slot);
    }, PRAZO_CONEXAO_MS);
  } catch (err) {
    console.warn('[rtc] resposta falhou:', err.message);
    desistirDoRtc(slot);
  }
}

async function receberIce(slot, candidate) {
  const pc = streams.get(slot)?.pc;
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    // Candidato fora de ordem é rotina e se recupera sozinho no próximo.
    console.warn('[rtc]', err.message);
  }
}

/** A conexão direta entregou o primeiro quadro: ela assume, e o relay sai. */
function assumirRtc(slot) {
  const s = streams.get(slot);
  if (!s || s.viaRtc) return;

  s.viaRtc = true;
  clearTimeout(s.prazoRtc);
  s.prazoRtc = null;

  // O som passa a sair do <video>; manter o decodificador de áudio tocando
  // junto daria eco com meio segundo de diferença entre os dois caminhos.
  s.audio?.stop();
  s.audio = null;
  s.video.muted = false;
  // Tirar do mudo pode fazer a política de autoplay pausar o vídeo; pedir o
  // play de volta é barato e é o que evita a tela congelar no primeiro quadro.
  s.video.play().catch(() => {});
  s.started = true;

  aplicarVolume(slot);
  ws?.send(JSON.stringify({ type: 'rtc-ativo', slot, on: true }));
  renderGrid();
  renderBar();
}

/**
 * Desiste da conexão direta e volta para o relay.
 *
 * Vale tanto para a que nunca fechou quanto para a que caiu no meio. Nos dois
 * casos o relay é o destino, e ele nunca precisou ser religado do lado de cá:
 * basta o servidor voltar a mandar os bytes, e é isso que o aviso faz.
 */
function desistirDoRtc(slot) {
  const s = streams.get(slot);
  if (!s) return;

  const estava = s.viaRtc;
  fecharPeer(s);

  if (estava) {
    // O decodificador está frio desde que o relay parou; o servidor manda um
    // keyframe junto com a religada, e é ele que traz a imagem de volta.
    s.started = false;
    const config = available.get(slot)?.config;
    if (config) s.player.start(config);
    renderGrid();
    renderBar();
  }

  if (watching.has(slot)) ws?.send(JSON.stringify({ type: 'rtc-ativo', slot, on: false }));
}

function fecharPeer(s) {
  clearTimeout(s.prazoRtc);
  s.prazoRtc = null;
  s.viaRtc = false;
  s.video.srcObject = null;
  s.video.muted = true;
  if (!s.pc) return;
  try {
    s.pc.close();
  } catch {
    // Fechar o que já se fechou lança, e não há nada a desfazer.
  }
  s.pc = null;
}

function enviarRtc(slot, payload) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'rtc', slot, payload }));
}

/**
 * Quadros por segundo do elemento de vídeo desde a última leitura.
 *
 * `getVideoPlaybackQuality` é o único jeito de contar quadros de um <video> sem
 * pendurar um callback por quadro — que custaria mais do que o diagnóstico vale.
 */
function quadrosDoVideo(s) {
  const q = s.video.getVideoPlaybackQuality?.();
  if (!q) return '—';
  const total = q.totalVideoFrames;
  const n = total - (s.quadrosAntes ?? total);
  s.quadrosAntes = total;
  // Quadro descartado pelo navegador é exatamente a micro-travada que se vê.
  const perdidos = q.droppedVideoFrames - (s.perdidosAntes ?? q.droppedVideoFrames);
  s.perdidosAntes = q.droppedVideoFrames;
  return perdidos > 0 ? `${n} fps · ${perdidos} perdidos` : `${n} fps`;
}

function ensureStatsTimer() {
  if (lagTimer) return;
  lagTimer = setInterval(() => {
    const s = streams.get(activeSlot) ?? streams.values().next().value;
    if (!s) return;

    // Pela conexão direta quem conta os quadros é o próprio elemento de vídeo,
    // e o atraso vem do ida-e-volta medido pelo ICE. O carimbo de tempo do
    // relay não existe nesse caminho — e o do player ficaria congelado na
    // última medição, o que é pior que não mostrar nada.
    if (s.viaRtc) {
      const m = medidaDe(s);
      $('pVia').textContent = 'WebRTC (direto)';
      $('pRes').textContent = m.w ? `${m.w}×${m.h}` : '—';
      $('pFps').textContent = quadrosDoVideo(s);
      $('pJitter').textContent = 'do WebRTC';
      resumoPeer(s.pc).then(({ rtt, relay }) => {
        if (!s.viaRtc) return;
        $('pLag').textContent = rtt === null ? '—' : `${rtt} ms${relay ? ' · TURN' : ''}`;
      });
    } else {
      $('pVia').textContent = s.pc ? 'relay (negociando direto…)' : 'relay (WebSocket)';
      $('pLag').textContent = `${Math.max(0, s.player.getLag())} ms`;
      $('pFps').textContent = `${s.player.takeFrameCount()} fps`;
      $('pRes').textContent = s.player.getSizes().video;
      // O número que interessa quando a imagem anda aos saltos sem perder um
      // quadro sequer: o desencontro entre o ritmo em que os quadros foram
      // capturados e o ritmo em que eles chegaram.
      const j = s.player.getJitter();
      $('pJitter').textContent = j === null ? '—' : `${j} ms`;
    }

    // Quatro estados diferentes que, sem isto, parecem todos "sem som".
    if (s.viaRtc) {
      const temSom = (s.video.srcObject?.getAudioTracks?.().length ?? 0) > 0;
      if (!temSom) $('pSom').textContent = 'a transmissão não tem áudio';
      else if (volume === 0) $('pSom').textContent = 'silenciado aqui';
      else $('pSom').textContent = `tocando · ${Math.round(volume * 100)}%`;
    } else if (!s.audio) $('pSom').textContent = 'a transmissão não tem áudio';
    else if (!s.audio.temSom()) $('pSom').textContent = 'aguardando o áudio…';
    else if (volume === 0) $('pSom').textContent = 'silenciado aqui';
    else $('pSom').textContent = `tocando · ${Math.round(volume * 100)}%`;
  }, 1000);
}

/**
 * Ctrl+Shift+D reabre o diagnóstico.
 *
 * O botão que abria este painel saiu da barra de propósito, mas o painel em si
 * continua sendo a única forma de saber por onde o vídeo está vindo e o quanto
 * ele está chegando irregular. Um atalho não ocupa espaço na tela e é o que
 * separa "está travando" de "está travando por causa disto".
 */
window.addEventListener('keydown', (e) => {
  // Ctrl + Shift + D (ou Cmd + Shift + D) copia o log de diagnóstico sem abrir nenhum painel
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault();
    copyStutterLog();
    return;
  }

  if (e.key !== 'Escape') return;

  if (!$('debugOverlay')?.hidden) {
    toggleDebugOverlay();
    return;
  }

  for (const id of ['profileModal', 'roomModal', 'joinModal', 'createModal']) {
    if (!$(id).hidden) {
      $(id).hidden = true;
      return;
    }
  }

  if (telaCheia) {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    telaCheia = false;
    renderGrid();
  }
});

// ResizeObserver para recomputar dimensões instantaneamente quando o Discord redimensiona
if (window.ResizeObserver) {
  const gridObserver = new ResizeObserver(() => {
    if (inRoom()) {
      applyStrip();
    }
  });
  const gridEl = $('grid');
  if (gridEl) gridObserver.observe(gridEl);
}

// Aplica preferências iniciais salvas
applyFitMode(currentFitMode);
applyLatencyMode(currentLatencyMode);

/**
 * Diagnóstico: tenta capturar a tela direto de dentro do iframe.
 */
$('probe')?.addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('getDisplayMedia nem existe neste contexto — iframe sem permissão.', true);
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    toast('Funcionou! O iframe permite captura direta — dá para dispensar a aba externa.');
  } catch (err) {
    toast(`Bloqueado (${err.name}): ${err.message}`, true);
  }
});
