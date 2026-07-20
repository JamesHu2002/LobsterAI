import type { IpcMain } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import {
  NativeSandboxControlStage,
  NativeSandboxIpcChannel,
  NativeSandboxPlatform,
  NativeSandboxState,
} from '../../shared/nativeSandbox/constants';
import type {
  NativeSandboxOperationResult,
  NativeSandboxSetEnabledResult,
} from '../../shared/nativeSandbox/types';
import type { NativeSandboxControlServiceApi } from './nativeSandboxControlService';
import { registerNativeSandboxIpcHandlers } from './nativeSandboxIpcHandlers';

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;

const createResult = (): NativeSandboxOperationResult => ({
  success: true,
  status: {
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
  },
});

const createHarness = () => {
  const handlers = new Map<string, RegisteredHandler>();
  const handle = vi.fn((channel: string, listener: RegisteredHandler) => {
    handlers.set(channel, listener);
  });
  const result = createResult();
  const toggleResult: NativeSandboxSetEnabledResult = {
    ...result,
    enabled: true,
    previousEnabled: false,
    stage: NativeSandboxControlStage.Idle,
    status: {
      ...result.status,
      enabled: true,
      backendConnected: true,
    },
  };
  const service: NativeSandboxControlServiceApi = {
    getStatus: vi.fn(async () => result),
    install: vi.fn(async () => result),
    repair: vi.fn(async () => result),
    setEnabled: vi.fn(async () => toggleResult),
  };
  const createService = vi.fn(() => service);
  const logger = { log: vi.fn() };

  registerNativeSandboxIpcHandlers({
    ipcMain: { handle } as unknown as Pick<IpcMain, 'handle'>,
    createService,
    logger,
  });

  return { createService, handlers, logger, result, service, toggleResult };
};

describe('registerNativeSandboxIpcHandlers', () => {
  test('registers all native sandbox channels without constructing the service', () => {
    const { createService, handlers } = createHarness();

    expect([...handlers.keys()]).toEqual([
      NativeSandboxIpcChannel.GetStatus,
      NativeSandboxIpcChannel.Install,
      NativeSandboxIpcChannel.Repair,
      NativeSandboxIpcChannel.SetEnabled,
    ]);
    expect(createService).not.toHaveBeenCalled();
  });

  test('delegates the dedicated transactional mode switch', async () => {
    const { handlers, logger, service, toggleResult } = createHarness();
    const setEnabled = handlers.get(NativeSandboxIpcChannel.SetEnabled);

    await expect(setEnabled?.({}, { enabled: true })).resolves.toBe(toggleResult);

    expect(service.setEnabled).toHaveBeenCalledWith(true);
    expect(logger.log).toHaveBeenNthCalledWith(
      1,
      '[NativeSandbox] Enable requested by the user.',
    );
    expect(logger.log).toHaveBeenNthCalledWith(
      2,
      '[NativeSandbox] Mode switch finished (success=true, enabled=true, '
      + 'stage=idle, rolledBack=false).',
    );
  });

  test('rejects malformed mode requests instead of treating them as disable', async () => {
    const { handlers, service } = createHarness();
    const setEnabled = handlers.get(NativeSandboxIpcChannel.SetEnabled);

    await expect(setEnabled?.({}, { enabled: 'yes' })).rejects.toThrow(
      'Invalid native sandbox mode request.',
    );
    expect(service.setEnabled).not.toHaveBeenCalled();
  });

  test('constructs one shared service lazily on the first invocation', async () => {
    const { createService, handlers, result, service } = createHarness();
    const getStatus = handlers.get(NativeSandboxIpcChannel.GetStatus);
    const install = handlers.get(NativeSandboxIpcChannel.Install);

    await expect(getStatus?.({})).resolves.toBe(result);
    await expect(install?.({})).resolves.toBe(result);

    expect(createService).toHaveBeenCalledOnce();
    expect(service.getStatus).toHaveBeenCalledOnce();
    expect(service.install).toHaveBeenCalledOnce();
  });

  test('delegates repair and preserves lifecycle diagnostics', async () => {
    const { handlers, logger, result, service } = createHarness();
    const repair = handlers.get(NativeSandboxIpcChannel.Repair);

    await expect(repair?.({})).resolves.toBe(result);

    expect(service.repair).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenNthCalledWith(
      1,
      '[NativeSandbox] Repair requested by the user.',
    );
    expect(logger.log).toHaveBeenNthCalledWith(
      2,
      '[NativeSandbox] Repair finished (success=true, cancelled=false, state=ready).',
    );
  });
});
