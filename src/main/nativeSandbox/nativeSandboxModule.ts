import { app, ipcMain } from 'electron';

import { LegacySrtWindowsProvisioner } from './legacy/legacySrtWindowsProvisioner';
import {
  type NativeSandboxControlDependencies,
  NativeSandboxControlService,
} from './nativeSandboxControlService';
import { createNativeSandboxEnvironment } from './nativeSandboxEnvironment';
import { registerNativeSandboxIpcHandlers } from './nativeSandboxIpcHandlers';
import { migrateNativeSandboxM0Configuration } from './nativeSandboxM0Migration';

export type RegisterNativeSandboxModuleOptions = Omit<
  NativeSandboxControlDependencies,
  'provisioner'
>;

/** Main-process composition root for the native sandbox domain. */
export const registerNativeSandboxModule = (
  options: RegisterNativeSandboxModuleOptions,
): void => {
  void migrateNativeSandboxM0Configuration(options);

  registerNativeSandboxIpcHandlers({
    ipcMain,
    createService: () => new NativeSandboxControlService({
      ...options,
      provisioner: new LegacySrtWindowsProvisioner(createNativeSandboxEnvironment(app, {
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        arch: process.arch,
      })),
    }),
  });
};
