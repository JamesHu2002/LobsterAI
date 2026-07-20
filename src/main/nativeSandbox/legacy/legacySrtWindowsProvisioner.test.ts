import path from 'path';
import { describe, expect, test, vi } from 'vitest';

import {
  NativeSandboxErrorCode,
  NativeSandboxRuntimeKind,
  NativeSandboxState,
} from '../../../shared/nativeSandbox/constants';
import { resolveLegacySrtWindowsHelperPath } from './legacySrtWindowsEnvironment';
import { LegacySrtWindowsProvisioner } from './legacySrtWindowsProvisioner';

const createReadyRuntime = () => ({
  resolveSrtWin: vi.fn((config?: { path?: string }) => ({
    exe: config?.path ?? 'srt-win.exe',
    prependArgs: ['--srt-win'],
  })),
  getWindowsSandboxUserStatus: vi.fn(() => ({
    provisioned: true,
    sid: 'S-1-5-21-test' as string | undefined,
    groupExists: true,
    inBuiltinUsers: true,
    inSandboxGroup: true,
    hiddenFromLogon: true,
    credPresent: true,
  })),
  getWindowsWfpStatus: vi.fn(() => ({
    state: 'installed' as 'absent' | 'installed' | 'cannot-read',
    filters: 4,
    portRange: [60080, 60089] as [number, number],
  })),
  verifyWindowsWfpEgress: vi.fn(async () => ({ target: '127.0.0.1:60100' })),
  installWindowsSandbox: vi.fn(() => ({})),
});

const createService = (
  runtime: ReturnType<typeof createReadyRuntime>,
  overrides: Partial<ConstructorParameters<typeof LegacySrtWindowsProvisioner>[0]> = {},
) => new LegacySrtWindowsProvisioner({
  appPath: 'C:\\LobsterAI',
  resourcesPath: 'C:\\LobsterAI\\resources',
  isPackaged: true,
  platform: 'win32',
  architecture: 'x64',
  pathExists: () => true,
  loadRuntime: async () => runtime,
  now: () => 123,
  ...overrides,
});

describe('resolveLegacySrtWindowsHelperPath', () => {
  test('uses a direct resources path in packaged builds', () => {
    expect(resolveLegacySrtWindowsHelperPath({
      appPath: 'C:\\LobsterAI',
      resourcesPath: 'C:\\LobsterAI\\resources',
      isPackaged: true,
      architecture: 'x64',
    })).toBe(path.join('C:\\LobsterAI\\resources', 'sandbox-runtime', 'srt-win.exe'));
  });

  test('uses the architecture-specific npm vendor helper in development', () => {
    expect(resolveLegacySrtWindowsHelperPath({
      appPath: 'C:\\LobsterAI',
      resourcesPath: 'C:\\LobsterAI\\resources',
      isPackaged: false,
      architecture: 'arm64',
    })).toBe(path.join(
      'C:\\LobsterAI',
      'node_modules',
      '@anthropic-ai',
      'sandbox-runtime',
      'vendor',
      'srt-win',
      'arm64',
      'srt-win.exe',
    ));
  });
});

describe('LegacySrtWindowsProvisioner', () => {
  test('does not load SRT or trigger setup during construction', () => {
    const loadRuntime = vi.fn(async () => createReadyRuntime());
    createService(createReadyRuntime(), { loadRuntime });
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  test('reports a missing helper without loading the runtime', async () => {
    const loadRuntime = vi.fn(async () => createReadyRuntime());
    const service = createService(createReadyRuntime(), {
      pathExists: () => false,
      loadRuntime,
    });

    const result = await service.getStatus();

    expect(result.success).toBe(true);
    expect(result.status.state).toBe(NativeSandboxState.Unavailable);
    expect(result.status.runtimeAvailable).toBe(false);
    expect(result.status.lastError?.code).toBe(
      NativeSandboxErrorCode.RuntimeExecutableUnavailable,
    );
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  test('verifies a complete Windows installation as ready', async () => {
    const runtime = createReadyRuntime();
    const service = createService(runtime);

    const result = await service.getStatus();

    expect(result.success).toBe(true);
    expect(result.status).toMatchObject({
      state: NativeSandboxState.Ready,
      supported: true,
      runtimeKind: NativeSandboxRuntimeKind.LegacyWindowsAdapter,
      runtimeAvailable: true,
      activationAvailable: false,
      lifecycleAvailable: false,
      installed: true,
      healthy: true,
      backendConnected: false,
      busy: false,
      checkedAt: 123,
    });
    expect(runtime.verifyWindowsWfpEgress).toHaveBeenCalledOnce();
  });

  test('treats a fresh non-admin machine with unreadable WFP state as not installed', async () => {
    const runtime = createReadyRuntime();
    runtime.getWindowsSandboxUserStatus.mockReturnValue({
      provisioned: false,
      sid: '',
      groupExists: false,
      inBuiltinUsers: false,
      inSandboxGroup: false,
      hiddenFromLogon: false,
      credPresent: false,
    });
    runtime.getWindowsWfpStatus.mockReturnValue({
      state: 'cannot-read',
      filters: 0,
      portRange: [60080, 60089],
    });
    const service = createService(runtime);

    const result = await service.getStatus();

    expect(result.success).toBe(true);
    expect(result.status.state).toBe(NativeSandboxState.NotInstalled);
    expect(result.status.installed).toBe(false);
    expect(runtime.verifyWindowsWfpEgress).not.toHaveBeenCalled();
  });

  test('coalesces concurrent install and repair requests into one setup operation', async () => {
    const runtime = createReadyRuntime();
    let resolveRuntime: ((value: typeof runtime) => void) | undefined;
    const runtimeReady = new Promise<typeof runtime>(resolve => {
      resolveRuntime = resolve;
    });
    const service = createService(runtime, { loadRuntime: () => runtimeReady });

    const install = service.install();
    const repair = service.repair();
    expect(install).toBe(repair);

    resolveRuntime?.(runtime);
    const result = await install;

    expect(result.success).toBe(true);
    expect(runtime.installWindowsSandbox).toHaveBeenCalledTimes(1);
    expect(runtime.installWindowsSandbox).toHaveBeenCalledWith(expect.objectContaining({
      force: false,
    }));
  });

  test('keeps repair idempotent without forcing an install migration', async () => {
    const runtime = createReadyRuntime();
    const service = createService(runtime);

    const result = await service.repair();

    expect(result.success).toBe(true);
    expect(runtime.installWindowsSandbox).toHaveBeenCalledWith(expect.objectContaining({
      force: false,
    }));
  });

  test('returns UAC cancellation as a non-error result', async () => {
    const runtime = createReadyRuntime();
    runtime.installWindowsSandbox.mockReturnValue({ cancelled: true });
    const service = createService(runtime);

    const result = await service.install();

    expect(result.success).toBe(true);
    expect(result.cancelled).toBe(true);
  });

  test('does not load Windows runtime APIs on unsupported platforms', async () => {
    const loadRuntime = vi.fn(async () => createReadyRuntime());
    const service = createService(createReadyRuntime(), {
      platform: 'darwin',
      architecture: 'arm64',
      loadRuntime,
    });

    const result = await service.getStatus();

    expect(result.status.state).toBe(NativeSandboxState.Unsupported);
    expect(result.status.supported).toBe(false);
    expect(loadRuntime).not.toHaveBeenCalled();
  });
});
