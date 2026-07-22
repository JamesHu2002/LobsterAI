import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  NATIVE_SANDBOX_ACTIVATION_AVAILABLE,
  NATIVE_SANDBOX_POLICY_VERSION,
  NATIVE_SANDBOX_PROTOCOL_VERSION,
  NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION,
  NativeSandboxErrorCode,
  NativeSandboxOperation,
  NativeSandboxPlatform,
  NativeSandboxRuntimeKind,
  NativeSandboxState,
} from '../../../shared/nativeSandbox/constants';
import type {
  NativeSandboxError,
  NativeSandboxOperationResult,
  NativeSandboxStatus,
} from '../../../shared/nativeSandbox/types';
import type { NativeSandboxProvisioner } from '../domain/nativeSandboxProvisioner';
import {
  isNativeSandboxEnvironmentSupported,
  mapNativeSandboxPlatform,
  type NativeSandboxEnvironment,
} from '../nativeSandboxEnvironment';
import { verifyWindowsNativeSandboxBootstrap } from './windowsNativeSandboxBootstrapVerifier';
import {
  resolveWindowsNativeSandboxInstallRoot,
  resolveWindowsNativeSandboxManifestPath,
  resolveWindowsNativeSandboxSetupPath,
  WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME,
  WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME,
} from './windowsNativeSandboxEnvironment';

const STATUS_TIMEOUT_MS = 20_000;
const LIFECYCLE_TIMEOUT_MS = 180_000;
const SETUP_SCHEMA_VERSION = 1;

const WindowsSandboxSetupOperation = {
  Install: 'install',
  Verify: 'verify',
  Repair: 'repair',
} as const;

type WindowsSandboxSetupOperation =
  typeof WindowsSandboxSetupOperation[keyof typeof WindowsSandboxSetupOperation];

interface WindowsSandboxSetupInvocation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WindowsSandboxSetupReport {
  schemaVersion: number;
  operation: string;
  success: boolean;
  cancelled: boolean;
  installed: boolean;
  healthy: boolean;
  runtimeVersion: string;
  protocolVersion: number;
  policyVersion: string;
  installRoot: string;
  runnerPath: string;
  setupPath: string;
  identity: {
    accountName: string;
    accountSid: string;
    ready: boolean;
  };
  integrity: {
    manifestVerified: boolean;
    hashesVerified: boolean;
    signaturesRequired: boolean;
    signaturesVerified: boolean;
  };
  network: {
    mode: string;
    rulesInstalled: boolean;
    rulesEffective: boolean;
  };
  protection: {
    protectedInstall: boolean;
    credentialsProtected: boolean;
  };
  rebootRequired: boolean;
  errorCode?: string;
  message?: string;
}

