/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Uma página, duas fontes. Tela e câmera são painéis independentes, cada um com
 * sua própria conexão e seu próprio ligar/desligar — abrir uma aba por fonte
 * dobraria as janelas que a pessoa precisa manter vivas, e nenhuma delas pode
 * ser fechada enquanto transmite.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import {
  createBroadcaster,
  supportError,
  fonteIndisponivel,
  opcoesTela,
  QUALITY_PRESETS,
} from '/shared/broadcaster.js?v=9';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

const FONTES = ['tela', 'camera'];
const TITULO = document.title;

/**
 * As opções da transmissão.
 */
const GUARDADAS = 'opcoesTransmissao';

function guardadas() {
  try {
    return JSON.parse(localStorage.getItem(GUARDADAS) ?? '{}');
  } catch {
    return {};
  }
}

const salvas = guardadas();
const opcoes = {
  preset: query.get('preset') || salvas.preset || 'automatico',
  priority: query.get('prioridade') || salvas.priority || 'fluidez',
  bitrate: Number(query.get('q')) || Number(salvas.bitrate) || 8_000_000,
  fps: Number(query.get('fps')) || Number(salvas.fps) || 60,
};

function getEffectiveQuality() {
  const p = opcoes.preset;
  if (p && QUALITY_PRESETS[p] && !QUALITY_PRESETS[p].isCustom) {
    if (p === 'automatico') {
      return {
        preset: 'automatico',
        width: 1920,
        height: 1080,
        fps: 60,
        bitrate: 8_000_000,
        priority: opcoes.priority || 'fluidez',
      };
    }
    return {
      preset: p,
      width: QUALITY_PRESETS[p].width ?? 1600,
      height: QUALITY_PRESETS[p].height ?? 900,
      fps: QUALITY_PRESETS[p].fps ?? 30,
      bitrate: QUALITY_PRESETS[p].bitrate ?? 4_000_000,
      priority: QUALITY_PRESETS[p].priority || 'fluidez',
    };
  }
  return {
    preset: 'personalizado',
    width: 1600,
    height: 900,
    fps: Number(opcoes.fps) || 30,
    bitrate: Number(opcoes.bitrate) || 4_000_000,
    priority: opcoes.priority || 'fluidez',
  };
}

function guardar() {
  try {
    localStorage.setItem(GUARDADAS, JSON.stringify(opcoes));
  } catch {
    /* navegação privada: vale só para esta sessão */
  }
}

function espelharOpcoes() {
  if ($('preset-qualidade')) $('preset-qualidade').value = opcoes.preset;
  if ($('personalizado-wrap')) $('personalizado-wrap').hidden = opcoes.preset !== 'personalizado';
  if ($('qualidade')) $('qualidade').value = String(opcoes.bitrate);
  if ($('quadros')) $('quadros').value = String(opcoes.fps);
  if ($('prioridade')) $('prioridade').value = opcoes.priority;
}

function aplicarOpcoes(novas) {
  if (!novas) return;
  if (novas.preset) opcoes.preset = novas.preset;
  if (novas.prioridade) opcoes.priority = novas.prioridade;
  if (Number(novas.q)) opcoes.bitrate = Number(novas.q);
  if (Number(novas.fps)) opcoes.fps = Number(novas.fps);
  espelharOpcoes();
}

function mudarPreset(preset) {
  opcoes.preset = preset;
  if (QUALITY_PRESETS[preset] && !QUALITY_PRESETS[preset].isCustom) {
    opcoes.fps = QUALITY_PRESETS[preset].fps ?? (preset === 'automatico' ? 60 : 30);
    opcoes.bitrate = QUALITY_PRESETS[preset].bitrate ?? 8_000_000;
  }
  guardar();
  espelharOpcoes();
  for (const painel of Object.values(paineis)) painel?.aplicarQualidade?.();
}

function mudarPrioridade(priority) {
  opcoes.priority = priority;
  guardar();
  for (const painel of Object.values(paineis)) painel?.aplicarQualidade?.();
}

