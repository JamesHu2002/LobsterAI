import {
  ArrowPathIcon,
  ShieldCheckIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import React from 'react';

import type {
  NativeSandboxOperation,
  NativeSandboxStatus,
} from '../../../../shared/nativeSandbox/types';
import { i18nService } from '../../../services/i18n';
import {
  NativeSandboxStatusTone,
  type NativeSandboxViewModel,
} from './nativeSandboxViewModel';

const STATUS_BADGE_CLASS_NAMES: Record<NativeSandboxStatusTone, string> = {
  [NativeSandboxStatusTone.Busy]: 'bg-primary-muted text-primary',
  [NativeSandboxStatusTone.Ready]: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  [NativeSandboxStatusTone.Warning]: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

const StatusRow: React.FC<{
  label: string;
  value: string;
  valueClassName?: string;
}> = ({ label, value, valueClassName = 'text-foreground' }) => (
  <div className="flex items-start justify-between gap-4 border-t border-border-subtle px-4 py-3 first:border-t-0">
    <dt className="text-sm text-secondary">{label}</dt>
    <dd className={`max-w-[60%] text-right text-sm font-medium ${valueClassName}`}>{value}</dd>
  </div>
);

const formatCheckedAt = (checkedAt?: number): string => {
  if (!checkedAt || !Number.isFinite(checkedAt)) {
    return i18nService.t('sandboxNotChecked');
  }

  return new Date(checkedAt).toLocaleString();
};

interface NativeSandboxStatusCardProps {
  isLoading: boolean;
  onRefresh: () => Promise<void>;
  onRunOperation: (operation: NativeSandboxOperation) => Promise<void>;
  status: NativeSandboxStatus | null;
  viewModel: NativeSandboxViewModel;
}

const NativeSandboxStatusCard: React.FC<NativeSandboxStatusCardProps> = ({
  isLoading,
  onRefresh,
  onRunOperation,
  status,
  viewModel,
}) => {
  const pendingValue = i18nService.t(viewModel.pendingValueKey);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheckIcon className="h-5 w-5 shrink-0 text-primary" />
          <h4 className="truncate text-sm font-medium text-foreground">
            {i18nService.t('sandboxRuntimeStatusTitle')}
          </h4>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS_NAMES[viewModel.statusTone]}`}>
            {i18nService.t(viewModel.stateLabelKey)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => { void onRefresh(); }}
          disabled={isLoading || viewModel.isOperating}
          title={i18nService.t('sandboxRefreshStatus')}
          aria-label={i18nService.t('sandboxRefreshStatus')}
          className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <dl className="border-t border-border">
        <StatusRow
          label={i18nService.t('sandboxPlatformLabel')}
          value={status
            ? status.supported
              ? i18nService.t('sandboxPlatformSupported')
              : i18nService.t('sandboxPlatformUnsupported')
            : pendingValue}
          valueClassName={status?.supported ? 'text-foreground' : 'text-amber-700 dark:text-amber-400'}
        />
        <StatusRow
          label={i18nService.t('sandboxRuntimeKindLabel')}
          value={status?.runtimeKind || pendingValue}
        />
        <StatusRow
          label={i18nService.t('sandboxRuntimeVersionLabel')}
          value={status?.runtimeVersion || pendingValue}
        />
        <StatusRow
          label={i18nService.t('sandboxRuntimeComponentStatusLabel')}
          value={status
            ? status.runtimeAvailable
              ? i18nService.t('sandboxRuntimeComponentAvailable')
              : i18nService.t('sandboxRuntimeComponentMissing')
            : pendingValue}
        />
        <StatusRow
          label={i18nService.t('sandboxInstallationStatusLabel')}
          value={status
            ? status.installed
              ? i18nService.t('sandboxInstalled')
              : i18nService.t('sandboxNotInstalled')
            : pendingValue}
        />
        <StatusRow
          label={i18nService.t('sandboxHealthStatusLabel')}
          value={status
            ? status.healthy
              ? i18nService.t('sandboxHealthy')
              : i18nService.t('sandboxUnhealthy')
            : pendingValue}
          valueClassName={status?.healthy ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}
        />
        <StatusRow
          label={i18nService.t('sandboxModeStatusLabel')}
          value={status
            ? status.enabled
              ? i18nService.t('sandboxModeEnabled')
              : i18nService.t('sandboxModeDisabled')
            : pendingValue}
        />
        <StatusRow
          label={i18nService.t('sandboxBackendStatusLabel')}
          value={status
            ? !status.enabled
              ? i18nService.t('sandboxBackendDisabled')
              : status.backendConnected
                ? i18nService.t('sandboxBackendReady')
                : i18nService.t('sandboxBackendUnavailable')
            : pendingValue}
          valueClassName={status?.backendConnected
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-secondary'}
        />
        <StatusRow
          label={i18nService.t('sandboxIdentityStatusLabel')}
          value={status
            ? status.identityReady
              ? i18nService.t('sandboxIdentityReady')
              : i18nService.t('sandboxIdentityUnavailable')
            : pendingValue}
          valueClassName={status?.identityReady
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-700 dark:text-amber-400'}
        />
        <StatusRow
          label={i18nService.t('sandboxIntegrityStatusLabel')}
          value={status
            ? status.integrityVerified
              ? i18nService.t('sandboxIntegrityVerified')
              : i18nService.t('sandboxIntegrityUnverified')
            : pendingValue}
          valueClassName={status?.integrityVerified
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-700 dark:text-amber-400'}
        />
        <StatusRow
          label={i18nService.t('sandboxInstallProtectionLabel')}
          value={status
            ? status.protectedInstallation
              ? i18nService.t('sandboxInstallProtected')
              : i18nService.t('sandboxInstallUnprotected')
            : pendingValue}
          valueClassName={status?.protectedInstallation
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-700 dark:text-amber-400'}
        />
        <StatusRow
          label={i18nService.t('sandboxSignatureStatusLabel')}
          value={status
            ? status.signatureRequired
              ? status.signatureVerified
                ? i18nService.t('sandboxSignatureVerified')
                : i18nService.t('sandboxSignatureUnverified')
              : i18nService.t('sandboxSignatureDevelopment')
            : pendingValue}
          valueClassName={status?.signatureRequired && !status.signatureVerified
            ? 'text-amber-700 dark:text-amber-400'
            : status?.signatureVerified
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-secondary'}
        />
        <StatusRow
          label={i18nService.t('sandboxInstallRootLabel')}
          value={status?.installationRoot || pendingValue}
        />
        <StatusRow
          label={i18nService.t('sandboxNetworkIsolationLabel')}
          value={status
            ? status.networkIsolated
              ? i18nService.t('sandboxCapabilityIsolated')
              : i18nService.t('sandboxCapabilityNotIsolated')
            : pendingValue}
          valueClassName={status?.networkIsolated
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-700 dark:text-amber-400'}
        />
        <StatusRow
          label={i18nService.t('sandboxReadIsolationLabel')}
          value={status
            ? status.readIsolated
              ? i18nService.t('sandboxCapabilityIsolated')
              : i18nService.t('sandboxCapabilityNotIsolated')
            : pendingValue}
          valueClassName={status?.readIsolated
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-700 dark:text-amber-400'}
        />
        <StatusRow
          label={i18nService.t('sandboxReleaseReadinessLabel')}
          value={status
            ? status.productionReady
              ? i18nService.t('sandboxProductionReady')
              : i18nService.t('sandboxInternalTestOnly')
            : pendingValue}
          valueClassName={status?.productionReady
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-700 dark:text-amber-400'}
        />
        <StatusRow
          label={i18nService.t('sandboxLastCheckedLabel')}
          value={formatCheckedAt(status?.checkedAt)}
        />
      </dl>

      <div className="border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[540px] text-xs leading-5 text-secondary">
            {i18nService.t('sandboxUacHint')}
          </p>
          {status?.lifecycleAvailable ? (
            <button
              type="button"
              onClick={() => { void onRunOperation(viewModel.actionOperation); }}
              disabled={!viewModel.canOperate}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              {viewModel.isOperating ? (
                <ArrowPathIcon className="h-4 w-4 animate-spin" />
              ) : (
                <WrenchScrewdriverIcon className="h-4 w-4" />
              )}
              {i18nService.t(viewModel.actionLabelKey)}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export default NativeSandboxStatusCard;