export interface WindowsNativeSandboxProvisionerOptions extends NativeSandboxEnvironment {
  runnerPath?: string;
  setupPath?: string;
  manifestPath?: string;
  installRoot?: string;
  runtimeVersion?: string;
  pathExists?: (filePath: string) => boolean;
  invokeSetup?: (
    setupPath: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<WindowsSandboxSetupInvocation>;
  verifyBootstrap?: () => Promise<void>;
  now?: () => number;
}

const invokeSetupExecutable = (
  setupPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<WindowsSandboxSetupInvocation> => new Promise((resolve, reject) => {
  execFile(
    setupPath,
    [...args],
    {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
    (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
        reject(error);
        return;
      }
      resolve({
        exitCode: typeof (error as { code?: unknown } | null)?.code === 'number'
          ? (error as { code: number }).code
          : 0,
        stdout,
        stderr,
      });
    },
  );
});

const parseSetupReport = (invocation: WindowsSandboxSetupInvocation): WindowsSandboxSetupReport => {
  const candidates = `${invocation.stdout}\n${invocation.stderr}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .reverse();
  for (const candidate of candidates) {
    try {
      const report = JSON.parse(candidate) as WindowsSandboxSetupReport;
      if (report && typeof report === 'object' && report.schemaVersion === SETUP_SCHEMA_VERSION) {
        return report;
      }
    } catch {
      // The helper can emit a short non-JSON diagnostic before its final report.
    }
  }
  throw new Error(
    `Windows Sandbox setup returned no valid report (exit code ${invocation.exitCode}).`,
  );
};

const knownErrorCode = (value: string | undefined): NativeSandboxError['code'] | undefined => {
  switch (value) {
    case 'runtime-manifest-invalid':
    case 'runtime-manifest-incompatible':
    case 'runtime-manifest-missing':
    case 'runtime-file-set-invalid':
      return NativeSandboxErrorCode.RuntimeManifestInvalid;
    case 'runtime-hash-invalid':
      return NativeSandboxErrorCode.RuntimeHashInvalid;
    case 'runtime-signature-invalid':
      return NativeSandboxErrorCode.RuntimeSignatureInvalid;
    case 'runtime-protection-invalid':
    case 'runtime-reparse-point-denied':
      return NativeSandboxErrorCode.RuntimeProtectionInvalid;
    case 'setup-uac-cancelled':
      return NativeSandboxErrorCode.SetupUacCancelled;
    case 'setup-partial-failure':
      return NativeSandboxErrorCode.SetupPartialFailure;
    default:
      if (value?.startsWith('sandbox-identity') || value?.startsWith('sandbox-credentials')) {
        return NativeSandboxErrorCode.SandboxIdentityInvalid;
      }
      if (value?.startsWith('network-')) {
        return NativeSandboxErrorCode.NetworkIsolationUnavailable;
      }
      return undefined;
  }
};

const normalizePath = (value: string): string => path.resolve(value).toLowerCase();

export class WindowsNativeSandboxProvisioner implements NativeSandboxProvisioner {
  private readonly runnerPath: string;
  private readonly setupPath: string;
  private readonly manifestPath: string;
  private readonly installRoot: string;
  private readonly runtimeVersion: string;
  private readonly pathExists: (filePath: string) => boolean;
  private readonly invokeSetup: NonNullable<WindowsNativeSandboxProvisionerOptions['invokeSetup']>;
  private readonly verifyBootstrap: NonNullable<
    WindowsNativeSandboxProvisionerOptions['verifyBootstrap']
  >;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly requireSignature: boolean;
  private currentStatus: NativeSandboxStatus;
  private statusFlight: Promise<NativeSandboxOperationResult> | null = null;
  private lifecycleFlight: Promise<NativeSandboxOperationResult> | null = null;

  constructor(options: WindowsNativeSandboxProvisionerOptions) {
    this.platform = options.platform;
    this.architecture = options.architecture;
    this.installRoot = options.installRoot ?? resolveWindowsNativeSandboxInstallRoot();
    this.runnerPath = options.runnerPath ?? path.join(
      this.installRoot,
      'current',
      WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME,
    );
    this.setupPath = options.setupPath ?? resolveWindowsNativeSandboxSetupPath(options);
    this.manifestPath = options.manifestPath ?? resolveWindowsNativeSandboxManifestPath(options);
    this.runtimeVersion = options.runtimeVersion ?? NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION;
    this.pathExists = options.pathExists ?? fs.existsSync;
    this.invokeSetup = options.invokeSetup ?? invokeSetupExecutable;
    this.now = options.now ?? Date.now;
    this.requireSignature = options.isPackaged;
    this.verifyBootstrap = options.verifyBootstrap ?? (() => (
      verifyWindowsNativeSandboxBootstrap({
        manifestPath: this.manifestPath,
        setupPath: this.setupPath,
        requireSignature: this.requireSignature,
      })
    ));
    this.currentStatus = this.createInitialStatus();
  }

  getStatus(): Promise<NativeSandboxOperationResult> {
    if (this.statusFlight) return this.statusFlight;
    const unsupported = this.unsupportedResult();
    if (unsupported) return Promise.resolve(unsupported);
    const availabilityError = this.bootstrapAvailabilityError();
    if (availabilityError) return Promise.resolve(availabilityError);
    this.currentStatus = {
      ...this.currentStatus,
      state: NativeSandboxState.Checking,
      busy: true,
      operation: NativeSandboxOperation.Check,
      lastError: undefined,
    };
    const flight = this.querySetupStatus().finally(() => {
      if (this.statusFlight === flight) this.statusFlight = null;
    });
    this.statusFlight = flight;
    return flight;
  }

  install(): Promise<NativeSandboxOperationResult> {
    return this.runLifecycleOperation(
      WindowsSandboxSetupOperation.Install,
      NativeSandboxOperation.Install,
    );
  }

  repair(): Promise<NativeSandboxOperationResult> {
    return this.runLifecycleOperation(
      WindowsSandboxSetupOperation.Repair,
      NativeSandboxOperation.Repair,
    );
  }

  private createInitialStatus(): NativeSandboxStatus {
    const platform = mapNativeSandboxPlatform(this.platform);
    const supportedPlatform = platform === NativeSandboxPlatform.Windows;
    const supported = isNativeSandboxEnvironmentSupported({
      platform: this.platform,
      architecture: this.architecture,
    });
    let lastError: NativeSandboxError | undefined;
    if (!supportedPlatform) {
      lastError = {
        code: NativeSandboxErrorCode.UnsupportedPlatform,
        message: `Native sandbox execution is not supported on ${this.platform}.`,
      };
    } else if (!supported) {
      lastError = {
        code: NativeSandboxErrorCode.UnsupportedArchitecture,
        message: `Native sandbox execution is not supported on ${this.architecture}.`,
      };
    }
    const lifecycleAvailable = supported
      && this.pathExists(this.setupPath)
      && this.pathExists(this.manifestPath);
    return {
      platform,
      architecture: this.architecture,
      supported,
      state: supported ? NativeSandboxState.NotInstalled : NativeSandboxState.Unsupported,
      runtimeKind: NativeSandboxRuntimeKind.NativeWindows,
      runtimeVersion: this.runtimeVersion,
      protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
      runtimeAvailable: lifecycleAvailable,
      activationAvailable: NATIVE_SANDBOX_ACTIVATION_AVAILABLE && supported,
      lifecycleAvailable,
      installed: false,
      healthy: false,
      enabled: false,
      backendConnected: false,
      networkIsolated: false,
      readIsolated: false,
      productionReady: false,
      identityReady: false,
      integrityVerified: false,
      protectedInstallation: false,
      signatureRequired: this.requireSignature,
      signatureVerified: false,
      installationRoot: this.installRoot,
      rebootRequired: false,
      busy: false,
      lastError,
      checkedAt: this.now(),
    };
  }

  private unsupportedResult(): NativeSandboxOperationResult | null {
    if (this.currentStatus.supported) return null;
    this.currentStatus = {
      ...this.currentStatus,
      state: NativeSandboxState.Unsupported,
      busy: false,
      operation: undefined,
      checkedAt: this.now(),
    };
    return { success: true, status: this.currentStatus };
  }

  private bootstrapAvailabilityError(): NativeSandboxOperationResult | null {
    if (this.pathExists(this.setupPath) && this.pathExists(this.manifestPath)) return null;
    const lastError: NativeSandboxError = {
      code: NativeSandboxErrorCode.SetupUnavailable,
      message: `Windows Sandbox setup bundle is incomplete at ${path.dirname(this.setupPath)}.`,
    };
    this.currentStatus = {
      ...this.currentStatus,
      state: NativeSandboxState.Unavailable,
      runtimeAvailable: false,
      lifecycleAvailable: false,
      installed: false,
      healthy: false,
      busy: false,
      operation: undefined,
      lastError,
      checkedAt: this.now(),
    };
    return { success: false, status: this.currentStatus, error: lastError.message };
  }

  private async querySetupStatus(): Promise<NativeSandboxOperationResult> {
    try {
      await this.verifyBootstrap();
      const report = await this.invokeAndParse(WindowsSandboxSetupOperation.Verify);
      return this.applyReport(report, NativeSandboxOperation.Check);
    } catch (error) {
      return this.failureResult(NativeSandboxErrorCode.StatusCheckFailed, error);
    }
  }

  private runLifecycleOperation(
    setupOperation: WindowsSandboxSetupOperation,
    operation: typeof NativeSandboxOperation.Install | typeof NativeSandboxOperation.Repair,
  ): Promise<NativeSandboxOperationResult> {
    if (this.lifecycleFlight) return this.lifecycleFlight;
    const availabilityError = this.bootstrapAvailabilityError();
    if (availabilityError) return Promise.resolve(availabilityError);
    this.currentStatus = {
      ...this.currentStatus,
      state: operation === NativeSandboxOperation.Install
        ? NativeSandboxState.Installing
        : NativeSandboxState.Repairing,
      busy: true,
      operation,
      lastError: undefined,
    };
    this.auditLifecycle(setupOperation, 'started');
    const flight = (async () => {
      try {
        await this.verifyBootstrap();
        const report = await this.invokeAndParse(setupOperation);
        const result = this.applyReport(report, operation);
        this.auditLifecycle(
          setupOperation,
          result.success ? 'completed' : report.cancelled ? 'cancelled' : 'failed',
          report.errorCode,
        );
        return result;
      } catch (error) {
        this.auditLifecycle(
          setupOperation,
          'failed',
          (error as { code?: string } | undefined)?.code,
        );
        return this.failureResult(
          operation === NativeSandboxOperation.Install
            ? NativeSandboxErrorCode.InstallFailed
            : NativeSandboxErrorCode.RepairFailed,
          error,
        );
      }
    })().finally(() => {
      if (this.lifecycleFlight === flight) this.lifecycleFlight = null;
    });
    this.lifecycleFlight = flight;
    return flight;
  }

  private async invokeAndParse(
    operation: WindowsSandboxSetupOperation,
  ): Promise<WindowsSandboxSetupReport> {
    const args: string[] = [operation];
    if (this.requireSignature) args.push('--require-signature');
    const invocation = await this.invokeSetup(
      this.setupPath,
      args,
      operation === WindowsSandboxSetupOperation.Verify
        ? STATUS_TIMEOUT_MS
        : LIFECYCLE_TIMEOUT_MS,
    );
    const report = parseSetupReport(invocation);
    if (report.operation !== operation) {
      throw new Error(`Windows Sandbox setup returned an unexpected ${report.operation} report.`);
    }
    return report;
  }

  private applyReport(
    report: WindowsSandboxSetupReport,
    operation: NativeSandboxStatus['operation'],
  ): NativeSandboxOperationResult {
    if (report.installed) this.validateInstalledReport(report);
    const integrityVerified = report.integrity.manifestVerified
      && report.integrity.hashesVerified
      && (!report.integrity.signaturesRequired || report.integrity.signaturesVerified);
    const protectedInstallation = report.protection.protectedInstall
      && report.protection.credentialsProtected;
    const healthy = report.success
      && report.healthy
      && report.identity.ready
      && integrityVerified
      && protectedInstallation
      && report.network.rulesInstalled
      && report.network.rulesEffective;
    const errorCode = knownErrorCode(report.errorCode)
      ?? (operation === NativeSandboxOperation.Install
        ? NativeSandboxErrorCode.InstallFailed
        : operation === NativeSandboxOperation.Repair
          ? NativeSandboxErrorCode.RepairFailed
          : NativeSandboxErrorCode.StatusCheckFailed);
    const lastError = !healthy && report.errorCode !== 'runtime-not-installed'
      ? {
          code: errorCode,
          message: report.message || `Windows Sandbox setup failed (${report.errorCode || 'unknown'}).`,
        }
      : undefined;
    this.currentStatus = {
      ...this.currentStatus,
      state: !report.installed
        ? NativeSandboxState.NotInstalled
        : healthy
          ? NativeSandboxState.Ready
          : NativeSandboxState.Degraded,
      runtimeVersion: report.runtimeVersion || this.runtimeVersion,
      protocolVersion: report.protocolVersion || NATIVE_SANDBOX_PROTOCOL_VERSION,
      runtimeAvailable: this.pathExists(this.setupPath) && this.pathExists(this.manifestPath),
      lifecycleAvailable: true,
      installed: report.installed,
      healthy,
      networkIsolated: report.network.rulesEffective,
      readIsolated: false,
      productionReady: false,
      identityReady: report.identity.ready,
      integrityVerified,
      protectedInstallation,
      signatureRequired: report.integrity.signaturesRequired,
      signatureVerified: report.integrity.signaturesVerified,
      installationRoot: report.installRoot || this.installRoot,
      rebootRequired: report.rebootRequired,
      busy: false,
      operation: undefined,
      lastError,
      checkedAt: this.now(),
    };
    const success = report.success && (healthy || !report.installed);
    return {
      success,
      cancelled: report.cancelled,
      error: success ? undefined : lastError?.message || report.message,
      status: this.currentStatus,
    };
  }

  private validateInstalledReport(report: WindowsSandboxSetupReport): void {
    if (
      report.runtimeVersion !== this.runtimeVersion
      || report.protocolVersion !== NATIVE_SANDBOX_PROTOCOL_VERSION
      || report.policyVersion !== NATIVE_SANDBOX_POLICY_VERSION
    ) {
      throw Object.assign(
        new Error('Installed Windows Sandbox runtime is incompatible with this LobsterAI build.'),
        { code: NativeSandboxErrorCode.RuntimeVersionIncompatible },
      );
    }
    if (
      this.requireSignature
      && (!report.integrity.signaturesRequired || !report.integrity.signaturesVerified)
    ) {
      throw Object.assign(
        new Error('Installed Windows Sandbox runtime does not satisfy the signature policy.'),
        { code: NativeSandboxErrorCode.RuntimeSignatureInvalid },
      );
    }
    const expectedInstalledSetupPath = path.join(
      this.installRoot,
      'current',
      WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME,
    );
    if (
      normalizePath(report.installRoot) !== normalizePath(this.installRoot)
      || normalizePath(report.setupPath) !== normalizePath(expectedInstalledSetupPath)
    ) {
      throw Object.assign(
        new Error('Windows Sandbox setup reported an unexpected protected installation path.'),
        { code: NativeSandboxErrorCode.RuntimeProtectionInvalid },
      );
    }
    if (normalizePath(report.runnerPath) !== normalizePath(this.runnerPath)) {
      throw Object.assign(
        new Error(`Windows Sandbox setup reported an unexpected runner path: ${report.runnerPath}`),
        { code: NativeSandboxErrorCode.RuntimeProtectionInvalid },
      );
    }
    if (!this.pathExists(this.runnerPath)) {
      throw Object.assign(
        new Error(`Installed Windows Sandbox runner is missing at ${this.runnerPath}.`),
        { code: NativeSandboxErrorCode.RuntimeExecutableUnavailable },
      );
    }
  }

  private failureResult(
    fallbackCode: NativeSandboxError['code'],
    error: unknown,
  ): NativeSandboxOperationResult {
    const explicitCode = (error as { code?: unknown } | undefined)?.code;
    const code = typeof explicitCode === 'string'
      && Object.values(NativeSandboxErrorCode).includes(explicitCode as NativeSandboxError['code'])
      ? explicitCode as NativeSandboxError['code']
      : fallbackCode;
    const lastError: NativeSandboxError = {
      code,
      message: error instanceof Error ? error.message : String(error),
    };
    this.currentStatus = {
      ...this.currentStatus,
      state: this.currentStatus.installed
        ? NativeSandboxState.Degraded
        : NativeSandboxState.Error,
      healthy: false,
      busy: false,
      operation: undefined,
      lastError,
      checkedAt: this.now(),
    };
    return { success: false, status: this.currentStatus, error: lastError.message };
  }

  private auditLifecycle(
    operation: WindowsSandboxSetupOperation,
    outcome: 'started' | 'completed' | 'cancelled' | 'failed',
    errorCode?: string,
  ): void {
    console.log(`[NativeSandboxAudit] ${JSON.stringify({
      event: `runtime.${operation}`,
      outcome,
      runtimeVersion: this.runtimeVersion,
      protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
      errorCode,
    })}`);
  }
}
