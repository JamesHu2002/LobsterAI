import fs from 'fs';

import {
  NATIVE_SANDBOX_PROTOCOL_VERSION,
  NativeSandboxErrorCode,
  NativeSandboxOperation,
  NativeSandboxPlatform,
  NativeSandboxRuntimeKind,
  NativeSandboxState,
} from '../../../shared/nativeSandbox/constants';
import type {
  NativeSandboxError,
  NativeSandboxOperation as NativeSandboxOperationValue,
  NativeSandboxOperationResult,
  NativeSandboxStatus,
} from '../../../shared/nativeSandbox/types';
import type { NativeSandboxProvisioner } from '../domain/nativeSandboxProvisioner';
import {
  isNativeSandboxEnvironmentSupported,
  mapNativeSandboxPlatform,
  type NativeSandboxEnvironment,
} from '../nativeSandboxEnvironment';
import {
  resolveLegacySrtWindowsHelperPath,
} from './legacySrtWindowsEnvironment';
import {
  type LegacySrtWindowsRuntime,
  loadLegacySrtWindowsRuntime,
} from './legacySrtWindowsRuntime';

export const LEGACY_SRT_WINDOWS_RUNTIME_VERSION = '0.0.65';

export interface LegacySrtWindowsProvisionerOptions extends NativeSandboxEnvironment {
  runtimeVersion?: string;
  pathExists?: (filePath: string) => boolean;
  loadRuntime?: () => Promise<LegacySrtWindowsRuntime>;
  now?: () => number;
}

const toError = (code: NativeSandboxError['code'], error: unknown): NativeSandboxError => ({
  code,
  message: error instanceof Error ? error.message : String(error),
});

/**
 * Temporary M0 control-plane adapter for the previously bundled Windows
 * runtime. It remains read-only from the product surface and is removed after
 * the Lobster-owned setup helper is available.
 */
export class LegacySrtWindowsProvisioner implements NativeSandboxProvisioner {
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly runtimeVersion: string;
  private readonly helperPath: string;
  private readonly pathExists: (filePath: string) => boolean;
  private readonly loadRuntime: () => Promise<LegacySrtWindowsRuntime>;
  private readonly now: () => number;
  private runtimePromise: Promise<LegacySrtWindowsRuntime> | null = null;
  private statusFlight: Promise<NativeSandboxOperationResult> | null = null;
  private setupFlight: Promise<NativeSandboxOperationResult> | null = null;
  private currentStatus: NativeSandboxStatus;

  constructor(options: LegacySrtWindowsProvisionerOptions) {
    this.platform = options.platform;
    this.architecture = options.architecture;
    this.runtimeVersion = options.runtimeVersion ?? LEGACY_SRT_WINDOWS_RUNTIME_VERSION;
    this.helperPath = resolveLegacySrtWindowsHelperPath(options);
    this.pathExists = options.pathExists ?? fs.existsSync;
    this.loadRuntime = options.loadRuntime ?? loadLegacySrtWindowsRuntime;
    this.now = options.now ?? Date.now;
    this.currentStatus = this.createInitialStatus();
  }

  getStatus(): Promise<NativeSandboxOperationResult> {
    if (this.setupFlight) {
      return Promise.resolve({ success: true, status: this.currentStatus });
    }
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
    return this.runSetup(NativeSandboxOperation.Install, false);
  }

