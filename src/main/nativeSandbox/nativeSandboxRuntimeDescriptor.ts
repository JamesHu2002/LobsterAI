import {
  NATIVE_SANDBOX_ACTIVATION_AVAILABLE,
  NATIVE_SANDBOX_PROTOCOL_VERSION,
  NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION,
  NativeSandboxRuntimeKind,
} from '../../shared/nativeSandbox/constants';
import type {
  NativeSandboxRuntimeKind as NativeSandboxRuntimeKindValue,
} from '../../shared/nativeSandbox/types';
import {
  isNativeSandboxEnvironmentSupported,
  type NativeSandboxEnvironment,
} from './nativeSandboxEnvironment';
import { resolveWindowsNativeSandboxRunnerPath } from './windows/windowsNativeSandboxEnvironment';

export interface NativeSandboxRuntimeDescriptor {
  runtimeKind: NativeSandboxRuntimeKindValue;
  runtimeVersion: string;
  protocolVersion: number;
  executablePath: string;
  activationAvailable: boolean;
}

/** Runtime descriptor serialized into the Lobster-owned OpenClaw plugin config. */
export const resolveNativeSandboxRuntimeDescriptor = (
  environment: NativeSandboxEnvironment,
): NativeSandboxRuntimeDescriptor => ({
  runtimeKind: NativeSandboxRuntimeKind.NativeWindows,
  runtimeVersion: NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION,
  protocolVersion: NATIVE_SANDBOX_PROTOCOL_VERSION,
  executablePath: resolveWindowsNativeSandboxRunnerPath(environment),
  activationAvailable: NATIVE_SANDBOX_ACTIVATION_AVAILABLE
    && isNativeSandboxEnvironmentSupported(environment),
});
