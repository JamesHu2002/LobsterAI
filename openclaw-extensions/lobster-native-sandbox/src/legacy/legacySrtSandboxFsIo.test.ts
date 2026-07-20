import { describe, expect, test, vi } from 'vitest';

import { SandboxFsErrorCode } from '../fs/sandboxFsError.js';
import type { NativeSandboxExecutor } from '../runtime/nativeSandboxExecutor.js';
import { LegacySrtSandboxFsIo } from './legacySrtSandboxFsIo.js';

const createIo = () => {
  const dispose = vi.fn();
  let stagedFileIndex = 0;
  const stageInput = vi.fn(async () => {
    stagedFileIndex += 1;
    return {
      filePath: `C:\\private\\staged-${stagedFileIndex}.bin`,
      dispose,
    };
  });
  const runIsolatedCommand = vi.fn(async () => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
  }));
  const io = new LegacySrtSandboxFsIo({
    executor: { runIsolatedCommand, stageInput } as unknown as NativeSandboxExecutor,
    workspaceDir: 'D:\\workspace',
    sessionKey: 'session-1',
  });
  return { dispose, io, runIsolatedCommand, stageInput };
};

describe('LegacySrtSandboxFsIo', () => {
  test('stages file bytes and keeps raw paths out of the shell command', async () => {
    const {
      dispose,
      io,
      runIsolatedCommand,
      stageInput,
    } = createIo();
    const targetPath = 'D:\\workspace\\folder with spaces\\secret.txt';
    const data = Buffer.from('hello');

    await io.writeFileAtomic({
      filePath: targetPath,
      data,
      mkdir: true,
    });

    const call = runIsolatedCommand.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      workspaceDir: 'D:\\workspace',
      cwd: 'D:\\workspace',
      allowFailure: true,
      sessionKey: 'session-1',
      binShell: {
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
        ],
      },
    });
    expect(call?.command).not.toContain(targetPath);
    expect(call?.command).not.toContain('C:\\private\\staged-2.bin');
    expect(call?.command).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(stageInput).toHaveBeenNthCalledWith(1, {
      data,
      workspaceDir: 'D:\\workspace',
    });
    const request = JSON.parse(
      (stageInput.mock.calls[1]?.[0]?.data as Buffer).toString('utf8'),
    );
    expect(request).toEqual({
      operation: 'write',
      firstPath: targetPath,
      secondPath: '',
      inputPath: 'C:\\private\\staged-1.bin',
      options: { mkdir: true },
    });
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  test('returns binary reads without text conversion', async () => {
    const { io, runIsolatedCommand } = createIo();
    const expected = Buffer.from([0, 1, 2, 255]);
    runIsolatedCommand.mockResolvedValueOnce({
      stdout: expected,
      stderr: Buffer.alloc(0),
      code: 0,
    });

    await expect(io.readFile('D:\\workspace\\binary.dat')).resolves.toEqual(expected);
  });

  test('validates directory enumeration output from the restricted helper', async () => {
    const { io, runIsolatedCommand } = createIo();
    runIsolatedCommand.mockResolvedValueOnce({
      stdout: Buffer.from('["a.txt","folder"]'),
      stderr: Buffer.alloc(0),
      code: 0,
    });

    await expect(io.listDirectory('D:\\workspace')).resolves.toEqual([
      'a.txt',
      'folder',
    ]);
  });

  test('maps restricted-account access failures to a stable bridge error', async () => {
    const { io, runIsolatedCommand } = createIo();
    runIsolatedCommand.mockResolvedValueOnce({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('{"code":"EACCES"}'),
      code: 1,
    });

    await expect(io.readFile('D:\\workspace\\denied.txt')).rejects.toMatchObject({
      code: SandboxFsErrorCode.IoError,
    });
  });
});
