import { app, ipcMain } from 'electron';

import { createNativeSandboxEnvironment } from './nativeSandboxEnvironment';
import { registerNativeSandboxIpcHandlers } from './nativeSandboxIpcHandlers';
import { NativeSandboxService } from './nativeSandboxService';

/** Main-process composition root for the native sandbox domain. */
export const registerNativeSandboxModule = (): void => {
  registerNativeSandboxIpcHandlers({
    ipcMain,
    createService: () => new NativeSandboxService(createNativeSandboxEnvironment(app, {
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      arch: process.arch,
    })),
  });
};
