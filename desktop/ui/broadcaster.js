/**
 * DC Screen Sharing — Native Broadcaster UI Logic
 *
 * Communicates with the main process via window.discordScreenRailway (preload bridge).
 * The main process owns the capture engine, WebSocket, and audio.
 * This renderer is purely UI + user input.
 */

'use strict';

const bridge = window.dcScreenSharing || window.discordScreenRailway || window.electronAPI;

// ── State ─────────────────────────────────────────────────────────────────────
let sources        = [];
let selectedSource = null;
let activeType     = 'screen'; // 'screen' | 'window'
let selectedPreset = 'maxima';
let isStreaming    = false;
let shareUrl       = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const elHeaderDot      = $('header-dot');
const elHeaderText     = $('header-status-text');
const elErrorBanner    = $('error-banner');
const elSourceGrid     = $('source-grid');
const elBtnStartStop   = $('btn-start-stop');
const elBtnCopyUrl     = $('btn-copy-url');
const elBtnOpenBrowser = $('btn-open-browser');
const elShareUrlDisp   = $('share-url-container');
const elFooterSpacer   = $('footer-spacer');
const elDiagPanel      = $('diag-panel');
const elDiagToggle     = $('btn-diag-toggle');

// Pipeline elements
const stages = {
  capture: { el: $('stage-capture'), fps: $('stage-capture-fps') },
  encode:  { el: $('stage-encode'),  fps: $('stage-encode-fps')  },
  send:    { el: $('stage-send'),    fps: $('stage-send-fps')    },
  viewers: { el: $('stage-viewers'), count: $('stage-viewers-count') },
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setupRoomConfig();
  setupTabs();
  setupPresets();
  setupAudio();
  setupDiag();
  setupFooter();

  await loadSources();

  if (bridge) {
    bridge.onBroadcasterState?.((state) => handleStateUpdate(state));
    bridge.onBroadcasterStats?.((stats) => handleStats(stats));
  }

  updateUI();
}

// ── Room Config ───────────────────────────────────────────────────────────────
function setupRoomConfig() {
  const tabCreate = $('tab-room-create');
  const tabJoin   = $('tab-room-join');
  const panelCreate = $('panel-room-create');
  const panelJoin   = $('panel-room-join');

  tabCreate?.addEventListener('click', () => {
    tabCreate.classList.add('active');
    tabJoin?.classList.remove('active');
    panelCreate?.classList.remove('hidden');
    panelJoin?.classList.add('hidden');
    clearError();
  });

  tabJoin?.addEventListener('click', () => {
    tabJoin.classList.add('active');
    tabCreate?.classList.remove('active');
    panelJoin?.classList.remove('hidden');
    panelCreate?.classList.add('hidden');
    clearError();
  });
}

// ── Source tabs ───────────────────────────────────────────────────────────────
function setupTabs() {
  ['screen', 'window'].forEach((type) => {
    const tab = document.querySelector(`[data-type="${type}"]`);
    if (tab) tab.addEventListener('click', () => {
      activeType = type;
      document.querySelectorAll('.source-tab[data-type]').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const matching = sources.filter((s) => s.type === activeType);
      if (matching.length && (!selectedSource || selectedSource.type !== activeType)) {
        selectedSource = matching[0];
      }
      renderSources();
      updateAudioUI();
    });
  });

  $('btn-refresh-sources')?.addEventListener('click', loadSources);
}

async function loadSources() {
  elSourceGrid.innerHTML = '<div class="source-loading">🔍 Enumerando fontes...</div>';
  try {
    sources = await bridge?.broadcasterEnumerateSources?.() ?? [];
    if (!selectedSource && sources.length) {
      selectedSource = sources.find((s) => s.type === 'screen') || sources[0];
    }
    renderSources();
    updateAudioUI();
  } catch (err) {
    elSourceGrid.innerHTML = `<div class="source-loading" style="color:var(--error);">Erro: ${err.message}</div>`;
  }
}

