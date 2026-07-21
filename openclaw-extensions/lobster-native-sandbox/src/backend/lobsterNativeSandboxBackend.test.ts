import { describe, expect, test, vi } from 'vitest';

import { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import type { SandboxFsIo } from '../fs/sandboxFsIo.js';
import type { NativeSandboxExecutor } from '../runtime/nativeSandboxExecutor.js';
import { createLobsterNativeSandboxBackendFactory } from './lobsterNativeSandboxBackend.js';

const createHarness = () => {
  const io = {} as SandboxFsIo;
  const policyContext = {
    agentWorkspaceDir: 'C:\\openclaw\\workspace-main',
    profile: {
      mode: 'inherit-host' as const,
      homeDir: 'C:\\Users\\tester',
      userProfileDir: 'C:\\Users\\tester',
      appDataDir: 'C:\\Users\\tester\\AppData\\Roaming',
      localAppDataDir: 'C:\\Users\\tester\\AppData\\Local',
    },
    writableRoots: [
      { id: 'agent', path: 'C:\\openclaw\\workspace-main' },
      { id: 'npm-cache', path: 'C:\\Users\\tester\\AppData\\Local\\npm-cache' },
    ],
    readableRoots: [{ id: 'skills', path: 'C:\\LobsterAI\\SKILLs' }],
    protectedPaths: [],
  };
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
      policyVersion: 'workspace-write-v3',
      runtimeVersion: '0.3.1',
    }),
    runtimeEnabled: true,
    platform: 'win32',
    createFsBridge,
    resolvePolicyContext: vi.fn(() => policyContext),
  });
  return {
    createFsBridge,
    createFsIo,
    factory,
    io,
    policyContext,
    prepareWorkspace,
    wrapCommand,
  };
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

    expect(harness.prepareWorkspace).toHaveBeenCalledWith(
      'D:\\project',
      harness.policyContext,
    );
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
      policyContext: harness.policyContext,
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
      policyContext: harness.policyContext,
    });
    expect(harness.createFsBridge).toHaveBeenCalledWith(expect.objectContaining({
      io: harness.io,
      policyContext: harness.policyContext,
    }));
  });
});
