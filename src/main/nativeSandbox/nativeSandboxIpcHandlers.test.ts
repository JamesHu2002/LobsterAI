import type { IpcMain } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import {
  NativeSandboxIpcChannel,
  NativeSandboxPlatform,
  NativeSandboxState,
} from '../../shared/nativeSandbox/constants';
import type { NativeSandboxOperationResult } from '../../shared/nativeSandbox/types';
import { registerNativeSandboxIpcHandlers } from './nativeSandboxIpcHandlers';
import type { NativeSandboxServiceApi } from './nativeSandboxService';

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
  const service: NativeSandboxServiceApi = {
    getStatus: vi.fn(async () => result),
    install: vi.fn(async () => result),
    repair: vi.fn(async () => result),
  };
  const createService = vi.fn(() => service);
  const logger = { log: vi.fn() };

  registerNativeSandboxIpcHandlers({
    ipcMain: { handle } as unknown as Pick<IpcMain, 'handle'>,
    createService,
    logger,
  });

  return { createService, handlers, logger, result, service };
};

describe('registerNativeSandboxIpcHandlers', () => {
  test('registers all native sandbox channels without constructing the service', () => {
    const { createService, handlers } = createHarness();

    expect([...handlers.keys()]).toEqual([
      NativeSandboxIpcChannel.GetStatus,
      NativeSandboxIpcChannel.Install,
      NativeSandboxIpcChannel.Repair,
    ]);
    expect(createService).not.toHaveBeenCalled();
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
