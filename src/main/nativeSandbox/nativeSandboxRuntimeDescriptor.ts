import {
  NATIVE_SANDBOX_ACTIVATION_AVAILABLE,
  NATIVE_SANDBOX_PROTOCOL_VERSION,
  NativeSandboxRuntimeKind,
} from '../../shared/nativeSandbox/constants';
import type {
  NativeSandboxRuntimeKind as NativeSandboxRuntimeKindValue,
} from '../../shared/nativeSandbox/types';
import {
  resolveLegacySrtWindowsHelperPath,
} from './legacy/legacySrtWindowsEnvironment';
import {
  LEGACY_SRT_WINDOWS_RUNTIME_VERSION,
} from './legacy/legacySrtWindowsProvisioner';
import type { NativeSandboxEnvironment } from './nativeSandboxEnvironment';

export interface NativeSandboxRuntimeDescriptor {
  runtimeKind: NativeSandboxRuntimeKindValue;
  runtimeVersion: string;
  protocolVersion: number;
  executablePath: string;
  activationAvailable: boolean;
}

/**
 * M0 exposes a vendor-neutral descriptor to config sync while the concrete
 * executable remains isolated behind the legacy Windows adapter.
 */
export const resolveNativeSandboxRuntimeDescriptor = (
  environment: NativeSandboxEnvironment,
): NativeSandboxRuntimeDescriptor => ({
  runtimeKind: NativeSandboxRuntimeKind.LegacyWindowsAdapter,
  runtimeVersion: LEGACY_SRT_WINDOWS_RUNTIME_VERSION,
  protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
  executablePath: resolveLegacySrtWindowsHelperPath(environment),
  activationAvailable: NATIVE_SANDBOX_ACTIVATION_AVAILABLE,
});
