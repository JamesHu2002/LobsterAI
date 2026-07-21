import path from 'node:path';

import type { NativeSandboxEnvironment } from '../nativeSandboxEnvironment';

export const WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME = 'lobster-command-runner.exe';
export const WINDOWS_NATIVE_SANDBOX_RUNNER_OVERRIDE_ENV = 'LOBSTER_NATIVE_SANDBOX_RUNNER';

export const resolveWindowsNativeSandboxRunnerPath = (
  environment: NativeSandboxEnvironment,
  overridePath = process.env[WINDOWS_NATIVE_SANDBOX_RUNNER_OVERRIDE_ENV],
): string => {
  const explicitPath = overridePath?.trim();
  if (explicitPath) return path.resolve(explicitPath);
  if (environment.isPackaged) {
    return path.join(
      environment.resourcesPath,
      'sandbox-runtime',
      WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME,
    );
  }
  return path.join(
    environment.appPath,
    'native',
    'sandbox-windows',
    'target',
    'release',
    WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME,
  );
};
