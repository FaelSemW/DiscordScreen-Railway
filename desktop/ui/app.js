const $ = (id) => document.getElementById(id);

function getBridge() {
  return window.discordScreenRailway || window.electronAPI || null;
}

let currentConfig = null;
let currentState = null;

function showError(msg) {
  const errBox = $('credentials-error');
  if (errBox) {
    errBox.textContent = `⚠️ ${msg}`;
    errBox.classList.remove('hidden');
  }
}

function clearError() {
  const errBox = $('credentials-error');
  if (errBox) {
    errBox.textContent = '';
    errBox.classList.add('hidden');
  }
}

async function init() {
  setupNavigation();
  setupEvents();

  const bridge = getBridge();
  if (!bridge || typeof bridge.validateCredentials !== 'function') {
    console.error('[BRIDGE] Bridge interno indisponível:', bridge);
    showError('Não foi possível carregar o componente interno do aplicativo (Bridge indisponível).');
    const nextBtn = $('btn-wizard-step2-next');
    if (nextBtn) nextBtn.disabled = true;
    showView('wizard');
    showWizardStep(2);
    return;
  }

  try {
    // Load initial config & state
    currentConfig = await bridge.getConfig();
    currentState = await bridge.getState();

    updateUi();

    // Listen to state changes from main process
    bridge.onStateChange((state) => {
      currentState = state;
      updateUi();
    });

    // Listen to log lines
    bridge.onLogLine((line) => {
      const box = $('logs-content');
      if (box) {
        box.textContent += `${line}\n`;
        box.scrollTop = box.scrollHeight;
      }
    });

    // Initial check: if not configured or not confirmed, open wizard
    if (!currentConfig || !currentConfig.isConfigured || !currentConfig.firstRunCompleted) {
      showView('wizard');
      showWizardStep(1);
    } else {
      showView('dashboard');
      bridge.startServices();
    }
  } catch (err) {
    console.error('[INIT] Erro ao inicializar UI:', err);
    showError(`Erro de inicialização: ${err.message}`);
  }
}

function setupNavigation() {
  $('btn-header-home')?.addEventListener('click', () => showView('dashboard'));
  $('btn-header-wizard')?.addEventListener('click', () => {
    showView('wizard');
    showWizardStep(1);
  });
  $('btn-header-logs')?.addEventListener('click', async () => {
    showView('logs');
    const bridge = getBridge();
    if (!bridge) return;
    try {
      const logs = await bridge.getRecentLogs();
      const box = $('logs-content');
      if (box) {
        box.textContent = logs.join('\n') + '\n';
        box.scrollTop = box.scrollHeight;
      }
    } catch {
      // Ignore
    }
  });
}

function showView(viewName) {
  $('view-dashboard')?.classList.toggle('hidden', viewName !== 'dashboard');
  $('view-wizard')?.classList.toggle('hidden', viewName !== 'wizard');
  $('view-logs')?.classList.toggle('hidden', viewName !== 'logs');
}

function showWizardStep(stepNum) {
  $('wizard-step-1')?.classList.toggle('hidden', stepNum !== 1);
  $('wizard-step-2')?.classList.toggle('hidden', stepNum !== 2);
  $('wizard-step-3')?.classList.toggle('hidden', stepNum !== 3);

  if (stepNum === 2) {
    setTimeout(() => {
      const idInput = $('input-client-id');
      if (idInput) idInput.focus();
    }, 50);
  }
}

