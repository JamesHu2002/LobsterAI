import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import {
  digestSandboxAuditValue,
  SandboxAuditEventType,
  SandboxAuditResult,
} from '../audit/sandboxAuditRecorder.js';
import {
  LOBSTER_NATIVE_POLICY_VERSION,
  LOBSTER_NATIVE_PROTOCOL_VERSION,
  LobsterNativeSandboxBackendErrorCode,
  LobsterNativeSandboxProfileMode,
  LobsterNativeSandboxRuntimeState,
  type LobsterNativeSandboxRuntimeState as LobsterNativeSandboxRuntimeStateValue,
} from '../backend/constants.js';
import { LobsterNativeSandboxBackendError } from '../backend/errors.js';
import { NativeSandboxFsIo } from '../fs/nativeSandboxFsIo.js';
import type { SandboxFsIo } from '../fs/sandboxFsIo.js';
import type {
  NativeSandboxCommandResult,
  NativeSandboxCommandToken,
  NativeSandboxExecutor,
  NativeSandboxExecutorStatus,
  NativeSandboxPolicyContext,
  NativeSandboxShell,
  NativeSandboxStagedInput,
  NativeSandboxWrappedCommand,
} from '../runtime/nativeSandboxExecutor.js';
import {
  type PreparedNativeSandboxPolicyContext,
  WindowsNativePolicyRegistry,
} from './windowsNativePolicyRegistry.js';

const WINDOWS_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_CHILD_ENV_NAME_PATTERN = /(KEY|SECRET|TOKEN)/i;
const DEFAULT_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_PROCESSES = 64;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROTECTED_CHILD_ENV_NAMES = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'GIT_CONFIG_COUNT',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOCALAPPDATA',
  'LOBSTER_SANDBOX',
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

interface WindowsNativeRunnerResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

interface WindowsNativeVerificationReport {
  protocolVersion: number;
  policyVersion: string;
  writableRoots: string[];
  readableRoots: string[];
  protectedPaths: string[];
  profileMode: string;
  restrictedToken: boolean;
  writeRestricted: boolean;
  ownerPreserved: boolean;
  networkIsolated: boolean;
  readIsolated: boolean;
  productionReady: boolean;
}

interface WindowsNativeExecutionReport {
  protocolVersion: number;
  outcome: 'completed' | 'timed-out' | 'cancelled' | 'output-limit-exceeded';
  exitCode?: number | null;
  durationMs: number;
  outputBytes: number;
}

interface WindowsNativeRunRequest {
  protocolVersion: number;
  policy: {
    policyVersion: string;
    taskId: string;
    agentId: string;
    cwd: string;
    writableRoots: string[];
    readableRoots: string[];
    protectedPaths: string[];
    profile: {
      mode: typeof LobsterNativeSandboxProfileMode.InheritHost;
      homeDir: string;
      userProfileDir: string;
      appDataDir: string;
      localAppDataDir: string;
    };
    scratchDir: string;
    networkMode: 'disabled';
    limits: {
      timeoutMs: number;
      maxProcesses: number;
      maxOutputBytes: number;
    };
  };
  command: {
    argv: string[];
    env: Record<string, string>;
  };
}

interface WindowsNativeCommandToken extends NativeSandboxCommandToken {
  requestPath: string;
  reportPath: string;
}

