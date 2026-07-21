import {
  NativeSandboxBackendState,
  NativeSandboxControlStage,
  NativeSandboxErrorCode,
  NativeSandboxOperation,
  NativeSandboxState,
} from '../../shared/nativeSandbox/constants';
import type {
  NativeSandboxBackendProbeResult,
  NativeSandboxError,
  NativeSandboxOperationResult,
  NativeSandboxSetEnabledResult,
  NativeSandboxStatus,
} from '../../shared/nativeSandbox/types';
import type { NativeSandboxProvisioner } from './domain/nativeSandboxProvisioner';

export interface NativeSandboxControlLogger {
  log: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}

export interface NativeSandboxControlDependencies {
  provisioner: NativeSandboxProvisioner;
  getEnabled: () => boolean;
  persistEnabled: (enabled: boolean) => void;
  isManagedByEnterprise: () => boolean;
  hasActiveWorkloads: () => boolean;
  getVerificationWorkspace: () => string;
  applyConfiguration: (enabled: boolean) => Promise<void>;
  verifyBackend: (params: {
    enabled: boolean;
    prepare: boolean;
    workspaceDir: string;
  }) => Promise<NativeSandboxBackendProbeResult>;
  logger?: NativeSandboxControlLogger;
}

export interface NativeSandboxControlServiceApi extends NativeSandboxProvisioner {
  setEnabled: (enabled: boolean) => Promise<NativeSandboxSetEnabledResult>;
}

const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const isNativeSandboxErrorCode = (value: unknown): value is NativeSandboxError['code'] => (
  typeof value === 'string'
  && Object.values(NativeSandboxErrorCode).includes(value as NativeSandboxError['code'])
);

const errorCodeForStage = (
  stage: typeof NativeSandboxControlStage[keyof typeof NativeSandboxControlStage],
): NativeSandboxError['code'] => {
  switch (stage) {
    case NativeSandboxControlStage.WorkloadCheck:
      return NativeSandboxErrorCode.ActiveWorkloads;
    case NativeSandboxControlStage.HealthCheck:
      return NativeSandboxErrorCode.HealthCheckFailed;
    case NativeSandboxControlStage.PersistConfiguration:
    case NativeSandboxControlStage.ApplyConfiguration:
      return NativeSandboxErrorCode.ConfigurationFailed;
    case NativeSandboxControlStage.VerifyBackend:
      return NativeSandboxErrorCode.BackendVerificationFailed;
    case NativeSandboxControlStage.Rollback:
      return NativeSandboxErrorCode.RollbackFailed;
    default:
      return NativeSandboxErrorCode.ConfigurationFailed;
  }
};

export class NativeSandboxControlService implements NativeSandboxControlServiceApi {
  private readonly logger: NativeSandboxControlLogger;
  private toggleFlight: Promise<NativeSandboxSetEnabledResult> | null = null;
  private activeOperation: typeof NativeSandboxOperation.Enable
    | typeof NativeSandboxOperation.Disable
    | null = null;

  constructor(private readonly dependencies: NativeSandboxControlDependencies) {
    this.logger = dependencies.logger ?? console;
  }

  async getStatus(): Promise<NativeSandboxOperationResult> {
    const result = await this.dependencies.provisioner.getStatus();
    return this.decorateResult(result, { verifyBackend: true });
  }

  async install(): Promise<NativeSandboxOperationResult> {
    return this.runLifecycleOperation(() => this.dependencies.provisioner.install());
  }

  async repair(): Promise<NativeSandboxOperationResult> {
    return this.runLifecycleOperation(() => this.dependencies.provisioner.repair());
  }

  setEnabled(enabled: boolean): Promise<NativeSandboxSetEnabledResult> {
    if (this.toggleFlight) return this.toggleFlight;
    const flight = this.setEnabledInner(enabled).finally(() => {
      if (this.toggleFlight === flight) {
        this.toggleFlight = null;
        this.activeOperation = null;
      }
    });
    this.toggleFlight = flight;
    return flight;
  }

