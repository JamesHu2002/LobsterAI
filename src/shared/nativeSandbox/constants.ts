export const NATIVE_SANDBOX_PROTOCOL_VERSION = 1;
export const NATIVE_SANDBOX_POLICY_VERSION = 'workspace-write-v1';
export const NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION = '0.1.0';
export const NATIVE_SANDBOX_OPENCLAW_BACKEND_ID = 'lobster-native';
export const NATIVE_SANDBOX_OPENCLAW_PLUGIN_ID = 'lobster-native-sandbox';
export const NATIVE_SANDBOX_RETIRED_OPENCLAW_PLUGIN_IDS = [
  'lobster-srt-sandbox',
] as const;

/** M2 exposes the native executor only through the explicitly labelled test UI. */
export const NATIVE_SANDBOX_ACTIVATION_AVAILABLE = true;

export const NativeSandboxIpcChannel = {
  GetStatus: 'native-sandbox:get-status',
  Install: 'native-sandbox:install',
  Repair: 'native-sandbox:repair',
  SetEnabled: 'native-sandbox:set-enabled',
} as const;

export const NativeSandboxGatewayMethod = {
  Status: 'lobster-native-sandbox.status',
} as const;

export const NativeSandboxRuntimeKind = {
  LegacyWindowsAdapter: 'legacy-windows-adapter',
  NativeWindows: 'native-windows',
  NativeMacOS: 'native-macos',
  Mock: 'mock',
} as const;

export const NativeSandboxNetworkMode = {
  Disabled: 'disabled',
  ManagedProxy: 'managed-proxy',
  Allowlist: 'allowlist',
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
  Enable: 'enable',
  Disable: 'disable',
} as const;

export const NativeSandboxErrorCode = {
  UnsupportedPlatform: 'unsupported-platform',
  UnsupportedArchitecture: 'unsupported-architecture',
  ActivationUnavailable: 'activation-unavailable',
  RuntimeExecutableUnavailable: 'runtime-executable-unavailable',
  RuntimeUnavailable: 'runtime-unavailable',
  RuntimeVersionIncompatible: 'runtime-version-incompatible',
  StatusCheckFailed: 'status-check-failed',
  InstallFailed: 'install-failed',
  RepairFailed: 'repair-failed',
  ActiveWorkloads: 'active-workloads',
  EnterpriseManaged: 'enterprise-managed',
  HealthCheckFailed: 'health-check-failed',
  ConfigurationFailed: 'configuration-failed',
  BackendVerificationFailed: 'backend-verification-failed',
  RollbackFailed: 'rollback-failed',
  InvalidWorkspace: 'invalid-workspace',
  UnsafeWorkspaceAcl: 'unsafe-workspace-acl',
} as const;

export const NativeSandboxControlStage = {
  Idle: 'idle',
  WorkloadCheck: 'workload-check',
  HealthCheck: 'health-check',
  PersistConfiguration: 'persist-configuration',
  ApplyConfiguration: 'apply-configuration',
  VerifyBackend: 'verify-backend',
  Rollback: 'rollback',
} as const;

export const NativeSandboxBackendState = {
  Disabled: 'disabled',
  Idle: 'idle',
  Initializing: 'initializing',
  Ready: 'ready',
  Resetting: 'resetting',
  Error: 'error',
} as const;
