import { createHash } from 'node:crypto';

import type {
  CreateSandboxBackendParams,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxFsBridge,
} from 'openclaw/plugin-sdk/sandbox';

import type { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import { AuditedSandboxFsBridge } from '../fs/auditedSandboxFsBridge.js';
import type { SandboxFsIo } from '../fs/sandboxFsIo.js';
import { SrtSandboxFsIo } from '../fs/srtSandboxFsIo.js';
import {
  LOBSTER_SRT_SANDBOX_BACKEND_ID,
  LOBSTER_SRT_WORKSPACE_PATH_SEMANTICS,
  LobsterSrtSandboxBackendErrorCode,
} from './constants.js';
import {
  createBackendDisabledError,
  LobsterSrtSandboxBackendError,
} from './errors.js';
import type { SrtWindowsSession } from './srtWindowsSession.js';

export type LobsterSrtSandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle['createFsBridge']>
>[0]['sandbox'];

export type LobsterSrtSandboxFsBridgeFactory = (params: {
  sandbox: LobsterSrtSandboxFsBridgeContext;
  io: SandboxFsIo;
}) => SandboxFsBridge;

export type LobsterSrtSandboxBackendDependencies = {
  createFsBridge: LobsterSrtSandboxFsBridgeFactory;
  session: SrtWindowsSession;
  audit: SandboxAuditRecorder;
  runtimeEnabled: boolean;
  platform?: NodeJS.Platform;
};

export function createLobsterSrtSandboxBackendFactory(
  dependencies: LobsterSrtSandboxBackendDependencies,
): SandboxBackendFactory {
  return async params => {
    if (!dependencies.runtimeEnabled) {
      throw createBackendDisabledError();
    }
    const workdir = resolveTaskWorkspaceDir(params);
    await dependencies.session.prepareWorkspace(workdir);
    return createLobsterSrtSandboxBackend(params, dependencies);
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
    async buildExecSpec({ command, workdir: requestedWorkdir, env, usePty }) {
      const wrapped = await dependencies.session.wrapCommand({
        command,
        workspaceDir: workdir,
        cwd: requestedWorkdir ?? workdir,
        env,
        sessionKey: params.sessionKey,
      });
      return {
        argv: wrapped.argv,
        env: wrapped.env,
        stdinMode: usePty ? 'pipe-open' : 'pipe-closed',
        finalizeToken: wrapped.token,
      };
    },
    finalizeExec: async finalizeParams => {
      await dependencies.session.finalizeCommand(finalizeParams);
    },
    async runShellCommand(command) {
      return dependencies.session.runIsolatedCommand({
        command: appendCommandArguments(command.script, command.args),
        workspaceDir: workdir,
        cwd: workdir,
        stdin: command.stdin,
        allowFailure: command.allowFailure,
        signal: command.signal,
        sessionKey: params.sessionKey,
      });
    },
    createFsBridge: ({ sandbox }) => {
      const io = new SrtSandboxFsIo({
        session: dependencies.session,
        workspaceDir: workdir,
        sessionKey: params.sessionKey,
      });
      const delegate = dependencies.createFsBridge({ sandbox, io });
      return new AuditedSandboxFsBridge({
        delegate,
        audit: dependencies.audit,
        sessionKey: params.sessionKey,
        workspaceDir: workdir,
      });
    },
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

function appendCommandArguments(script: string, args?: readonly string[]): string {
  if (!args?.length) return script;
  const encodedArgs = args.map(argument => (
    `'${argument.replaceAll('\'', '\'\'')}'`
  ));
  return `${script} ${encodedArgs.join(' ')}`;
}