  private async setEnabledInner(enabled: boolean): Promise<NativeSandboxSetEnabledResult> {
    const previousEnabled = this.dependencies.getEnabled();
    this.activeOperation = enabled
      ? NativeSandboxOperation.Enable
      : NativeSandboxOperation.Disable;
    let stage: typeof NativeSandboxControlStage[
      keyof typeof NativeSandboxControlStage
    ] = NativeSandboxControlStage.WorkloadCheck;
    let persistedTarget = false;
    let rolledBack = false;
    this.auditToggle('requested', enabled, stage);

    try {
      if (enabled && this.dependencies.isManagedByEnterprise()) {
        throw Object.assign(
          new Error('Sandbox test mode is unavailable while execution policy is enterprise-managed.'),
          { code: NativeSandboxErrorCode.EnterpriseManaged },
        );
      }
      if (this.dependencies.hasActiveWorkloads()) {
        throw new Error(
          'A task or scheduled job is still running. Wait for it to finish before switching Sandbox.',
        );
      }

      if (enabled) {
        stage = NativeSandboxControlStage.HealthCheck;
        const healthy = await this.ensureHealthy();
        if (!healthy.success || !healthy.status.healthy) {
          const decorated = await this.decorateResult(healthy);
          const healthErrorCode = isNativeSandboxErrorCode(
            decorated.status.lastError?.code,
          )
            ? decorated.status.lastError.code
            : NativeSandboxErrorCode.HealthCheckFailed;
          this.auditToggle(
            healthy.cancelled ? 'cancelled' : 'failed',
            enabled,
            stage,
            healthErrorCode,
          );
          return this.toToggleResult(decorated, {
            enabled: previousEnabled,
            previousEnabled,
            stage,
          });
        }
      }

      const workspaceDir = this.dependencies.getVerificationWorkspace().trim();
      if (enabled && !workspaceDir) {
        throw Object.assign(
          new Error('No task workspace is configured for Sandbox verification.'),
          { code: NativeSandboxErrorCode.InvalidWorkspace },
        );
      }

      if (enabled === previousEnabled) {
        stage = NativeSandboxControlStage.VerifyBackend;
        const probe = await this.dependencies.verifyBackend({
          enabled,
          prepare: enabled,
          workspaceDir,
        });
        this.assertProbeMatches(enabled, probe);
        const current = await this.dependencies.provisioner.getStatus();
        this.auditToggle('unchanged', enabled, stage);
        return this.toToggleResult(this.decorateResult(current, { probe }), {
          enabled,
          previousEnabled,
          stage: NativeSandboxControlStage.Idle,
        });
      }

      stage = NativeSandboxControlStage.PersistConfiguration;
      this.dependencies.persistEnabled(enabled);
      persistedTarget = true;

      stage = NativeSandboxControlStage.ApplyConfiguration;
      await this.dependencies.applyConfiguration(enabled);

      stage = NativeSandboxControlStage.VerifyBackend;
      const probe = await this.dependencies.verifyBackend({
        enabled,
        prepare: enabled,
        workspaceDir,
      });
      this.assertProbeMatches(enabled, probe);

      const current = await this.dependencies.provisioner.getStatus();
      this.auditToggle('succeeded', enabled, stage);
      return this.toToggleResult(this.decorateResult(current, { probe }), {
        enabled,
        previousEnabled,
        stage: NativeSandboxControlStage.Idle,
      });
    } catch (error) {
      const originalStage = stage;
      let rollbackError: unknown;
      if (persistedTarget) {
        stage = NativeSandboxControlStage.Rollback;
        try {
          this.dependencies.persistEnabled(previousEnabled);
          await this.dependencies.applyConfiguration(previousEnabled);
          const rollbackProbe = await this.dependencies.verifyBackend({
            enabled: previousEnabled,
            prepare: previousEnabled,
            workspaceDir: this.dependencies.getVerificationWorkspace().trim(),
          });
          this.assertProbeMatches(previousEnabled, rollbackProbe);
          rolledBack = true;
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
          this.logger.error(
            '[NativeSandboxAudit] toggle rollback failed; restrictive runtime state is retained.',
            caughtRollbackError,
          );
        }
      }

      const current = await this.dependencies.provisioner.getStatus();
      const explicitCode = (error as { code?: unknown } | undefined)?.code;
      const errorCode = rollbackError
        ? NativeSandboxErrorCode.RollbackFailed
        : isNativeSandboxErrorCode(explicitCode)
          ? explicitCode
          : errorCodeForStage(originalStage);
      const message = rollbackError
        ? `Sandbox switch failed and rollback could not be verified: ${getErrorMessage(rollbackError)}`
        : getErrorMessage(error);
      const status = this.decorateStatus(current.status, {
        enabled: this.dependencies.getEnabled(),
        backendConnected: false,
        lastError: { code: errorCode, message },
      });
      this.auditToggle('failed', enabled, rollbackError ? stage : originalStage, errorCode);
      return {
        success: false,
        status,
        error: message,
        enabled: status.enabled,
        previousEnabled,
        stage: rollbackError ? stage : originalStage,
        rolledBack,
      };
    }
  }

