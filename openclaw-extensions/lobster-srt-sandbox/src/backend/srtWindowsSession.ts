import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SandboxManager,
  type SandboxRuntimeConfig,
  type WindowsBinShell,
} from '@anthropic-ai/sandbox-runtime';

import {
  digestSandboxAuditValue,
  SandboxAuditEventType,
  type SandboxAuditRecorder,
  SandboxAuditResult,
} from '../audit/sandboxAuditRecorder.js';
import {
  createWindowsWorkspacePathPolicy,
  SandboxPathIntent,
} from '../fs/windowsWorkspacePathPolicy.js';
import {
  LOBSTER_SRT_POLICY_VERSION,
  LOBSTER_SRT_RUNTIME_VERSION,
  LobsterSrtSandboxBackendErrorCode,
  LobsterSrtSandboxRuntimeState,
  type LobsterSrtSandboxRuntimeState as LobsterSrtSandboxRuntimeStateValue,
} from './constants.js';
import { LobsterSrtSandboxBackendError } from './errors.js';

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_WINDOWS_COMMAND_LINE_ESTIMATE = 30_000;
const WINDOWS_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTECTED_CHILD_ENV_NAMES = new Set([
  'ALL_PROXY',
  'GIT_CONFIG_COUNT',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

export interface SrtSandboxManagerLike {
  initialize(
    config: SandboxRuntimeConfig,
    askCallback?: undefined,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string | WindowsBinShell,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

export interface SrtWindowsSessionStatus {
  state: LobsterSrtSandboxRuntimeStateValue;
  runtimeEnabled: boolean;
  workspaceDigest?: string;
  activeCommands: number;
  lastErrorCode?: string;
}

export interface SrtWrappedCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  token: SrtCommandToken;
}

export interface SrtCommandToken {
  id: string;
  command: string;
  sessionKey?: string;
  startedAt: number;
  workspaceDir: string;
}

export interface SrtCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

export interface SrtStagedInput {
  filePath: string;
  dispose: () => void;
}

export interface SrtWindowsSessionOptions {
  helperPath: string;
  runtimeEnabled: boolean;
  audit: SandboxAuditRecorder;
  manager?: SrtSandboxManagerLike;
  platform?: NodeJS.Platform;
  pathExists?: (filePath: string) => boolean;
  validateWorkspace?: (workspaceDir: string) => Promise<void>;
  verifyWriteBoundary?: (workspaceDir: string) => Promise<void>;
  createBridgeDirectory?: () => string;
  now?: () => number;
}

const normalizeWindowsPath = (value: string): string => {
  const resolved = path.win32.resolve(value.trim());
  const parsed = path.win32.parse(resolved);
  return resolved.length > parsed.root.length
    ? resolved.replace(/[\\/]+$/, '')
    : resolved;
};

const isPathWithin = (rootPath: string, candidatePath: string): boolean => {
  const relative = path.win32.relative(rootPath, candidatePath);
  return relative === ''
    || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
};

const isDriveRoot = (value: string): boolean => {
  const parsed = path.win32.parse(value);
  return value.toLowerCase() === parsed.root.toLowerCase();
};

export const buildSrtWindowsRuntimeConfig = (params: {
  workspaceDir: string;
  bridgeDirectory: string;
  helperPath: string;
}): SandboxRuntimeConfig => {
  const workspaceDir = normalizeWindowsPath(params.workspaceDir);
  const bridgeDirectory = normalizeWindowsPath(params.bridgeDirectory);

  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
      strictAllowlist: true,
      allowLocalBinding: false,
    },
    filesystem: {
      // The dedicated account has no inherent access to the caller's private
      // files. Broad inheritable DENY ACEs on USERPROFILE or a repository
      // parent would force Windows to propagate ACLs through huge unrelated
      // trees. Keep the session ACL delta bounded to the selected workspace.
      denyRead: [],
      // allowWrite already includes READ|EXECUTE on Windows. Avoid granting
      // inheritable ACEs to whole PATH/tool directories: package stores can
      // contain hundreds of thousands of descendants and make ACL propagation
      // unbounded. Machine-wide tools remain reachable through their existing
      // BUILTIN\Users permissions; per-user tool support is a later policy.
      // Binary file writes use a random, host-owned staging directory because
      // the Windows runner does not forward stdin to the sandboxed child.
      // The directory is empty at initialization and remains read-only to the
      // sandbox account, so the ACL grant is bounded and cannot become an
      // alternate write escape.
      allowRead: [bridgeDirectory],
      allowWrite: [workspaceDir],
      denyWrite: [],
      allowGitConfig: false,
    },
    windows: {
      srtWin: {
        path: params.helperPath,
      },
    },
  };
};

const addChildEnvironment = (
  argv: readonly string[],
  childEnv: Readonly<Record<string, string>>,
): string[] => {
  const result = [...argv];
  const boundaryIndex = result.indexOf('--');
  if (boundaryIndex < 0) {
    throw new LobsterSrtSandboxBackendError(
      LobsterSrtSandboxBackendErrorCode.InvalidEnvironment,
      'SRT returned an invalid Windows command boundary.',
    );
  }
  const envArgs: string[] = [];
  for (const [name, value] of Object.entries(childEnv)) {
    const upperName = name.toUpperCase();
    if (!WINDOWS_ENV_NAME_PATTERN.test(name)) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.InvalidEnvironment,
        `Sandbox child environment variable is not allowed: ${name}`,
      );
    }
    // OpenClaw's normal sandbox environment includes PATH. SRT must remain
    // authoritative for identity, executable lookup, proxy and trust values,
    // so protected overlays are ignored rather than making every exec fail.
    if (
      PROTECTED_CHILD_ENV_NAMES.has(upperName)
      || upperName.startsWith('GIT_CONFIG_')
    ) {
      continue;
    }
    envArgs.push('--env', `${name}=${value}`);
  }
  result.splice(boundaryIndex, 0, ...envArgs);
  const estimate = result.reduce((total, item) => total + item.length + 3, 0);
  if (estimate > MAX_WINDOWS_COMMAND_LINE_ESTIMATE) {
    throw new LobsterSrtSandboxBackendError(
      LobsterSrtSandboxBackendErrorCode.InvalidEnvironment,
      'Sandbox command and environment exceed the Windows command-line limit.',
    );
  }
  return result;
};

