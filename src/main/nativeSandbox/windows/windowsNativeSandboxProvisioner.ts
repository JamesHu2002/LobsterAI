import { execFile } from 'node:child_process';
import fs from 'node:fs';

import {
  NATIVE_SANDBOX_ACTIVATION_AVAILABLE,
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
import { resolveWindowsNativeSandboxRunnerPath } from './windowsNativeSandboxEnvironment';

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface WindowsNativeSandboxProvisionerOptions extends NativeSandboxEnvironment {
  runnerPath?: string;
  runtimeVersion?: string;
  pathExists?: (filePath: string) => boolean;
  probeVersion?: (runnerPath: string) => Promise<string>;
  now?: () => number;
}

const probeRunnerVersion = (runnerPath: string): Promise<string> => new Promise(
  (resolve, reject) => {
    execFile(
      runnerPath,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  },
);

const toError = (code: NativeSandboxError['code'], error: unknown): NativeSandboxError => ({
  code,
  message: error instanceof Error ? error.message : String(error),
});

export class WindowsNativeSandboxProvisioner implements NativeSandboxProvisioner {
  private readonly runnerPath: string;
  private readonly runtimeVersion: string;
  private readonly pathExists: (filePath: string) => boolean;
  private readonly probeVersion: (runnerPath: string) => Promise<string>;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private currentStatus: NativeSandboxStatus;
  private statusFlight: Promise<NativeSandboxOperationResult> | null = null;

  constructor(options: WindowsNativeSandboxProvisionerOptions) {
    this.platform = options.platform;
    this.architecture = options.architecture;
    this.runnerPath = options.runnerPath ?? resolveWindowsNativeSandboxRunnerPath(options);
    this.runtimeVersion = options.runtimeVersion ?? NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION;
    this.pathExists = options.pathExists ?? fs.existsSync;
    this.probeVersion = options.probeVersion ?? probeRunnerVersion;
    this.now = options.now ?? Date.now;
    this.currentStatus = this.createInitialStatus();
  }

  getStatus(): Promise<NativeSandboxOperationResult> {
    if (this.statusFlight) return this.statusFlight;
    const unsupported = this.unsupportedResult();
    if (unsupported) return Promise.resolve(unsupported);

    this.currentStatus = {
      ...this.currentStatus,
      state: NativeSandboxState.Checking,
      busy: true,
      operation: NativeSandboxOperation.Check,
      lastError: undefined,
    };
    const flight = this.refreshStatus().finally(() => {
      if (this.statusFlight === flight) this.statusFlight = null;
    });
    this.statusFlight = flight;
    return flight;
  }

  install(): Promise<NativeSandboxOperationResult> {
    return Promise.resolve(this.lifecycleUnavailableResult());
  }

  repair(): Promise<NativeSandboxOperationResult> {
    return Promise.resolve(this.lifecycleUnavailableResult());
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
    return {
      platform,
      architecture: this.architecture,
      supported,
      state: supported ? NativeSandboxState.NotInstalled : NativeSandboxState.Unsupported,
      runtimeKind: NativeSandboxRuntimeKind.NativeWindows,
      runtimeVersion: this.runtimeVersion,
      protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
      runtimeAvailable: false,
      activationAvailable: NATIVE_SANDBOX_ACTIVATION_AVAILABLE && supported,
      lifecycleAvailable: false,
      installed: false,
      healthy: false,
      enabled: false,
      backendConnected: false,
      networkIsolated: false,
      readIsolated: false,
      productionReady: false,
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

  private async refreshStatus(): Promise<NativeSandboxOperationResult> {
    if (!this.pathExists(this.runnerPath)) {
      const lastError: NativeSandboxError = {
        code: NativeSandboxErrorCode.RuntimeExecutableUnavailable,
        message: `Native sandbox runner was not found at ${this.runnerPath}.`,
      };
      this.currentStatus = {
        ...this.currentStatus,
        state: NativeSandboxState.NotInstalled,
        runtimeAvailable: false,
        installed: false,
        healthy: false,
        busy: false,
        operation: undefined,
        lastError,
        checkedAt: this.now(),
      };
      return { success: true, status: this.currentStatus };
    }

    try {
      const reportedVersion = await this.probeVersion(this.runnerPath);
      const expected = `lobster-command-runner ${this.runtimeVersion}`;
      if (reportedVersion !== expected) {
        const lastError: NativeSandboxError = {
          code: NativeSandboxErrorCode.RuntimeVersionIncompatible,
          message: `Native sandbox runner reported ${reportedVersion || 'an empty version'}; expected ${expected}.`,
        };
        this.currentStatus = {
          ...this.currentStatus,
          state: NativeSandboxState.Degraded,
          runtimeAvailable: true,
          installed: true,
          healthy: false,
          busy: false,
          operation: undefined,
          lastError,
          checkedAt: this.now(),
        };
        return { success: true, status: this.currentStatus };
      }
      this.currentStatus = {
        ...this.currentStatus,
        state: NativeSandboxState.Ready,
        runtimeAvailable: true,
        installed: true,
        healthy: true,
        busy: false,
        operation: undefined,
        lastError: undefined,
        checkedAt: this.now(),
      };
      return { success: true, status: this.currentStatus };
    } catch (error) {
      const lastError = toError(NativeSandboxErrorCode.StatusCheckFailed, error);
      this.currentStatus = {
        ...this.currentStatus,
        state: NativeSandboxState.Error,
        runtimeAvailable: true,
        installed: true,
        healthy: false,
        busy: false,
        operation: undefined,
        lastError,
        checkedAt: this.now(),
      };
      return { success: false, status: this.currentStatus, error: lastError.message };
    }
  }

  private lifecycleUnavailableResult(): NativeSandboxOperationResult {
    const lastError: NativeSandboxError = {
      code: NativeSandboxErrorCode.ActivationUnavailable,
      message: 'Native sandbox installation and repair are not available in the M2 test build.',
    };
    return {
      success: false,
      error: lastError.message,
      status: {
        ...this.currentStatus,
        busy: false,
        operation: undefined,
        lastError,
        checkedAt: this.now(),
      },
    };
  }
}
