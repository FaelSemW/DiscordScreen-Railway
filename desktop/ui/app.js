const $ = (id) => document.getElementById(id);

function getBridge() {
  return window.dcScreenSharing || window.discordScreenRailway || window.electronAPI || null;
}

let currentConfig = null;
let currentState = null;
let broadcasterState = null;
let broadcasterStats = null;

async function init() {
  setupNavigation();
  setupEvents();

  const bridge = getBridge();
  if (!bridge) {
    console.error('[BRIDGE] Bridge interno indisponível.');
    return;
  }

  try {
    currentConfig = await bridge.getConfig();
    currentState = await bridge.getState();

    populateConfigForm();
    updateUi();

    bridge.onStateChange((state) => {
      currentState = state;
      updateUi();
    });

    bridge.onBroadcasterState?.((state) => {
      broadcasterState = state;
      updateBroadcasterUi();
    });

    bridge.onBroadcasterStats?.((stats) => {
      broadcasterStats = stats;
      updateDiagnosticsUi();
    });

    bridge.onLogLine((line) => {
      const box = $('logs-content');
      if (box) {
        box.textContent += `${line}\n`;
        box.scrollTop = box.scrollHeight;
      }
    });

    // Make sure services are running
    bridge.startServices().catch(() => {});
  } catch (err) {
    console.error('[INIT] Erro ao inicializar UI:', err);
  }
}

function setupNavigation() {
  const navBtns = [
    { id: 'btn-header-home', view: 'dashboard' },
    { id: 'btn-header-config', view: 'config' },
    { id: 'btn-header-diagnostics', view: 'diagnostics' },
    { id: 'btn-header-logs', view: 'logs' },
  ];

  for (const { id, view } of navBtns) {
    $(id)?.addEventListener('click', () => {
      showView(view);
      for (const btn of navBtns) {
        const el = $(btn.id);
        if (el) {
          el.className = btn.view === view ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
        }
      }
      if (view === 'diagnostics') refreshDiagnostics();
      if (view === 'logs') refreshLogs();
    });
  }
}

function showView(viewName) {
  $('view-dashboard')?.classList.toggle('hidden', viewName !== 'dashboard');
  $('view-config')?.classList.toggle('hidden', viewName !== 'config');
  $('view-diagnostics')?.classList.toggle('hidden', viewName !== 'diagnostics');
  $('view-logs')?.classList.toggle('hidden', viewName !== 'logs');
}

function updateUi() {
  if (!currentState) return;

  const bridge = getBridge();
  const sRunning = currentState.serverRunning || currentState.serverState === 'ready';
  const cConnected = currentState.tunnelRunning || currentState.cloudflareState === 'connected';

  // 1. Servidor Local
  const localPort = currentState.localPort || 3000;
  if ($('status-server-url')) $('status-server-url').textContent = `127.0.0.1:${localPort}`;
  const sBadge = $('badge-server-status');
  const sText = $('text-server-status');
  if (sBadge && sText) {
    if (sRunning) {
      sBadge.className = 'status-badge connected';
      sText.textContent = 'ONLINE (127.0.0.1)';
    } else {
      sBadge.className = 'status-badge error';
      sText.textContent = currentState.serverState?.toUpperCase() || 'PARADO';
    }
  }

  // 2. Cloudflare Tunnel
  const publicUrl = currentState.publicUrl || '';
  let cfHost = 'trycloudflare.com';
  try {
    if (publicUrl) cfHost = new URL(publicUrl).hostname;
  } catch {}

  if ($('status-cf-host')) $('status-cf-host').textContent = cfHost;
  const cBadge = $('badge-cf-status');
  const cText = $('text-cf-status');
  if (cBadge && cText) {
    if (cConnected) {
      cBadge.className = 'status-badge connected';
      cText.textContent = 'CONNECTED';
    } else if (currentState.cloudflareState === 'starting') {
      cBadge.className = 'status-badge connecting';
      cText.textContent = 'CONNECTING...';
    } else {
      cBadge.className = 'status-badge error';
      cText.textContent = currentState.cloudflareState?.toUpperCase() || 'DESCONECTADO';
    }
  }

  // 3. URLs
  const inputPublic = $('input-public-url');
  if (inputPublic) {
    inputPublic.value = publicUrl || (sRunning ? `http://127.0.0.1:${localPort}` : '');
  }

  const inputCallback = $('input-discord-callback');
  if (inputCallback) {
    inputCallback.value = currentState.discordRedirect || (publicUrl ? `${publicUrl}/api/auth/discord/callback` : '');
  }

  const tunnelStatusLabel = $('label-tunnel-status');
  if (tunnelStatusLabel) {
    if (cConnected) {
      tunnelStatusLabel.textContent = '● Online (Cloudflare Tunnel)';
      tunnelStatusLabel.style.color = '#23a55a';
    } else {
      tunnelStatusLabel.textContent = '● Conectando túnel...';
      tunnelStatusLabel.style.color = '#f0b232';
    }
  }

  const toggleServerBtn = $('btn-toggle-server');
  if (toggleServerBtn) {
    toggleServerBtn.textContent = sRunning ? '⏹ Parar Servidor Local' : '▶ Iniciar Servidor Local';
  }

  updateBroadcasterUi();
  updateDiagnosticsUi();
}

