import { spawn } from 'node:child_process';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscordDetector } from './discord-detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const EXCLUSION_STATES = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  CAPTURING: 'CAPTURING',
  ERROR: 'ERROR',
  STOPPED: 'STOPPED',
};

export class AudioExclusionManager extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.helperPath] Custom path to DCSS.AudioCapture.exe
   * @param {DiscordDetector} [options.discordDetector]
   * @param {number} [options.sampleRate] Default 48000
   * @param {number} [options.channels] Default 2
   * @param {Function} [options.logger]
   */
  constructor(options = {}) {
    super();
    this.sampleRate = options.sampleRate || 48000;
    this.channels = options.channels || 2;
    this.logger = options.logger || console;

    this.helperPath =
      options.helperPath ||
      this._resolveDefaultHelperPath();

    this.discordDetector = options.discordDetector || new DiscordDetector();
    this._ownsDetector = !options.discordDetector;

    this.state = EXCLUSION_STATES.IDLE;
    this.childProcess = null;
    this.pipeClient = null;
    this.pipeName = null;
    this.currentExcludePid = null;
    this.currentIncludePid = null;
    this.stats = {
      bytesCaptured: 0,
      chunksCaptured: 0,
      startedAt: null,
      targetPid: null,
      isExcluding: false,
    };

    this._setupDetectorListeners();
  }

  _resolveDefaultHelperPath() {
    // 1. Prioritize unpacked location when running in packaged Electron
    const resourcesPath = process.resourcesPath || '';
    const unpackedInResources = resourcesPath
      ? path.join(resourcesPath, 'app.asar.unpacked', 'desktop', 'bin', 'DCSS.AudioCapture.exe')
      : '';
    const unpackedFromDir = __dirname.includes('app.asar')
      ? path.join(__dirname.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'), '..', 'bin', 'DCSS.AudioCapture.exe')
      : '';

    const candidates = [
      unpackedInResources,
      unpackedFromDir,
      path.join(process.cwd(), 'desktop', 'bin', 'DCSS.AudioCapture.exe'),
      path.join(resourcesPath, 'bin', 'DCSS.AudioCapture.exe'),
      path.join(__dirname, '..', 'bin', 'DCSS.AudioCapture.exe'),
      path.join(__dirname, 'DCSS.AudioCapture.exe'),
    ].filter(Boolean);

    for (const c of candidates) {
      // Ensure we NEVER return a path inside app.asar for process spawn
      if (!c.includes('app.asar\\') && !c.includes('app.asar/') && fs.existsSync(c)) {
        return c;
      }
    }

    // Fallback: if only asar candidate exists, convert to app.asar.unpacked
    for (const c of candidates) {
      const unpacked = c.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
      if (fs.existsSync(unpacked)) return unpacked;
      if (fs.existsSync(c)) return c;
    }

    return candidates[0];
  }

  _setupDetectorListeners() {
    this.discordDetector.on('restarted', async ({ newPid }) => {
      // Se a captura é isolada para uma janela específica (includePid), o Discord não interfere
      if (this.currentIncludePid) return;
      if (this.state === EXCLUSION_STATES.CAPTURING && this.currentExcludePid !== newPid) {
        this.logger.info(`[AudioExclusionManager] Discord reiniciado (novo PID: ${newPid}). Reconstruindo captura...`);
        try {
          await this.restartWithPid(newPid);
        } catch (err) {
          this.logger.error('[AudioExclusionManager] Erro ao reconstruir captura após reinício do Discord:', err);
        }
      }
    });

    this.discordDetector.on('started', async (state) => {
      // Se a captura é isolada para uma janela específica (includePid), o Discord não interfere
      if (this.currentIncludePid) return;
      if (this.state === EXCLUSION_STATES.CAPTURING && !this.currentExcludePid && state.rootPid) {
        this.logger.info(`[AudioExclusionManager] Discord aberto durante transmissão (PID: ${state.rootPid}). Ativando exclusão...`);
        try {
          await this.restartWithPid(state.rootPid);
        } catch (err) {
          this.logger.error('[AudioExclusionManager] Erro ao ativar exclusão para Discord recém-iniciado:', err);
        }
      }
    });
  }

  getState() {
    return {
      state: this.state,
      currentExcludePid: this.currentExcludePid,
      currentIncludePid: this.currentIncludePid || null,
      stats: { ...this.stats },
      helperExists: fs.existsSync(this.helperPath),
    };
  }

  /**
   * Starts process loopback capture excluding Discord if running, or targeting a window PID.
   *
   * @param {Object} [params]
   * @param {number} [params.forcePid] Explicit PID to exclude
   * @param {number} [params.includePid] Explicit PID to isolate for capture (window audio)
   * @param {boolean} [params.excludeDiscord] Default true
   * @returns {Promise<boolean>}
   */
  async start(params = {}) {
    if (this.state === EXCLUSION_STATES.CAPTURING) {
      this.logger.warn('[AudioExclusionManager] Captura já está ativa.');
      return true;
    }

    if (this._ownsDetector) {
      this.discordDetector.start();
    }

    const includePid = params.includePid ? Number(params.includePid) : null;
    let targetPid = params.forcePid;
    const shouldExclude = params.excludeDiscord !== false;

    if (!includePid && shouldExclude && !targetPid) {
      const discordState = await this.discordDetector.check();
      if (discordState.isRunning && discordState.rootPid) {
        targetPid = discordState.rootPid;
        this.logger.info(`[AudioExclusionManager] Discord detectado (PID: ${targetPid}, sabor: ${discordState.flavor}). Exclusão ativada.`);
      } else {
        this.logger.info('[AudioExclusionManager] Discord não está em execução no momento.');
      }
    }

    if (!fs.existsSync(this.helperPath)) {
      const msg = `Executável do capturador não encontrado em: ${this.helperPath}`;
      this.logger.error(`[AudioExclusionManager] ${msg}`);
      this.state = EXCLUSION_STATES.ERROR;
      this.emit('error', new Error(msg));
      return false;
    }

    this.state = EXCLUSION_STATES.STARTING;
    this.currentExcludePid = (!includePid && targetPid) ? targetPid : null;
    this.currentIncludePid = includePid || null;
    this.pipeName = `dcss_loopback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const args = [
      '--pipe', this.pipeName,
      '--parent-pid', String(process.pid),
      '--sample-rate', String(this.sampleRate),
      '--channels', String(this.channels),
    ];

    if (includePid) {
      args.push('--include-pid', String(includePid));
    } else {
      // WASAPI process loopback requires a non-zero TargetProcessId.
      // If Discord is not running or not excluded, exclude the Broadcaster app itself (process.pid),
      // which captures ALL system audio without failing with 0x80070057.
      const excludePidToUse = targetPid || process.pid;
      args.push('--exclude-pid', String(excludePidToUse));
    }

    this.logger.info(`[AudioExclusionManager] Iniciando ${path.basename(this.helperPath)} ${args.join(' ')}`);

    try {
      this.childProcess = spawn(this.helperPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const child = this.childProcess;

      this.childProcess.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (text) this.logger.info(`[DCSS.AudioCapture] ${text}`);
      });

      this.childProcess.on('exit', (code, signal) => {
        if (this.childProcess !== child) return;
        this.logger.info(`[AudioExclusionManager] Processo auxiliar encerrou (code: ${code}, signal: ${signal})`);
        this._cleanupProcess();
        if (this.state === EXCLUSION_STATES.CAPTURING || this.state === EXCLUSION_STATES.STARTING) {
          this.state = EXCLUSION_STATES.STOPPED;
          this.emit('stopped');
        }
      });

      this.childProcess.on('error', (err) => {
        if (this.childProcess !== child) return;
        this.logger.error('[AudioExclusionManager] Erro no processo auxiliar:', err);
        this.state = EXCLUSION_STATES.ERROR;
        this.emit('error', err);
      });

      // Wait briefly for helper to initialize pipe server, then connect with retries
      await this._connectToPipeWithRetry(`\\\\.\\pipe\\${this.pipeName}`, 3000);

      if (this.childProcess !== child || this.state === EXCLUSION_STATES.STOPPED) return false;

      this.state = EXCLUSION_STATES.CAPTURING;
      this.stats.startedAt = Date.now();
      this.stats.targetPid = targetPid || null;
      this.stats.includePid = includePid || null;
      this.stats.isExcluding = Boolean(targetPid && !includePid);

      this.emit('started', {
        isExcluding: this.stats.isExcluding,
        targetPid: this.stats.targetPid,
        includePid: this.stats.includePid,
        sampleRate: this.sampleRate,
        channels: this.channels,
      });

      return true;
    } catch (err) {
      this.logger.error('[AudioExclusionManager] Falha ao iniciar captura:', err);
      this.stop();
      this.state = EXCLUSION_STATES.ERROR;
      this.emit('error', err);
      return false;
    }
  }

  async restartWithPid(newPid) {
    if (this.currentIncludePid) return false;
    await this.stop();
    return await this.start({ forcePid: newPid, excludeDiscord: true });
  }

  async stop() {
    this.state = EXCLUSION_STATES.STOPPED;

    if (this._ownsDetector) {
      this.discordDetector.stop();
    }

    if (this.pipeClient) {
      try {
        this.pipeClient.destroy();
      } catch {}
      this.pipeClient = null;
    }

    this._cleanupProcess();
    this.currentExcludePid = null;
    this.currentIncludePid = null;
    this.pipeName = null;
    this.emit('stopped');
  }

  _cleanupProcess() {
    if (this.childProcess) {
      try {
        if (!this.childProcess.killed) {
          this.childProcess.kill('SIGTERM');
        }
      } catch {}
      this.childProcess = null;
    }
  }

  _connectToPipeWithRetry(fullPipePath, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const tryConnect = () => {
        if (this.state === EXCLUSION_STATES.STOPPED) {
          return reject(new Error('Cancelado pelo encerramento.'));
        }

        const client = net.connect(fullPipePath, () => {
          this.logger.info(`[AudioExclusionManager] Conectado ao pipe de captura: ${fullPipePath}`);
          this.pipeClient = client;

          client.on('data', (chunk) => {
            this.stats.bytesCaptured += chunk.length;
            this.stats.chunksCaptured++;
            this.emit('data', chunk);
          });

          client.on('error', (err) => {
            this.logger.warn(`[AudioExclusionManager] Erro no pipe de captura: ${err.message}`);
          });

          client.on('close', () => {
            this.logger.info('[AudioExclusionManager] Pipe de captura fechado.');
          });

          resolve();
        });

        client.on('error', (err) => {
          client.destroy();
          if (Date.now() - startTime < timeoutMs) {
            setTimeout(tryConnect, 100);
          } else {
            reject(new Error(`Timeout (${timeoutMs}ms) conectando ao pipe ${fullPipePath}: ${err.message}`));
          }
        });
      };

      // Initial small delay to let helper start up
      setTimeout(tryConnect, 80);
    });
  }
}
