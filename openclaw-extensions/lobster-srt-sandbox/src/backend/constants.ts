export const LOBSTER_SRT_SANDBOX_BACKEND_ID = 'lobster-srt';
export const LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS = 'host';

export const LobsterSrtSandboxBackendErrorCode = {
  UnsupportedPlatform: 'unsupported-platform',
  BackendUnavailable: 'backend-unavailable',
  CommandExecutionUnavailable: 'command-execution-unavailable',
} as const;

export type LobsterSrtSandboxBackendErrorCode =
  typeof LobsterSrtSandboxBackendErrorCode[keyof typeof LobsterSrtSandboxBackendErrorCode];