function updateBroadcasterUi() {
  const bState = broadcasterState?.state || 'ready';
  const isStreaming = bState === 'streaming';

  const bBadge = $('badge-broadcaster-status');
  const bText = $('text-broadcaster-status');
  if (bBadge && bText) {
    if (isStreaming) {
      bBadge.className = 'status-badge connected';
      bText.textContent = 'TRANSMITINDO (60 FPS)';
    } else {
      bBadge.className = 'status-badge connected';
      bText.textContent = 'PRONTO';
    }
  }

  const diagBc = $('diag-bc-status');
  if (diagBc) diagBc.textContent = isStreaming ? 'TRANSMITINDO' : 'PRONTO';
}

function updateDiagnosticsUi() {
  if (!currentState) return;

  const sRunning = currentState.serverRunning || currentState.serverState === 'ready';
  const cConnected = currentState.tunnelRunning || currentState.cloudflareState === 'connected';

  if ($('diag-srv-status')) $('diag-srv-status').textContent = sRunning ? 'READY (127.0.0.1)' : 'STOPPED';
  if ($('diag-srv-addr')) $('diag-srv-addr').textContent = `127.0.0.1:${currentState.localPort || 3000}`;
  if ($('diag-cf-status')) $('diag-cf-status').textContent = cConnected ? 'CONNECTED' : (currentState.cloudflareState || 'OFF');
  if ($('diag-cf-url')) $('diag-cf-url').textContent = currentState.publicUrl || '—';
  if ($('diag-ws-status')) $('diag-ws-status').textContent = sRunning ? 'CONNECTED' : 'DISCONNECTED';

  if (broadcasterStats) {
    if ($('diag-fps-cap')) $('diag-fps-cap').textContent = `${broadcasterStats.capture?.fpsAdmitted ?? '—'} fps`;
    if ($('diag-fps-enc')) $('diag-fps-enc').textContent = `${broadcasterStats.encoder?.fps ?? '—'} fps`;
    if ($('diag-fps-sent')) $('diag-fps-sent').textContent = `${broadcasterStats.network?.fpsSent ?? '—'} fps`;
    if ($('diag-resolution')) $('diag-resolution').textContent = broadcasterStats.capture?.resolution || '1920x1080 (Máxima)';
  }

  if (currentConfig) {
    if ($('diag-client-id')) $('diag-client-id').textContent = currentConfig.discordClientId || 'Não configurado (Modo Web Direto)';
    if ($('diag-client-secret')) $('diag-client-secret').textContent = currentConfig.hasClientSecret ? 'Configurado (Criptografado DPAPI)' : 'Não configurado';
    if ($('diag-redirect-uri')) $('diag-redirect-uri').textContent = currentState.discordRedirect || '—';
  }
}

async function refreshDiagnostics() {
  const bridge = getBridge();
  if (!bridge) return;
  try {
    const diag = await bridge.getDiagnostics?.();
    if (diag?.discordConfiguration) {
      if ($('diag-client-id')) $('diag-client-id').textContent = diag.discordConfiguration.clientIdPresent ? diag.discordConfiguration.clientIdMasked : 'Não configurado';
      if ($('diag-client-secret')) $('diag-client-secret').textContent = diag.discordConfiguration.clientSecretPresent ? 'Armazenado no Windows DPAPI' : 'Não configurado';
    }
  } catch (err) {
    console.warn('Erro ao atualizar diagnósticos:', err);
  }
}

async function refreshLogs() {
  const bridge = getBridge();
  if (!bridge) return;
  try {
    const logs = await bridge.getRecentLogs();
    const box = $('logs-content');
    if (box) {
      box.textContent = logs.join('\n') + '\n';
      box.scrollTop = box.scrollHeight;
    }
  } catch {}
}

function populateConfigForm() {
  if (!currentConfig) return;
  if ($('cfg-port')) $('cfg-port').value = currentConfig.port || 3000;
  if ($('cfg-client-id')) $('cfg-client-id').value = currentConfig.discordClientId || '';
  if ($('cfg-client-secret')) $('cfg-client-secret').value = currentConfig.clientSecretMasked || '';
  if ($('cfg-custom-domain')) $('cfg-custom-domain').value = currentConfig.customDomain || '';
}

