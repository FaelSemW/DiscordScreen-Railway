import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronBinary from 'electron';

const requested = process.argv.find(arg => arg.startsWith('--seconds='));
const seconds = Math.max(75, Number(requested?.split('=')[1]) || 75);
const env = { ...process.env, DCSS_SOAK_SECONDS: String(seconds) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, [fileURLToPath(new URL('./native-runtime-soak.mjs', import.meta.url))], {
  env, windowsHide: true, stdio: 'inherit',
});
const timeout = setTimeout(() => {
  console.error('Soak test exceeded its deadline.');
  child.kill();
  process.exitCode = 1;
}, (seconds + 60) * 1000);
child.on('error', error => { console.error(error); clearTimeout(timeout); process.exitCode = 1; });
child.on('close', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