  repair(): Promise<NativeSandboxOperationResult> {
    return this.runSetup(NativeSandboxOperation.Repair, false);
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
        message: `Native sandbox setup is not supported on ${this.platform}.`,
      };
    } else if (!supported) {
      lastError = {
        code: NativeSandboxErrorCode.UnsupportedArchitecture,
        message: `Native sandbox setup is not supported on ${this.architecture}.`,
      };
    }
    return {
      platform,
      architecture: this.architecture,
      supported,
      state: supported ? NativeSandboxState.NotInstalled : NativeSandboxState.Unsupported,
      runtimeKind: NativeSandboxRuntimeKind.LegacyWindowsAdapter,
      runtimeVersion: this.runtimeVersion,
      protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
      runtimeAvailable: false,
      activationAvailable: false,
      lifecycleAvailable: false,
      installed: false,
      healthy: false,
      enabled: false,
      backendConnected: false,
      busy: false,
      lastError,
      checkedAt: this.now(),
    };
  }

  private getRuntime(): Promise<LegacySrtWindowsRuntime> {
    if (!this.runtimePromise) {
      this.runtimePromise = this.loadRuntime();
    }
    return this.runtimePromise;
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

  private helperUnavailableResult(): NativeSandboxOperationResult | null {
    if (this.pathExists(this.helperPath)) return null;
    const lastError: NativeSandboxError = {
      code: NativeSandboxErrorCode.RuntimeExecutableUnavailable,
      message: `Sandbox helper was not found at ${this.helperPath}.`,
    };
    this.currentStatus = {
      ...this.currentStatus,
      state: NativeSandboxState.Unavailable,
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

  private async refreshStatus(): Promise<NativeSandboxOperationResult> {
    const unsupported = this.unsupportedResult();
    if (unsupported) return unsupported;
    const helperUnavailable = this.helperUnavailableResult();
    if (helperUnavailable) return helperUnavailable;

    let runtime: LegacySrtWindowsRuntime;
    try {
      runtime = await this.getRuntime();
    } catch (error) {
      const lastError = toError(NativeSandboxErrorCode.RuntimeUnavailable, error);
      this.currentStatus = {
        ...this.currentStatus,
        state: NativeSandboxState.Unavailable,
        runtimeAvailable: true,
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
      const srtWin = runtime.resolveSrtWin({ path: this.helperPath });
      const rawUser = runtime.getWindowsSandboxUserStatus({ srtWin });
      const rawNetwork = runtime.getWindowsWfpStatus({ srtWin });
      const installed = rawUser.provisioned
        || rawUser.credPresent
        || rawNetwork.state === 'installed';
      let networkVerified = false;
      let lastError: NativeSandboxError | undefined;
      if (rawUser.provisioned && rawUser.credPresent) {
        try {
          await runtime.verifyWindowsWfpEgress({
            proxyPortRange: rawNetwork.portRange,
            srtWin,
          });
          networkVerified = true;
        } catch (error) {
          lastError = toError(NativeSandboxErrorCode.StatusCheckFailed, error);
        }
      }
      const userHealthy = rawUser.provisioned
        && rawUser.credPresent
        && rawUser.groupExists
        && rawUser.inBuiltinUsers
        && rawUser.inSandboxGroup
        && rawUser.hiddenFromLogon;
      const healthy = userHealthy && networkVerified;
      // Non-admin callers commonly receive `cannot-read` for WFP enumeration.
      // A machine with no provisioned account or group is still unambiguously fresh.
      const fullyAbsent = !rawUser.provisioned
        && !rawUser.credPresent
        && !rawUser.groupExists
        && rawNetwork.state !== 'installed';
      this.currentStatus = {
        ...this.currentStatus,
        state: healthy
          ? NativeSandboxState.Ready
          : fullyAbsent
            ? NativeSandboxState.NotInstalled
            : NativeSandboxState.Degraded,
        runtimeAvailable: true,
        installed,
        healthy,
        busy: false,
        operation: undefined,
        lastError,
        checkedAt: this.now(),
      };
      return { success: true, status: this.currentStatus };
    } catch (error) {
      const lastError = toError(NativeSandboxErrorCode.StatusCheckFailed, error);
      this.currentStatus = {
        ...this.currentStatus,
        state: NativeSandboxState.Error,
        runtimeAvailable: true,
        healthy: false,
        busy: false,
        operation: undefined,
        lastError,
        checkedAt: this.now(),
      };
      return { success: false, status: this.currentStatus, error: lastError.message };
    }
  }

  private runSetup(
    operation: NativeSandboxOperationValue,
    force: boolean,
  ): Promise<NativeSandboxOperationResult> {
    if (this.setupFlight) return this.setupFlight;

    const flight = (async () => {
      if (this.statusFlight) await this.statusFlight;
      const unsupported = this.unsupportedResult();
      if (unsupported) {
        return {
          ...unsupported,
          success: false,
          error: unsupported.status.lastError?.message,
        };
      }
      const helperUnavailable = this.helperUnavailableResult();
      if (helperUnavailable) {
        return {
          ...helperUnavailable,
          success: false,
          error: helperUnavailable.status.lastError?.message,
        };
      }

      this.currentStatus = {
        ...this.currentStatus,
        state: operation === NativeSandboxOperation.Repair
          ? NativeSandboxState.Repairing
          : NativeSandboxState.Installing,
        runtimeAvailable: true,
        busy: true,
        operation,
        lastError: undefined,
        checkedAt: this.now(),
      };

      try {
        const runtime = await this.getRuntime();
        const srtWin = runtime.resolveSrtWin({ path: this.helperPath });
        const result = runtime.installWindowsSandbox({ force, srtWin });
        const refreshed = await this.refreshStatus();
        return {
          ...refreshed,
          cancelled: result.cancelled,
        };
      } catch (error) {
        const errorCode = operation === NativeSandboxOperation.Repair
          ? NativeSandboxErrorCode.RepairFailed
          : NativeSandboxErrorCode.InstallFailed;
        const lastError = toError(errorCode, error);
        this.currentStatus = {
          ...this.currentStatus,
          state: NativeSandboxState.Error,
          healthy: false,
          busy: false,
          operation: undefined,
          lastError,
          checkedAt: this.now(),
        };
        return { success: false, status: this.currentStatus, error: lastError.message };
      }
    })().finally(() => {
      if (this.setupFlight === flight) this.setupFlight = null;
    });
    this.setupFlight = flight;
    return flight;
  }
}
