import { execFile } from 'node:child_process';
import EventEmitter from 'node:events';

/**
 * Known Discord executable names and their flavors.
 */
export const DISCORD_VARIANTS = [
  { name: 'Discord.exe', flavor: 'Stable' },
  { name: 'DiscordPTB.exe', flavor: 'PTB' },
  { name: 'DiscordCanary.exe', flavor: 'Canary' },
  { name: 'DiscordDevelopment.exe', flavor: 'Development' },
];

/**
 * Regex ensuring executable path belongs to an official Discord desktop installation
 * and NOT our own application ("Discord Screen Railway.exe") or arbitrary electron/chromium.
 */
const DISCORD_PATH_REGEX = /[\\/]Discord(?:PTB|Canary|Development)?[\\/]/i;

/**
 * Enumerates running processes and identifies the Discord Desktop process tree.
 * Returns the root PID (whose parent is NOT another Discord process) and all children.
 *
 * @param {Object} [options]
 * @param {Function} [options.execFn] Mockable execFile for tests
 * @returns {Promise<{
 *   isRunning: boolean,
 *   flavor: string|null,
 *   rootPid: number|null,
 *   executablePath: string|null,
 *   childPids: number[],
 *   allPids: number[]
 * }>}
 */
export async function detectDiscordProcessTree(options = {}) {
  if (process.platform !== 'win32' && !options.execFn && !options.mockProcesses) {
    return {
      isRunning: false,
      flavor: null,
      rootPid: null,
      executablePath: null,
      childPids: [],
      allPids: [],
    };
  }

  let rawProcesses = [];

  if (options.mockProcesses) {
    rawProcesses = options.mockProcesses;
  } else {
    try {
      rawProcesses = await queryWindowsProcesses(options.execFn || execFile);
    } catch (err) {
      console.warn('[discord-detector] Falha ao consultar processos:', err.message);
      return {
        isRunning: false,
        flavor: null,
        rootPid: null,
        executablePath: null,
        childPids: [],
        allPids: [],
      };
    }
  }

  return parseDiscordProcessTree(rawProcesses);
}

/**
 * Queries Windows processes using PowerShell CimInstance.
 */
function queryWindowsProcesses(runner) {
  return new Promise((resolve, reject) => {
    const psScript = `
$procs = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '(?i)^discord(ptb|canary|development)?\\.exe$'
} | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath
$procs | ConvertTo-Json -Compress
`.trim();

    runner(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) return reject(error);
        const text = (stdout || '').trim();
        if (!text) return resolve([]);
        try {
          const parsed = JSON.parse(text);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

/**
 * Pure parsing logic separated for testability.
 */
export function parseDiscordProcessTree(processes) {
  if (!Array.isArray(processes) || processes.length === 0) {
    return {
      isRunning: false,
      flavor: null,
      rootPid: null,
      executablePath: null,
      childPids: [],
      allPids: [],
    };
  }

  // 1. Filter only legitimate Discord processes:
  // Must match known Discord executable name AND not be "Discord Screen Railway" or unrelated process.
  const discordProcesses = processes.filter((proc) => {
    if (!proc || !proc.Name) return false;
    const nameMatch = DISCORD_VARIANTS.find(
      (v) => v.name.toLowerCase() === String(proc.Name).toLowerCase(),
    );
    if (!nameMatch) return false;

    // Strict path verification if ExecutablePath is available
    if (proc.ExecutablePath) {
      if (!DISCORD_PATH_REGEX.test(proc.ExecutablePath)) return false;
      // Guarantee our own executable is never treated as Discord
      if (/Discord Screen Railway/i.test(proc.ExecutablePath)) return false;
    }

    return true;
  });

  if (discordProcesses.length === 0) {
    return {
      isRunning: false,
      flavor: null,
      rootPid: null,
      executablePath: null,
      childPids: [],
      allPids: [],
    };
  }

  const pidSet = new Set(discordProcesses.map((p) => Number(p.ProcessId)));
  const allPids = Array.from(pidSet);

  // 2. Determine root process:
  // The root Discord process has a ParentProcessId that is NOT another Discord process.
  let root = discordProcesses.find((p) => !pidSet.has(Number(p.ParentProcessId)));

  // If hierarchy is obscured, pick the lowest PID or first candidate
  if (!root) {
    root = discordProcesses[0];
  }

  const rootPid = Number(root.ProcessId);
  const childPids = allPids.filter((pid) => pid !== rootPid);

  const matchedVariant = DISCORD_VARIANTS.find(
    (v) => v.name.toLowerCase() === String(root.Name).toLowerCase(),
  );

  return {
    isRunning: true,
    flavor: matchedVariant ? matchedVariant.flavor : 'Stable',
    rootPid,
    executablePath: root.ExecutablePath || null,
    childPids,
    allPids,
  };
}

/**
 * Monitored detector class that periodically watches for Discord changes.
 */
export class DiscordDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.intervalMs = options.intervalMs || 3000;
    this._timer = null;
    this._lastState = {
      isRunning: false,
      flavor: null,
      rootPid: null,
      executablePath: null,
      childPids: [],
      allPids: [],
    };
  }

  getState() {
    return { ...this._lastState };
  }

  async check() {
    const nextState = await detectDiscordProcessTree(this.options);
    const prev = this._lastState;

    const wasRunning = prev.isRunning;
    const isNowRunning = nextState.isRunning;
    const prevPid = prev.rootPid;
    const nextPid = nextState.rootPid;

    this._lastState = nextState;

    if (!wasRunning && isNowRunning) {
      this.emit('started', nextState);
      this.emit('change', nextState);
    } else if (wasRunning && !isNowRunning) {
      this.emit('stopped', { previousPid: prevPid });
      this.emit('change', nextState);
    } else if (wasRunning && isNowRunning && prevPid !== nextPid) {
      this.emit('restarted', { previousPid: prevPid, newPid: nextPid, state: nextState });
      this.emit('change', nextState);
    }

    return nextState;
  }

  start() {
    if (this._timer) return;
    this.check().catch(() => {});
    this._timer = setInterval(() => {
      this.check().catch(() => {});
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
