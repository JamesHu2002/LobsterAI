export const NATIVE_SANDBOX_RUNTIME_VERSION = '0.0.65';
export const NATIVE_SANDBOX_POLICY_VERSION = 'm3-single-workspace-v1';
export const NATIVE_SANDBOX_OPENCLAW_BACKEND_ID = 'lobster-srt';
export const NATIVE_SANDBOX_OPENCLAW_PLUGIN_ID = 'lobster-srt-sandbox';

export const NativeSandboxIpcChannel = {
  GetStatus: 'native-sandbox:get-status',
  Install: 'native-sandbox:install',
  Repair: 'native-sandbox:repair',
  SetEnabled: 'native-sandbox:set-enabled',
} as const;

export const NativeSandboxGatewayMethod = {
  Status: 'lobster-srt-sandbox.status',
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
  HelperUnavailable: 'helper-unavailable',
  RuntimeUnavailable: 'runtime-unavailable',
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

export const NativeSandboxNetworkState = {
  Unknown: 'unknown',
  Absent: 'absent',
  Installed: 'installed',
  CannotRead: 'cannot-read',
  Verified: 'verified',
  VerificationFailed: 'verification-failed',
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
