import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { SandboxAuditRecorder } from './src/audit/sandboxAuditRecorder.js';
import {
  LOBSTER_SRT_POLICY_VERSION,
  LOBSTER_SRT_RUNTIME_VERSION,
  LOBSTER_SRT_SANDBOX_BACKEND_ID,
  LobsterSrtSandboxGatewayMethod,
  registerLobsterSrtSandboxBackend,
  SrtWindowsSession,
} from './src/backend/index.js';

type LobsterSrtPluginConfig = {
  helperPath: string;
  runtimeEnabled: boolean;
};

const readPluginConfig = (value: Record<string, unknown> | undefined): LobsterSrtPluginConfig => ({
  helperPath: typeof value?.helperPath === 'string' ? value.helperPath.trim() : '',
  runtimeEnabled: value?.runtimeEnabled === true,
});

const getErrorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : 'backend-unavailable';
};

export default definePluginEntry({
  id: 'lobster-srt-sandbox',
  name: 'Lobster SRT Sandbox',
  description: 'Windows native sandbox backend for LobsterAI task workspaces.',
  register(api) {
    // Discovery/setup loads must not mutate the process-global backend registry.
    if (api.registrationMode !== 'full') {
      return;
    }

    const config = readPluginConfig(api.pluginConfig);
    const audit = new SandboxAuditRecorder({
      policyVersion: LOBSTER_SRT_POLICY_VERSION,
      runtimeVersion: LOBSTER_SRT_RUNTIME_VERSION,
      logger: {
        debug: message => api.logger.debug(message),
      },
    });
    const session = new SrtWindowsSession({
      helperPath: config.helperPath,
      runtimeEnabled: config.runtimeEnabled,
      audit,
    });
    registerLobsterSrtSandboxBackend({
      session,
      audit,
      runtimeEnabled: config.runtimeEnabled,
    });
    api.registerGatewayMethod(LobsterSrtSandboxGatewayMethod.Status, async ({ params }) => {
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
          await session.prepareWorkspace(workspaceDir);
        }
        return {
          ok: true,
          registered: true,
          backendId: LOBSTER_SRT_SANDBOX_BACKEND_ID,
          policyVersion: LOBSTER_SRT_POLICY_VERSION,
          runtimeVersion: LOBSTER_SRT_RUNTIME_VERSION,
          ...session.getStatus(),
          recentAudit: audit.recent(10),
        };
      } catch (error) {
        return {
          ok: false,
          registered: true,
          backendId: LOBSTER_SRT_SANDBOX_BACKEND_ID,
          policyVersion: LOBSTER_SRT_POLICY_VERSION,
          runtimeVersion: LOBSTER_SRT_RUNTIME_VERSION,
          ...session.getStatus(),
          errorCode: getErrorCode(error),
          recentAudit: audit.recent(10),
        };
      }
    });
    api.registerService({
      id: 'lobster-srt-sandbox-runtime',
      start: () => undefined,
      stop: async () => {
        await session.reset();
      },
    });
    api.logger.info('[lobster-srt-sandbox] registered lobster-srt sandbox backend.');
  },
});