  private async ensureHealthy(): Promise<NativeSandboxOperationResult> {
    let result = await this.dependencies.provisioner.getStatus();
    if (!result.status.activationAvailable) {
      const lastError: NativeSandboxError = {
        code: NativeSandboxErrorCode.ActivationUnavailable,
        message: 'The native Sandbox executor is not available in this milestone.',
      };
      return {
        success: false,
        status: this.decorateStatus(result.status, { lastError }),
        error: lastError.message,
      };
    }
    if (result.status.healthy) return result;
    result = result.status.installed
      ? await this.dependencies.provisioner.repair()
      : await this.dependencies.provisioner.install();
    if (result.cancelled) {
      return {
        ...result,
        success: false,
        error: 'Windows administrator approval was cancelled.',
      };
    }
    if (!result.success || !result.status.healthy) {
      return {
        ...result,
        success: false,
        error: result.error
          || result.status.lastError?.message
          || 'Windows Sandbox health verification failed.',
      };
    }
    return result;
  }

  private async runLifecycleOperation(
    operation: () => Promise<NativeSandboxOperationResult>,
  ): Promise<NativeSandboxOperationResult> {
    const current = await this.dependencies.provisioner.getStatus();
    if (!current.status.lifecycleAvailable) {
      const lastError: NativeSandboxError = {
        code: NativeSandboxErrorCode.ActivationUnavailable,
        message: 'Runtime installation is unavailable while the native executor is being built.',
      };
      return {
        success: false,
        error: lastError.message,
        status: this.decorateStatus(current.status, { lastError }),
      };
    }
    if (this.dependencies.hasActiveWorkloads()) {
      return {
        success: false,
        error: 'A task or scheduled job is still running. Wait before changing Sandbox setup.',
        status: this.decorateStatus(current.status, {
          lastError: {
            code: NativeSandboxErrorCode.ActiveWorkloads,
            message: 'A task or scheduled job is still running.',
          },
        }),
      };
    }
    const result = await operation();
    if (result.success && result.status.healthy && this.dependencies.getEnabled()) {
      try {
        await this.dependencies.applyConfiguration(true);
        const probe = await this.dependencies.verifyBackend({
          enabled: true,
          prepare: true,
          workspaceDir: this.dependencies.getVerificationWorkspace().trim(),
        });
        this.assertProbeMatches(true, probe);
        return this.decorateResult(result, { probe });
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
          status: this.decorateStatus(result.status, {
            backendConnected: false,
            lastError: {
              code: NativeSandboxErrorCode.BackendVerificationFailed,
              message: getErrorMessage(error),
            },
          }),
        };
      }
    }
    return this.decorateResult(result);
  }

  private async decorateResult(
    result: NativeSandboxOperationResult,
    options: {
      probe?: NativeSandboxBackendProbeResult;
      verifyBackend?: boolean;
    } = {},
  ): Promise<NativeSandboxOperationResult> {
    let probe = options.probe;
    let probeError: unknown;
    const enabled = this.dependencies.getEnabled();
    if (
      options.verifyBackend
      && enabled
      && result.status.healthy
      && !this.toggleFlight
    ) {
      try {
        probe = await this.dependencies.verifyBackend({
          enabled: true,
          prepare: false,
          workspaceDir: this.dependencies.getVerificationWorkspace().trim(),
        });
      } catch (error) {
        probeError = error;
        probe = undefined;
      }
    }
    const backendStateAvailable = probe?.state === NativeSandboxBackendState.Idle
      || probe?.state === NativeSandboxBackendState.Ready;
    const backendConnected = enabled
      && probe?.ok === true
      && probe.registered
      && probe.runtimeEnabled
      && backendStateAvailable;
    const reportedErrorCode = isNativeSandboxErrorCode(probe?.errorCode)
      ? probe.errorCode
      : NativeSandboxErrorCode.BackendVerificationFailed;
    const backendError = enabled && result.status.healthy && !backendConnected
      ? {
          code: reportedErrorCode,
          message: probeError
            ? getErrorMessage(probeError)
            : `OpenClaw sandbox backend is unavailable${
                probe?.errorCode ? ` (${probe.errorCode})` : ''
              }.`,
        }
      : undefined;
    const status = this.decorateStatus(result.status, {
      enabled,
      backendConnected,
      backendState: probe?.state,
      networkIsolated: probe?.networkIsolated ?? result.status.networkIsolated,
      readIsolated: probe?.readIsolated ?? result.status.readIsolated,
      productionReady: probe?.productionReady ?? result.status.productionReady,
      state: enabled && result.status.healthy && !backendConnected
        ? NativeSandboxState.Degraded
        : result.status.state,
      lastError: backendError ?? result.status.lastError,
    });
    return {
      ...result,
      status,
    };
  }

  private decorateStatus(
    status: NativeSandboxStatus,
    overrides: Partial<NativeSandboxStatus> = {},
  ): NativeSandboxStatus {
    return {
      ...status,
      enabled: this.dependencies.getEnabled(),
      backendConnected: false,
      managedByEnterprise: this.dependencies.isManagedByEnterprise(),
      busy: status.busy || Boolean(this.toggleFlight),
      operation: this.activeOperation ?? status.operation,
      ...overrides,
    };
  }

  private async toToggleResult(
    result: NativeSandboxOperationResult | Promise<NativeSandboxOperationResult>,
    fields: Pick<
      NativeSandboxSetEnabledResult,
      'enabled' | 'previousEnabled' | 'stage'
    >,
  ): Promise<NativeSandboxSetEnabledResult> {
    const resolved = await result;
    return {
      ...resolved,
      ...fields,
    };
  }

  private assertProbeMatches(
    enabled: boolean,
    probe: NativeSandboxBackendProbeResult,
  ): void {
    const matches = probe.ok
      && probe.registered
      && probe.runtimeEnabled === enabled
      && (
        enabled
          ? probe.state === NativeSandboxBackendState.Ready
          : probe.state === NativeSandboxBackendState.Disabled
      );
    if (!matches) {
      const reportedCode = isNativeSandboxErrorCode(probe.errorCode)
        ? probe.errorCode
        : NativeSandboxErrorCode.BackendVerificationFailed;
      const unsafeWorkspaceAcl = reportedCode === NativeSandboxErrorCode.UnsafeWorkspaceAcl;
      throw Object.assign(
        new Error(
          unsafeWorkspaceAcl
            ? 'The selected workspace grants broad write access to local users, '
              + 'so this test build cannot enforce a reliable write boundary.'
            : `OpenClaw sandbox backend verification failed${
                probe.errorCode ? ` (${probe.errorCode})` : ''
              }.`,
        ),
        {
          code: reportedCode,
        },
      );
    }
  }

  private auditToggle(
    outcome: string,
    enabled: boolean,
    stage: typeof NativeSandboxControlStage[keyof typeof NativeSandboxControlStage],
    errorCode?: string,
  ): void {
    this.logger.log(`[NativeSandboxAudit] ${JSON.stringify({
      event: 'configuration.toggle',
      outcome,
      targetEnabled: enabled,
      stage,
      errorCode,
    })}`);
  }
}