export interface WindowsNativeSandboxExecutorOptions {
  runnerPath: string;
  runtimeEnabled: boolean;
  audit: SandboxAuditRecorder;
  platform?: NodeJS.Platform;
  pathExists?: (filePath: string) => boolean;
  invokeRunner?: (
    args: readonly string[],
    options: { cwd: string; signal?: AbortSignal },
  ) => Promise<WindowsNativeRunnerResult>;
  createScratchDirectory?: () => string;
  verifyWriteBoundary?: (workspaceDir: string) => Promise<void>;
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

const powershellLiteral = (value: string): string => value.replaceAll('\'', '\'\'');

const getErrorCode = (error: unknown): string => (
  error instanceof LobsterNativeSandboxBackendError
    ? error.code
    : LobsterNativeSandboxBackendErrorCode.CommandExecutionFailed
);

const deriveAgentId = (sessionKey?: string): string => {
  const match = sessionKey?.match(/^agent:([^:]+)/i);
  return match?.[1]?.trim() || 'main';
};

const deriveTaskId = (sessionKey?: string): string => createHash('sha256')
  .update(sessionKey?.trim() || randomUUID())
  .digest('hex')
  .slice(0, 24);

const defaultInvokeRunner = (
  runnerPath: string,
  args: readonly string[],
  options: { cwd: string; signal?: AbortSignal },
): Promise<WindowsNativeRunnerResult> => new Promise((resolve, reject) => {
  const child = spawn(runnerPath, args, {
    cwd: options.cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  const onAbort = () => child.kill();
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdin.end();
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  child.once('error', error => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener('abort', onAbort);
    reject(error);
  });
  child.once('close', exitCode => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener('abort', onAbort);
    resolve({
      exitCode,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    });
  });
});

export class WindowsNativeSandboxExecutor implements NativeSandboxExecutor {
  private readonly platform: NodeJS.Platform;
  private readonly pathExists: (filePath: string) => boolean;
  private readonly invokeRunner: WindowsNativeSandboxExecutorOptions['invokeRunner'];
  private readonly createScratchDirectory: () => string;
  private readonly customWriteBoundaryProbe?: (workspaceDir: string) => Promise<void>;
  private readonly now: () => number;
  private state: LobsterNativeSandboxRuntimeStateValue;
  private workspaceDir: string | null = null;
  private scratchDir: string | null = null;
  private readonly policyRegistry = new WindowsNativePolicyRegistry();
  private initializationFlight: Promise<void> | null = null;
  private policyPreparationFlight: Promise<void> | null = null;
  private resetFlight: Promise<void> | null = null;
  private readonly activeCommandIds = new Set<string>();
  private lastErrorCode: string | undefined;
  private networkIsolated = false;
  private readIsolated = false;
  private productionReady = false;

  constructor(private readonly options: WindowsNativeSandboxExecutorOptions) {
    this.platform = options.platform ?? process.platform;
    this.pathExists = options.pathExists ?? fs.existsSync;
    this.invokeRunner = options.invokeRunner ?? ((args, invocationOptions) => (
      defaultInvokeRunner(options.runnerPath, args, invocationOptions)
    ));
    this.createScratchDirectory = options.createScratchDirectory ?? (() => (
      fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-native-sandbox-'))
    ));
    this.customWriteBoundaryProbe = options.verifyWriteBoundary;
    this.now = options.now ?? Date.now;
    this.state = options.runtimeEnabled
      ? LobsterNativeSandboxRuntimeState.Idle
      : LobsterNativeSandboxRuntimeState.Disabled;
  }

  getStatus(): NativeSandboxExecutorStatus {
    return {
      state: this.state,
      runtimeEnabled: this.options.runtimeEnabled,
      workspaceDigest: this.workspaceDir
        ? digestSandboxAuditValue(this.workspaceDir.toLowerCase())
        : undefined,
      activeCommands: this.activeCommandIds.size,
      lastErrorCode: this.lastErrorCode,
      networkIsolated: this.networkIsolated,
      readIsolated: this.readIsolated,
      productionReady: this.productionReady,
    };
  }

  createFsIo(params: {
    workspaceDir: string;
    sessionKey: string;
    policyContext?: NativeSandboxPolicyContext;
  }): SandboxFsIo {
    return new NativeSandboxFsIo({
      executor: this,
      workspaceDir: params.workspaceDir,
      sessionKey: params.sessionKey,
      policyContext: params.policyContext,
    });
  }