function mudarOpcao(chave, valor) {
  if (!Number(valor)) return;
  opcoes[chave] = Number(valor);
  guardar();
  for (const painel of Object.values(paineis)) painel?.aplicarQualidade?.();
}

const paineis = {};

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function falhar(titulo, msg) {
  for (const f of FONTES) $(`bloco-${f}`).hidden = true;
  // Título e motivo no mesmo lugar: sem o cabeçalho não há mais onde separar
  // os dois, e separados em duas linhas eles diziam a mesma coisa duas vezes.
  const el = $('pageStatus');
  el.textContent = `${titulo} ${msg}`;
  el.className = 'status error';
}

// --------------------------------------------------------------- chamamento

let piscando = null;

/**
 * Destaca a fonte que a atividade pediu e chama pelo título.
 *
 * Uma aba em segundo plano não pode se trazer para a frente: `window.focus()` é
 * ignorado, e quem abriu esta página foi o navegador do sistema, não uma página
 * nossa que pudesse chamá-la de volta. O título é o único lugar onde ela ainda
 * aparece para quem está olhando outra coisa.
 */
function chamar(fonte) {
  for (const f of FONTES) $(`bloco-${f}`).classList.toggle('chamando', f === fonte);

  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
  if (!fonte) return;

  // Piscar só serve para quem não está olhando; com a aba à frente, o destaque
  // no bloco já diz qual é.
  if (!document.hidden) return;

  const aviso = fonte === 'camera' ? '● Ligar a câmera' : '● Compartilhar a tela';
  let ligado = false;
  piscando = setInterval(() => {
    ligado = !ligado;
    document.title = ligado ? aviso : TITULO;
  }, 1200);
}

// Visto o recado, para de piscar — o destaque no bloco continua dizendo qual é.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !piscando) return;
  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
});

/**
 * A configuração mudou na engrenagem da atividade.
 *
 * Vale na hora para o que já está no ar. O som não passa por aqui: ele é
 * decidido no seletor do navegador, na hora da captura.
 */
function aplicarConfig(novas) {
  aplicarOpcoes(novas);
  for (const f of FONTES) paineis[f]?.aplicarQualidade();
}

/**
 * A atividade pediu uma fonte.
 *
 * A câmera abre aqui mesmo, mas em prévia: getUserMedia não exige gesto do
 * usuário depois da permissão concedida, então dá para mostrar o que ela vê — e
 * mostrar é o certo, porque ir ao ar com a webcam errada não tem desfazer.
 *
 * Tela não abre nem em prévia: `getDisplayMedia` exige ativação transitória e
 * lança InvalidStateError sem ela, então o seletor só nasce de um clique nesta
 * página. O que resta é chamar e esperar.
 */
function atenderPedido(fonte, novas) {
  aplicarOpcoes(novas);

  const painel = paineis[fonte];
  if (!painel || painel.ativo() || painel.indisponivel()) return;

  chamar(fonte);
  if (fonte === 'camera') painel.verCamera();
}

// --------------------------------------------------------------- controle

/**
 * Conexão de controle: aberta ao carregar, viva enquanto esta aba estiver.
 *
 * É por ela que a atividade alcança esta página **antes** de existir qualquer
 * transmissão — para pedir uma fonte, ou para avisar que a configuração mudou.
 * As conexões de transmissão não serviriam: cada uma nasce só depois que a
 * captura foi concedida, então com nada no ar não há ninguém escutando.
 */
let controle = null;
let religar = null;
let controlePingTimer = null;

