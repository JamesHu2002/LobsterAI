import { registerSandboxBackend } from 'openclaw/plugin-sdk/sandbox';

import { createWindowsSandboxFsBridge } from '../fs/windowsSandboxFsBridge.js';
import { LOBSTER_SRT_SANDBOX_BACKEND_ID } from './constants.js';
import { createLobsterSrtSandboxBackendFactory } from './lobsterSrtSandboxBackend.js';

export function registerLobsterSrtSandboxBackend(): () => void {
  return registerSandboxBackend(LOBSTER_SRT_SANDBOX_BACKEND_ID, {
    factory: createLobsterSrtSandboxBackendFactory({
      createFsBridge: createWindowsSandboxFsBridge,
    }),
  });
}

export {
  LOBSTER_SRT_SANDBOX_BACKEND_ID,
  LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS,
  LobsterSrtSandboxBackendErrorCode,
} from './constants.js';
export { LobsterSrtSandboxBackendError } from './errors.js';
export {
  createLobsterSrtSandboxBackend,
  createLobsterSrtSandboxBackendFactory,
  type LobsterSrtSandboxBackendDependencies,
  type LobsterSrtSandboxFsBridgeContext,
  type LobsterSrtSandboxFsBridgeFactory,
} from './lobsterSrtSandboxBackend.js';
