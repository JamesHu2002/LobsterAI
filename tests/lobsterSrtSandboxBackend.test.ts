import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { SandboxAuditRecorder } from '../openclaw-extensions/lobster-srt-sandbox/src/audit/sandboxAuditRecorder';
import {
  LOBSTER_SRT_SANDBOX_BACKEND_ID,
  LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS,
  LobsterSrtSandboxBackendErrorCode,
} from '../openclaw-extensions/lobster-srt-sandbox/src/backend/constants';
import { LobsterSrtSandboxBackendError } from '../openclaw-extensions/lobster-srt-sandbox/src/backend/errors';
import {
  createLobsterSrtSandboxBackend,
  createLobsterSrtSandboxBackendFactory,
  type LobsterSrtSandboxBackendDependencies,
} from '../openclaw-extensions/lobster-srt-sandbox/src/backend/lobsterSrtSandboxBackend';
import type { SrtWindowsSession } from '../openclaw-extensions/lobster-srt-sandbox/src/backend/srtWindowsSession';

const createBackendParams = () => ({
  sessionKey: 'agent:main:session:one',
  scopeKey: 'agent:main:session:one',
  workspaceDir: 'C:\\state\\workspace-main',
  taskWorkspaceDir: 'C:\\work\\task',
  agentWorkspaceDir: 'C:\\state\\workspace-main',
  cfg: {
    docker: {
      env: { LANG: 'C.UTF-8' },
    },
  },
});

const createDependencies = (
  overrides: Partial<LobsterSrtSandboxBackendDependencies> = {},
) => {
  const bridge = {};
  const prepareWorkspace = vi.fn(async () => undefined);
  const wrapCommand = vi.fn(async () => ({
    argv: ['C:\\sandbox-runtime\\srt-win.exe', 'exec', '--', 'powershell.exe'],
    env: { PATH: 'C:\\Windows\\System32' },
    token: { id: 'exec-1' },
  }));
  const finalizeCommand = vi.fn(async () => undefined);
  const runIsolatedCommand = vi.fn(async () => ({
    stdout: Buffer.from('ok'),
    stderr: Buffer.alloc(0),
    code: 0,
  }));
  const session = {
    prepareWorkspace,
    wrapCommand,
    finalizeCommand,
    runIsolatedCommand,
  } as unknown as SrtWindowsSession;
  const createFsBridge = vi.fn(() => bridge);
  const dependencies: LobsterSrtSandboxBackendDependencies = {
    runtimeEnabled: true,
    platform: 'win32',
    audit: new SandboxAuditRecorder({
      policyVersion: 'm3-test',
      runtimeVersion: '0.0.65',
    }),
    session,
    createFsBridge,
    ...overrides,
  };
  return {
    bridge,
    createFsBridge,
    dependencies,
    finalizeCommand,
    prepareWorkspace,
    runIsolatedCommand,
    wrapCommand,
  };
};

describe('lobster-srt sandbox backend', () => {
  test('fails closed when a stale config selects the disabled backend', async () => {
    const harness = createDependencies({ runtimeEnabled: false });
    const factory = createLobsterSrtSandboxBackendFactory(harness.dependencies);

    await expect(factory(createBackendParams() as never)).rejects.toMatchObject({
      name: 'LobsterSrtSandboxBackendError',
      code: LobsterSrtSandboxBackendErrorCode.BackendDisabled,
    });
    expect(harness.prepareWorkspace).not.toHaveBeenCalled();
    expect(harness.createFsBridge).not.toHaveBeenCalled();
  });

  test('prepares the task workspace before exposing the enabled backend', async () => {
    const harness = createDependencies();
    const factory = createLobsterSrtSandboxBackendFactory(harness.dependencies);

    const backend = await factory(createBackendParams() as never);

    expect(harness.prepareWorkspace).toHaveBeenCalledWith('C:\\work\\task');
    expect(backend.id).toBe(LOBSTER_SRT_SANDBOX_BACKEND_ID);
  });

  test('connects OpenClaw file tools to restricted-account I/O', () => {
    const harness = createDependencies();
    const backend = createLobsterSrtSandboxBackend(
      createBackendParams() as never,
      harness.dependencies,
    );
    const sandbox = {
      workspaceDir: 'C:\\work\\task',
      agentWorkspaceDir: 'C:\\state\\workspace-main',
      taskWorkspaceDir: 'C:\\work\\task',
    };

    expect(backend.id).toBe(LOBSTER_SRT_SANDBOX_BACKEND_ID);
    expect(backend.workdir).toBe('C:\\work\\task');
    expect(backend.env).toBeUndefined();
    expect(
      (backend.capabilities as { workspacePathSemantics?: string } | undefined)
        ?.workspacePathSemantics,
    ).toBe(LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS);
    expect(backend.createFsBridge?.({ sandbox: sandbox as never })).not.toBe(harness.bridge);
    expect(harness.createFsBridge).toHaveBeenCalledWith({
      sandbox,
      io: expect.any(Object),
    });
  });

  test('routes exec, shell commands and finalization through the SRT session', async () => {
    const harness = createDependencies();
    const backend = createLobsterSrtSandboxBackend(
      createBackendParams() as never,
      harness.dependencies,
    );

    await expect(backend.buildExecSpec({
      command: 'npm test',
      env: { PATH: 'C:\\host-path', CI: '1' },
      usePty: false,
    })).resolves.toMatchObject({
      argv: ['C:\\sandbox-runtime\\srt-win.exe', 'exec', '--', 'powershell.exe'],
      stdinMode: 'pipe-closed',
      finalizeToken: { id: 'exec-1' },
    });
    expect(harness.wrapCommand).toHaveBeenCalledWith({
      command: 'npm test',
      workspaceDir: 'C:\\work\\task',
      cwd: 'C:\\work\\task',
      env: { PATH: 'C:\\host-path', CI: '1' },
      sessionKey: 'agent:main:session:one',
    });

    await expect(backend.runShellCommand({
      script: 'Write-Output',
      args: ['hello', 'value\'; Write-Output injected; #'],
    })).resolves.toMatchObject({
      code: 0,
      stdout: Buffer.from('ok'),
    });
    expect(harness.runIsolatedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'Write-Output \'hello\' \'value\'\'; Write-Output injected; #\'',
        workspaceDir: 'C:\\work\\task',
      }),
    );

    await backend.finalizeExec?.({
      status: 'completed',
      exitCode: 0,
      timedOut: false,
      token: { id: 'exec-1' },
    });
    expect(harness.finalizeCommand).toHaveBeenCalledOnce();
  });

  test('rejects non-Windows activation before constructing a bridge', () => {
    const harness = createDependencies({ platform: 'linux' });

    expect(() => createLobsterSrtSandboxBackend(
      createBackendParams() as never,
      harness.dependencies,
    )).toThrow(LobsterSrtSandboxBackendError);
    expect(harness.createFsBridge).not.toHaveBeenCalled();
  });

  test('declares explicit startup activation for backend registration', () => {
    const manifestPath = path.join(
      process.cwd(),
      'openclaw-extensions',
      'lobster-srt-sandbox',
      'openclaw.plugin.json',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      activation?: { onStartup?: boolean };
    };

    expect(manifest.activation?.onStartup).toBe(true);
  });
});