function renderSources() {
  const filtered = sources.filter((s) => s.type === activeType);
  if (!filtered.length) {
    elSourceGrid.innerHTML = '<div class="source-loading">Nenhuma fonte encontrada.</div>';
    return;
  }

  elSourceGrid.innerHTML = '';
  for (const src of filtered) {
    const item = document.createElement('div');
    item.className = 'source-item' + (selectedSource?.id === src.id ? ' selected' : '');
    item.dataset.id = src.id;

    const thumbHtml = src.thumbnailDataUrl
      ? `<img class="source-thumb" src="${src.thumbnailDataUrl}" alt="${src.name}">`
      : `<div class="source-thumb-placeholder">${src.type === 'screen' ? '🖥' : '🪟'}</div>`;

    const resHtml = src.width ? `<div class="source-resolution">${src.width}×${src.height}</div>` : '';
    const badgeHtml = selectedSource?.id === src.id ? '<div class="source-selected-badge">✓</div>' : '';

    item.innerHTML = `
      ${thumbHtml}
      <div class="source-name">${src.name}</div>
      ${resHtml}
      ${badgeHtml}
    `;

    item.addEventListener('click', () => {
      selectedSource = src;
      renderSources();
      updateAudioUI();
      clearError();
    });

    elSourceGrid.appendChild(item);
  }
}

// ── Presets ───────────────────────────────────────────────────────────────────
const PRESET_CONFIGS = {
  economia:   { fps: 30, width: 1280,  height: 720,  bitrate: 2_000_000 },
  equilibrado:{ fps: 30, width: 1600,  height: 900,  bitrate: 4_000_000 },
  alta:       { fps: 30, width: 1920,  height: 1080, bitrate: 6_000_000 },
  maxima:     { fps: 60, width: 1920,  height: 1080, bitrate: 8_000_000 },
  automatico: { fps: 60, width: 1920,  height: 1080, bitrate: 8_000_000, isAuto: true },
  '4k60':     { fps: 60, width: 3840,  height: 2160, bitrate: 20_000_000 },
};

