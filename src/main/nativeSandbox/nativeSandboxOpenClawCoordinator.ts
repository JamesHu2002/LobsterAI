import {
  NATIVE_SANDBOX_OPENCLAW_BACKEND_ID,
  NATIVE_SANDBOX_OPENCLAW_PLUGIN_ID,
  NATIVE_SANDBOX_PROTOCOL_VERSION,
  NativeSandboxBackendState,
  NativeSandboxErrorCode,
  NativeSandboxGatewayMethod,
  NativeSandboxRuntimeKind,
} from '../../shared/nativeSandbox/constants';
import type {
  NativeSandboxBackendProbeResult,
} from '../../shared/nativeSandbox/types';

type JsonObject = Record<string, unknown>;

export interface NativeSandboxOpenClawCoordinatorDependencies {
  syncConfiguration: (enabled: boolean) => Promise<void>;
  isGatewayRunning: () => boolean;
  ensureGatewayRunning: () => Promise<void>;
  readGatewayConfig: () => unknown;
  requestGateway: (
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number },
  ) => Promise<Record<string, unknown>>;
}

export interface NativeSandboxOpenClawCoordinator {
  applyConfiguration: (enabled: boolean) => Promise<void>;
  verifyBackend: (params: {
    enabled: boolean;
    prepare: boolean;
    workspaceDir: string;
  }) => Promise<NativeSandboxBackendProbeResult>;
}

const asObject = (value: unknown): JsonObject | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
);

const readNativeSandboxSelection = (config: unknown): {
  backendSelected: boolean;
  runtimeEnabled: boolean;
} => {
  const root = asObject(config);
  const agents = asObject(root?.agents);
  const defaults = asObject(agents?.defaults);
  const sandbox = asObject(defaults?.sandbox);
  const plugins = asObject(root?.plugins);
  const entries = asObject(plugins?.entries);
  const plugin = asObject(entries?.[NATIVE_SANDBOX_OPENCLAW_PLUGIN_ID]);
  const pluginConfig = asObject(plugin?.config);
  return {
    backendSelected: sandbox?.backend === NATIVE_SANDBOX_OPENCLAW_BACKEND_ID,
    runtimeEnabled: pluginConfig?.runtimeEnabled === true,
  };
};

const parseBackendState = (value: unknown): NativeSandboxBackendProbeResult['state'] => (
  Object.values(NativeSandboxBackendState).includes(
    value as typeof NativeSandboxBackendState[keyof typeof NativeSandboxBackendState],
  )
    ? value as NativeSandboxBackendProbeResult['state']
    : NativeSandboxBackendState.Error
);

export const parseNativeSandboxBackendProbe = (
  raw: Record<string, unknown>,
): NativeSandboxBackendProbeResult => ({
  ok: raw.ok === true,
  registered: raw.registered === true,
  runtimeEnabled: raw.runtimeEnabled === true,
  state: parseBackendState(raw.state),
  backendId: typeof raw.backendId === 'string' ? raw.backendId : undefined,
  runtimeKind: Object.values(NativeSandboxRuntimeKind).includes(
    raw.runtimeKind as NativeSandboxBackendProbeResult['runtimeKind'],
  )
    ? raw.runtimeKind as NativeSandboxBackendProbeResult['runtimeKind']
    : undefined,
  runtimeVersion: typeof raw.runtimeVersion === 'string'
    ? raw.runtimeVersion
    : undefined,
  protocolVersion: typeof raw.protocolVersion === 'number'
    ? raw.protocolVersion
    : undefined,
  policyVersion: typeof raw.policyVersion === 'string'
    ? raw.policyVersion
    : undefined,
  errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : undefined,
});

const configurationMismatchProbe = (
  enabled: boolean,
): NativeSandboxBackendProbeResult => ({
  ok: false,
  registered: false,
  runtimeEnabled: enabled,
  state: NativeSandboxBackendState.Error,
  backendId: NATIVE_SANDBOX_OPENCLAW_BACKEND_ID,
  errorCode: NativeSandboxErrorCode.ConfigurationFailed,
});

export const createNativeSandboxOpenClawCoordinator = (
  dependencies: NativeSandboxOpenClawCoordinatorDependencies,
): NativeSandboxOpenClawCoordinator => {
  let restoreGatewayOnDisable = false;
  return {
    applyConfiguration: async enabled => {
      const wasGatewayRunning = dependencies.isGatewayRunning();
      const shouldBeRunning = enabled
        || wasGatewayRunning
        || (!enabled && restoreGatewayOnDisable);
      try {
        await dependencies.syncConfiguration(enabled);
        if (shouldBeRunning && !dependencies.isGatewayRunning()) {
          await dependencies.ensureGatewayRunning();
        }
        if (!enabled) restoreGatewayOnDisable = false;
      } catch (error) {
        if (enabled && wasGatewayRunning) {
          restoreGatewayOnDisable = true;
        }
        throw error;
      }
    },

    verifyBackend: async ({ enabled, prepare, workspaceDir }) => {
      const selection = readNativeSandboxSelection(dependencies.readGatewayConfig());
      if (
        selection.backendSelected !== enabled
        || selection.runtimeEnabled !== enabled
      ) {
        return configurationMismatchProbe(enabled);
      }
      if (!enabled) {
        return {
          ok: true,
          registered: true,
          runtimeEnabled: false,
          state: NativeSandboxBackendState.Disabled,
          backendId: NATIVE_SANDBOX_OPENCLAW_BACKEND_ID,
        };
      }

      if (!dependencies.isGatewayRunning()) {
        await dependencies.ensureGatewayRunning();
      }
      const raw = await dependencies.requestGateway(
        NativeSandboxGatewayMethod.Status,
        {
          prepare,
          ...(prepare ? { workspaceDir } : {}),
        },
        { timeoutMs: 30_000 },
      );
      const probe = parseNativeSandboxBackendProbe(raw);
      if (
        probe.backendId !== NATIVE_SANDBOX_OPENCLAW_BACKEND_ID
        || probe.protocolVersion !== NATIVE_SANDBOX_PROTOCOL_VERSION
      ) {
        return {
          ...probe,
          ok: false,
          errorCode: NativeSandboxErrorCode.RuntimeVersionIncompatible,
        };
      }
      return probe;
    },
  };
};
