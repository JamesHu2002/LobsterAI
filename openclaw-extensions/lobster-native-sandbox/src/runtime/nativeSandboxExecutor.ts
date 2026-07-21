import type { SandboxFsIo } from '../fs/sandboxFsIo.js';

export interface NativeSandboxExecutorStatus {
  state: 'disabled' | 'idle' | 'initializing' | 'ready' | 'resetting' | 'error';
  runtimeEnabled: boolean;
  workspaceDigest?: string;
  activeCommands: number;
  lastErrorCode?: string;
  networkIsolated?: boolean;
  readIsolated?: boolean;
  productionReady?: boolean;
}

export interface NativeSandboxCommandToken {
  id: string;
  command: string;
  sessionKey?: string;
  startedAt: number;
  workspaceDir: string;
  requestPath?: string;
  reportPath?: string;
}

export interface NativeSandboxWrappedCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  token: NativeSandboxCommandToken;
}

export interface NativeSandboxCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

export interface NativeSandboxStagedInput {
  filePath: string;
  dispose: () => void;
}

export type NativeSandboxShell = string | {
  exe: string;
  args: readonly string[];
};

export interface NativeSandboxExecutor {
  getStatus(): NativeSandboxExecutorStatus;
  prepareWorkspace(workspaceDir: string): Promise<void>;
  wrapCommand(params: {
    command: string;
    workspaceDir: string;
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    sessionKey?: string;
    binShell?: NativeSandboxShell;
  }): Promise<NativeSandboxWrappedCommand>;
  stageInput(params: {
    data: Buffer;
    workspaceDir: string;
  }): Promise<NativeSandboxStagedInput>;
  finalizeCommand(params: {
    token?: unknown;
    status: 'completed' | 'failed';
    exitCode: number | null;
    timedOut: boolean;
  }): Promise<void>;
  runIsolatedCommand(params: {
    command: string;
    workspaceDir: string;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Buffer | string;
    signal?: AbortSignal;
    allowFailure?: boolean;
    sessionKey?: string;
    binShell?: NativeSandboxShell;
  }): Promise<NativeSandboxCommandResult>;
  createFsIo(params: {
    workspaceDir: string;
    sessionKey: string;
  }): SandboxFsIo;
  reset(): Promise<void>;
}
