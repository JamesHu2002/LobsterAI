import {
  NativeSandboxOperation,
  NativeSandboxState,
} from '../../../../shared/nativeSandbox/constants';
import type {
  NativeSandboxOperation as NativeSandboxOperationValue,
  NativeSandboxState as NativeSandboxStateValue,
  NativeSandboxStatus,
} from '../../../../shared/nativeSandbox/types';
import type { NativeSandboxTranslationKey } from './translations';

const STATUS_LABEL_KEYS: Record<NativeSandboxStateValue, NativeSandboxTranslationKey> = {
  [NativeSandboxState.Unsupported]: 'sandboxStatusUnsupported',
  [NativeSandboxState.Unavailable]: 'sandboxStatusUnavailable',
  [NativeSandboxState.NotInstalled]: 'sandboxStatusNotInstalled',
  [NativeSandboxState.Checking]: 'sandboxStatusChecking',
  [NativeSandboxState.Installing]: 'sandboxStatusInstalling',
  [NativeSandboxState.Repairing]: 'sandboxStatusRepairing',
  [NativeSandboxState.Ready]: 'sandboxStatusReady',
  [NativeSandboxState.Degraded]: 'sandboxStatusDegraded',
  [NativeSandboxState.Error]: 'sandboxStatusError',
};

export const NativeSandboxStatusTone = {
  Busy: 'busy',
  Ready: 'ready',
  Warning: 'warning',
} as const;

export type NativeSandboxStatusTone =
  typeof NativeSandboxStatusTone[keyof typeof NativeSandboxStatusTone];

export interface NativeSandboxViewModelInput {
  activeOperation: NativeSandboxOperationValue | null;
  isLoading: boolean;
  operationError: string | null;
  status: NativeSandboxStatus | null;
}

export interface NativeSandboxViewModel {
  actionLabelKey: NativeSandboxTranslationKey;
  actionOperation: NativeSandboxOperationValue;
  canOperate: boolean;
  isOperating: boolean;
  latestError: string | null;
  pendingValueKey: NativeSandboxTranslationKey;
  stateLabelKey: NativeSandboxTranslationKey;
  statusTone: NativeSandboxStatusTone;
}

export const buildNativeSandboxViewModel = ({
  activeOperation,
  isLoading,
  operationError,
  status,
}: NativeSandboxViewModelInput): NativeSandboxViewModel => {
  const actionOperation = status?.installed
    ? NativeSandboxOperation.Repair
    : NativeSandboxOperation.Install;
  const isOperating = Boolean(activeOperation || status?.busy);
  const effectiveOperation = activeOperation ?? status?.operation;

  let actionLabelKey: NativeSandboxTranslationKey;
  if (isOperating) {
    if (effectiveOperation === NativeSandboxOperation.Repair) {
      actionLabelKey = 'sandboxRepairingAction';
    } else if (effectiveOperation === NativeSandboxOperation.Install) {
      actionLabelKey = 'sandboxInstallingAction';
    } else {
      actionLabelKey = 'sandboxStatusChecking';
    }
  } else {
    actionLabelKey = actionOperation === NativeSandboxOperation.Repair
      ? 'sandboxRepairAction'
      : 'sandboxInstallAction';
  }

  const stateLabelKey = isLoading && !status
    ? 'sandboxStatusLoading'
    : status
      ? STATUS_LABEL_KEYS[status.state]
      : 'sandboxStatusUnknown';

  const statusTone = status?.state === NativeSandboxState.Ready
    ? NativeSandboxStatusTone.Ready
    : status?.busy || isLoading
      ? NativeSandboxStatusTone.Busy
      : NativeSandboxStatusTone.Warning;

  return {
    actionLabelKey,
    actionOperation,
    canOperate: Boolean(
      status?.supported
      && status.runtimeAvailable
      && status.lifecycleAvailable
      && !isOperating
      && !isLoading
    ),
    isOperating,
    latestError: operationError || status?.lastError?.message || null,
    pendingValueKey: isLoading ? 'sandboxStatusLoading' : 'sandboxStatusUnknown',
    stateLabelKey,
    statusTone,
  };
};
