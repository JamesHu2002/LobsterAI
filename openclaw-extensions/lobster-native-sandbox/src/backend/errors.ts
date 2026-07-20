import {
  LobsterNativeSandboxBackendErrorCode,
  type LobsterNativeSandboxBackendErrorCode as LobsterNativeSandboxBackendErrorCodeValue,
} from './constants.js';

export class LobsterNativeSandboxBackendError extends Error {
  constructor(
    readonly code: LobsterNativeSandboxBackendErrorCodeValue,
    message: string,
  ) {
    super(message);
    this.name = 'LobsterNativeSandboxBackendError';
  }
}

export function createBackendDisabledError(): LobsterNativeSandboxBackendError {
  return new LobsterNativeSandboxBackendError(
    LobsterNativeSandboxBackendErrorCode.BackendDisabled,
    'The LobsterAI native sandbox is disabled; refusing to execute through the backend.',
  );
}

export function createBackendUnavailableError(): LobsterNativeSandboxBackendError {
  return new LobsterNativeSandboxBackendError(
    LobsterNativeSandboxBackendErrorCode.BackendUnavailable,
    'The lobster-native backend is unavailable; refusing to fall back to host execution.',
  );
}
