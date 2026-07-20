import { registerSandboxBackend } from 'openclaw/plugin-sdk/sandbox';

import { createWindowsSandboxFsBridge } from '../fs/windowsSandboxFsBridge.js';
import { LOBSTER_SRT_SANDBOX_BACKEND_ID } from './constants.js';
import {
  createLobsterSrtSandboxBackendFactory,
  type LobsterSrtSandboxBackendDependencies,
} from './lobsterSrtSandboxBackend.js';

export function registerLobsterSrtSandboxBackend(
  dependencies: Omit<LobsterSrtSandboxBackendDependencies, 'createFsBridge'>,
): () => void {
  return registerSandboxBackend(LOBSTER_SRT_SANDBOX_BACKEND_ID, {
    factory: createLobsterSrtSandboxBackendFactory({
      ...dependencies,
      createFsBridge: ({ sandbox, io }) => createWindowsSandboxFsBridge({
        sandbox,
        io,
      }),
    }),
  });
}

export {
  LOBSTER_SRT_POLICY_VERSION,
  LOBSTER_SRT_RUNTIME_VERSION,
  LOBSTER_SRT_SANDBOX_BACKEND_ID,
  LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS,
  LobsterSrtSandboxBackendErrorCode,
  LobsterSrtSandboxGatewayMethod,
  LobsterSrtSandboxRuntimeState,
} from './constants.js';
export { LobsterSrtSandboxBackendError } from './errors.js';
export {
  createLobsterSrtSandboxBackend,
  createLobsterSrtSandboxBackendFactory,
  type LobsterSrtSandboxBackendDependencies,
  type LobsterSrtSandboxFsBridgeContext,
  type LobsterSrtSandboxFsBridgeFactory,
} from './lobsterSrtSandboxBackend.js';
export {
  buildSrtWindowsRuntimeConfig,
  type SrtSandboxManagerLike,
  SrtWindowsSession,
  type SrtWindowsSessionOptions,
  type SrtWindowsSessionStatus,
} from './srtWindowsSession.js';
