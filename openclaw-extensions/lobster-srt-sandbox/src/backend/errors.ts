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

export function createBackendDisabledError(): LobsterSrtSandboxBackendError {
  return new LobsterSrtSandboxBackendError(
    LobsterSrtSandboxBackendErrorCode.BackendDisabled,
    'The LobsterAI native sandbox is disabled; refusing to execute through the backend.',
  );
}

export function createBackendUnavailableError(): LobsterSrtSandboxBackendError {
  return new LobsterSrtSandboxBackendError(
    LobsterSrtSandboxBackendErrorCode.BackendUnavailable,
    'The lobster-srt backend is unavailable; refusing to fall back to host execution.',
  );
}
