import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import {
  LOBSTER_SRT_SANDBOX_BACKEND_ID,
  LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS,
  LobsterSrtSandboxBackendErrorCode,
} from '../openclaw-extensions/lobster-srt-sandbox/src/backend/constants';
import { LobsterSrtSandboxBackendError } from '../openclaw-extensions/lobster-srt-sandbox/src/backend/errors';
import {
  createLobsterSrtSandboxBackend,
  createLobsterSrtSandboxBackendFactory,
} from '../openclaw-extensions/lobster-srt-sandbox/src/backend/lobsterSrtSandboxBackend';

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

describe('lobster-srt sandbox backend', () => {
  test('rejects registered backend activation before exposing the M2 file bridge', async () => {
    const createFsBridge = vi.fn();
    const factory = createLobsterSrtSandboxBackendFactory({
      platform: 'win32',
      createFsBridge: createFsBridge as never,
    });

    await expect(factory(createBackendParams() as never)).rejects.toMatchObject({
      name: 'LobsterSrtSandboxBackendError',
      code: LobsterSrtSandboxBackendErrorCode.BackendUnavailable,
    });
    expect(createFsBridge).not.toHaveBeenCalled();
  });

  test('connects the OpenClaw sandbox context to the Windows filesystem bridge', () => {
    const bridge = {};
    const createFsBridge = vi.fn(() => bridge);
    const backend = createLobsterSrtSandboxBackend(createBackendParams() as never, {
      platform: 'win32',
      createFsBridge: createFsBridge as never,
    });
    const sandbox = {
      workspaceDir: 'C:\\work\\task',
      agentWorkspaceDir: 'C:\\state\\workspace-main',
    };

    expect(backend.id).toBe(LOBSTER_SRT_SANDBOX_BACKEND_ID);
    expect(backend.workdir).toBe('C:\\work\\task');
    expect(backend.env).toBeUndefined();
    expect(
      (backend.capabilities as { workspacePathSemantics?: string } | undefined)
        ?.workspacePathSemantics,
    ).toBe(LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS);
    expect(backend.createFsBridge?.({ sandbox: sandbox as never })).toBe(bridge);
    expect(createFsBridge).toHaveBeenCalledWith({ sandbox });
  });

  test('fails closed for command execution until the SRT adapter is connected', async () => {
    const backend = createLobsterSrtSandboxBackend(createBackendParams() as never, {
      platform: 'win32',
      createFsBridge: vi.fn() as never,
    });

    await expect(backend.buildExecSpec({
      command: 'whoami',
      env: {},
      usePty: false,
    })).rejects.toMatchObject({
      name: 'LobsterSrtSandboxBackendError',
      code: LobsterSrtSandboxBackendErrorCode.CommandExecutionUnavailable,
    });
    await expect(backend.runShellCommand({ script: 'whoami' })).rejects.toMatchObject({
      code: LobsterSrtSandboxBackendErrorCode.CommandExecutionUnavailable,
    });
  });

  test('rejects non-Windows activation before constructing a bridge', () => {
    const createFsBridge = vi.fn();

    expect(() => createLobsterSrtSandboxBackend(createBackendParams() as never, {
      platform: 'linux',
      createFsBridge: createFsBridge as never,
    })).toThrow(LobsterSrtSandboxBackendError);
    expect(createFsBridge).not.toHaveBeenCalled();
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
