import { registerSandboxBackend } from 'openclaw/plugin-sdk/sandbox';

import { createWindowsSandboxFsBridge } from '../fs/windowsSandboxFsBridge.js';
import { LOBSTER_NATIVE_SANDBOX_BACKEND_ID } from './constants.js';
import {
  createLobsterNativeSandboxBackendFactory,
  type LobsterNativeSandboxBackendDependencies,
} from './lobsterNativeSandboxBackend.js';

export function registerLobsterNativeSandboxBackend(
  dependencies: Omit<LobsterNativeSandboxBackendDependencies, 'createFsBridge'>,
): () => void {
  return registerSandboxBackend(LOBSTER_NATIVE_SANDBOX_BACKEND_ID, {
    factory: createLobsterNativeSandboxBackendFactory({
      ...dependencies,
      createFsBridge: ({ sandbox, io, policyContext }) => createWindowsSandboxFsBridge({
        sandbox,
        io,
        writeRoots: policyContext.writableRoots,
        readRoots: policyContext.readableRoots,
      }),
    }),
  });
}

export {
  LEGACY_SRT_RUNTIME_KIND,
  LEGACY_SRT_RUNTIME_VERSION,
  LOBSTER_NATIVE_POLICY_VERSION,
  LOBSTER_NATIVE_PROTOCOL_VERSION,
  LOBSTER_NATIVE_SANDBOX_BACKEND_ID,
  LOBSTER_NATIVE_WINDOWS_RUNTIME_KIND,
  LOBSTER_NATIVE_WINDOWS_RUNTIME_VERSION,
  LOBSTER_NATIVE_WORKSPACE_PATH_SEMANTICS,
  LobsterNativeSandboxBackendErrorCode,
  LobsterNativeSandboxFilesystemCapability,
  LobsterNativeSandboxGatewayMethod,
  LobsterNativeSandboxRuntimeState,
} from './constants.js';
export { LobsterNativeSandboxBackendError } from './errors.js';
export {
  createLobsterNativeSandboxBackend,
  createLobsterNativeSandboxBackendFactory,
  type LobsterNativeSandboxBackendDependencies,
  type LobsterNativeSandboxFsBridgeContext,
  type LobsterNativeSandboxFsBridgeFactory,
} from './lobsterNativeSandboxBackend.js';
