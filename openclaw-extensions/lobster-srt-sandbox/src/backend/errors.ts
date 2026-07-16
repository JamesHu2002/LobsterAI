import {
  LobsterSrtSandboxBackendErrorCode,
  type LobsterSrtSandboxBackendErrorCode as LobsterSrtSandboxBackendErrorCodeValue,
} from './constants.js';

export class LobsterSrtSandboxBackendError extends Error {
  constructor(
    readonly code: LobsterSrtSandboxBackendErrorCodeValue,
    message: string,
  ) {
    super(message);
    this.name = 'LobsterSrtSandboxBackendError';
  }
}

export function createCommandExecutionUnavailableError(): LobsterSrtSandboxBackendError {
  return new LobsterSrtSandboxBackendError(
    LobsterSrtSandboxBackendErrorCode.CommandExecutionUnavailable,
    'The lobster-srt command runtime is not connected yet; refusing to execute on the host.',
  );
}

export function createBackendUnavailableError(): LobsterSrtSandboxBackendError {
  return new LobsterSrtSandboxBackendError(
    LobsterSrtSandboxBackendErrorCode.BackendUnavailable,
    'The lobster-srt backend is packaged for M2 validation but cannot be activated until the native M3 runtime boundary is connected.',
  );
}
