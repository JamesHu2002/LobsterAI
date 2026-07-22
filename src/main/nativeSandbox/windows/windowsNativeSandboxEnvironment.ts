import path from 'node:path';

import type { NativeSandboxEnvironment } from '../nativeSandboxEnvironment';

export const WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME = 'lobster-command-runner.exe';
export const WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME = 'lobster-sandbox-setup.exe';
export const WINDOWS_NATIVE_SANDBOX_MANIFEST_FILENAME = 'lobster-sandbox-manifest.json';
export const WINDOWS_NATIVE_SANDBOX_RUNNER_OVERRIDE_ENV = 'LOBSTER_NATIVE_SANDBOX_RUNNER';
export const WINDOWS_NATIVE_SANDBOX_SETUP_OVERRIDE_ENV = 'LOBSTER_NATIVE_SANDBOX_SETUP';
export const WINDOWS_NATIVE_SANDBOX_INSTALL_DIRECTORY_NAME = 'LobsterAI-SandboxRuntime';

export const resolveWindowsNativeSandboxInstallRoot = (
  programData = process.env.ProgramData,
): string => path.join(
  programData?.trim() || 'C:\\ProgramData',
  WINDOWS_NATIVE_SANDBOX_INSTALL_DIRECTORY_NAME,
);

export const resolveWindowsNativeSandboxBootstrapDirectory = (
  environment: NativeSandboxEnvironment,
): string => environment.isPackaged
  ? path.join(environment.resourcesPath, 'sandbox-runtime')
  : path.join(environment.appPath, 'native', 'sandbox-windows', 'target', 'release');

export const resolveWindowsNativeSandboxRunnerPath = (
  environment: NativeSandboxEnvironment,
  overridePath = process.env[WINDOWS_NATIVE_SANDBOX_RUNNER_OVERRIDE_ENV],
): string => {
  const explicitPath = environment.isPackaged ? undefined : overridePath?.trim();
  if (explicitPath) return path.resolve(explicitPath);
  return path.join(
    resolveWindowsNativeSandboxInstallRoot(),
    'current',
    WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME,
  );
};

export const resolveWindowsNativeSandboxSetupPath = (
  environment: NativeSandboxEnvironment,
  overridePath = process.env[WINDOWS_NATIVE_SANDBOX_SETUP_OVERRIDE_ENV],
): string => {
  const explicitPath = environment.isPackaged ? undefined : overridePath?.trim();
  if (explicitPath) return path.resolve(explicitPath);
  return path.join(
    resolveWindowsNativeSandboxBootstrapDirectory(environment),
    WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME,
  );
};

export const resolveWindowsNativeSandboxManifestPath = (
  environment: NativeSandboxEnvironment,
): string => path.join(
  resolveWindowsNativeSandboxBootstrapDirectory(environment),
  WINDOWS_NATIVE_SANDBOX_MANIFEST_FILENAME,
);