function ligarControle() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  controle = new WebSocket(
    `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&modo=controle`,
  );

  controle.addEventListener('open', () => {
    clearInterval(controlePingTimer);
    controlePingTimer = setInterval(() => {
      if (controle?.readyState === WebSocket.OPEN) {
        controle.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }, 20_000);
  });

  controle.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;

    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      if (controle?.readyState === WebSocket.OPEN) {
        controle.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp || Date.now() }));
      }
    } else if (msg.type === 'pong') {
      // keepalive ok
    } else if (msg.type === 'start-request') atenderPedido(msg.fonte, msg.opcoes);
    else if (msg.type === 'config-request') aplicarConfig(msg.opcoes);
    else if (msg.type === 'room-gone') {
      // Sala fechada: não há a quem transmitir, e insistir na reconexão só
      // gastaria rede contra um id que não existe mais.
      clearTimeout(religar);
      religar = 'morto';
      $('pageStatus').textContent = 'A sala foi fechada. Volte à atividade e comece de novo.';
      $('pageStatus').className = 'status aviso';
    }
  });

  // Sem reconectar, uma queda de rede deixa a aba aberta e surda, sem nada na
  // tela dizendo que ela parou de obedecer à atividade.
  controle.addEventListener('close', () => {
    clearInterval(controlePingTimer);
    controlePingTimer = null;
    controle = null;
    if (religar === 'morto') return;
    clearTimeout(religar);
    religar = setTimeout(ligarControle, 3000);
  });
}

// ------------------------------------------------------------------ painel

