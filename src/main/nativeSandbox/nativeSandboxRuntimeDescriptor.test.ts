import { describe, expect, test } from 'vitest';

import { NativeSandboxRuntimeKind } from '../../shared/nativeSandbox/constants';
import { resolveNativeSandboxRuntimeDescriptor } from './nativeSandboxRuntimeDescriptor';
import {
  resolveWindowsNativeSandboxRunnerPath,
  resolveWindowsNativeSandboxSetupPath,
} from './windows/windowsNativeSandboxEnvironment';

const createEnvironment = (platform: NodeJS.Platform) => ({
  appPath: 'D:\\LobsterAI',
  resourcesPath: 'D:\\LobsterAI\\resources',
  isPackaged: false,
  platform,
  architecture: 'x64',
});

describe('resolveNativeSandboxRuntimeDescriptor', () => {
  test('exposes the native Windows runner only on supported Windows hosts', () => {
    const descriptor = resolveNativeSandboxRuntimeDescriptor(createEnvironment('win32'));

    expect(descriptor).toMatchObject({
      runtimeKind: NativeSandboxRuntimeKind.NativeWindows,
      runtimeVersion: '0.4.0',
      protocolVersion: 4,
      activationAvailable: true,
    });
    expect(descriptor.executablePath).toMatch(
      /[\\/]LobsterAI-SandboxRuntime[\\/]current[\\/]lobster-command-runner\.exe$/i,
    );
  });

  test('keeps the M3 activation gate closed on non-Windows hosts', () => {
    const descriptor = resolveNativeSandboxRuntimeDescriptor(createEnvironment('darwin'));

    expect(descriptor.activationAvailable).toBe(false);
  });

  test('ignores executable path overrides in packaged builds', () => {
    const environment = {
      ...createEnvironment('win32'),
      isPackaged: true,
    };

    expect(resolveWindowsNativeSandboxRunnerPath(environment, 'D:\\tampered-runner.exe'))
      .toMatch(
        /[\\/]LobsterAI-SandboxRuntime[\\/]current[\\/]lobster-command-runner\.exe$/i,
      );
    expect(resolveWindowsNativeSandboxSetupPath(environment, 'D:\\tampered-setup.exe'))
      .toBe('D:\\LobsterAI\\resources\\sandbox-runtime\\lobster-sandbox-setup.exe');
  });
});
