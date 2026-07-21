import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { SandboxAuditRecorder } from './src/audit/sandboxAuditRecorder.js';
import {
  LOBSTER_NATIVE_POLICY_VERSION,
  LOBSTER_NATIVE_PROTOCOL_VERSION,
  LOBSTER_NATIVE_SANDBOX_BACKEND_ID,
  LOBSTER_NATIVE_WINDOWS_RUNTIME_KIND,
  LOBSTER_NATIVE_WINDOWS_RUNTIME_VERSION,
  LobsterNativeSandboxGatewayMethod,
  registerLobsterNativeSandboxBackend,
} from './src/backend/index.js';
import { WindowsNativeSandboxExecutor } from './src/windows/windowsNativeSandboxExecutor.js';
import { createWindowsSandboxPolicyContext } from './src/windows/windowsSandboxPolicyContext.js';

type LobsterNativePluginConfig = {
  runtimeExecutablePath: string;
  runtimeKind: string;
  runtimeVersion: string;
  protocolVersion: number;
  runtimeEnabled: boolean;
  sandboxDataRoot: string;
  skillsRoot: string;
};

const readPluginConfig = (
  value: Record<string, unknown> | undefined,
): LobsterNativePluginConfig => ({
  runtimeExecutablePath: typeof value?.runtimeExecutablePath === 'string'
    ? value.runtimeExecutablePath.trim()
    : '',
  runtimeKind: typeof value?.runtimeKind === 'string' ? value.runtimeKind : '',
  runtimeVersion: typeof value?.runtimeVersion === 'string' ? value.runtimeVersion : '',
  protocolVersion: typeof value?.protocolVersion === 'number' ? value.protocolVersion : 0,
  runtimeEnabled: value?.runtimeEnabled === true,
  sandboxDataRoot: typeof value?.sandboxDataRoot === 'string'
    ? value.sandboxDataRoot.trim()
    : '',
  skillsRoot: typeof value?.skillsRoot === 'string' ? value.skillsRoot.trim() : '',
});

const getErrorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : 'backend-unavailable';
};

export default definePluginEntry({
  id: 'lobster-native-sandbox',
  name: 'Lobster Native Sandbox',
  description: 'Windows native sandbox backend for LobsterAI task workspaces.',
  register(api) {
    // Discovery/setup loads must not mutate the process-global backend registry.
    if (api.registrationMode !== 'full') {
      return;
    }

    const config = readPluginConfig(api.pluginConfig);
    const audit = new SandboxAuditRecorder({
      policyVersion: LOBSTER_NATIVE_POLICY_VERSION,
      runtimeVersion: config.runtimeVersion || LOBSTER_NATIVE_WINDOWS_RUNTIME_VERSION,
      logger: {
        debug: message => api.logger.debug(message),
      },
    });
    const executor = new WindowsNativeSandboxExecutor({
      runnerPath: config.runtimeExecutablePath,
      runtimeEnabled: config.runtimeEnabled,
      audit,
    });
    registerLobsterNativeSandboxBackend({
      executor,
      audit,
      runtimeEnabled: config.runtimeEnabled,
      resolvePolicyContext: params => createWindowsSandboxPolicyContext({
        sessionKey: params.sessionKey,
        agentWorkspaceDir: (
          params as typeof params & { agentWorkspaceDir?: string }
        ).agentWorkspaceDir?.trim() || params.workspaceDir,
        sandboxDataRoot: config.sandboxDataRoot,
        skillsRoot: config.skillsRoot,
      }),
    });
    api.registerGatewayMethod(LobsterNativeSandboxGatewayMethod.Status, async ({ params }) => {
      const request = (
        params && typeof params === 'object'
          ? params as Record<string, unknown>
          : {}
      );
      try {
        if (request.prepare === true) {
          const workspaceDir = typeof request.workspaceDir === 'string'
            ? request.workspaceDir
            : '';
          await executor.prepareWorkspace(
            workspaceDir,
            createWindowsSandboxPolicyContext({
              sessionKey: 'agent:main:sandbox-health-check',
              agentWorkspaceDir: workspaceDir,
              sandboxDataRoot: config.sandboxDataRoot,
              skillsRoot: config.skillsRoot,
            }),
          );
        }
        return {
          ok: true,
          registered: true,
          backendId: LOBSTER_NATIVE_SANDBOX_BACKEND_ID,
          policyVersion: LOBSTER_NATIVE_POLICY_VERSION,
          protocolVersion: LOBSTER_NATIVE_PROTOCOL_VERSION,
          runtimeKind: config.runtimeKind || LOBSTER_NATIVE_WINDOWS_RUNTIME_KIND,
          runtimeVersion: config.runtimeVersion || LOBSTER_NATIVE_WINDOWS_RUNTIME_VERSION,
          ...executor.getStatus(),
          recentAudit: audit.recent(10),
        };
      } catch (error) {
        return {
          ok: false,
          registered: true,
          backendId: LOBSTER_NATIVE_SANDBOX_BACKEND_ID,
          policyVersion: LOBSTER_NATIVE_POLICY_VERSION,
          protocolVersion: LOBSTER_NATIVE_PROTOCOL_VERSION,
          runtimeKind: config.runtimeKind || LOBSTER_NATIVE_WINDOWS_RUNTIME_KIND,
          runtimeVersion: config.runtimeVersion || LOBSTER_NATIVE_WINDOWS_RUNTIME_VERSION,
          ...executor.getStatus(),
          errorCode: getErrorCode(error),
          recentAudit: audit.recent(10),
        };
      }
    });
    api.registerService({
      id: 'lobster-native-sandbox-runtime',
      start: () => undefined,
      stop: async () => {
        await executor.reset();
      },
    });
    api.logger.info(
      '[lobster-native-sandbox] registered native sandbox backend '
      + `(runtime=${config.runtimeKind || LOBSTER_NATIVE_WINDOWS_RUNTIME_KIND}, `
      + `protocol=${config.protocolVersion || LOBSTER_NATIVE_PROTOCOL_VERSION}).`,
    );
  },
});
