import { app, ipcMain } from 'electron';

import {
  type NativeSandboxControlDependencies,
  NativeSandboxControlService,
} from './nativeSandboxControlService';
import { createNativeSandboxEnvironment } from './nativeSandboxEnvironment';
import { registerNativeSandboxIpcHandlers } from './nativeSandboxIpcHandlers';
import { NativeSandboxService } from './nativeSandboxService';

export type RegisterNativeSandboxModuleOptions = Omit<
  NativeSandboxControlDependencies,
  'diagnostics'
>;

/** Main-process composition root for the native sandbox domain. */
export const registerNativeSandboxModule = (
  options: RegisterNativeSandboxModuleOptions,
): void => {
  registerNativeSandboxIpcHandlers({
    ipcMain,
    createService: () => new NativeSandboxControlService({
      ...options,
      diagnostics: new NativeSandboxService(createNativeSandboxEnvironment(app, {
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        arch: process.arch,
      })),
    }),
  });
};
