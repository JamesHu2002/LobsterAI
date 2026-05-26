import { EventEmitter } from 'events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: mocks.spawn,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(),
    quit: vi.fn(),
  },
  session: {
    defaultSession: {
      fetch: vi.fn(),
    },
  },
}));

import {
  buildWindowsUpdateLauncherArgs,
  spawnDetachedWindowsUpdateLauncher,
} from './appUpdateInstaller';

function createChildProcess(pid = 1234): EventEmitter & { pid?: number; unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

beforeEach(() => {
  mocks.spawn.mockReset();
});

describe('Windows update launcher', () => {
  test('builds hidden PowerShell launcher arguments', () => {
    expect(buildWindowsUpdateLauncherArgs('C:\\Temp\\lobsterai update.ps1')).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      'C:\\Temp\\lobsterai update.ps1',
    ]);
  });

  test('spawns detached hidden PowerShell and resolves after the process starts', async () => {
    const child = createChildProcess(4321);
    mocks.spawn.mockReturnValue(child);

    const result = spawnDetachedWindowsUpdateLauncher('C:\\Temp\\lobsterai update.ps1');

    expect(mocks.spawn).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        'C:\\Temp\\lobsterai update.ps1',
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );

    child.emit('spawn');

    await expect(result).resolves.toBe(4321);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  test('rejects when PowerShell spawn throws synchronously', async () => {
    const error = new Error('powershell is unavailable');
    mocks.spawn.mockImplementation(() => {
      throw error;
    });

    await expect(spawnDetachedWindowsUpdateLauncher('C:\\Temp\\update.ps1')).rejects.toBe(error);
  });

  test('rejects when PowerShell emits a launch error', async () => {
    const child = createChildProcess();
    const error = new Error('blocked by policy');
    mocks.spawn.mockReturnValue(child);

    const result = spawnDetachedWindowsUpdateLauncher('C:\\Temp\\update.ps1');
    child.emit('error', error);

    await expect(result).rejects.toBe(error);
    expect(child.unref).not.toHaveBeenCalled();
  });
});
