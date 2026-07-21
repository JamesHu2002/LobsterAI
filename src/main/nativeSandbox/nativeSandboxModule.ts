import { app, ipcMain } from 'electron';

import {
  type NativeSandboxControlDependencies,
  NativeSandboxControlService,
} from './nativeSandboxControlService';
import { createNativeSandboxEnvironment } from './nativeSandboxEnvironment';
import { registerNativeSandboxIpcHandlers } from './nativeSandboxIpcHandlers';
import { WindowsNativeSandboxProvisioner } from './windows/windowsNativeSandboxProvisioner';

export type RegisterNativeSandboxModuleOptions = Omit<
  NativeSandboxControlDependencies,
  'provisioner'
>;

/** Main-process composition root for the native sandbox domain. */
export const registerNativeSandboxModule = (
  options: RegisterNativeSandboxModuleOptions,
): void => {
  registerNativeSandboxIpcHandlers({
    ipcMain,
    createService: () => new NativeSandboxControlService({
      ...options,
      provisioner: new WindowsNativeSandboxProvisioner(createNativeSandboxEnvironment(app, {
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        arch: process.arch,
      })),
    }),
  });
};
