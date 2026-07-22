import { describe, expect, test, vi } from 'vitest';

import {
  NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION,
  NativeSandboxErrorCode,
  NativeSandboxRuntimeKind,
  NativeSandboxState,
} from '../../../shared/nativeSandbox/constants';
import { WindowsNativeSandboxProvisioner } from './windowsNativeSandboxProvisioner';

const installRoot = 'C:\\ProgramData\\LobsterAI-SandboxRuntime';
const runnerPath = `${installRoot}\\current\\lobster-command-runner.exe`;

const setupReport = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  operation: 'verify',
  success: true,
  cancelled: false,
  installed: true,
  healthy: true,
  runtimeVersion: NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION,
  protocolVersion: 4,
  policyVersion: 'workspace-write-v4',
  installRoot,
  runnerPath,
  setupPath: `${installRoot}\\current\\lobster-sandbox-setup.exe`,
  identity: {
    accountName: 'LobsterSandboxOffline',
    accountSid: 'S-1-5-21-test',
    ready: true,
  },
  integrity: {
    manifestVerified: true,
    hashesVerified: true,
    signaturesRequired: false,
    signaturesVerified: false,
  },
  network: {
    mode: 'disabled',
    rulesInstalled: true,
    rulesEffective: true,
  },
  protection: {
    protectedInstall: true,
    credentialsProtected: true,
  },
  rebootRequired: false,
  ...overrides,
});

const createProvisioner = (overrides: Partial<ConstructorParameters<
  typeof WindowsNativeSandboxProvisioner
>[0]> = {}) => new WindowsNativeSandboxProvisioner({
  appPath: 'D:\\LobsterAI',
  resourcesPath: 'D:\\LobsterAI\\resources',
  isPackaged: false,
  platform: 'win32',
  architecture: 'x64',
  runnerPath,
  setupPath: 'D:\\LobsterAI\\lobster-sandbox-setup.exe',
  manifestPath: 'D:\\LobsterAI\\lobster-sandbox-manifest.json',
  installRoot,
  pathExists: () => true,
  invokeSetup: async () => ({
    exitCode: 0,
    stdout: JSON.stringify(setupReport()),
    stderr: '',
  }),
  verifyBootstrap: async () => undefined,
  now: () => 123,
  ...overrides,
});

