import {
  NativeSandboxErrorCode,
  NativeSandboxNetworkState,
  NativeSandboxOperation,
  NativeSandboxPlatform,
  NativeSandboxState,
} from './constants';

export type NativeSandboxPlatform =
  typeof NativeSandboxPlatform[keyof typeof NativeSandboxPlatform];

export type NativeSandboxState =
  typeof NativeSandboxState[keyof typeof NativeSandboxState];

export type NativeSandboxOperation =
  typeof NativeSandboxOperation[keyof typeof NativeSandboxOperation];

export type NativeSandboxErrorCode =
  typeof NativeSandboxErrorCode[keyof typeof NativeSandboxErrorCode];

export type NativeSandboxNetworkState =
  typeof NativeSandboxNetworkState[keyof typeof NativeSandboxNetworkState];

export interface NativeSandboxError {
  code: NativeSandboxErrorCode;
  message: string;
}

export interface NativeSandboxUserStatus {
  provisioned: boolean;
  credentialPresent: boolean;
  groupExists: boolean;
  inBuiltinUsers: boolean;
  inSandboxGroup: boolean;
  hiddenFromLogon: boolean;
  sid?: string;
}

export interface NativeSandboxNetworkStatus {
  state: NativeSandboxNetworkState;
  filters?: number;
  portRange?: [number, number];
}

export interface NativeSandboxStatus {
  platform: NativeSandboxPlatform;
  architecture: string;
  supported: boolean;
  state: NativeSandboxState;
  runtimeVersion: string;
  helperAvailable: boolean;
  helperPath?: string;
  installed: boolean;
  healthy: boolean;
  /** M1 only provisions and diagnoses SRT; command execution remains local. */
  backendConnected: boolean;
  busy: boolean;
  operation?: NativeSandboxOperation;
  user?: NativeSandboxUserStatus;
  network?: NativeSandboxNetworkStatus;
  lastError?: NativeSandboxError;
  checkedAt: number;
}

export interface NativeSandboxOperationResult {
  success: boolean;
  status: NativeSandboxStatus;
  cancelled?: boolean;
  error?: string;
}