function setupEvents() {
  // Wizard Step 1 -> Step 2
  $('btn-wizard-step1-next')?.addEventListener('click', () => {
    clearError();
    if (currentConfig?.discordClientId) {
      $('input-client-id').value = currentConfig.discordClientId;
    }
    showWizardStep(2);
  });

  // Wizard Step 2 -> Back to Step 1
  $('btn-wizard-step2-back')?.addEventListener('click', () => {
    clearError();
    showWizardStep(1);
  });

  // Wizard Step 2 -> Step 3 (Validate & Save Credentials)
  const handleStep2Next = async (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();

    const bridge = getBridge();
    if (!bridge || typeof bridge.validateCredentials !== 'function') {
      showError('Componente interno indisponível. Reinicie o aplicativo.');
      return;
    }

    const nextBtn = $('btn-wizard-step2-next');
    const clientId = ($('input-client-id')?.value || '').trim().replace(/\s+/g, '');
    const clientSecret = ($('input-client-secret')?.value || '').trim();

    clearError();

    console.log('[WIZARD] Advance clicked');

    // UI loading state
    const originalText = nextBtn ? nextBtn.textContent : 'Avançar ➔';
    if (nextBtn) {
      nextBtn.disabled = true;
      nextBtn.textContent = '⏳ Salvando...';
    }

    let saveTimeout = null;
    let finished = false;

    const cleanup = () => {
      finished = true;
      if (saveTimeout) clearTimeout(saveTimeout);
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.textContent = originalText;
      }
    };

    saveTimeout = setTimeout(() => {
      if (!finished) {
        cleanup();
        showError('Tempo limite esgotado ao salvar credenciais. Tente novamente.');
      }
    }, 8000);

    try {
      // 1. Basic format validation
      console.log('[WIZARD] Validating credentials format');
      const validation = await bridge.validateCredentials({
        clientId,
        clientSecret: clientSecret || (currentConfig?.hasClientSecret ? undefined : ''),
      });

      if (!validation.valid) {
        const msg = Object.values(validation.errors)[0] || 'Credenciais inválidas.';
        console.warn('[WIZARD] Validation failed:', msg);
        cleanup();
        showError(msg);
        return;
      }

      console.log('[WIZARD] Sending credentials to Main process');
      const patch = { discordClientId: clientId };
      if (clientSecret) patch.discordClientSecret = clientSecret;

      const saveResult = await bridge.saveConfig(patch);
      console.log('[WIZARD] Save result received:', saveResult);

      if (!saveResult || saveResult.ok === false) {
        const msg = saveResult?.error || 'Não foi possível salvar as credenciais no computador.';
        cleanup();
        showError(msg);
        return;
      }

      currentConfig = await bridge.getConfig();
      cleanup();

      console.log('[WIZARD] Transitioning to portal setup screen');
      showWizardStep(3);
    } catch (err) {
      console.error('[WIZARD] Erro ao salvar credenciais:', err);
      cleanup();
      showError(`Erro ao salvar: ${err.message || 'Falha na comunicação com o processo principal.'}`);
    }
  };

  $('btn-wizard-step2-next')?.addEventListener('click', handleStep2Next);

  // Allow Enter key in inputs to trigger Next
  $('input-client-id')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      $('input-client-secret')?.focus();
    }
  });
  $('input-client-secret')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleStep2Next(e);
    }
  });

  // Wizard Step 3 -> Back to Step 2
  $('btn-wizard-step3-back')?.addEventListener('click', () => {
    showWizardStep(2);
  });

  // Wizard Step 3 -> Toggle Finish Button
  $('check-portal-confirmed')?.addEventListener('change', (e) => {
    $('btn-wizard-step3-finish').disabled = !e.target.checked;
  });

  // Wizard Step 3 -> Finish
  $('btn-wizard-step3-finish')?.addEventListener('click', async () => {
    const bridge = getBridge();
    if (!bridge) return;

    const finishBtn = $('btn-wizard-step3-finish');
    const origText = finishBtn ? finishBtn.textContent : 'Concluir e Conectar ➔';
    if (finishBtn) {
      finishBtn.disabled = true;
      finishBtn.textContent = '⏳ Conectando...';
    }

    try {
      await bridge.confirmDiscordConfig('https://zaprecovery.online');
      await bridge.startServices();
      showView('dashboard');
    } catch (err) {
      console.error('[WIZARD] Erro ao concluir assistente:', err);
      alert(`Erro ao iniciar serviços: ${err.message}`);
    } finally {
      if (finishBtn) {
        finishBtn.disabled = false;
        finishBtn.textContent = origText;
      }
    }
  });

  // Copy portal values
  $('btn-copy-portal-target')?.addEventListener('click', () => {
    getBridge()?.copyToClipboard('zaprecovery.online');
  });

  $('btn-copy-portal-redirect')?.addEventListener('click', () => {
    getBridge()?.copyToClipboard('https://zaprecovery.online/auth/callback');
  });

  $('btn-copy-target')?.addEventListener('click', () => {
    getBridge()?.copyToClipboard('https://zaprecovery.online');
  });

  // Start Transmission
  $('btn-start-transmission')?.addEventListener('click', async () => {
    await getBridge()?.openCapturePage();
  });

  // Open Discord
  $('btn-open-discord')?.addEventListener('click', async () => {
    await getBridge()?.openDiscord();
  });

  // Change Application
  $('btn-change-app')?.addEventListener('click', () => {
    clearError();
    showView('wizard');
    showWizardStep(2);
  });

  // Reset Config
  $('btn-reset-config')?.addEventListener('click', async () => {
    if (confirm('Tem certeza que deseja redefinir todas as configurações do Discord Screen Railway?')) {
      clearError();
      const bridge = getBridge();
      if (bridge) {
        await bridge.resetConfig(false);
        currentConfig = await bridge.getConfig();
      }
      if ($('input-client-id')) $('input-client-id').value = '';
      if ($('input-client-secret')) $('input-client-secret').value = '';
      if ($('check-portal-confirmed')) $('check-portal-confirmed').checked = false;
      showView('wizard');
      showWizardStep(1);
    }
  });

  // Copy Logs
  $('btn-copy-logs')?.addEventListener('click', async () => {
    const bridge = getBridge();
    if (!bridge) return;
    const logs = await bridge.getRecentLogs();
    bridge.copyToClipboard(logs.join('\n'));
    alert('Logs copiados para a área de transferência!');
  });
}

function updateUi() {
  if (!currentState) return;

  const isReady = currentState.state === 'ready';

  // Server badge
  const serverBadge = $('badge-server-status');
  const serverText = $('text-server-status');
  if (serverBadge && serverText) {
    serverBadge.className = `status-badge ${isReady ? 'connected' : 'connecting'}`;
    serverText.textContent = isReady ? 'Conectado' : 'Conectando...';
  }

  // Discord badge
  const discordValue = $('status-client-id');
  const discordBadge = $('badge-discord-status');
  const discordText = $('text-discord-status');
  if (discordValue && discordBadge && discordText) {
    if (currentConfig?.discordClientId) {
      discordValue.textContent = `ID: ${currentConfig.discordClientId.slice(0, 4)}••••${currentConfig.discordClientId.slice(-4)}`;
      discordBadge.className = 'status-badge connected';
      discordText.textContent = 'Configurada';
    } else {
      discordValue.textContent = 'Não configurada';
      discordBadge.className = 'status-badge error';
      discordText.textContent = 'Pendente';
    }
  }

  // Stream badge
  const streamBadge = $('badge-stream-status');
  const streamText = $('text-stream-status');
  if (streamBadge && streamText) {
    streamBadge.className = `status-badge ${isReady ? 'connected' : 'connecting'}`;
    streamText.textContent = isReady ? 'Pronta' : 'Aguardando';
  }
}

document.addEventListener('DOMContentLoaded', init);
