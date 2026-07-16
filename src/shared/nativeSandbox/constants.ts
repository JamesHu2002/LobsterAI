export const NATIVE_SANDBOX_RUNTIME_VERSION = '0.0.65';

export const NativeSandboxIpcChannel = {
  GetStatus: 'native-sandbox:get-status',
  Install: 'native-sandbox:install',
  Repair: 'native-sandbox:repair',
} as const;

export const NativeSandboxPlatform = {
  Windows: 'windows',
  MacOS: 'macos',
  Linux: 'linux',
  Unknown: 'unknown',
} as const;

export const NativeSandboxState = {
  Unsupported: 'unsupported',
  Unavailable: 'unavailable',
  NotInstalled: 'not-installed',
  Checking: 'checking',
  Installing: 'installing',
  Repairing: 'repairing',
  Ready: 'ready',
  Degraded: 'degraded',
  Error: 'error',
} as const;

export const NativeSandboxOperation = {
  Check: 'check',
  Install: 'install',
  Repair: 'repair',
} as const;

export const NativeSandboxErrorCode = {
  UnsupportedPlatform: 'unsupported-platform',
  UnsupportedArchitecture: 'unsupported-architecture',
  HelperUnavailable: 'helper-unavailable',
  RuntimeUnavailable: 'runtime-unavailable',
  StatusCheckFailed: 'status-check-failed',
  InstallFailed: 'install-failed',
  RepairFailed: 'repair-failed',
} as const;

export const NativeSandboxNetworkState = {
  Unknown: 'unknown',
  Absent: 'absent',
  Installed: 'installed',
  CannotRead: 'cannot-read',
  Verified: 'verified',
  VerificationFailed: 'verification-failed',
} as const;
