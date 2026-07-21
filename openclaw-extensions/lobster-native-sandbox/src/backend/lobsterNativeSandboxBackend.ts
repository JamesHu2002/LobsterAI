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
import type { NativeSandboxExecutor } from '../runtime/nativeSandboxExecutor.js';
import {
  LOBSTER_NATIVE_SANDBOX_BACKEND_ID,
  LOBSTER_NATIVE_WORKSPACE_PATH_SEMANTICS,
  LobsterNativeSandboxBackendErrorCode,
} from './constants.js';
import {
  createBackendDisabledError,
  LobsterNativeSandboxBackendError,
} from './errors.js';

export type LobsterNativeSandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle['createFsBridge']>
>[0]['sandbox'];

export type LobsterNativeSandboxFsBridgeFactory = (params: {
  sandbox: LobsterNativeSandboxFsBridgeContext;
  io: SandboxFsIo;
}) => SandboxFsBridge;

export type LobsterNativeSandboxBackendDependencies = {
  createFsBridge: LobsterNativeSandboxFsBridgeFactory;
  executor: NativeSandboxExecutor;
  audit: SandboxAuditRecorder;
  runtimeEnabled: boolean;
  platform?: NodeJS.Platform;
};

export function createLobsterNativeSandboxBackendFactory(
  dependencies: LobsterNativeSandboxBackendDependencies,
): SandboxBackendFactory {
  return async params => {
    if (!dependencies.runtimeEnabled) {
      throw createBackendDisabledError();
    }
    const workdir = resolveTaskWorkspaceDir(params);
    await dependencies.executor.prepareWorkspace(workdir);
    return createLobsterNativeSandboxBackend(params, dependencies);
  };
}

export function createLobsterNativeSandboxBackend(
  params: CreateSandboxBackendParams,
  dependencies: LobsterNativeSandboxBackendDependencies,
): SandboxBackendHandle {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new LobsterNativeSandboxBackendError(
      LobsterNativeSandboxBackendErrorCode.UnsupportedPlatform,
      `The ${LOBSTER_NATIVE_SANDBOX_BACKEND_ID} backend only supports Windows.`,
    );
  }

  const runtimeId = buildLobsterNativeRuntimeId(params.scopeKey);
  const workdir = resolveTaskWorkspaceDir(params);
  return {
    id: LOBSTER_NATIVE_SANDBOX_BACKEND_ID,
    runtimeId,
    runtimeLabel: runtimeId,
    workdir,
    capabilities: {
      workspacePathSemantics: LOBSTER_NATIVE_WORKSPACE_PATH_SEMANTICS,
    } as SandboxBackendHandle['capabilities'] & {
      workspacePathSemantics: typeof LOBSTER_NATIVE_WORKSPACE_PATH_SEMANTICS;
    },
    configLabel: LOBSTER_NATIVE_SANDBOX_BACKEND_ID,
    configLabelKind: 'Backend',
    async buildExecSpec({ command, workdir: requestedWorkdir, env }) {
      const wrapped = await dependencies.executor.wrapCommand({
        command,
        workspaceDir: workdir,
        cwd: requestedWorkdir ?? workdir,
        env,
        sessionKey: params.sessionKey,
      });
      return {
        argv: wrapped.argv,
        env: wrapped.env,
        stdinMode: 'pipe-closed',
        finalizeToken: wrapped.token,
      };
    },
    finalizeExec: async finalizeParams => {
      await dependencies.executor.finalizeCommand(finalizeParams);
    },
    async runShellCommand(command) {
      return dependencies.executor.runIsolatedCommand({
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
      const io = dependencies.executor.createFsIo({
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

function buildLobsterNativeRuntimeId(scopeKey: string): string {
  const digest = createHash('sha256').update(scopeKey).digest('hex').slice(0, 16);
  return `${LOBSTER_NATIVE_SANDBOX_BACKEND_ID}-${digest}`;
}

function appendCommandArguments(script: string, args?: readonly string[]): string {
  if (!args?.length) return script;
  const encodedArgs = args.map(argument => (
    `'${argument.replaceAll('\'', '\'\'')}'`
  ));
  return `${script} ${encodedArgs.join(' ')}`;
}
