import { describe, expect, test, vi } from 'vitest';

import {
  NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION,
  NativeSandboxErrorCode,
  NativeSandboxRuntimeKind,
  NativeSandboxState,
} from '../../../shared/nativeSandbox/constants';
import { WindowsNativeSandboxProvisioner } from './windowsNativeSandboxProvisioner';

const createProvisioner = (overrides: Partial<ConstructorParameters<
  typeof WindowsNativeSandboxProvisioner
>[0]> = {}) => new WindowsNativeSandboxProvisioner({
  appPath: 'D:\\LobsterAI',
  resourcesPath: 'D:\\LobsterAI\\resources',
  isPackaged: false,
  platform: 'win32',
  architecture: 'x64',
  runnerPath: 'D:\\LobsterAI\\lobster-command-runner.exe',
  pathExists: () => true,
  probeVersion: async () => (
    `lobster-command-runner ${NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION}`
  ),
  now: () => 123,
  ...overrides,
});

describe('WindowsNativeSandboxProvisioner', () => {
  test('reports a matching Windows runner as ready without exposing setup lifecycle', async () => {
    const provisioner = createProvisioner();

    const result = await provisioner.getStatus();

    expect(result.success).toBe(true);
    expect(result.status).toMatchObject({
      runtimeKind: NativeSandboxRuntimeKind.NativeWindows,
      state: NativeSandboxState.Ready,
      runtimeAvailable: true,
      activationAvailable: true,
      lifecycleAvailable: false,
      installed: true,
      healthy: true,
      checkedAt: 123,
    });
  });

  test('fails closed when the runner version does not match the protocol bundle', async () => {
    const provisioner = createProvisioner({
      probeVersion: async () => 'lobster-command-runner 9.9.9',
    });

    const result = await provisioner.getStatus();

    expect(result.success).toBe(true);
    expect(result.status).toMatchObject({
      state: NativeSandboxState.Degraded,
      healthy: false,
      lastError: {
        code: NativeSandboxErrorCode.RuntimeVersionIncompatible,
      },
    });
  });

  test('reports a missing development runner without attempting a version probe', async () => {
    const probeVersion = vi.fn(async () => 'unexpected');
    const provisioner = createProvisioner({
      pathExists: () => false,
      probeVersion,
    });

    const result = await provisioner.getStatus();

    expect(result.status).toMatchObject({
      state: NativeSandboxState.NotInstalled,
      runtimeAvailable: false,
      installed: false,
      healthy: false,
      lastError: {
        code: NativeSandboxErrorCode.RuntimeExecutableUnavailable,
      },
    });
    expect(probeVersion).not.toHaveBeenCalled();
  });

  test('keeps non-Windows platforms unsupported', async () => {
    const provisioner = createProvisioner({ platform: 'darwin' });

    const result = await provisioner.getStatus();

    expect(result.status).toMatchObject({
      state: NativeSandboxState.Unsupported,
      supported: false,
      activationAvailable: false,
      lastError: {
        code: NativeSandboxErrorCode.UnsupportedPlatform,
      },
    });
  });
});
