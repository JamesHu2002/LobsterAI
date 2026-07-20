import type {
  NativeSandboxOperationResult,
  NativeSandboxSetEnabledResult,
} from './types';

/** Renderer-facing contract exposed through Electron's preload bridge. */
export interface NativeSandboxBridge {
  getStatus: () => Promise<NativeSandboxOperationResult>;
  install: () => Promise<NativeSandboxOperationResult>;
  repair: () => Promise<NativeSandboxOperationResult>;
  setEnabled: (enabled: boolean) => Promise<NativeSandboxSetEnabledResult>;
}