const toErrorCode = (error: unknown): string => (
  error instanceof LobsterSrtSandboxBackendError
    ? error.code
    : LobsterSrtSandboxBackendErrorCode.CommandExecutionFailed
);

const createCommandId = (): string => (
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
);

const isTimeoutAbort = (signal?: AbortSignal): boolean => {
  const reason = signal?.reason as { name?: unknown } | undefined;
  return signal?.aborted === true && reason?.name === 'TimeoutError';
};

export class SrtWindowsSession {
  private readonly manager: SrtSandboxManagerLike;
  private readonly platform: NodeJS.Platform;
  private readonly pathExists: (filePath: string) => boolean;
  private readonly validateWorkspaceRoot: (workspaceDir: string) => Promise<void>;
  private readonly verifyWriteBoundary: (workspaceDir: string) => Promise<void>;
  private readonly createBridgeDirectory: () => string;
  private readonly now: () => number;
  private state: LobsterSrtSandboxRuntimeStateValue;
  private workspaceDir: string | null = null;
  private bridgeDirectory: string | null = null;
  private initializationFlight: Promise<void> | null = null;
  private resetFlight: Promise<void> | null = null;
  private readonly activeCommandIds = new Set<string>();
  private activeCommands = 0;
  private lastErrorCode: string | undefined;

  constructor(private readonly options: SrtWindowsSessionOptions) {
    this.manager = options.manager ?? SandboxManager;
    this.platform = options.platform ?? process.platform;
    this.pathExists = options.pathExists ?? fs.existsSync;
    this.validateWorkspaceRoot = options.validateWorkspace ?? (async workspaceDir => {
      const policy = createWindowsWorkspacePathPolicy({ taskWorkspaceDir: workspaceDir });
      await policy.prepare({
        filePath: workspaceDir,
        intent: SandboxPathIntent.Stat,
      });
    });
    this.verifyWriteBoundary = options.verifyWriteBoundary
      ?? (workspaceDir => this.verifyPreparedWorkspaceBoundary(workspaceDir));
    this.createBridgeDirectory = options.createBridgeDirectory ?? (() => (
      fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-srt-bridge-'))
    ));
    this.now = options.now ?? Date.now;
    this.state = options.runtimeEnabled
      ? LobsterSrtSandboxRuntimeState.Idle
      : LobsterSrtSandboxRuntimeState.Disabled;
  }

