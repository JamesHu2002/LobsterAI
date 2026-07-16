import { createHash } from 'node:crypto';

import type {
  CreateSandboxBackendParams,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxFsBridge,
} from 'openclaw/plugin-sdk/sandbox';

import {
  LOBSTER_SRT_SANDBOX_BACKEND_ID,
  LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS,
  LobsterSrtSandboxBackendErrorCode,
} from './constants.js';
import {
  createBackendUnavailableError,
  createCommandExecutionUnavailableError,
  LobsterSrtSandboxBackendError,
} from './errors.js';

export type LobsterSrtSandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle['createFsBridge']>
>[0]['sandbox'];

export type LobsterSrtSandboxFsBridgeFactory = (params: {
  sandbox: LobsterSrtSandboxFsBridgeContext;
}) => SandboxFsBridge;

export type LobsterSrtSandboxBackendDependencies = {
  createFsBridge: LobsterSrtSandboxFsBridgeFactory;
  platform?: NodeJS.Platform;
};

export function createLobsterSrtSandboxBackendFactory(
  dependencies: LobsterSrtSandboxBackendDependencies,
): SandboxBackendFactory {
  return async () => {
    // M2 registers the backend id so the extension contract and packaging can
    // be validated, but context construction must still fail before any host
    // filesystem bridge is exposed. M3 will replace this gate only after the
    // native handle-relative I/O and SRT command boundaries are connected.
    void dependencies;
    throw createBackendUnavailableError();
  };
}

export function createLobsterSrtSandboxBackend(
  params: CreateSandboxBackendParams,
  dependencies: LobsterSrtSandboxBackendDependencies,
): SandboxBackendHandle {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new LobsterSrtSandboxBackendError(
      LobsterSrtSandboxBackendErrorCode.UnsupportedPlatform,
      `The ${LOBSTER_SRT_SANDBOX_BACKEND_ID} backend only supports Windows.`,
    );
  }

  const runtimeId = buildLobsterSrtRuntimeId(params.scopeKey);
  const workdir = resolveTaskWorkspaceDir(params);
  return {
    id: LOBSTER_SRT_SANDBOX_BACKEND_ID,
    runtimeId,
    runtimeLabel: runtimeId,
    workdir,
    capabilities: {
      workspacePathSemantics: LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS,
    } as SandboxBackendHandle['capabilities'] & {
      workspacePathSemantics: typeof LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS;
    },
    configLabel: LOBSTER_SRT_SANDBOX_BACKEND_ID,
    configLabelKind: 'Backend',
    async buildExecSpec() {
      // M2.2 delivers only the file boundary. Never fall back to host or Docker
      // execution while the SRT command-session adapter is still unavailable.
      throw createCommandExecutionUnavailableError();
    },
    async runShellCommand() {
      // The Windows file bridge uses host-side anchored I/O and must not route
      // its operations through an unrestricted shell command.
      throw createCommandExecutionUnavailableError();
    },
    createFsBridge: ({ sandbox }) => dependencies.createFsBridge({ sandbox }),
  };
}

function resolveTaskWorkspaceDir(params: CreateSandboxBackendParams): string {
  const taskWorkspaceDir = (params as CreateSandboxBackendParams & {
    taskWorkspaceDir?: string;
  }).taskWorkspaceDir?.trim();
  return taskWorkspaceDir || params.workspaceDir;
}

function buildLobsterSrtRuntimeId(scopeKey: string): string {
  const digest = createHash('sha256').update(scopeKey).digest('hex').slice(0, 16);
  return `${LOBSTER_SRT_SANDBOX_BACKEND_ID}-${digest}`;
}