  async prepareWorkspace(
    rawWorkspaceDir: string,
    rawPolicyContext?: NativeSandboxPolicyContext,
  ): Promise<void> {
    this.assertRuntimeAvailable();
    const workspaceDir = this.validateWorkspace(rawWorkspaceDir);
    const policyContext = rawPolicyContext
      ? this.policyRegistry.prepare(rawPolicyContext)
      : undefined;
    if (this.workspaceDir && this.state === LobsterNativeSandboxRuntimeState.Error) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
        'Native Sandbox policy preparation failed. Reset Sandbox before running another task.',
      );
    }
    if (this.workspaceDir && this.state === LobsterNativeSandboxRuntimeState.Ready) {
      this.assertSameWorkspace(workspaceDir);
      if (policyContext) await this.ensurePolicyContextPrepared(workspaceDir, policyContext);
      return;
    }
    if (this.initializationFlight) {
      await this.initializationFlight;
      this.assertSameWorkspace(workspaceDir);
      if (policyContext) await this.ensurePolicyContextPrepared(workspaceDir, policyContext);
      return;
    }
    if (!policyContext) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
        'Native Sandbox policy roots are required during workspace initialization.',
      );
    }

    this.state = LobsterNativeSandboxRuntimeState.Initializing;
    this.lastErrorCode = undefined;
    const flight = (async () => {
      let scratchDir: string | null = null;
      try {
        scratchDir = normalizeWindowsPath(this.createScratchDirectory());
        fs.mkdirSync(scratchDir, { recursive: true });
        this.workspaceDir = workspaceDir;
        this.scratchDir = scratchDir;
        await this.preparePolicyContext(workspaceDir, policyContext, 'm2-prepare');
        if (this.customWriteBoundaryProbe) {
          await this.customWriteBoundaryProbe(workspaceDir);
        } else {
          await this.verifyPreparedWorkspaceBoundary(workspaceDir);
        }
        this.state = LobsterNativeSandboxRuntimeState.Ready;
        this.options.audit.record({
          type: SandboxAuditEventType.BackendPrepared,
          result: SandboxAuditResult.Succeeded,
          workspaceDir,
        });
      } catch (error) {
        if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
        this.workspaceDir = null;
        this.scratchDir = null;
        this.policyRegistry.clear();
        this.state = LobsterNativeSandboxRuntimeState.Error;
        this.lastErrorCode = getErrorCode(error);
        this.options.audit.record({
          type: SandboxAuditEventType.BackendFailedClosed,
          result: SandboxAuditResult.Failed,
          workspaceDir,
          errorCode: this.lastErrorCode,
        });
        if (error instanceof LobsterNativeSandboxBackendError) throw error;
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
          `Unable to initialize the Windows sandbox: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })().finally(() => {
      if (this.initializationFlight === flight) this.initializationFlight = null;
    });
    this.initializationFlight = flight;
    await flight;
  }

  private async ensurePolicyContextPrepared(
    workspaceDir: string,
    policyContext: PreparedNativeSandboxPolicyContext,
  ): Promise<void> {
    if (this.policyRegistry.contains(policyContext)) return;
    if (this.policyPreparationFlight) {
      await this.policyPreparationFlight;
      return this.ensurePolicyContextPrepared(workspaceDir, policyContext);
    }
    const flight = this.preparePolicyContext(
      workspaceDir,
      policyContext,
      'm2-policy-expand',
    ).catch(error => {
      this.state = LobsterNativeSandboxRuntimeState.Error;
      this.lastErrorCode = getErrorCode(error);
      this.options.audit.record({
        type: SandboxAuditEventType.BackendFailedClosed,
        result: SandboxAuditResult.Failed,
        workspaceDir,
        errorCode: this.lastErrorCode,
      });
      throw error;
    }).finally(() => {
      if (this.policyPreparationFlight === flight) this.policyPreparationFlight = null;
    });
    this.policyPreparationFlight = flight;
    await flight;
  }

  private async preparePolicyContext(
    workspaceDir: string,
    policyContext: PreparedNativeSandboxPolicyContext,
    sessionKey: string,
  ): Promise<void> {
    let requestPath: string | null = null;
    try {
      const request = this.createRequest({
        commandArgv: ['cmd.exe', '/d', '/c', 'exit 0'],
        cwd: workspaceDir,
        env: {},
        sessionKey,
        policyContext,
      });
      requestPath = this.writeJsonArtifact('verify', request);
      const result = await this.requireInvoker()(
        ['verify', requestPath],
        { cwd: workspaceDir },
      );
      if (result.exitCode !== 0) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
          `Native runner verification failed with exit code ${String(result.exitCode)}.`,
        );
      }
      const verification = this.parseVerificationReport(result.stdout);
      this.networkIsolated = verification.networkIsolated;
      this.readIsolated = verification.readIsolated;
      this.productionReady = verification.productionReady;
      if (
        !verification.restrictedToken
        || !verification.writeRestricted
        || !verification.ownerPreserved
      ) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.RuntimeProtocolInvalid,
          'Native runner did not prove the required Windows write boundary.',
        );
      }
      this.policyRegistry.register(policyContext);
    } catch (error) {
      if (requestPath) {
        await this.cleanupPolicy(requestPath, workspaceDir).catch(() => undefined);
      }
      throw error;
    } finally {
      if (requestPath) fs.rmSync(requestPath, { force: true });
    }
  }

  async wrapCommand(params: {
    command: string;
    workspaceDir: string;
    policyContext?: NativeSandboxPolicyContext;
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    sessionKey?: string;
    binShell?: NativeSandboxShell;
  }): Promise<NativeSandboxWrappedCommand> {
    await this.prepareWorkspace(params.workspaceDir, params.policyContext);
    if (params.signal?.aborted) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.CommandExecutionFailed,
        'Sandbox command was cancelled before it started.',
      );
    }
    const workspaceDir = this.requireWorkspace();
    const cwd = this.validateCwd(params.cwd ?? workspaceDir, workspaceDir);
    const startedAt = this.now();
    const token: WindowsNativeCommandToken = {
      id: `${startedAt.toString(36)}-${randomUUID()}`,
      command: params.command,
      sessionKey: params.sessionKey,
      startedAt,
      workspaceDir,
      requestPath: '',
      reportPath: '',
    };
    this.options.audit.record({
      type: SandboxAuditEventType.CommandRequested,
      result: SandboxAuditResult.Allowed,
      sessionKey: params.sessionKey,
      workspaceDir,
      command: params.command,
    });
    try {
      const request = this.createRequest({
        commandArgv: this.buildShellArgv(params.command, params.binShell),
        cwd,
        env: this.filterChildEnvironment(params.env ?? {}),
        sessionKey: params.sessionKey,
        policyContext: this.policyRegistry.require(params.policyContext),
      });
      token.requestPath = this.writeJsonArtifact('request', request);
      token.reportPath = this.reserveArtifactPath('report');
      this.activeCommandIds.add(token.id);
      return {
        argv: [
          this.options.runnerPath,
          'run',
          token.requestPath,
          '--report-file',
          token.reportPath,
        ],
        env: { ...process.env },
        token,
      };
    } catch (error) {
      this.options.audit.record({
        type: SandboxAuditEventType.BackendFailedClosed,
        result: SandboxAuditResult.Failed,
        sessionKey: params.sessionKey,
        workspaceDir,
        command: params.command,
        durationMs: this.now() - startedAt,
        errorCode: getErrorCode(error),
      });
      throw error;
    }
  }

  async stageInput(params: {
    data: Buffer;
    workspaceDir: string;
  }): Promise<NativeSandboxStagedInput> {
    await this.prepareWorkspace(params.workspaceDir);
    const filePath = this.reserveArtifactPath('input', '.bin');
    fs.writeFileSync(filePath, params.data, { flag: 'wx' });
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
    const token = params.token as WindowsNativeCommandToken | undefined;
    if (!token) return;
    let reportError: unknown;
    try {
      if (fs.existsSync(token.reportPath)) {
        this.parseExecutionReport(fs.readFileSync(token.reportPath));
      } else if (!params.timedOut) {
        reportError = new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.RuntimeProtocolInvalid,
          'Native runner did not produce its execution report.',
        );
      }
    } finally {
      this.activeCommandIds.delete(token.id);
      fs.rmSync(token.requestPath, { force: true });
      fs.rmSync(token.reportPath, { force: true });
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
        errorCode: reportError ? getErrorCode(reportError) : undefined,
      });
    }
    if (reportError) throw reportError;
  }

  async runIsolatedCommand(params: {
    command: string;
    workspaceDir: string;
    policyContext?: NativeSandboxPolicyContext;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: Buffer | string;
    signal?: AbortSignal;
    allowFailure?: boolean;
    sessionKey?: string;
    binShell?: NativeSandboxShell;
  }): Promise<NativeSandboxCommandResult> {
    if (params.stdin !== undefined && Buffer.byteLength(params.stdin) > 0) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InteractiveInputUnsupported,
        'The M2 native Sandbox runner does not support command stdin.',
      );
    }
    const wrapped = await this.wrapCommand(params);
    const token = wrapped.token as WindowsNativeCommandToken;
    let result: WindowsNativeRunnerResult;
    try {
      result = await this.requireInvoker()(wrapped.argv.slice(1), {
        cwd: params.cwd ?? params.workspaceDir,
        signal: params.signal,
      });
    } catch (error) {
      await this.finalizeCommand({
        token,
        status: 'failed',
        exitCode: null,
        timedOut: params.signal?.aborted === true,
      }).catch(() => undefined);
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.CommandExecutionFailed,
        `Unable to start the native Sandbox runner: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const exitCode = result.exitCode ?? 1;
    const timedOut = exitCode === 124;
    await this.finalizeCommand({
      token,
      status: exitCode === 0 ? 'completed' : 'failed',
      exitCode,
      timedOut,
    });
    if (exitCode !== 0 && !params.allowFailure) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.CommandExecutionFailed,
        `Sandbox command exited with code ${exitCode}.`,
      );
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: exitCode,
    };
  }

  async reset(): Promise<void> {
    if (this.initializationFlight) {
      await this.initializationFlight.catch(() => undefined);
      return this.reset();
    }
    if (this.policyPreparationFlight) {
      await this.policyPreparationFlight.catch(() => undefined);
      return this.reset();
    }
    if (this.resetFlight) return this.resetFlight;
    if (!this.workspaceDir || !this.scratchDir) return;
    this.state = LobsterNativeSandboxRuntimeState.Resetting;
    const workspaceDir = this.workspaceDir;
    const scratchDir = this.scratchDir;
    const flight = (async () => {
      let cleanupRequestPath: string | null = null;
      try {
        fs.mkdirSync(scratchDir, { recursive: true });
        const request = this.createRequest({
          commandArgv: ['cmd.exe', '/d', '/c', 'exit 0'],
          cwd: workspaceDir,
          env: {},
          sessionKey: 'm2-cleanup',
          policyContext: this.policyRegistry.createCleanupContext(),
        });
        cleanupRequestPath = this.writeJsonArtifact('cleanup', request);
        await this.cleanupPolicy(cleanupRequestPath, workspaceDir);
        this.workspaceDir = null;
        this.scratchDir = null;
        this.policyRegistry.clear();
        this.activeCommandIds.clear();
        this.lastErrorCode = undefined;
        this.networkIsolated = false;
        this.readIsolated = false;
        this.productionReady = false;
        this.state = this.options.runtimeEnabled
          ? LobsterNativeSandboxRuntimeState.Idle
          : LobsterNativeSandboxRuntimeState.Disabled;
        this.options.audit.record({
          type: SandboxAuditEventType.BackendReset,
          result: SandboxAuditResult.Succeeded,
          workspaceDir,
        });
      } catch (error) {
        this.state = LobsterNativeSandboxRuntimeState.Error;
        this.lastErrorCode = getErrorCode(error);
        throw error;
      } finally {
        if (cleanupRequestPath) fs.rmSync(cleanupRequestPath, { force: true });
        fs.rmSync(scratchDir, { recursive: true, force: true });
      }
    })().finally(() => {
      if (this.resetFlight === flight) this.resetFlight = null;
    });
    this.resetFlight = flight;
    return flight;
  }

  private assertRuntimeAvailable(): void {
    if (!this.options.runtimeEnabled) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.BackendDisabled,
        'The LobsterAI native Sandbox is disabled.',
      );
    }
    if (this.platform !== 'win32') {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.UnsupportedPlatform,
        'The LobsterAI native Sandbox currently supports Windows only.',
      );
    }
    if (!this.pathExists(this.options.runnerPath)) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.HelperUnavailable,
        `Native Sandbox runner was not found at ${this.options.runnerPath}.`,
      );
    }
  }

  private validateWorkspace(rawWorkspaceDir: string): string {
    const trimmed = rawWorkspaceDir.trim();
    if (!trimmed) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        'A task workspace is required for native Sandbox execution.',
      );
    }
    let resolved: string;
    try {
      resolved = normalizeWindowsPath(fs.realpathSync.native(trimmed));
      if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        `Native Sandbox workspace is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (resolved.toLowerCase() === path.win32.parse(resolved).root.toLowerCase()) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        'A drive root cannot be used as a native Sandbox workspace.',
      );
    }
    return resolved;
  }

  private validateCwd(rawCwd: string, workspaceDir: string): string {
    let cwd: string;
    try {
      cwd = normalizeWindowsPath(fs.realpathSync.native(rawCwd));
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        `Sandbox command cwd is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isPathWithin(workspaceDir, cwd)) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        'Sandbox command cwd must stay inside the task workspace.',
      );
    }
    return cwd;
  }

  private assertSameWorkspace(workspaceDir: string): void {
    if (this.workspaceDir?.toLowerCase() === workspaceDir.toLowerCase()) return;
    throw new LobsterNativeSandboxBackendError(
      LobsterNativeSandboxBackendErrorCode.WorkspaceConflict,
      'M2 supports one active task workspace. Disable Sandbox before switching projects.',
    );
  }

  private requireWorkspace(): string {
    if (!this.workspaceDir) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
        'Native Sandbox workspace has not been initialized.',
      );
    }
    return this.workspaceDir;
  }

  private requireScratch(): string {
    if (!this.scratchDir) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
        'Native Sandbox scratch directory has not been initialized.',
      );
    }
    return this.scratchDir;
  }

  private requireInvoker(): NonNullable<WindowsNativeSandboxExecutorOptions['invokeRunner']> {
    if (!this.invokeRunner) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
        'Native Sandbox runner invocation is unavailable.',
      );
    }
    return this.invokeRunner;
  }

  private createRequest(params: {
    commandArgv: string[];
    cwd: string;
    env: Record<string, string>;
    sessionKey?: string;
    policyContext: PreparedNativeSandboxPolicyContext;
  }): WindowsNativeRunRequest {
    const writableRoots = this.policyRegistry.uniquePaths([
      this.requireWorkspace(),
      ...params.policyContext.writableRoots.map(root => root.path),
    ]);
    return {
      protocolVersion: LOBSTER_NATIVE_PROTOCOL_VERSION,
      policy: {
        policyVersion: LOBSTER_NATIVE_POLICY_VERSION,
        taskId: deriveTaskId(params.sessionKey),
        agentId: deriveAgentId(params.sessionKey),
        cwd: params.cwd,
        writableRoots,
        readableRoots: this.policyRegistry.uniquePaths(
          params.policyContext.readableRoots.map(root => root.path),
        ),
        protectedPaths: this.policyRegistry.uniquePaths(params.policyContext.protectedPaths),
        profile: params.policyContext.profile,
        scratchDir: this.requireScratch(),
        networkMode: 'disabled',
        limits: {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxProcesses: DEFAULT_MAX_PROCESSES,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        },
      },
      command: {
        argv: params.commandArgv,
        env: params.env,
      },
    };
  }

  private writeJsonArtifact(prefix: string, value: unknown): string {
    const filePath = this.reserveArtifactPath(prefix);
    fs.writeFileSync(filePath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    return filePath;
  }

  private reserveArtifactPath(prefix: string, extension = '.json'): string {
    return path.win32.join(this.requireScratch(), `${prefix}-${randomUUID()}${extension}`);
  }

  private buildShellArgv(command: string, shell?: NativeSandboxShell): string[] {
    if (shell && typeof shell !== 'string') {
      if (!shell.exe.trim()) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.CommandExecutionFailed,
          'Sandbox shell executable must not be empty.',
        );
      }
      return [shell.exe, ...shell.args, command];
    }
    const selected = shell?.trim().toLowerCase();
    if (selected && !['powershell', 'powershell.exe', 'cmd', 'cmd.exe'].includes(selected)) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.CommandExecutionFailed,
        `Unsupported native Sandbox shell: ${shell}.`,
      );
    }
    if (selected === 'cmd' || selected === 'cmd.exe') {
      return ['cmd.exe', '/d', '/s', '/c', command];
    }
    return [
      path.win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ];
  }

  private filterChildEnvironment(environment: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
      const upperName = name.toUpperCase();
      if (
        !WINDOWS_ENV_NAME_PATTERN.test(name)
        || name.includes('\0')
        || value.includes('\0')
      ) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.InvalidEnvironment,
          `Sandbox child environment variable is not allowed: ${name}`,
        );
      }
      if (
        PROTECTED_CHILD_ENV_NAMES.has(upperName)
        || upperName.startsWith('GIT_CONFIG_')
        || SENSITIVE_CHILD_ENV_NAME_PATTERN.test(upperName)
      ) {
        continue;
      }
      result[name] = value;
    }
    return result;
  }

  private parseVerificationReport(bytes: Buffer): WindowsNativeVerificationReport {
    let report: WindowsNativeVerificationReport;
    try {
      report = JSON.parse(bytes.toString('utf8')) as WindowsNativeVerificationReport;
    } catch {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeProtocolInvalid,
        'Native runner returned an invalid verification report.',
      );
    }
    if (
      report.protocolVersion !== LOBSTER_NATIVE_PROTOCOL_VERSION
      || report.policyVersion !== LOBSTER_NATIVE_POLICY_VERSION
      || !Array.isArray(report.writableRoots)
      || !Array.isArray(report.readableRoots)
      || !Array.isArray(report.protectedPaths)
      || report.profileMode !== LobsterNativeSandboxProfileMode.InheritHost
      || typeof report.networkIsolated !== 'boolean'
      || typeof report.readIsolated !== 'boolean'
      || typeof report.productionReady !== 'boolean'
    ) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeProtocolInvalid,
        'Native runner verification report is incompatible with this plugin.',
      );
    }
    return report;
  }

  private parseExecutionReport(bytes: Buffer): WindowsNativeExecutionReport {
    let report: WindowsNativeExecutionReport;
    try {
      report = JSON.parse(bytes.toString('utf8')) as WindowsNativeExecutionReport;
    } catch {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeProtocolInvalid,
        'Native runner returned an invalid execution report.',
      );
    }
    if (
      report.protocolVersion !== LOBSTER_NATIVE_PROTOCOL_VERSION
      || !['completed', 'timed-out', 'cancelled', 'output-limit-exceeded'].includes(report.outcome)
    ) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeProtocolInvalid,
        'Native runner execution report is incompatible with this plugin.',
      );
    }
    return report;
  }

  private async verifyPreparedWorkspaceBoundary(workspaceDir: string): Promise<void> {
    const insidePath = path.win32.join(
      workspaceDir,
      `.lobster-sandbox-probe-${randomUUID()}.tmp`,
    );
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-native-outside-'));
    const outsidePath = path.win32.join(outsideDir, 'escape.tmp');
    try {
      const inside = await this.executePreparedRequest({
        command: `Set-Content -LiteralPath '${powershellLiteral(insidePath)}' -Value 'ok'`,
        cwd: workspaceDir,
        sessionKey: 'm2-probe-inside',
      });
      if (inside.process.exitCode !== 0 || !fs.existsSync(insidePath)) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
          'Native Sandbox probe could not write inside the selected workspace.',
        );
      }
      const outside = await this.executePreparedRequest({
        command: `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${
          powershellLiteral(outsidePath)
        }' -Value 'escape'`,
        cwd: workspaceDir,
        sessionKey: 'm2-probe-outside',
      });
      if (outside.process.exitCode === 0 || fs.existsSync(outsidePath)) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.UnsafeWorkspaceAcl,
          'Native Sandbox boundary probe could write outside the selected workspace.',
        );
      }
    } finally {
      fs.rmSync(insidePath, { force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  }

  private async executePreparedRequest(params: {
    command: string;
    cwd: string;
    sessionKey: string;
  }): Promise<{
    process: WindowsNativeRunnerResult;
    report: WindowsNativeExecutionReport;
  }> {
    const request = this.createRequest({
      commandArgv: this.buildShellArgv(params.command),
      cwd: params.cwd,
      env: {},
      sessionKey: params.sessionKey,
      policyContext: this.policyRegistry.require(),
    });
    const requestPath = this.writeJsonArtifact('probe-request', request);
    const reportPath = this.reserveArtifactPath('probe-report');
    try {
      const processResult = await this.requireInvoker()(
        ['run', requestPath, '--report-file', reportPath],
        { cwd: params.cwd },
      );
      if (!fs.existsSync(reportPath)) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.RuntimeProtocolInvalid,
          'Native Sandbox probe did not produce an execution report.',
        );
      }
      return {
        process: processResult,
        report: this.parseExecutionReport(fs.readFileSync(reportPath)),
      };
    } finally {
      fs.rmSync(requestPath, { force: true });
      fs.rmSync(reportPath, { force: true });
    }
  }

  private async cleanupPolicy(requestPath: string, workspaceDir: string): Promise<void> {
    const result = await this.requireInvoker()(
      ['cleanup', requestPath],
      { cwd: workspaceDir },
    );
    if (result.exitCode !== 0) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
        `Native Sandbox cleanup failed with exit code ${String(result.exitCode)}.`,
      );
    }
  }
}
