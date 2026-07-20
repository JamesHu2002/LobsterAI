import { describe, expect, test, vi } from 'vitest';

import { migrateNativeSandboxM0Configuration } from './nativeSandboxM0Migration';

describe('migrateNativeSandboxM0Configuration', () => {
  test('forces an existing enabled preference off and applies host configuration', async () => {
    let enabled = true;
    const persistEnabled = vi.fn((nextEnabled: boolean) => {
      enabled = nextEnabled;
    });
    const applyConfiguration = vi.fn(async () => undefined);

    const result = await migrateNativeSandboxM0Configuration({
      getEnabled: () => enabled,
      persistEnabled,
      applyConfiguration,
    });

    expect(result).toEqual({
      migrated: true,
      configurationApplied: true,
    });
    expect(enabled).toBe(false);
    expect(persistEnabled).toHaveBeenCalledWith(false);
    expect(applyConfiguration).toHaveBeenCalledWith(false);
  });

  test('does nothing when Sandbox is already disabled', async () => {
    const persistEnabled = vi.fn();
    const applyConfiguration = vi.fn(async () => undefined);

    const result = await migrateNativeSandboxM0Configuration({
      getEnabled: () => false,
      persistEnabled,
      applyConfiguration,
    });

    expect(result).toEqual({
      migrated: false,
      configurationApplied: false,
    });
    expect(persistEnabled).not.toHaveBeenCalled();
    expect(applyConfiguration).not.toHaveBeenCalled();
  });

  test('keeps the persisted preference disabled when runtime config application fails', async () => {
    let enabled = true;
    const error = new Error('gateway unavailable');
    const logger = { error: vi.fn() };

    const result = await migrateNativeSandboxM0Configuration({
      getEnabled: () => enabled,
      persistEnabled: nextEnabled => {
        enabled = nextEnabled;
      },
      applyConfiguration: vi.fn(async () => {
        throw error;
      }),
      logger,
    });

    expect(result).toEqual({
      migrated: true,
      configurationApplied: false,
    });
    expect(enabled).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      '[NativeSandbox] Failed to apply the M0 fail-closed configuration migration.',
      error,
    );
  });
});
