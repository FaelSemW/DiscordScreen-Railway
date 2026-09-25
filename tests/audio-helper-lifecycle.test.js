import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
import { spawn } from 'node:child_process';
import { AudioExclusionManager } from '../desktop/main/audio-exclusion-manager.js';

describe('Native audio helper restarts', () => {
  it('ignores delayed exit/error events from the previous helper', async () => {
    const children = [];
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      children.push(child);
      return child;
    });
    const detector = new EventEmitter();
    detector.check = async () => ({ isRunning: false });
    const manager = new AudioExclusionManager({
      helperPath: process.execPath, discordDetector: detector,
      logger: { info() {}, warn() {}, error() {} },
    });
    manager.on('error', () => {});
    manager._connectToPipeWithRetry = vi.fn().mockResolvedValue();
    await manager.start({ excludeDiscord: false });
    await manager.stop();
    await manager.start({ excludeDiscord: false });
    children[0].emit('exit', 0, null);
    children[0].emit('error', new Error('delayed old-process failure'));
    expect(manager.childProcess).toBe(children[1]);
    expect(manager.state).toBe('CAPTURING');
    expect(children[1].kill).not.toHaveBeenCalled();
    await manager.stop();
  });
});
