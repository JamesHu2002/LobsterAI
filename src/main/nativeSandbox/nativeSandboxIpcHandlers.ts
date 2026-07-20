import type { IpcMain } from 'electron';

import { NativeSandboxIpcChannel } from '../../shared/nativeSandbox/constants';
import type { NativeSandboxSetEnabledRequest } from '../../shared/nativeSandbox/types';
import type { NativeSandboxControlServiceApi } from './nativeSandboxControlService';

interface NativeSandboxLogger {
  log: (...args: unknown[]) => void;
}

export interface RegisterNativeSandboxIpcHandlersOptions {
  ipcMain: Pick<IpcMain, 'handle'>;
  createService: () => NativeSandboxControlServiceApi;
  logger?: NativeSandboxLogger;
}

/**
 * Registers the public IPC boundary without constructing the service. The
 * service (and therefore SRT) remains untouched until a renderer invokes one
 * of these channels.
 */
export const registerNativeSandboxIpcHandlers = ({
  ipcMain,
  createService,
  logger = console,
}: RegisterNativeSandboxIpcHandlersOptions): void => {
  let service: NativeSandboxControlServiceApi | null = null;
  const getService = (): NativeSandboxControlServiceApi => {
    if (!service) service = createService();
    return service;
  };

  ipcMain.handle(NativeSandboxIpcChannel.GetStatus, () => {
    return getService().getStatus();
  });

  // These are the only M1 entry points that may trigger SRT's one-time UAC flow.
  ipcMain.handle(NativeSandboxIpcChannel.Install, async () => {
    logger.log('[NativeSandbox] Installation requested by the user.');
    const result = await getService().install();
    logger.log(
      `[NativeSandbox] Installation finished (success=${result.success}, `
      + `cancelled=${Boolean(result.cancelled)}, state=${result.status.state}).`,
    );
    return result;
  });

  ipcMain.handle(NativeSandboxIpcChannel.Repair, async () => {
    logger.log('[NativeSandbox] Repair requested by the user.');
    const result = await getService().repair();
    logger.log(
      `[NativeSandbox] Repair finished (success=${result.success}, `
      + `cancelled=${Boolean(result.cancelled)}, state=${result.status.state}).`,
    );
    return result;
  });

  ipcMain.handle(
    NativeSandboxIpcChannel.SetEnabled,
    async (_event, request: NativeSandboxSetEnabledRequest) => {
      if (!request || typeof request.enabled !== 'boolean') {
        throw new TypeError('Invalid native sandbox mode request.');
      }
      const enabled = request.enabled;
      logger.log(`[NativeSandbox] ${enabled ? 'Enable' : 'Disable'} requested by the user.`);
      const result = await getService().setEnabled(enabled);
      logger.log(
        `[NativeSandbox] Mode switch finished (success=${result.success}, `
        + `enabled=${result.enabled}, stage=${result.stage}, `
        + `rolledBack=${Boolean(result.rolledBack)}).`,
      );
      return result;
    },
  );
};
