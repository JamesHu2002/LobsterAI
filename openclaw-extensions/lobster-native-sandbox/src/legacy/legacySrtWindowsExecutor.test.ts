import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import {
  LobsterNativeSandboxBackendErrorCode,
  LobsterNativeSandboxRuntimeState,
} from '../backend/constants.js';
import { LobsterNativeSandboxBackendError } from '../backend/errors.js';
import {
  buildSrtWindowsRuntimeConfig,
  LegacySrtWindowsExecutor,
  type SrtSandboxManagerLike,
} from './legacySrtWindowsExecutor.js';

const temporaryRoots: string[] = [];

const createWorkspacePair = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-srt-m3-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  temporaryRoots.push(root);
  return { first, root, second };
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const createManager = (): SrtSandboxManagerLike => ({
  initialize: vi.fn(async () => undefined),
  wrapWithSandboxArgv: vi.fn(async () => ({
    argv: [
      'C:\\sandbox-runtime\\srt-win.exe',
      'exec',
      '--',
      'powershell.exe',
      '-Command',
      'Write-Output ok',
    ],
    env: { PATH: 'C:\\Windows\\System32' },
  })),
  cleanupAfterCommand: vi.fn(),
  reset: vi.fn(async () => undefined),
});

const createSession = (
  manager: SrtSandboxManagerLike,
  options: { runtimeEnabled?: boolean } = {},
) => new LegacySrtWindowsExecutor({
  helperPath: 'C:\\sandbox-runtime\\srt-win.exe',
  runtimeEnabled: options.runtimeEnabled ?? true,
  audit: new SandboxAuditRecorder({
    policyVersion: 'm3-test',
    runtimeVersion: '0.0.65',
  }),
  manager,
  platform: 'win32',
  pathExists: () => true,
  verifyWriteBoundary: async () => undefined,
  createBridgeDirectory: () => {
    const bridgeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-srt-bridge-test-'));
    temporaryRoots.push(bridgeDirectory);
    return bridgeDirectory;
  },
});

describe('buildSrtWindowsRuntimeConfig', () => {
  test('uses an offline network policy and grants write only to the task workspace', () => {
    const { first, second } = createWorkspacePair();

    const config = buildSrtWindowsRuntimeConfig({
      workspaceDir: first,
      bridgeDirectory: second,
      helperPath: 'C:\\sandbox-runtime\\srt-win.exe',
    });

    expect(config.network).toMatchObject({
      allowedDomains: [],
      deniedDomains: ['*'],
      strictAllowlist: true,
      allowLocalBinding: false,
    });
    expect(config.filesystem.allowWrite).toEqual([path.win32.resolve(first)]);
    expect(config.filesystem.denyRead).toEqual([]);
    expect(config.filesystem.allowRead).toEqual([path.win32.resolve(second)]);
    expect(config.windows?.srtWin?.path).toBe('C:\\sandbox-runtime\\srt-win.exe');
  });
});

describe('LegacySrtWindowsExecutor', () => {
  test('initializes one workspace once and rejects a different workspace fail-closed', async () => {
    const manager = createManager();
    const session = createSession(manager);
    const { first, second } = createWorkspacePair();

    await session.prepareWorkspace(first);
    await session.prepareWorkspace(first.toUpperCase());

    expect(manager.initialize).toHaveBeenCalledOnce();
    expect(session.getStatus().state).toBe(LobsterNativeSandboxRuntimeState.Ready);
    await expect(session.prepareWorkspace(second)).rejects.toMatchObject({
      code: LobsterNativeSandboxBackendErrorCode.WorkspaceConflict,
    });
    expect(manager.initialize).toHaveBeenCalledOnce();
  });

  test('returns a shell:false argv and preserves SRT-owned child environment', async () => {
    const manager = createManager();
    const session = createSession(manager);
    const { first } = createWorkspacePair();

    const wrapped = await session.wrapCommand({
      command: 'npm test',
      workspaceDir: first,
      env: {
        CI: '1',
        HTTPS_PROXY: 'http://host-proxy.invalid',
        PATH: 'C:\\untrusted',
      },
      sessionKey: 'session-1',
    });

    const boundary = wrapped.argv.indexOf('--');
    expect(wrapped.argv.slice(0, boundary)).toEqual(expect.arrayContaining([
      '--env',
      'CI=1',
    ]));
    expect(wrapped.argv.join('\0')).not.toContain('host-proxy.invalid');
    expect(wrapped.argv.join('\0')).not.toContain('C:\\untrusted');
    expect(wrapped.env).toEqual({ PATH: 'C:\\Windows\\System32' });
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledWith(
      'npm test',
      'powershell',
      undefined,
      undefined,
      path.win32.resolve(first),
    );
    expect(session.getStatus().activeCommands).toBe(1);
    await session.finalizeCommand({
      token: wrapped.token,
      status: 'completed',
      exitCode: 0,
      timedOut: false,
    });
    expect(session.getStatus().activeCommands).toBe(0);
  });

  test('rejects malformed environment names', async () => {
    const manager = createManager();
    const session = createSession(manager);
    const { first } = createWorkspacePair();

    await expect(session.wrapCommand({
      command: 'npm test',
      workspaceDir: first,
      env: {
        'INVALID-NAME': 'value',
      },
    })).rejects.toMatchObject({
      code: LobsterNativeSandboxBackendErrorCode.InvalidEnvironment,
    });
    expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce();
    expect(session.getStatus().activeCommands).toBe(0);
  });

  test('stays disabled without touching SRT when the product flag is off', async () => {
    const manager = createManager();
    const session = createSession(manager, { runtimeEnabled: false });
    const { first } = createWorkspacePair();

    await expect(session.prepareWorkspace(first)).rejects.toMatchObject({
      code: LobsterNativeSandboxBackendErrorCode.BackendDisabled,
    });
    expect(manager.initialize).not.toHaveBeenCalled();
    expect(session.getStatus().state).toBe(LobsterNativeSandboxRuntimeState.Disabled);
  });

  test('resets session ACL/proxy state on Gateway service shutdown', async () => {
    const manager = createManager();
    const session = createSession(manager);
    const { first } = createWorkspacePair();
    await session.prepareWorkspace(first);

    await session.reset();

    expect(manager.reset).toHaveBeenCalledOnce();
    expect(session.getStatus().state).toBe(LobsterNativeSandboxRuntimeState.Idle);
  });

  test('resets and fails closed when the workspace ACL probe detects outside writes', async () => {
    const manager = createManager();
    const { first } = createWorkspacePair();
    const session = new LegacySrtWindowsExecutor({
      helperPath: 'C:\\sandbox-runtime\\srt-win.exe',
      runtimeEnabled: true,
      audit: new SandboxAuditRecorder({
        policyVersion: 'm3-test',
        runtimeVersion: '0.0.65',
      }),
      manager,
      platform: 'win32',
      pathExists: () => true,
      createBridgeDirectory: () => {
        const bridgeDirectory = fs.mkdtempSync(
          path.join(os.tmpdir(), 'lobster-srt-bridge-test-'),
        );
        temporaryRoots.push(bridgeDirectory);
        return bridgeDirectory;
      },
      verifyWriteBoundary: async () => {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.UnsafeWorkspaceAcl,
          'outside write succeeded',
        );
      },
    });

    await expect(session.prepareWorkspace(first)).rejects.toMatchObject({
      code: LobsterNativeSandboxBackendErrorCode.UnsafeWorkspaceAcl,
    });
    expect(manager.reset).toHaveBeenCalledOnce();
    expect(session.getStatus().state).toBe(LobsterNativeSandboxRuntimeState.Error);
  });
});
