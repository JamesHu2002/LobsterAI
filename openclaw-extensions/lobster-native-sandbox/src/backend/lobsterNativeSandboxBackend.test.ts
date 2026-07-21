import { describe, expect, test, vi } from 'vitest';

import { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import type { SandboxFsIo } from '../fs/sandboxFsIo.js';
import type { NativeSandboxExecutor } from '../runtime/nativeSandboxExecutor.js';
import { createLobsterNativeSandboxBackendFactory } from './lobsterNativeSandboxBackend.js';

const createHarness = () => {
  const io = {} as SandboxFsIo;
  const prepareWorkspace = vi.fn(async () => undefined);
  const wrapCommand = vi.fn(async () => ({
    argv: ['D:\\runner.exe', 'run', 'request.json'],
    env: { SYSTEMROOT: 'C:\\Windows' },
    token: {
      id: 'command-1',
      command: 'npm test',
      startedAt: 1,
      workspaceDir: 'D:\\project',
    },
  }));
  const createFsIo = vi.fn(() => io);
  const executor = {
    prepareWorkspace,
    wrapCommand,
    createFsIo,
    finalizeCommand: vi.fn(async () => undefined),
  } as unknown as NativeSandboxExecutor;
  const createFsBridge = vi.fn(() => ({
    resolvePath: vi.fn(),
  } as never));
  const factory = createLobsterNativeSandboxBackendFactory({
    executor,
    audit: new SandboxAuditRecorder({
      policyVersion: 'workspace-write-v1',
      runtimeVersion: '0.1.0',
    }),
    runtimeEnabled: true,
    platform: 'win32',
    createFsBridge,
  });
  return { createFsBridge, createFsIo, factory, io, prepareWorkspace, wrapCommand };
};

describe('lobster native sandbox backend', () => {
  test('uses the host task workspace and the native runner for exec and file tools', async () => {
    const harness = createHarness();
    const backend = await harness.factory({
      sessionKey: 'agent:main:session-1',
      scopeKey: 'session-1',
      workspaceDir: 'C:\\openclaw\\workspace-main',
      agentWorkspaceDir: 'C:\\openclaw\\workspace-main',
      taskWorkspaceDir: 'D:\\project',
      cfg: {} as never,
    });

    expect(harness.prepareWorkspace).toHaveBeenCalledWith('D:\\project');
    await expect(backend.buildExecSpec({
      command: 'npm test',
      workdir: 'D:\\project\\packages\\app',
      env: { CI: '1' },
      usePty: true,
    })).resolves.toMatchObject({
      argv: ['D:\\runner.exe', 'run', 'request.json'],
      stdinMode: 'pipe-closed',
    });
    expect(harness.wrapCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npm test',
      workspaceDir: 'D:\\project',
      cwd: 'D:\\project\\packages\\app',
      sessionKey: 'agent:main:session-1',
    }));

    backend.createFsBridge?.({
      sandbox: {
        workspaceDir: 'D:\\project',
        agentWorkspaceDir: 'C:\\openclaw\\workspace-main',
        taskWorkspaceDir: 'D:\\project',
        workspaceAccess: 'rw',
        containerName: 'native',
        containerWorkdir: 'D:\\project',
        docker: {},
      },
    });
    expect(harness.createFsIo).toHaveBeenCalledWith({
      workspaceDir: 'D:\\project',
      sessionKey: 'agent:main:session-1',
    });
    expect(harness.createFsBridge).toHaveBeenCalledWith(expect.objectContaining({
      io: harness.io,
    }));
  });
});
