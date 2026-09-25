import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const electronBinary = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const runnerFile = path.join(projectRoot, 'tests', 'physical-validation-runner.cjs');

console.log('[RUNNER] Launching physical validation via Electron...');
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = execFile(
  electronBinary,
  [runnerFile],
  { cwd: projectRoot, timeout: 90000, env: childEnv }
);

child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));

child.on('close', (code) => {
  console.log(`[RUNNER] Electron physical validation finished with code ${code}`);
  process.exit(code || 0);
});
