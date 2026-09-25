const $ = (id) => document.getElementById(id);

let currentTab = 'screens';
let allSources = [];
let selectedSourceId = null;

function getBridge() {
  return window.discordScreenRailway || window.electronAPI || null;
}

async function init() {
  setupTabs();
  setupActions();
  await loadSources();
}

function setupTabs() {
  $('tab-screens')?.addEventListener('click', () => switchTab('screens'));
  $('tab-windows')?.addEventListener('click', () => switchTab('windows'));
}

function switchTab(tab) {
  currentTab = tab;
  $('tab-screens')?.classList.toggle('active', tab === 'screens');
  $('tab-windows')?.classList.toggle('active', tab === 'windows');

  const isScreen = tab === 'screens';
  const textEl = $('audio-toggle-text');
  const subEl = $('audio-toggle-sub');
  const includeDiscordLabel = $('label-include-discord');

  if (isScreen) {
    if (textEl) textEl.textContent = 'Compartilhar áudio do sistema';
    if (subEl) subEl.textContent = 'Transmite áudio do computador (jogos, YouTube, músicas) sem a chamada do Discord.';
    if (includeDiscordLabel) includeDiscordLabel.style.display = 'inline-flex';
  } else {
    if (textEl) textEl.textContent = 'Compartilhar áudio do aplicativo';
    if (subEl) subEl.textContent = 'Transmite o áudio gerado exclusivamente pela janela escolhida.';
    if (includeDiscordLabel) includeDiscordLabel.style.display = 'none';
  }

  selectedSourceId = null;
  const shareBtn = $('btn-share');
  if (shareBtn) shareBtn.disabled = true;

  renderSources();
}

async function loadSources() {
  const bridge = getBridge();
  if (!bridge || typeof bridge.getMediaSources !== 'function') {
    console.error('Bridge não disponível para obter fontes');
    return;
  }

  try {
    allSources = await bridge.getMediaSources();
    renderSources();
  } catch (err) {
    console.error('Erro ao carregar fontes:', err);
  }
}

function renderSources() {
  const container = $('sources-grid');
  if (!container) return;
  container.innerHTML = '';

  const isScreen = currentTab === 'screens';
  const filtered = allSources.filter((s) => (isScreen ? s.id.startsWith('screen:') : s.id.startsWith('window:')));

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 40px 0;">
        Nenhum ${isScreen ? 'monitor' : 'aplicativo'} encontrado.
      </div>
    `;
    return;
  }

  for (const src of filtered) {
    const card = document.createElement('div');
    card.className = 'source-card' + (src.id === selectedSourceId ? ' selected' : '');
    card.dataset.id = src.id;

    const img = document.createElement('img');
    img.className = 'source-thumb';
    img.src = src.thumbnailDataUrl || '';
    img.alt = src.name;

    const info = document.createElement('div');
    info.className = 'source-info';

    if (src.appIconDataUrl) {
      const icon = document.createElement('img');
      icon.className = 'source-icon';
      icon.src = src.appIconDataUrl;
      info.appendChild(icon);
    }

    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = src.name;
    name.title = src.name;
    info.appendChild(name);

    card.appendChild(img);
    card.appendChild(info);

    card.addEventListener('click', () => {
      selectedSourceId = src.id;
      document.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      const shareBtn = $('btn-share');
      if (shareBtn) shareBtn.disabled = false;
    });

    card.addEventListener('dblclick', () => {
      selectedSourceId = src.id;
      confirmShare();
    });

    container.appendChild(card);
  }
}

function setupActions() {
  $('btn-cancel')?.addEventListener('click', cancelShare);
  $('btn-close')?.addEventListener('click', cancelShare);
  $('btn-share')?.addEventListener('click', confirmShare);
}

function confirmShare() {
  if (!selectedSourceId) return;
  const bridge = getBridge();
  if (!bridge || typeof bridge.selectMediaSource !== 'function') return;

  const shareAudio = $('check-system-audio')?.checked ?? true;
  const includeDiscord = $('check-include-discord')?.checked ?? false;
  bridge.selectMediaSource({
    sourceId: selectedSourceId,
    shareAudio,
    excludeDiscord: !includeDiscord,
  });
}

function cancelShare() {
  const bridge = getBridge();
  if (bridge && typeof bridge.cancelMediaSource === 'function') {
    bridge.cancelMediaSource();
  }
}

window.addEventListener('DOMContentLoaded', init);
