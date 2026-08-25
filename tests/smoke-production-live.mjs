import { WebSocket } from 'ws';

async function runLiveSmokeTests() {
  console.log('==================================================');
  console.log('LIVE PRODUCTION SMOKE TESTS: https://zaprecovery.online');
  console.log('==================================================\n');

  console.log('--- 1. HTTP Endpoints ---');
  const endpoints = [
    '/api/health',
    '/',
    '/share.html',
    '/privacy.html',
    '/terms.html',
    '/api/config',
  ];

  for (const ep of endpoints) {
    const url = 'https://zaprecovery.online' + ep;
    const res = await fetch(url);
    const contentType = res.headers.get('content-type') || '';
    let preview = '';
    if (contentType.includes('json')) {
      preview = JSON.stringify(await res.json());
    } else if (contentType.includes('html')) {
      const text = await res.text();
      preview = `HTML (${text.length} bytes)`;
    } else {
      preview = `(${res.statusText})`;
    }
    console.log(`${ep.padEnd(15)} -> HTTP ${res.status} [${contentType.split(';')[0]}] ${preview}`);
  }

  console.log('\n--- 2. /control Security Validation ---');
  const wsControl = new WebSocket('wss://zaprecovery.online/control');
  const controlResult = await new Promise((resolve) => {
    wsControl.on('open', () => resolve('VULNERABLE_OPENED'));
    wsControl.on('unexpected-response', (_req, res) => resolve(`REJECTED_HTTP_${res.statusCode}`));
    wsControl.on('error', (err) => resolve(`ERROR_${err.message}`));
  });
  console.log(`Unauthenticated wss://zaprecovery.online/control -> ${controlResult}`);

  console.log('\n--- 3. Activity Frontend Wave 1 Bundle Check ---');
  const indexHtml = await (await fetch('https://zaprecovery.online/')).text();
  const scriptMatch = indexHtml.match(/\/assets\/index-[^"']+\.js/);
  console.log('Active production bundle:', scriptMatch ? scriptMatch[0] : 'not found');
  if (scriptMatch) {
    const bundleText = await (await fetch('https://zaprecovery.online' + scriptMatch[0])).text();
    const hasDiagnostics = bundleText.includes('videoSizeChanges') && bundleText.includes('fullGridRebuilds');
    const hasDataSlot = bundleText.includes('dataset.slot') || bundleText.includes('data-slot');
    console.log('Contains __DIAGNOSTICS (videoSizeChanges & fullGridRebuilds):', hasDiagnostics);
    console.log('Contains targeted dataset.slot handling:', hasDataSlot);
  }

  console.log('\n--- 4. Authenticated /ws Endpoint Availability ---');
  const wsApp = new WebSocket('wss://zaprecovery.online/ws');
  const wsResult = await new Promise((resolve) => {
    wsApp.on('open', () => resolve('OPENED_WITHOUT_TOKEN'));
    wsApp.on('unexpected-response', (_req, res) => resolve(`REJECTED_HTTP_${res.statusCode}`));
    wsApp.on('error', (err) => resolve(`ERROR_${err.message}`));
    wsApp.on('close', (code) => resolve(`CLOSED_${code}`));
  });
  console.log(`Unauthenticated /ws check -> ${wsResult} (Expected 401/error without token)`);

  console.log('\n==================================================');
  console.log('LIVE SMOKE TESTS COMPLETED');
  console.log('==================================================');
}

runLiveSmokeTests().catch((err) => {
  console.error('Fatal smoke test error:', err);
  process.exit(1);
});
