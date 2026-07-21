import {
  NativeSandboxBackendState,
  NativeSandboxControlStage,
  NativeSandboxErrorCode,
  NativeSandboxFilesystemCapability,
  NativeSandboxNetworkMode,
  NativeSandboxOperation,
  NativeSandboxPlatform,
  NativeSandboxProfileMode,
  NativeSandboxRuntimeKind,
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

export type NativeSandboxRuntimeKind =
  typeof NativeSandboxRuntimeKind[keyof typeof NativeSandboxRuntimeKind];

export type NativeSandboxNetworkMode =
  typeof NativeSandboxNetworkMode[keyof typeof NativeSandboxNetworkMode];

export type NativeSandboxProfileMode =
  typeof NativeSandboxProfileMode[keyof typeof NativeSandboxProfileMode];

export type NativeSandboxFilesystemCapability =
  typeof NativeSandboxFilesystemCapability[keyof typeof NativeSandboxFilesystemCapability];

export type NativeSandboxControlStage =
  typeof NativeSandboxControlStage[keyof typeof NativeSandboxControlStage];

export type NativeSandboxBackendState =
  typeof NativeSandboxBackendState[keyof typeof NativeSandboxBackendState];

export interface NativeSandboxError {
  code: NativeSandboxErrorCode;
  message: string;
}

export interface NativeSandboxStatus {
  platform: NativeSandboxPlatform;
  architecture: string;
  supported: boolean;
  state: NativeSandboxState;
  runtimeKind: NativeSandboxRuntimeKind;
  runtimeVersion: string;
  protocolVersion: number;
  runtimeAvailable: boolean;
  activationAvailable: boolean;
  lifecycleAvailable: boolean;
  installed: boolean;
  healthy: boolean;
  /** Persisted product mode, independent from transient backend health. */
  enabled: boolean;
  backendConnected: boolean;
  backendState?: NativeSandboxBackendState;
  networkIsolated?: boolean;
  readIsolated?: boolean;
  productionReady?: boolean;
  managedByEnterprise?: boolean;
  busy: boolean;
  operation?: NativeSandboxOperation;
  lastError?: NativeSandboxError;
  checkedAt: number;
}

export interface NativeSandboxOperationResult {
  success: boolean;
  status: NativeSandboxStatus;
  cancelled?: boolean;
  error?: string;
}

export interface NativeSandboxSetEnabledRequest {
  enabled: boolean;
}

export interface NativeSandboxSetEnabledResult extends NativeSandboxOperationResult {
  enabled: boolean;
  previousEnabled: boolean;
  stage: NativeSandboxControlStage;
  rolledBack?: boolean;
}

export interface NativeSandboxBackendProbeResult {
  ok: boolean;
  registered: boolean;
  runtimeEnabled: boolean;
  state: NativeSandboxBackendState;
  backendId?: string;
  runtimeKind?: NativeSandboxRuntimeKind;
  runtimeVersion?: string;
  protocolVersion?: number;
  policyVersion?: string;
  networkIsolated?: boolean;
  readIsolated?: boolean;
  productionReady?: boolean;
  errorCode?: string;
}

export interface NativeSandboxResourceLimits {
  timeoutMs?: number;
  maxProcesses?: number;
  maxOutputBytes?: number;
}

export interface NativeSandboxHostProfile {
  mode: NativeSandboxProfileMode;
  homeDir: string;
  userProfileDir: string;
  appDataDir: string;
  localAppDataDir: string;
}

/**
 * Serialized, platform-neutral policy contract. M0 defines the boundary; the
 * native Windows runner starts consuming it in M1.
 */
export interface NativeSandboxPolicySnapshot {
  protocolVersion: number;
  policyVersion: string;
  taskId: string;
  agentId: string;
  cwd: string;
  writableRoots: string[];
  readableRoots: string[];
  protectedPaths: string[];
  profile: NativeSandboxHostProfile;
  scratchDir: string;
  networkMode: NativeSandboxNetworkMode;
  limits: NativeSandboxResourceLimits;
}

export interface NativeSandboxRuntimeCapabilities {
  runtimeKind: NativeSandboxRuntimeKind;
  runtimeVersion: string;
  protocolVersion: number;
  supportedNetworkModes: NativeSandboxNetworkMode[];
  supportsMultipleWritableRoots: boolean;
  enforcesProcessTree: boolean;
}
