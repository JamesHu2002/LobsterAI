import { NativeSandboxPlatform } from '../../shared/nativeSandbox/constants';
import type { NativeSandboxPlatform as NativeSandboxPlatformValue } from '../../shared/nativeSandbox/types';

export interface NativeSandboxEnvironment {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  architecture: string;
}

export interface NativeSandboxAppEnvironment {
  getAppPath: () => string;
  isPackaged: boolean;
}

export interface NativeSandboxProcessEnvironment {
  resourcesPath: string;
  platform: NodeJS.Platform;
  arch: string;
}

const SUPPORTED_WINDOWS_ARCHITECTURES = new Set(['x64']);

export const createNativeSandboxEnvironment = (
  electronApp: NativeSandboxAppEnvironment,
  runtimeProcess: NativeSandboxProcessEnvironment,
): NativeSandboxEnvironment => ({
  appPath: electronApp.getAppPath(),
  resourcesPath: runtimeProcess.resourcesPath,
  isPackaged: electronApp.isPackaged,
  platform: runtimeProcess.platform,
  architecture: runtimeProcess.arch,
});

export const mapNativeSandboxPlatform = (
  platform: NodeJS.Platform,
): NativeSandboxPlatformValue => {
  if (platform === 'win32') return NativeSandboxPlatform.Windows;
  if (platform === 'darwin') return NativeSandboxPlatform.MacOS;
  if (platform === 'linux') return NativeSandboxPlatform.Linux;
  return NativeSandboxPlatform.Unknown;
};

export const isNativeSandboxEnvironmentSupported = (
  environment: Pick<NativeSandboxEnvironment, 'platform' | 'architecture'>,
): boolean => environment.platform === 'win32'
  && SUPPORTED_WINDOWS_ARCHITECTURES.has(environment.architecture);
