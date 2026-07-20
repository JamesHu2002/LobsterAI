import { describe, expect, test, vi } from 'vitest';

import {
  NativeSandboxBackendState,
  NativeSandboxControlStage,
  NativeSandboxErrorCode,
  NativeSandboxPlatform,
  NativeSandboxState,
} from '../../shared/nativeSandbox/constants';
import type {
  NativeSandboxOperationResult,
  NativeSandboxStatus,
} from '../../shared/nativeSandbox/types';
import {
  type NativeSandboxControlDependencies,
  NativeSandboxControlService,
} from './nativeSandboxControlService';

const createStatus = (
  overrides: Partial<NativeSandboxStatus> = {},
): NativeSandboxStatus => ({
  platform: NativeSandboxPlatform.Windows,
  architecture: 'x64',
  supported: true,
  state: NativeSandboxState.Ready,
  runtimeVersion: '0.0.65',
  helperAvailable: true,
  installed: true,
  healthy: true,
  enabled: false,
  backendConnected: false,
  busy: false,
  checkedAt: 123,
  ...overrides,
});

const createResult = (
  statusOverrides: Partial<NativeSandboxStatus> = {},
): NativeSandboxOperationResult => ({
  success: true,
  status: createStatus(statusOverrides),
});

const createHarness = (options: {
  enabled?: boolean;
  active?: boolean;
  managed?: boolean;
  status?: NativeSandboxStatus;
} = {}) => {
  let enabled = options.enabled ?? false;
  const status = options.status ?? createStatus({ enabled });
  const diagnostics = {
    getStatus: vi.fn(async () => ({ success: true, status })),
    install: vi.fn(async () => createResult({ enabled, healthy: true, installed: true })),
    repair: vi.fn(async () => createResult({ enabled, healthy: true, installed: true })),
  };
  const applyConfiguration = vi.fn(async () => undefined);
  const verifyBackend = vi.fn(async (params: { enabled: boolean }) => ({
    ok: true,
    registered: true,
    runtimeEnabled: params.enabled,
    state: params.enabled
      ? NativeSandboxBackendState.Ready
      : NativeSandboxBackendState.Disabled,
  }));
  const persistEnabled = vi.fn((nextEnabled: boolean) => {
    enabled = nextEnabled;
  });
  const dependencies: NativeSandboxControlDependencies = {
    diagnostics,
    getEnabled: () => enabled,
    persistEnabled,
    isManagedByEnterprise: () => options.managed ?? false,
    hasActiveWorkloads: () => options.active ?? false,
    getVerificationWorkspace: () => 'D:\\workspace',
    applyConfiguration,
    verifyBackend,
    logger: {
      log: vi.fn(),
      error: vi.fn(),
    },
  };

  return {
    applyConfiguration,
    dependencies,
    diagnostics,
    getEnabled: () => enabled,
    persistEnabled,
    service: new NativeSandboxControlService(dependencies),
    verifyBackend,
  };
};