function criarPainel(fonte) {
  const el = (sufixo) => $(`${fonte}-${sufixo}`);
  const camera = fonte === 'camera';

  let broadcaster = null;

  /**
   * Prévia local: o que a fonte mostra, antes de qualquer transmissão.
   *
   * Existe porque ir ao ar com a fonte errada não tem desfazer — quem está
   * assistindo já viu a janela que não era para ver, ou a webcam que não era
   * para ligar. Conferir e transmitir passam a ser dois gestos.
   *
   * O stream da prévia é reaproveitado pela transmissão, e é por isso que ela
   * pede a tela com as mesmas opções: com outras, ligar o som depois exigiria
   * escolher a tela de novo.
   */
  let previa = null;
  // Qual câmera. `null` é o que o navegador escolher.
  let dispositivo = null;

  function pararPrevia() {
    previa?.getTracks().forEach((t) => t.stop());
    previa = null;
    el('previa').srcObject = null;
    el('previa').hidden = true;
    el('vazio').hidden = false;
  }

  function mostrarPrevia(stream) {
    previa = stream;
    el('previa').srcObject = stream;
    el('previa')
      .play()
      .catch(() => {});
    el('previa').hidden = false;
    el('vazio').hidden = true;

    // A fonte pode acabar sozinha — webcam desconectada, janela fechada. Sem
    // isto o último quadro fica congelado e a prévia passa a mentir.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (previa === stream) {
        pararPrevia();
        setStatus(camera ? 'A câmera foi desligada.' : 'O compartilhamento acabou.');
      }
    });
  }

  function setStatus(msg, kind = '') {
    const alvo = el('status');
    alvo.textContent = msg;
    alvo.className = `status ${kind}`;
  }

  function mostrarSetup() {
    el('preview').srcObject = null;
    el('live').hidden = true;
    el('setup').hidden = false;
    el('start').disabled = false;
  }

  // ------------------------------------------------------ escolher a fonte

  /** Abre a prévia da câmera, trocando a que estiver aberta. */
  async function verCamera(id = dispositivo) {
    setStatus('Abrindo a câmera…');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: id ? { deviceId: { exact: id } } : true,
        audio: false,
      });
      // Sem escolha explícita, adota a que o navegador deu: assim o tique do
      // menu marca a que está no ar em vez de não marcar nenhuma.
      dispositivo = id ?? s.getVideoTracks()[0]?.getSettings().deviceId ?? null;
      pararPrevia();
      mostrarPrevia(s);
      setStatus('Prévia — ainda não está no ar.');
      await listarCameras();
    } catch (err) {
      setStatus(
        err.name === 'NotAllowedError'
          ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
          : err.message,
        'error',
      );
    }
  }

  /** Abre a prévia da tela. O seletor exige o clique, que é quem chama isto. */
  async function verTela() {
    const q = getEffectiveQuality();
    try {
      const s = await navigator.mediaDevices.getDisplayMedia(
        opcoesTela({ fps: q.fps, width: q.width, height: q.height, comSom: true }),
      );
      pararPrevia();
      mostrarPrevia(s);
      setStatus('Prévia — ainda não está no ar.');
    } catch (err) {
      // Cancelar o seletor é escolha, não falha.
      if (err.name !== 'NotAllowedError') setStatus(err.message, 'error');
    }
  }

  function fecharMenu() {
    el('menu').hidden = true;
    el('escolher').setAttribute('aria-expanded', 'false');
  }

  /**
   * A lista de câmeras.
   *
   * Os nomes só chegam depois da permissão — antes dela o navegador entrega os
   * dispositivos anônimos, para não revelar o hardware a quem não pediu nada.
   * Por isso abrir o menu abre a prévia primeiro.
   */
  async function listarCameras() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'videoinput',
    );

    el('menu').replaceChildren(
      ...cams.map((d, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(d.deviceId === dispositivo));
        b.textContent = d.label || `Câmera ${i + 1}`;
        b.addEventListener('click', () => {
          fecharMenu();
          verCamera(d.deviceId);
        });
        li.append(b);
        return li;
      }),
    );
  }

  /**
   * Abre o menu de câmeras.
   */
  async function escolher() {
    if (!camera) return verTela();

    if (!el('menu').hidden) return fecharMenu();

    await listarCameras();

    if (!el('menu').childElementCount) {
      setStatus('Nenhuma câmera encontrada neste computador.', 'error');
      return;
    }

    el('menu').hidden = false;
    el('escolher').setAttribute('aria-expanded', 'true');
  }

  // ------------------------------------------------------------- transmitir

  async function ligar() {
    // Pedido repetido não reabre nada
    if (broadcaster) return;

    el('start').disabled = true;
    setStatus(camera ? 'Aguardando a permissão da câmera…' : 'Aguardando você escolher a tela…');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = getEffectiveQuality();

    broadcaster = createBroadcaster({
      wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&fonte=${fonte}`,
      preset: q.preset,
      priority: q.priority,
      bitrate: q.bitrate,
      fps: q.fps,
      audio: !camera,
      fonte,
      streamPronto: previa,
      deviceId: camera ? dispositivo : null,
      onStatus: (s) =>
        setStatus(
          `Codec: ${s.codec} · ${s.width}×${s.height} · captura ${s.direct ? 'direta (MediaStreamTrackProcessor)' : 'via <video>'}`,
        ),
      onStats: (s) => {
        el('viewers').textContent = s.viewers;
        el('fps').textContent = `${s.fps} fps`;
        el('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
        el('elapsed').textContent =
          `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;

        if (fonte === 'tela') {
          const healthEl = $('tela-health');
          if (healthEl && s.health) {
            healthEl.textContent = s.health;
            healthEl.className = 'health-badge';
            if (s.health === 'Excelente') healthEl.classList.add('excelente');
            else if (s.health === 'Boa') healthEl.classList.add('boa');
            else if (s.health.startsWith('Limitada')) healthEl.classList.add('limitada');
            else healthEl.classList.add('critica');
          }

          const adaptMsg = $('tela-adaptive-msg');
          if (adaptMsg) {
            if (s.reason) {
              adaptMsg.textContent = s.reason;
              adaptMsg.hidden = false;
            } else {
              adaptMsg.hidden = true;
            }
          }

          if (s.target && $('tela-diag-target')) {
            $('tela-diag-target').textContent = `${s.target.label} (Pedido: ${s.target.fps} FPS)`;
          }
          if ($('tela-diag-limiter')) {
            const lim = s.limiter || 'NONE';
            $('tela-diag-limiter').textContent = lim;
            $('tela-diag-limiter').style.color = lim === 'NONE' ? '#4ade80' : '#f87171';
          }
          if (s.current && $('tela-diag-current')) {
            $('tela-diag-current').textContent =
              s.current.label ?? `${s.current.width}×${s.current.height} @ ${s.current.fps}fps`;
          }
          if (s.capture && $('tela-diag-capture')) {
            $('tela-diag-capture').textContent =
              `Track Settings: ${s.capture.trackFps} FPS (${s.capture.width}×${s.capture.height}, ${s.capture.surface}) | Real: ${s.capture.capturedFps} FPS`;
          }
          if (s.capture && $('tela-diag-capture-path')) {
            $('tela-diag-capture-path').textContent =
              `${s.capture.path} (Lidos: ${s.capture.framesRead || s.capture.capturedFps}, Pulados: ${s.capture.framesSkipped || 0}, Enviados: ${s.encoder.inputFps})`;
          }
          if (s.capture && $('tela-diag-cap-pacing')) {
            $('tela-diag-cap-pacing').textContent =
              `Méd: ${s.capture.avgIntervalMs || 0}ms | P50: ${s.capture.p50IntervalMs || 0}ms | P95: ${s.capture.p95IntervalMs || 0}ms | P99: ${s.capture.p99IntervalMs || 0}ms | Max: ${s.capture.maxIntervalMs || 0}ms | Jitter: ${s.capture.jitterMs || 0}ms`;
          }
          if (s.capture?.histogram && $('tela-diag-cap-histo')) {
            const h = s.capture.histogram;
            $('tela-diag-cap-histo').textContent =
              `<12ms: ${h.lt12} | 12-20ms: ${h.b12_20} | 20-28ms: ${h.b20_28} | 28-38ms: ${h.b28_38} | 38-50ms: ${h.b38_50} | >50ms: ${h.gt50}`;
          }
          if (s.encoder && $('tela-diag-encoder')) {
            $('tela-diag-encoder').textContent =
              `Entrada: ${s.encoder.inputFps} FPS | Saída: ${s.encoder.outputFps} FPS | Fila: ${s.encoder.queueSize} (P95: ${s.encoder.queueP95 || 0}) | Encode Méd: ${s.encoder.avgEncodeMs}ms (P95: ${s.encoder.p95EncodeMs}ms)`;
          }
          if (s.encoder && $('tela-diag-enc-pacing')) {
            $('tela-diag-enc-pacing').textContent =
              `Intervalo Saída Méd: ${s.encoder.outputGapAvgMs || 0}ms | P95: ${s.encoder.outputGapP95Ms || 0}ms | Max: ${s.encoder.outputGapMaxMs || 0}ms`;
          }
          if (s.encoder && $('tela-diag-keyframes')) {
            $('tela-diag-keyframes').textContent =
              `Keys: ${s.encoder.keyframesCount || 0} (méd: ${Math.round((s.encoder.avgKeyframeBytes || 0) / 1024)} KB) | Deltas méd: ${Math.round((s.encoder.avgDeltaBytes || 0) / 1024)} KB`;
          }
          if (s.bitrate && $('tela-diag-cfg-bitrate')) {
            $('tela-diag-cfg-bitrate').textContent =
              `${(s.bitrate.configuredBps / 1e6).toFixed(2)} Mbps`;
          }
          if (s.bitrate && $('tela-diag-enc-bitrate')) {
            $('tela-diag-enc-bitrate').textContent =
              `${(s.bitrate.encodedBps / 1e6).toFixed(2)} Mbps`;
          }
          if (s.bitrate && $('tela-diag-sent-bitrate')) {
            $('tela-diag-sent-bitrate').textContent =
              `${(s.bitrate.sentTotalBps / 1e6).toFixed(2)} Mbps (vídeo: ${(s.bitrate.sentVideoBps / 1e6).toFixed(2)}M, áudio: ${(s.bitrate.sentAudioBps / 1e3).toFixed(0)}k)`;
          }
          if (s.network && $('tela-diag-network')) {
            $('tela-diag-network').textContent =
              `Buffer WS: ${(s.network.wsBufferedBytes / 1024).toFixed(0)} KB | Descartes: ${s.network.droppedNetworkFrames}`;
          }
          if (s.network && $('tela-diag-send-delay')) {
            $('tela-diag-send-delay').textContent = `${s.network.encoderToSendDelayP95Ms || 0} ms`;
          }
        }
      },
      onAviso: (msg) => setStatus(msg, 'aviso'),
      onEnd: (reason) => {
        broadcaster = null;
        mostrarSetup();
        setStatus(reason);
      },
    });

    // O broadcaster assume as faixas daqui para a frente
    previa = null;
    el('previa').srcObject = null;
    el('previa').hidden = true;
    el('vazio').hidden = false;

    try {
      const stream = await broadcaster.start();
      el('preview').srcObject = stream;
      el('preview')
        .play()
        .catch(() => {});
      el('setup').hidden = true;
      el('live').hidden = false;
      if (!camera) $('somAba').hidden = false;
      chamar(null);
    } catch (err) {
      broadcaster = null;
      el('start').disabled = false;
      const negado = camera
        ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
        : 'Você cancelou a seleção de tela.';
      setStatus(err.name === 'NotAllowedError' ? negado : err.message, 'error');
    }
  }

  const indisponivel = fonteIndisponivel(fonte);
  if (indisponivel) {
    el('start').disabled = true;
    el('escolher').disabled = true;
    setStatus(indisponivel, 'error');
  }

  el('start').addEventListener('click', ligar);
  el('stop').addEventListener('click', () =>
    broadcaster?.stop(camera ? 'Câmera desligada.' : 'Transmissão encerrada.'),
  );

  el('escolher').addEventListener('click', (e) => {
    e.stopPropagation();
    escolher().catch((err) => setStatus(err.message, 'error'));
  });

  if (camera) {
    document.addEventListener('click', fecharMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') fecharMenu();
    });
  }

  return {
    ligar,
    escolher,
    verCamera,
    setStatus,
    indisponivel: () => Boolean(indisponivel),
    aplicarQualidade: () => {
      const q = getEffectiveQuality();
      return broadcaster?.setQuality({
        preset: q.preset,
        priority: q.priority,
        bitrate: q.bitrate,
        fps: q.fps,
      });
    },
    ativo: () => Boolean(broadcaster),
    parar: () => {
      broadcaster?.stop();
      pararPrevia();
    },
    trocarSom: () => broadcaster?.trocarSom(),
  };
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
const missing = supportError({ requireChromium: true });