describe('WindowsNativeSandboxProvisioner', () => {
  test('reports a verified protected installation as M3 ready', async () => {
    const result = await createProvisioner().getStatus();

    expect(result.success).toBe(true);
    expect(result.status).toMatchObject({
      runtimeKind: NativeSandboxRuntimeKind.NativeWindows,
      state: NativeSandboxState.Ready,
      runtimeAvailable: true,
      activationAvailable: true,
      lifecycleAvailable: true,
      installed: true,
      healthy: true,
      identityReady: true,
      integrityVerified: true,
      protectedInstallation: true,
      networkIsolated: true,
      productionReady: false,
      checkedAt: 123,
    });
  });

  test('derives the installed runner from an explicit installation root', async () => {
    const customRoot = 'D:\\LobsterSandboxRuntime';
    const customRunner = `${customRoot}\\current\\lobster-command-runner.exe`;
    const result = await createProvisioner({
      installRoot: customRoot,
      runnerPath: undefined,
      invokeSetup: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(setupReport({
          installRoot: customRoot,
          runnerPath: customRunner,
          setupPath: `${customRoot}\\current\\lobster-sandbox-setup.exe`,
        })),
        stderr: '',
      }),
    }).getStatus();

    expect(result.success).toBe(true);
    expect(result.status.installationRoot).toBe(customRoot);
  });

  test('reports a clean machine as not installed while keeping lifecycle available', async () => {
    const provisioner = createProvisioner({
      invokeSetup: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(setupReport({
          installed: false,
          healthy: false,
          runtimeVersion: NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION,
          protocolVersion: 0,
          policyVersion: '',
          runnerPath: '',
          errorCode: 'runtime-not-installed',
        })),
        stderr: '',
      }),
    });

    const result = await provisioner.getStatus();

    expect(result.success).toBe(true);
    expect(result.status).toMatchObject({
      state: NativeSandboxState.NotInstalled,
      lifecycleAvailable: true,
      installed: false,
      healthy: false,
    });
  });

  test('fails closed when setup reports a runtime hash mismatch', async () => {
    const provisioner = createProvisioner({
      invokeSetup: async () => ({
        exitCode: 1,
        stdout: JSON.stringify(setupReport({
          success: false,
          healthy: false,
          errorCode: 'runtime-hash-invalid',
          message: 'Runtime hash mismatch.',
        })),
        stderr: '',
      }),
    });

    const result = await provisioner.getStatus();

    expect(result.success).toBe(false);
    expect(result.status).toMatchObject({
      state: NativeSandboxState.Degraded,
      healthy: false,
      lastError: {
        code: NativeSandboxErrorCode.RuntimeHashInvalid,
      },
    });
  });

  test.each([
    ['runtime-file-set-invalid', NativeSandboxErrorCode.RuntimeManifestInvalid],
    ['runtime-reparse-point-denied', NativeSandboxErrorCode.RuntimeProtectionInvalid],
  ])('maps setup error %s to a stable product error', async (setupError, expectedError) => {
    const provisioner = createProvisioner({
      invokeSetup: async () => ({
        exitCode: 1,
        stdout: JSON.stringify(setupReport({
          success: false,
          healthy: false,
          errorCode: setupError,
          message: 'Runtime verification failed.',
        })),
        stderr: '',
      }),
    });

    const result = await provisioner.getStatus();

    expect(result.success).toBe(false);
    expect(result.status.lastError?.code).toBe(expectedError);
  });

  test('rejects an installed report outside the fixed protected installation root', async () => {
    const result = await createProvisioner({
      invokeSetup: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(setupReport({
          installRoot: 'D:\\UntrustedRuntime',
          setupPath: 'D:\\UntrustedRuntime\\current\\lobster-sandbox-setup.exe',
        })),
        stderr: '',
      }),
    }).getStatus();

    expect(result.success).toBe(false);
    expect(result.status.lastError?.code).toBe(NativeSandboxErrorCode.RuntimeProtectionInvalid);
  });

  test('requires verified Authenticode in packaged builds', async () => {
    const invokeSetup = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(setupReport()),
      stderr: '',
    }));
    const result = await createProvisioner({
      isPackaged: true,
      invokeSetup,
    }).getStatus();

    expect(invokeSetup).toHaveBeenCalledWith(
      'D:\\LobsterAI\\lobster-sandbox-setup.exe',
      ['verify', '--require-signature'],
      expect.any(Number),
    );
    expect(result).toMatchObject({
      success: false,
      status: {
        healthy: false,
        lastError: {
          code: NativeSandboxErrorCode.RuntimeSignatureInvalid,
        },
      },
    });
  });

  test('installs through the fixed setup command and preserves UAC cancellation', async () => {
    const invokeSetup = vi.fn(async () => ({
      exitCode: 2,
      stdout: JSON.stringify(setupReport({
        operation: 'install',
        success: false,
        cancelled: true,
        installed: false,
        healthy: false,
        errorCode: 'setup-uac-cancelled',
        message: 'Windows administrator approval was cancelled.',
      })),
      stderr: '',
    }));
    const result = await createProvisioner({ invokeSetup }).install();

    expect(invokeSetup).toHaveBeenCalledWith(
      'D:\\LobsterAI\\lobster-sandbox-setup.exe',
      ['install'],
      expect.any(Number),
    );
    expect(result).toMatchObject({
      success: false,
      cancelled: true,
      status: {
        lastError: {
          code: NativeSandboxErrorCode.SetupUacCancelled,
        },
      },
    });
  });

  test('reports an incomplete bootstrap bundle without invoking setup', async () => {
    const invokeSetup = vi.fn();
    const result = await createProvisioner({
      pathExists: () => false,
      invokeSetup,
    }).getStatus();

    expect(result.success).toBe(false);
    expect(result.status).toMatchObject({
      state: NativeSandboxState.Unavailable,
      lifecycleAvailable: false,
      lastError: {
        code: NativeSandboxErrorCode.SetupUnavailable,
      },
    });
    expect(invokeSetup).not.toHaveBeenCalled();
  });

  test('keeps non-Windows platforms unsupported', async () => {
    const result = await createProvisioner({ platform: 'darwin' }).getStatus();

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
