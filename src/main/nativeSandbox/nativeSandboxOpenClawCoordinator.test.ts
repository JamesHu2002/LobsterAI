import { describe, expect, test, vi } from 'vitest';

import {
  NATIVE_SANDBOX_OPENCLAW_BACKEND_ID,
  NATIVE_SANDBOX_OPENCLAW_PLUGIN_ID,
  NATIVE_SANDBOX_PROTOCOL_VERSION,
  NativeSandboxBackendState,
  NativeSandboxErrorCode,
  NativeSandboxGatewayMethod,
} from '../../shared/nativeSandbox/constants';
import {
  createNativeSandboxOpenClawCoordinator,
  parseNativeSandboxBackendProbe,
} from './nativeSandboxOpenClawCoordinator';

const createConfig = (enabled: boolean) => ({
  agents: {
    defaults: {
      sandbox: enabled
        ? { backend: NATIVE_SANDBOX_OPENCLAW_BACKEND_ID, mode: 'all' }
        : { mode: 'off' },
    },
  },
  plugins: {
    entries: {
      [NATIVE_SANDBOX_OPENCLAW_PLUGIN_ID]: {
        enabled: true,
        config: { runtimeEnabled: enabled },
      },
    },
  },
});

const createHarness = (options: {
  configEnabled?: boolean;
  running?: boolean;
} = {}) => {
  let running = options.running ?? true;
  let config = createConfig(options.configEnabled ?? false);
  const syncConfiguration = vi.fn(async (enabled: boolean) => {
    config = createConfig(enabled);
  });
  const ensureGatewayRunning = vi.fn(async () => {
    running = true;
  });
  const requestGateway = vi.fn(async () => ({
    ok: true,
    registered: true,
    runtimeEnabled: true,
    state: NativeSandboxBackendState.Ready,
    backendId: NATIVE_SANDBOX_OPENCLAW_BACKEND_ID,
    protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
  }));
  const coordinator = createNativeSandboxOpenClawCoordinator({
    syncConfiguration,
    isGatewayRunning: () => running,
    ensureGatewayRunning,
    readGatewayConfig: () => config,
    requestGateway,
  });
  return {
    coordinator,
    ensureGatewayRunning,
    requestGateway,
    setConfig: (nextConfig: unknown) => {
      config = nextConfig as ReturnType<typeof createConfig>;
    },
    setRunning: (nextRunning: boolean) => {
      running = nextRunning;
    },
    syncConfiguration,
  };
};

describe('NativeSandboxOpenClawCoordinator', () => {
  test('syncs configuration and starts a stopped Gateway when enabling', async () => {
    const harness = createHarness({ running: false });

    await harness.coordinator.applyConfiguration(true);

    expect(harness.syncConfiguration).toHaveBeenCalledWith(true);
    expect(harness.ensureGatewayRunning).toHaveBeenCalledOnce();
  });

  test('restores a previously running Gateway when enable fails during restart', async () => {
    const harness = createHarness({ running: true });
    harness.syncConfiguration.mockImplementationOnce(async () => {
      harness.setRunning(false);
      throw new Error('restart failed');
    });

    await expect(harness.coordinator.applyConfiguration(true)).rejects.toThrow(
      'restart failed',
    );
    await harness.coordinator.applyConfiguration(false);

    expect(harness.ensureGatewayRunning).toHaveBeenCalledOnce();
  });

  test('verifies disabled mode from the generated config without starting Gateway', async () => {
    const harness = createHarness({ configEnabled: false, running: false });

    await expect(harness.coordinator.verifyBackend({
      enabled: false,
      prepare: false,
      workspaceDir: '',
    })).resolves.toMatchObject({
      ok: true,
      runtimeEnabled: false,
      state: NativeSandboxBackendState.Disabled,
    });
    expect(harness.ensureGatewayRunning).not.toHaveBeenCalled();
    expect(harness.requestGateway).not.toHaveBeenCalled();
  });

  test('prepares and parses the real backend when enabled', async () => {
    const harness = createHarness({ configEnabled: true });

    await expect(harness.coordinator.verifyBackend({
      enabled: true,
      prepare: true,
      workspaceDir: 'D:\\workspace',
    })).resolves.toMatchObject({
      ok: true,
      runtimeEnabled: true,
      state: NativeSandboxBackendState.Ready,
    });
    expect(harness.requestGateway).toHaveBeenCalledWith(
      NativeSandboxGatewayMethod.Status,
      { prepare: true, workspaceDir: 'D:\\workspace' },
      { timeoutMs: 30_000 },
    );
  });

  test('fails closed when generated config and requested mode differ', async () => {
    const harness = createHarness({ configEnabled: false });

    await expect(harness.coordinator.verifyBackend({
      enabled: true,
      prepare: true,
      workspaceDir: 'D:\\workspace',
    })).resolves.toMatchObject({
      ok: false,
      state: NativeSandboxBackendState.Error,
      errorCode: NativeSandboxErrorCode.ConfigurationFailed,
    });
    expect(harness.requestGateway).not.toHaveBeenCalled();
  });

  test('fails closed when the executor protocol is incompatible', async () => {
    const harness = createHarness({ configEnabled: true });
    harness.requestGateway.mockResolvedValueOnce({
      ok: true,
      registered: true,
      runtimeEnabled: true,
      state: NativeSandboxBackendState.Ready,
      backendId: NATIVE_SANDBOX_OPENCLAW_BACKEND_ID,
      protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION + 1,
    });

    await expect(harness.coordinator.verifyBackend({
      enabled: true,
      prepare: false,
      workspaceDir: 'D:\\workspace',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: NativeSandboxErrorCode.RuntimeVersionIncompatible,
    });
  });
});

describe('parseNativeSandboxBackendProbe', () => {
  test('maps unknown runtime states to error', () => {
    expect(parseNativeSandboxBackendProbe({
      ok: true,
      registered: true,
      runtimeEnabled: true,
      state: 'future-state',
    }).state).toBe(NativeSandboxBackendState.Error);
  });
});