function setupEvents() {
  const bridge = getBridge();
  if (!bridge) return;

  // Copy Public URL
  $('btn-copy-public-url')?.addEventListener('click', () => {
    const url = $('input-public-url')?.value;
    if (url) {
      bridge.copyToClipboard(url);
      const btn = $('btn-copy-public-url');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ Copiado!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    }
  });

  // Open Viewer
  $('btn-open-viewer')?.addEventListener('click', () => {
    const url = $('input-public-url')?.value;
    if (url) bridge.openExternal(url);
  });

  // Copy Callback
  $('btn-copy-callback')?.addEventListener('click', () => {
    const cb = $('input-discord-callback')?.value;
    if (cb) {
      bridge.copyToClipboard(cb);
      const btn = $('btn-copy-callback');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ Copiado!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    }
  });

  // Open Discord Dev Portal
  $('btn-open-discord-dev')?.addEventListener('click', () => {
    bridge.openExternal('https://discord.com/developers/applications');
  });

  // Open Native Broadcaster
  $('btn-open-native-broadcaster')?.addEventListener('click', () => {
    bridge.openBroadcaster?.();
  });

  // Open Discord App
  $('btn-open-discord')?.addEventListener('click', () => {
    bridge.openDiscord?.();
  });

  // Restart Tunnel
  $('btn-restart-tunnel')?.addEventListener('click', async () => {
    const btn = $('btn-restart-tunnel');
    if (btn) btn.disabled = true;
    try {
      await bridge.restartTunnel?.();
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Toggle Server
  $('btn-toggle-server')?.addEventListener('click', async () => {
    const sRunning = currentState?.serverRunning || currentState?.serverState === 'ready';
    if (sRunning) {
      await bridge.stopServices?.();
    } else {
      await bridge.startServices?.();
    }
  });

  // Open Logs Folder
  $('btn-open-logs-folder')?.addEventListener('click', () => {
    bridge.openLogsFolder?.();
  });
  $('btn-open-logs-dir')?.addEventListener('click', () => {
    bridge.openLogsFolder?.();
  });

  // Copy Logs
  $('btn-copy-logs')?.addEventListener('click', () => {
    const box = $('logs-content');
    if (box?.textContent) {
      bridge.copyToClipboard(box.textContent);
      const btn = $('btn-copy-logs');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ Copiado!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    }
  });

  // Clear Logs
  $('btn-clear-logs')?.addEventListener('click', () => {
    const box = $('logs-content');
    if (box) box.textContent = '';
  });

  // Refresh Diagnostics
  $('btn-refresh-diagnostics')?.addEventListener('click', () => {
    refreshDiagnostics();
  });

  // Save Config
  $('btn-save-config')?.addEventListener('click', async () => {
    const patch = {
      port: Number($('cfg-port')?.value) || 3000,
      discordClientId: ($('cfg-client-id')?.value || '').trim(),
      customDomain: ($('cfg-custom-domain')?.value || '').trim(),
    };

    const secretVal = ($('cfg-client-secret')?.value || '').trim();
    if (secretVal && !secretVal.includes('••••')) {
      patch.discordClientSecret = secretVal;
    }

    const tokenVal = ($('cfg-tunnel-token')?.value || '').trim();
    if (tokenVal) {
      patch.cloudflareTunnelToken = tokenVal;
    }

    const res = await bridge.saveConfig(patch);
    if (res?.ok) {
      currentConfig = res.config;
      const btn = $('btn-save-config');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ Salvo com Sucesso!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    } else {
      alert(`Erro ao salvar: ${res?.error || 'Erro desconhecido'}`);
    }
  });

  // Reset Config
  $('btn-reset-all-config')?.addEventListener('click', async () => {
    if (confirm('Tem certeza de que deseja redefinir todas as configurações do aplicativo?')) {
      await bridge.resetConfig(false);
      location.reload();
    }
  });
}

// Métodos de contrato com o preload bridge
export async function validateCredentials(clientId, clientSecret) {
  const bridge = getBridge();
  if (!bridge) return { valid: false };
  return bridge.validateCredentials(clientId, clientSecret);
}

export async function confirmDiscordConfig(domain) {
  const bridge = getBridge();
  if (!bridge) return;
  return bridge.confirmDiscordConfig(domain);
}

export async function getRecentLogs() {
  const bridge = getBridge();
  if (!bridge) return [];
  return bridge.getRecentLogs();
}

window.addEventListener('DOMContentLoaded', init);

