import path from 'path';

import type { NativeSandboxEnvironment } from '../nativeSandboxEnvironment';

export const resolveLegacySrtWindowsHelperPath = (
  environment: Pick<
    NativeSandboxEnvironment,
    'appPath' | 'resourcesPath' | 'isPackaged' | 'architecture'
  >,
): string => {
  if (environment.isPackaged) {
    return path.join(environment.resourcesPath, 'sandbox-runtime', 'srt-win.exe');
  }
  return path.join(
    environment.appPath,
    'node_modules',
    '@anthropic-ai',
    'sandbox-runtime',
    'vendor',
    'srt-win',
    environment.architecture,
    'srt-win.exe',
  );
};