  getStatus(): SrtWindowsSessionStatus {
    return {
      state: this.state,
      runtimeEnabled: this.options.runtimeEnabled,
      workspaceDigest: this.workspaceDir
        ? digestSandboxAuditValue(this.workspaceDir.toLowerCase())
        : undefined,
      activeCommands: this.activeCommands,
      lastErrorCode: this.lastErrorCode,
    };
  }

  async prepareWorkspace(rawWorkspaceDir: string): Promise<void> {
    this.assertRuntimeAvailable();
    const workspaceDir = this.validateWorkspace(rawWorkspaceDir);
    if (this.workspaceDir && this.state === LobsterSrtSandboxRuntimeState.Ready) {
      this.assertSameWorkspace(workspaceDir);
      return;
    }
    if (this.initializationFlight) {
      await this.initializationFlight;
      this.assertSameWorkspace(workspaceDir);
      return;
    }

    this.state = LobsterSrtSandboxRuntimeState.Initializing;
    this.lastErrorCode = undefined;
    const flight = (async () => {
      let managerTouched = false;
      try {
        await this.validateWorkspaceRoot(workspaceDir);
        this.bridgeDirectory = normalizeWindowsPath(this.createBridgeDirectory());
        managerTouched = true;
        await this.manager.initialize(buildSrtWindowsRuntimeConfig({
          workspaceDir,
          bridgeDirectory: this.bridgeDirectory,
          helperPath: this.options.helperPath,
        }), undefined, false);
        await this.verifyWriteBoundary(workspaceDir);
        this.workspaceDir = workspaceDir;
        this.state = LobsterSrtSandboxRuntimeState.Ready;
        this.options.audit.record({
          type: SandboxAuditEventType.BackendPrepared,
          result: SandboxAuditResult.Succeeded,
          workspaceDir,
        });
      } catch (error) {
        if (managerTouched) {
          await this.manager.reset().catch(() => undefined);
        }
        this.cleanupBridgeDirectory();
        this.workspaceDir = null;
        this.state = LobsterSrtSandboxRuntimeState.Error;
        this.lastErrorCode = error instanceof LobsterSrtSandboxBackendError
          ? error.code
          : LobsterSrtSandboxBackendErrorCode.RuntimeInitializationFailed;
        this.options.audit.record({
          type: SandboxAuditEventType.BackendFailedClosed,
          result: SandboxAuditResult.Failed,
          workspaceDir,
          errorCode: this.lastErrorCode,
        });
        if (error instanceof LobsterSrtSandboxBackendError) {
          throw error;
        }
        throw new LobsterSrtSandboxBackendError(
          LobsterSrtSandboxBackendErrorCode.RuntimeInitializationFailed,
          `Unable to initialize the Windows sandbox: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })().finally(() => {
      if (this.initializationFlight === flight) {
        this.initializationFlight = null;
      }
    });
    this.initializationFlight = flight;
    await flight;
  }

  async wrapCommand(params: {
    command: string;
    workspaceDir: string;
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    sessionKey?: string;
    binShell?: string | WindowsBinShell;
  }): Promise<SrtWrappedCommand> {
    await this.prepareWorkspace(params.workspaceDir);
    const workspaceDir = this.requireWorkspace();
    const cwd = this.validateCwd(params.cwd ?? workspaceDir, workspaceDir);
    const startedAt = this.now();
    this.options.audit.record({
      type: SandboxAuditEventType.CommandRequested,
      result: SandboxAuditResult.Allowed,
      sessionKey: params.sessionKey,
      workspaceDir,
      command: params.command,
    });
    let commandPrepared = false;
    try {
      const wrapped = await this.manager.wrapWithSandboxArgv(
        params.command,
        params.binShell ?? 'powershell',
        undefined,
        params.signal,
        cwd,
      );
      commandPrepared = true;
      const argv = addChildEnvironment(wrapped.argv, params.env ?? {});
      const token: SrtCommandToken = {
        id: createCommandId(),
        command: params.command,
        sessionKey: params.sessionKey,
        startedAt,
        workspaceDir,
      };
      this.activeCommandIds.add(token.id);
      this.activeCommands = this.activeCommandIds.size;
      return {
        argv,
        env: wrapped.env,
        token,
      };
    } catch (error) {
      if (commandPrepared) {
        try {
          this.manager.cleanupAfterCommand();
        } catch {
          // Preserve the policy/argument error that prevented execution.
        }
      }
      this.options.audit.record({
        type: SandboxAuditEventType.BackendFailedClosed,
        result: SandboxAuditResult.Failed,
        sessionKey: params.sessionKey,
        workspaceDir,
        command: params.command,
        durationMs: this.now() - startedAt,
        errorCode: toErrorCode(error),
      });
      throw error;
    }
  }

  async stageInput(params: {
    data: Buffer;
    workspaceDir: string;
  }): Promise<SrtStagedInput> {
    await this.prepareWorkspace(params.workspaceDir);
    const bridgeDirectory = this.requireBridgeDirectory();
    const filePath = path.win32.join(
      bridgeDirectory,
      `input-${createCommandId()}.bin`,
    );
    try {
      fs.writeFileSync(filePath, params.data, { flag: 'wx' });
    } catch (error) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.CommandExecutionFailed,
        `Unable to stage sandbox file input: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let disposed = false;
    return {
      filePath,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        fs.rmSync(filePath, { force: true });
      },
    };
  }

  async finalizeCommand(params: {
    token?: unknown;
    status: 'completed' | 'failed';
    exitCode: number | null;
    timedOut: boolean;
  }): Promise<void> {
    const token = params.token as SrtCommandToken | undefined;
    try {
      this.manager.cleanupAfterCommand();
    } finally {
      if (token) {
        this.activeCommandIds.delete(token.id);
        this.activeCommands = this.activeCommandIds.size;
        this.options.audit.record({
          type: SandboxAuditEventType.CommandFinished,
          result: params.status === 'completed'
            ? SandboxAuditResult.Succeeded
            : SandboxAuditResult.Failed,
          sessionKey: token.sessionKey,
          workspaceDir: token.workspaceDir,
          command: token.command,
          durationMs: this.now() - token.startedAt,
          exitCode: params.exitCode,
          timedOut: params.timedOut,
        });
      }
    }
  }

  async runIsolatedCommand(params: {
    command: string;
    workspaceDir: string;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Buffer | string;
    signal?: AbortSignal;
    allowFailure?: boolean;
    sessionKey?: string;
    binShell?: string | WindowsBinShell;
  }): Promise<SrtCommandResult> {
    const wrapped = await this.wrapCommand(params);
    let finalized = false;
    try {
      const result = await this.spawnCaptured({
        argv: wrapped.argv,
        env: wrapped.env,
        cwd: this.validateCwd(params.cwd ?? params.workspaceDir, params.workspaceDir),
        stdin: params.stdin,
        signal: params.signal,
      });
      if (result.code !== 0 && !params.allowFailure) {
        throw new LobsterSrtSandboxBackendError(
          LobsterSrtSandboxBackendErrorCode.CommandExecutionFailed,
          `Sandbox command exited with code ${result.code}.`,
        );
      }
      finalized = true;
      await this.finalizeCommand({
        token: wrapped.token,
        status: result.code === 0 ? 'completed' : 'failed',
        exitCode: result.code,
        timedOut: false,
      });
      return result;
    } catch (error) {
      if (!finalized) {
        finalized = true;
        await this.finalizeCommand({
          token: wrapped.token,
          status: 'failed',
          exitCode: null,
          timedOut: isTimeoutAbort(params.signal),
        });
      }
      throw error;
    }
  }

  async reset(): Promise<void> {
    if (this.initializationFlight) {
      await this.initializationFlight.catch(() => undefined);
      return this.reset();
    }
    if (this.resetFlight) return this.resetFlight;
    if (!this.workspaceDir && this.state !== LobsterSrtSandboxRuntimeState.Error) {
      return;
    }
    this.state = LobsterSrtSandboxRuntimeState.Resetting;
    const workspaceDir = this.workspaceDir ?? undefined;
    const flight = this.manager.reset()
      .then(() => {
        this.workspaceDir = null;
        this.activeCommandIds.clear();
        this.activeCommands = 0;
        this.lastErrorCode = undefined;
        this.state = this.options.runtimeEnabled
          ? LobsterSrtSandboxRuntimeState.Idle
          : LobsterSrtSandboxRuntimeState.Disabled;
        this.options.audit.record({
          type: SandboxAuditEventType.BackendReset,
          result: SandboxAuditResult.Succeeded,
          workspaceDir,
        });
      })
      .catch((error) => {
        this.state = LobsterSrtSandboxRuntimeState.Error;
        this.lastErrorCode = LobsterSrtSandboxBackendErrorCode.RuntimeInitializationFailed;
        this.options.audit.record({
          type: SandboxAuditEventType.BackendFailedClosed,
          result: SandboxAuditResult.Failed,
          workspaceDir,
          errorCode: this.lastErrorCode,
        });
        throw error;
      })
      .finally(() => {
        this.cleanupBridgeDirectory();
        if (this.resetFlight === flight) {
          this.resetFlight = null;
        }
      });
    this.resetFlight = flight;
    return flight;
  }

  private assertRuntimeAvailable(): void {
    if (!this.options.runtimeEnabled) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.BackendDisabled,
        'The LobsterAI native sandbox is disabled.',
      );
    }
    if (this.platform !== 'win32') {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.UnsupportedPlatform,
        'The lobster-srt backend only supports Windows.',
      );
    }
    if (
      !path.win32.isAbsolute(this.options.helperPath)
      || !this.pathExists(this.options.helperPath)
    ) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.HelperUnavailable,
        'The packaged Windows sandbox helper is unavailable.',
      );
    }
  }

  private validateWorkspace(rawWorkspaceDir: string): string {
    const value = rawWorkspaceDir.trim();
    if (!value || !path.win32.isAbsolute(value)) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.InvalidWorkspace,
        'Sandbox workspace must be an absolute Windows path.',
      );
    }
    const workspaceDir = normalizeWindowsPath(value);
    if (isDriveRoot(workspaceDir)) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.InvalidWorkspace,
        'Sandbox workspace may not be a drive root.',
      );
    }
    try {
      if (!fs.statSync(workspaceDir).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.InvalidWorkspace,
        'Sandbox workspace is unavailable.',
      );
    }
    return workspaceDir;
  }

  private validateCwd(rawCwd: string, rawWorkspaceDir: string): string {
    const workspaceDir = normalizeWindowsPath(rawWorkspaceDir);
    const cwd = normalizeWindowsPath(rawCwd);
    if (!isPathWithin(workspaceDir, cwd)) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.InvalidWorkspace,
        'Sandbox command cwd is outside the active task workspace.',
      );
    }
    return cwd;
  }

  private assertSameWorkspace(workspaceDir: string): void {
    const activeWorkspace = this.requireWorkspace();
    if (activeWorkspace.toLowerCase() !== workspaceDir.toLowerCase()) {
      this.options.audit.record({
        type: SandboxAuditEventType.BackendFailedClosed,
        result: SandboxAuditResult.Denied,
        workspaceDir,
        errorCode: LobsterSrtSandboxBackendErrorCode.WorkspaceConflict,
      });
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.WorkspaceConflict,
        'This M3 test build already has a different active workspace. '
        + 'Wait for tasks to finish and restart the Gateway before switching workspaces.',
      );
    }
  }

  private requireWorkspace(): string {
    if (!this.workspaceDir) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.RuntimeInitializationFailed,
        'The Windows sandbox workspace is not initialized.',
      );
    }
    return this.workspaceDir;
  }

  private requireBridgeDirectory(): string {
    if (!this.bridgeDirectory) {
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.RuntimeInitializationFailed,
        'The Windows sandbox file bridge is not initialized.',
      );
    }
    return this.bridgeDirectory;
  }

  private cleanupBridgeDirectory(): void {
    if (!this.bridgeDirectory) return;
    const bridgeDirectory = this.bridgeDirectory;
    this.bridgeDirectory = null;
    fs.rmSync(bridgeDirectory, { recursive: true, force: true });
  }

  private async verifyPreparedWorkspaceBoundary(workspaceDir: string): Promise<void> {
    const workspaceParent = path.win32.dirname(workspaceDir);
    const probeId = createCommandId();
    const insideFile = path.win32.join(workspaceDir, `.lobster-srt-probe-${probeId}.tmp`);
    let outsideDir: string | null = null;
    try {
      outsideDir = fs.mkdtempSync(
        path.win32.join(workspaceParent, '.lobster-srt-boundary-'),
      );
      const outsideFile = path.win32.join(outsideDir, 'write-probe.tmp');
      const insideResult = await this.runPreparedBoundaryProbe(
        `Set-Content -LiteralPath ${quotePowerShellLiteral(insideFile)} -Value inside`,
        workspaceDir,
      );
      if (insideResult.code !== 0) {
        throw new LobsterSrtSandboxBackendError(
          LobsterSrtSandboxBackendErrorCode.RuntimeInitializationFailed,
          'The Windows sandbox could not write its selected task workspace.',
        );
      }

      const outsideResult = await this.runPreparedBoundaryProbe(
        `Set-Content -LiteralPath ${quotePowerShellLiteral(outsideFile)} -Value outside`,
        workspaceDir,
      );
      if (outsideResult.code === 0) {
        throw new LobsterSrtSandboxBackendError(
          LobsterSrtSandboxBackendErrorCode.UnsafeWorkspaceAcl,
          'The selected workspace inherits broad host write permissions. '
          + 'This M3 build cannot safely restrict shell writes to that workspace.',
        );
      }
    } catch (error) {
      if (error instanceof LobsterSrtSandboxBackendError) throw error;
      throw new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.RuntimeInitializationFailed,
        `Unable to verify the Windows workspace boundary: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      fs.rmSync(insideFile, { force: true });
      if (outsideDir) {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    }
  }

  private async runPreparedBoundaryProbe(
    command: string,
    workspaceDir: string,
  ): Promise<SrtCommandResult> {
    const signal = AbortSignal.timeout(20_000);
    const wrapped = await this.manager.wrapWithSandboxArgv(
      command,
      'powershell',
      undefined,
      signal,
      workspaceDir,
    );
    try {
      return await this.spawnCaptured({
        argv: wrapped.argv,
        env: wrapped.env,
        cwd: workspaceDir,
        signal,
      });
    } finally {
      this.manager.cleanupAfterCommand();
    }
  }

  private spawnCaptured(params: {
    argv: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin?: Buffer | string;
    signal?: AbortSignal;
  }): Promise<SrtCommandResult> {
    if (params.signal?.aborted) {
      return Promise.reject(new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.CommandExecutionFailed,
        'Sandbox command was aborted before launch.',
      ));
    }
    const [command, ...args] = params.argv;
    if (!command) {
      return Promise.reject(new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.CommandExecutionFailed,
        'SRT returned an empty command.',
      ));
    }

    return new Promise<SrtCommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: params.cwd,
        env: params.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        params.signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      const onAbort = (): void => {
        child.kill();
        fail(new LobsterSrtSandboxBackendError(
          LobsterSrtSandboxBackendErrorCode.CommandExecutionFailed,
          'Sandbox command was aborted.',
        ));
      };
      const append = (target: Buffer[], chunk: Buffer, isStdout: boolean): void => {
        const nextBytes = (isStdout ? stdoutBytes : stderrBytes) + chunk.length;
        if (nextBytes > MAX_CAPTURE_BYTES) {
          child.kill();
          fail(new LobsterSrtSandboxBackendError(
            LobsterSrtSandboxBackendErrorCode.CommandOutputLimitExceeded,
            'Sandbox command output exceeded the capture limit.',
          ));
          return;
        }
        if (isStdout) stdoutBytes = nextBytes;
        else stderrBytes = nextBytes;
        target.push(chunk);
      };

      params.signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', error => fail(new LobsterSrtSandboxBackendError(
        LobsterSrtSandboxBackendErrorCode.CommandExecutionFailed,
        `Unable to launch sandbox command: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )));
      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk, true));
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk, false));
      child.once('close', code => {
        if (settled) return;
        settled = true;
        params.signal?.removeEventListener('abort', onAbort);
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          code: code ?? 1,
        });
      });
      child.stdin.once('error', error => {
        child.kill();
        fail(new LobsterSrtSandboxBackendError(
          LobsterSrtSandboxBackendErrorCode.CommandExecutionFailed,
          `Unable to write sandbox command input: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ));
      });
      child.stdin.end(params.stdin);
    });
  }
}

const quotePowerShellLiteral = (value: string): string => (
  `'${value.replaceAll('\'', '\'\'')}'`
);

export const SRT_M3_RUNTIME_METADATA = {
  policyVersion: LOBSTER_SRT_POLICY_VERSION,
  runtimeVersion: LOBSTER_SRT_RUNTIME_VERSION,
} as const;