function setupPresets() {
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedPreset = btn.dataset.preset;
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ── Audio Selection ──────────────────────────────────────────────────────────
let audioSelectionMode = 'source'; // 'source' | 'system' | 'none'

function setupAudio() {
  const tabSource = $('tab-audio-source');
  const tabSystem = $('tab-audio-system');
  const tabOff    = $('tab-audio-off');

  const setAudioMode = (mode) => {
    audioSelectionMode = mode;
    [tabSource, tabSystem, tabOff].forEach((t) => t?.classList.remove('active'));
    if (mode === 'source') tabSource?.classList.add('active');
    else if (mode === 'system') tabSystem?.classList.add('active');
    else if (mode === 'none') tabOff?.classList.add('active');
    updateAudioUI();
  };

  tabSource?.addEventListener('click', () => setAudioMode('source'));
  tabSystem?.addEventListener('click', () => setAudioMode('system'));
  tabOff?.addEventListener('click', () => setAudioMode('none'));

  updateAudioUI();
}

function updateAudioUI() {
  const isWindow = selectedSource ? selectedSource.type === 'window' : activeType === 'window';
  const tabSource = $('tab-audio-source');
  const descEl = $('audio-source-desc');
  const discordRow = $('row-exclude-discord-wrapper');

  if (tabSource) {
    tabSource.textContent = isWindow ? '🪟 Áudio da Janela' : '🖥 Som da Tela';
  }

  if (audioSelectionMode === 'none') {
    if (descEl) descEl.textContent = '🔇 Sem áudio. A transmissão enviará apenas o vídeo da captura.';
    if (discordRow) discordRow.classList.add('hidden');
  } else if (audioSelectionMode === 'system') {
    if (descEl) descEl.textContent = '🔊 Som de todo o computador (captura o áudio geral do sistema).';
    if (discordRow) discordRow.classList.remove('hidden');
  } else {
    // 'source'
    if (isWindow) {
      const srcName = selectedSource?.name ? `"${selectedSource.name}"` : 'desta janela';
      if (descEl) descEl.textContent = `🎵 Áudio de ${srcName} com proteção e exclusão da voz do Discord ativa.`;
      if (discordRow) discordRow.classList.remove('hidden');
    } else {
      if (descEl) descEl.textContent = '🖥 Captura os sons do computador transmitidos junto com a tela inteira.';
      if (discordRow) discordRow.classList.remove('hidden');
    }
  }
}

// ── Diagnostics panel ─────────────────────────────────────────────────────────
function setupDiag() {
  elDiagToggle?.addEventListener('click', () => {
    const hidden = elDiagPanel.classList.toggle('hidden');
    elDiagToggle.textContent = hidden ? '▼ Expandir' : '▲ Recolher';
  });
}

// ── Footer ────────────────────────────────────────────────────────────────────
function setupFooter() {
  elBtnStartStop?.addEventListener('click', () => {
    if (isStreaming) stopBroadcast();
    else startBroadcast();
  });

  elBtnCopyUrl?.addEventListener('click', () => {
    if (shareUrl) bridge?.copyToClipboard?.(shareUrl);
  });

  elBtnOpenBrowser?.addEventListener('click', () => {
    if (shareUrl) bridge?.openExternal?.(shareUrl);
  });
}

// ── Start / Stop ──────────────────────────────────────────────────────────────
async function startBroadcast() {
  clearError();

  if (!selectedSource) {
    showError('Selecione uma fonte de captura antes de iniciar.');
    return;
  }

  const isCreate     = $('tab-room-create')?.classList.contains('active') ?? true;
  const roomMode     = isCreate ? 'create' : 'join';
  const roomName     = $('input-room-name')?.value?.trim() || 'Transmissão Nativa';
  const roomPassword = (isCreate ? $('input-room-password')?.value : $('input-join-password')?.value)?.trim() || '';
  const roomTarget   = $('input-join-target')?.value?.trim() || '';

  if (!isCreate && !roomTarget) {
    showError('Informe o link, token ou ID da sala existente antes de iniciar.');
    return;
  }

  const isWindow = selectedSource ? selectedSource.type === 'window' : activeType === 'window';
  let resolvedAudioMode = audioSelectionMode;
  if (audioSelectionMode === 'source') {
    resolvedAudioMode = isWindow ? 'window' : 'system';
  }

  const audio          = resolvedAudioMode !== 'none';
  const excludeDiscord = $('toggle-exclude-discord')?.checked ?? true;
  const presetCfg      = PRESET_CONFIGS[selectedPreset] || PRESET_CONFIGS.maxima;

  setButtonState('starting');
  setHeaderState('connecting');

  try {
    const result = await bridge?.broadcasterStart?.({
      sourceId:       selectedSource.id,
      sourceName:     selectedSource.name,
      audio,
      audioMode:      resolvedAudioMode,
      excludeDiscord,
      preset:         selectedPreset,
      fps:            presetCfg.fps,
      width:          presetCfg.width,
      height:         presetCfg.height,
      bitrate:        presetCfg.bitrate,
      room: {
        mode:     roomMode,
        name:     roomName,
        password: roomPassword,
        target:   roomTarget,
      },
    });

    if (result?.shareUrl) {
      shareUrl = result.shareUrl;
      elShareUrlDisp.textContent = shareUrl;
      elShareUrlDisp.classList.remove('hidden');
      elBtnCopyUrl.classList.remove('hidden');
      elBtnOpenBrowser.classList.remove('hidden');
      elFooterSpacer.classList.add('hidden');
    }

    isStreaming = true;
    setButtonState('streaming');
    setHeaderState('streaming');
    clearError();
  } catch (err) {
    setButtonState('idle');
    setHeaderState('error');
    showError(err.message || 'Falha ao iniciar transmissão.');
  }
}

async function stopBroadcast() {
  setButtonState('stopping');
  try {
    await bridge?.broadcasterStop?.();
  } catch {}
  isStreaming = false;
  shareUrl = null;
  elShareUrlDisp.classList.add('hidden');
  elBtnCopyUrl.classList.add('hidden');
  elBtnOpenBrowser.classList.add('hidden');
  elFooterSpacer.classList.remove('hidden');
  setButtonState('idle');
  setHeaderState('idle');
  resetPipeline();
}

// ── State from main process ───────────────────────────────────────────────────
function handleStateUpdate(state) {
  if (!state) return;

  if (state.lastError && state.state === 'error') {
    showError(state.lastError.message || state.lastError.title || 'Erro desconhecido.');
    setHeaderState('error');
    if (isStreaming) {
      isStreaming = false;
      setButtonState('idle');
    }
  }

  if (state.state === 'streaming') {
    isStreaming = true;
    setButtonState('streaming');
    setHeaderState('streaming');
    if (state.shareUrl && state.shareUrl !== shareUrl) {
      shareUrl = state.shareUrl;
      elShareUrlDisp.textContent = shareUrl;
      elShareUrlDisp.classList.remove('hidden');
      elBtnCopyUrl.classList.remove('hidden');
      elBtnOpenBrowser.classList.remove('hidden');
      elFooterSpacer.classList.add('hidden');
    }
  }

  if (state.state === 'idle' || state.state === 'stopping') {
    if (isStreaming || shareUrl) {
      isStreaming = false;
      shareUrl = null;
      elShareUrlDisp.textContent = '';
      elShareUrlDisp.classList.add('hidden');
      elBtnCopyUrl.classList.add('hidden');
      elBtnOpenBrowser.classList.add('hidden');
      elFooterSpacer.classList.remove('hidden');
      setButtonState('idle');
      setHeaderState('idle');
    }
  }
}

// ── Stats from main process ───────────────────────────────────────────────────
function handleStats(stats) {
  if (!stats) return;

  const { capture, encoder, network, audio, watchdog } = stats;
  if (isStreaming) setHeaderState(network?.wsOpen ? 'streaming' : 'reconnecting');

  // Pipeline
  const capFps = capture?.captureFps ?? 0;
  const encFps = capture?.encodedFps ?? 0;
  const sndFps = capture?.sentFps    ?? 0;
  const viewers = network?.viewers   ?? 0;

  setText('stage-capture-fps', `${capFps} fps`);
  setText('stage-encode-fps',  `${encFps} fps`);
  setText('stage-send-fps',    `${sndFps} fps`);
  setText('stage-viewers-count', `${viewers}`);

  const stageActive = (id, ok) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('active', ok);
    el.classList.toggle('error', !ok && isStreaming);
  };

  stageActive('stage-capture', capFps > 0);
  stageActive('stage-encode',  encFps > 0);
  stageActive('stage-send',    sndFps > 0);
  stageActive('stage-viewers', isStreaming);

  // Header fps display
  if (isStreaming) {
    elHeaderText.textContent = `${capFps} fps · ${viewers} viewer${viewers !== 1 ? 's' : ''}`;
  }

  // Diagnostics
  const admitFps = capture?.admittedFps ?? capFps;
  setText('d-cap-fps',    `${capFps} / ${admitFps}`);
  setText('d-cap-res',    capture?.width && capture?.height ? `${capture.width}×${capture.height}` : '—');
  setText('d-cap-p95',    capture?.p50IntervalMs !== undefined ? `${capture.p50IntervalMs}ms / ${capture.p95IntervalMs}ms` : '—');
  setText('d-cap-gaps',   `${capture?.gap33Ms ?? 0} / ${capture?.gap100Ms ?? 0}`);
  setText('d-cap-dup',    `${capture?.droppedDuplicate ?? 0} / ${capture?.droppedObsolete ?? 0}`);
  setText('d-cap-drop',   `${capture?.droppedEncoderPressure ?? 0} / ${capture?.droppedTransportPressure ?? 0}`);

  setText('d-enc-fps',    `${encFps}`);
  setText('d-enc-hw',     capture?.hardwareStatus || '—');
  setText('d-enc-lat',    capture?.avgEncodeLatencyMs ? `${capture.avgEncodeLatencyMs} ms` : '—');
  setText('d-enc-queue',  String(capture?.encoderQueueSize ?? 0));
  setText('d-enc-kf',     String(capture?.keyframeCount ?? 0));

  setText('d-net-fps',    `${sndFps}`);
  setText('d-net-buf',    formatBytes(network?.transportQueueBytes ?? 0));
  setText('d-net-bytes',  formatBytes(network?.totalBytesSent ?? 0));
  setText('d-net-ws',     network?.wsOpen ? 'Aberto' : 'Fechado');
  setText('d-net-recon',  String(network?.reconnectAttempts ?? 0));

  const audSrcMap = {
    'window-isolated': '🪟 Áudio da Janela (Isolado)',
    'native-exclusion': '🛡️ Exclusão Discord Ativa',
    'system-loopback-safe': '🖥️ Som do Sistema',
    'blocked-discord-exclusion-not-ready': '⚠️ Bloqueado (Call Discord)',
    'disabled': 'Desativado',
  };
  setText('d-aud-src',    audSrcMap[audio?.audioCaptureSource] || audio?.audioCaptureSource || 'disabled');
  setText('d-aud-excl',   audio?.exclusionState ?? 'IDLE');
  setText('d-aud-chunks', String(capture?.audioChunks ?? 0));
  setText('d-watch-rec',  String(watchdog?.captureRecoveries ?? 0));

  // Color-code WS status
  const wsEl = $('d-net-ws');
  if (wsEl) {
    wsEl.className = 'dv ' + (network?.wsOpen ? 'good' : (isStreaming ? 'error' : ''));
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setButtonState(state) {
  if (!elBtnStartStop) return;
  const s = {
    idle:      { text: '▶ Iniciar Transmissão', disabled: false, cls: 'btn-start' },
    starting:  { text: '⏳ Iniciando...',         disabled: true,  cls: 'btn-start' },
    streaming: { text: '⏹ Parar Transmissão',    disabled: false, cls: 'btn-stop'  },
    stopping:  { text: '⏳ Parando...',           disabled: true,  cls: 'btn-stop'  },
  }[state] || { text: '▶ Iniciar Transmissão', disabled: false, cls: 'btn-start' };

  elBtnStartStop.textContent = s.text;
  elBtnStartStop.disabled    = s.disabled;
  elBtnStartStop.className   = s.cls;
}

function setHeaderState(state) {
  const map = {
    idle:       { dot: 'gray',   text: 'Aguardando' },
    connecting: { dot: 'yellow', text: 'Conectando...' },
    reconnecting: { dot: 'yellow', text: 'Reconectando...' },
    streaming:  { dot: 'green',  text: 'Transmitindo' },
    error:      { dot: 'red',    text: 'Erro' },
  };
  const s = map[state] || map.idle;
  elHeaderDot.className   = `dot ${s.dot}`;
  elHeaderText.textContent = s.text;
}

function showError(msg) {
  elErrorBanner.textContent = `⚠️ ${msg}`;
  elErrorBanner.classList.add('visible');
}

function clearError() {
  elErrorBanner.textContent = '';
  elErrorBanner.classList.remove('visible');
}

function resetPipeline() {
  ['stage-capture-fps','stage-encode-fps','stage-send-fps'].forEach((id) => setText(id, '— fps'));
  setText('stage-viewers-count', '—');
  ['stage-capture','stage-encode','stage-send','stage-viewers'].forEach((id) => {
    const el = $(id);
    if (el) { el.classList.remove('active','error'); }
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function updateUI() {
  if (!bridge) {
    showError('Bridge de controle não disponível. Reinicie o aplicativo.');
    if (elBtnStartStop) elBtnStartStop.disabled = true;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
