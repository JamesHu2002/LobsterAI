export const LOBSTER_NATIVE_SANDBOX_BACKEND_ID = 'lobster-native';
export const LOBSTER_NATIVE_WORKSPACE_PATH_SEMANTICS = 'host';
export const LOBSTER_NATIVE_PROTOCOL_VERSION = 3;
export const LOBSTER_NATIVE_POLICY_VERSION = 'workspace-write-v3';
export const LOBSTER_NATIVE_WINDOWS_RUNTIME_VERSION = '0.3.0';
export const LOBSTER_NATIVE_WINDOWS_RUNTIME_KIND = 'native-windows';
export const LEGACY_SRT_RUNTIME_VERSION = '0.0.65';
export const LEGACY_SRT_RUNTIME_KIND = 'legacy-windows-adapter';

export const LobsterNativeSandboxProfileMode = {
  InheritHost: 'inherit-host',
} as const;

export type LobsterNativeSandboxProfileMode =
  typeof LobsterNativeSandboxProfileMode[keyof typeof LobsterNativeSandboxProfileMode];

export const LobsterNativeSandboxFilesystemCapability = {
  NpmCacheWrite: 'npm-cache-write',
} as const;

export type LobsterNativeSandboxFilesystemCapability =
  typeof LobsterNativeSandboxFilesystemCapability[
    keyof typeof LobsterNativeSandboxFilesystemCapability
  ];

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
  RuntimeProtocolInvalid: 'runtime-protocol-invalid',
  CommandExecutionFailed: 'command-execution-failed',
  CommandOutputLimitExceeded: 'command-output-limit-exceeded',
  InvalidEnvironment: 'invalid-environment',
  InteractiveInputUnsupported: 'interactive-input-unsupported',
} as const;

export type LobsterNativeSandboxBackendErrorCode =
  typeof LobsterNativeSandboxBackendErrorCode[
    keyof typeof LobsterNativeSandboxBackendErrorCode
  ];
