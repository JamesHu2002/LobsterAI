import { describe, expect, test } from 'vitest';

import { NativeSandboxRuntimeKind } from '../../shared/nativeSandbox/constants';
import { resolveNativeSandboxRuntimeDescriptor } from './nativeSandboxRuntimeDescriptor';

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
      runtimeVersion: '0.3.0',
      protocolVersion: 3,
      activationAvailable: true,
    });
    expect(descriptor.executablePath).toMatch(
      /[\\/]native[\\/]sandbox-windows[\\/]target[\\/]release[\\/]lobster-command-runner\.exe$/,
    );
  });

  test('keeps the M2 activation gate closed on non-Windows hosts', () => {
    const descriptor = resolveNativeSandboxRuntimeDescriptor(createEnvironment('darwin'));

    expect(descriptor.activationAvailable).toBe(false);
  });
});
