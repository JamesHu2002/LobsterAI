export const LOBSTER_SRT_SANDBOX_BACKEND_ID = 'lobster-srt';
export const LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS = 'host';
export const LOBSTER_SRT_RUNTIME_VERSION = '0.0.65';
export const LOBSTER_SRT_POLICY_VERSION = 'm3-single-workspace-v1';

export const LobsterSrtSandboxGatewayMethod = {
  Status: 'lobster-srt-sandbox.status',
} as const;

export const LobsterSrtSandboxRuntimeState = {
  Disabled: 'disabled',
  Idle: 'idle',
  Initializing: 'initializing',
  Ready: 'ready',
  Resetting: 'resetting',
  Error: 'error',
} as const;

export type LobsterSrtSandboxRuntimeState =
  typeof LobsterSrtSandboxRuntimeState[keyof typeof LobsterSrtSandboxRuntimeState];

export const LobsterSrtSandboxBackendErrorCode = {
  UnsupportedPlatform: 'unsupported-platform',
  BackendDisabled: 'backend-disabled',
  BackendUnavailable: 'backend-unavailable',
  HelperUnavailable: 'helper-unavailable',
  InvalidWorkspace: 'invalid-workspace',
  UnsafeWorkspaceAcl: 'unsafe-workspace-acl',
  WorkspaceConflict: 'workspace-conflict',
  RuntimeInitializationFailed: 'runtime-initialization-failed',
  CommandExecutionFailed: 'command-execution-failed',
  CommandOutputLimitExceeded: 'command-output-limit-exceeded',
  InvalidEnvironment: 'invalid-environment',
} as const;

export type LobsterSrtSandboxBackendErrorCode =
  typeof LobsterSrtSandboxBackendErrorCode[keyof typeof LobsterSrtSandboxBackendErrorCode];