if (!payload) {
  falhar('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  falhar('Link expirado.', 'Gere um novo pela atividade.');
} else if (missing) {
  falhar('Navegador sem suporte.', missing);
} else {
  for (const f of FONTES) paineis[f] = criarPainel(f);
  ligarControle();

  const pedida = query.get('fonte');
  if (FONTES.includes(pedida)) atenderPedido(pedida);
}

$('somAba')?.addEventListener('click', async () => {
  if (!paineis.tela?.ativo()) return;
  try {
    await paineis.tela.trocarSom();
    paineis.tela.setStatus('Som ligado, vindo da fonte escolhida.', 'ok');
    $('somAba').textContent = 'Trocar a fonte do som';
  } catch (err) {
    if (err.name !== 'NotAllowedError') paineis.tela.setStatus(err.message, 'error');
  }
});

espelharOpcoes();
$('preset-qualidade')?.addEventListener('change', (e) => mudarPreset(e.target.value));
$('prioridade')?.addEventListener('change', (e) => mudarPrioridade(e.target.value));
$('qualidade')?.addEventListener('change', (e) => mudarOpcao('bitrate', e.target.value));
$('quadros')?.addEventListener('change', (e) => mudarOpcao('fps', e.target.value));

window.addEventListener('beforeunload', () => {
  for (const f of FONTES) paineis[f]?.parar();
});