describe('NativeSandboxControlService', () => {
  test('enables only after health, config apply and prepared backend verification', async () => {
    const harness = createHarness();

    const result = await harness.service.setEnabled(true);

    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.status).toMatchObject({
      enabled: true,
      backendConnected: true,
    });
    expect(harness.persistEnabled).toHaveBeenCalledWith(true);
    expect(harness.applyConfiguration).toHaveBeenCalledWith(true);
    expect(harness.verifyBackend).toHaveBeenCalledWith({
      enabled: true,
      prepare: true,
      workspaceDir: 'D:\\workspace',
    });
  });

  test('runs explicit installation when enable finds a fresh runtime', async () => {
    const harness = createHarness({
      status: createStatus({
        state: NativeSandboxState.NotInstalled,
        installed: false,
        healthy: false,
      }),
    });

    const result = await harness.service.setEnabled(true);

    expect(result.success).toBe(true);
    expect(harness.diagnostics.install).toHaveBeenCalledOnce();
    expect(harness.diagnostics.repair).not.toHaveBeenCalled();
  });

  test('keeps mode disabled when the UAC installation is cancelled', async () => {
    const harness = createHarness({
      status: createStatus({
        state: NativeSandboxState.NotInstalled,
        installed: false,
        healthy: false,
      }),
    });
    harness.diagnostics.install.mockResolvedValue({
      ...createResult({
        state: NativeSandboxState.NotInstalled,
        installed: false,
        healthy: false,
      }),
      cancelled: true,
    });

    const result = await harness.service.setEnabled(true);

    expect(result.success).toBe(false);
    expect(result.enabled).toBe(false);
    expect(harness.persistEnabled).not.toHaveBeenCalled();
    expect(harness.applyConfiguration).not.toHaveBeenCalled();
  });

  test('keeps persisted enabled state consistent when a repeated health repair is cancelled', async () => {
    const harness = createHarness({
      enabled: true,
      status: createStatus({
        enabled: false,
        state: NativeSandboxState.Degraded,
        healthy: false,
      }),
    });
    harness.diagnostics.repair.mockResolvedValue({
      ...createResult({
        enabled: false,
        state: NativeSandboxState.Degraded,
        healthy: false,
      }),
      cancelled: true,
    });

    const result = await harness.service.setEnabled(true);

    expect(result).toMatchObject({
      success: false,
      enabled: true,
      status: {
        enabled: true,
        backendConnected: false,
      },
    });
    expect(harness.persistEnabled).not.toHaveBeenCalled();
    expect(harness.applyConfiguration).not.toHaveBeenCalled();
  });

  test('blocks mode switches while a task is active', async () => {
    const harness = createHarness({ active: true });

    const result = await harness.service.setEnabled(true);

    expect(result.success).toBe(false);
    expect(result.stage).toBe(NativeSandboxControlStage.WorkloadCheck);
    expect(result.status.lastError?.code).toBe(NativeSandboxErrorCode.ActiveWorkloads);
    expect(harness.persistEnabled).not.toHaveBeenCalled();
  });

  test('rolls persisted config back when backend verification fails', async () => {
    const harness = createHarness();
    harness.verifyBackend
      .mockResolvedValueOnce({
        ok: false,
        registered: true,
        runtimeEnabled: true,
        state: NativeSandboxBackendState.Error,
        errorCode: 'runtime-initialization-failed',
      })
      .mockResolvedValueOnce({
        ok: true,
        registered: true,
        runtimeEnabled: false,
        state: NativeSandboxBackendState.Disabled,
      });

    const result = await harness.service.setEnabled(true);

    expect(result.success).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(harness.persistEnabled.mock.calls).toEqual([[true], [false]]);
    expect(harness.applyConfiguration.mock.calls).toEqual([[true], [false]]);
  });

  test('preserves the unsafe workspace ACL reason after a verified rollback', async () => {
    const harness = createHarness();
    harness.verifyBackend
      .mockResolvedValueOnce({
        ok: false,
        registered: true,
        runtimeEnabled: true,
        state: NativeSandboxBackendState.Error,
        errorCode: NativeSandboxErrorCode.UnsafeWorkspaceAcl,
      })
      .mockResolvedValueOnce({
        ok: true,
        registered: true,
        runtimeEnabled: false,
        state: NativeSandboxBackendState.Disabled,
      });

    const result = await harness.service.setEnabled(true);

    expect(result).toMatchObject({
      success: false,
      enabled: false,
      rolledBack: true,
      status: {
        lastError: {
          code: NativeSandboxErrorCode.UnsafeWorkspaceAcl,
        },
      },
    });
  });

  test('reports an enabled backend in an error state as disconnected', async () => {
    const harness = createHarness({ enabled: true });
    harness.verifyBackend.mockResolvedValue({
      ok: true,
      registered: true,
      runtimeEnabled: true,
      state: NativeSandboxBackendState.Error,
      errorCode: 'runtime-initialization-failed',
    });

    const result = await harness.service.getStatus();

    expect(result.status).toMatchObject({
      backendConnected: false,
      state: NativeSandboxState.Degraded,
      lastError: {
        code: NativeSandboxErrorCode.BackendVerificationFailed,
      },
    });
  });

  test('allows a managed or unhealthy installation to be disabled without uninstalling', async () => {
    const harness = createHarness({
      enabled: true,
      managed: true,
      status: createStatus({
        enabled: true,
        healthy: false,
        state: NativeSandboxState.Degraded,
      }),
    });

    const result = await harness.service.setEnabled(false);

    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
    expect(harness.diagnostics.install).not.toHaveBeenCalled();
    expect(harness.diagnostics.repair).not.toHaveBeenCalled();
    expect(harness.persistEnabled).toHaveBeenCalledWith(false);
  });
});
