export const LOBSTER_NATIVE_SANDBOX_BACKEND_ID = 'lobster-native';
export const LOBSTER_NATIVE_WORKSPACE_PATH_SEMANTICS = 'host';
export const LOBSTER_NATIVE_PROTOCOL_VERSION = 1;
export const LOBSTER_NATIVE_POLICY_VERSION = 'workspace-write-v1';
export const LEGACY_SRT_RUNTIME_VERSION = '0.0.65';
export const LEGACY_SRT_RUNTIME_KIND = 'legacy-windows-adapter';

export const LobsterNativeSandboxGatewayMethod = {
  Status: 'lobster-native-sandbox.status',
} as const;

export const LobsterNativeSandboxRuntimeState = {
  Disabled: 'disabled',
  Idle: 'idle',
  Initializing: 'initializing',
  Ready: 'ready',
  Resetting: 'resetting',
  Error: 'error',
} as const;

export type LobsterNativeSandboxRuntimeState =
  typeof LobsterNativeSandboxRuntimeState[keyof typeof LobsterNativeSandboxRuntimeState];

export const LobsterNativeSandboxBackendErrorCode = {
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

export type LobsterNativeSandboxBackendErrorCode =
  typeof LobsterNativeSandboxBackendErrorCode[
    keyof typeof LobsterNativeSandboxBackendErrorCode
  ];
