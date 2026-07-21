import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import React, { useMemo } from 'react';

import { NativeSandboxOperation } from '../../../../shared/nativeSandbox/constants';
import { i18nService } from '../../../services/i18n';
import NativeSandboxStatusCard from './NativeSandboxStatusCard';
import { buildNativeSandboxViewModel } from './nativeSandboxViewModel';
import { useNativeSandboxController } from './useNativeSandboxController';

const SandboxSettingsSection: React.FC = () => {
  const controller = useNativeSandboxController();
  const viewModel = useMemo(() => buildNativeSandboxViewModel({
    activeOperation: controller.activeOperation,
    isLoading: controller.isLoading,
    operationError: controller.operationError,
    status: controller.status,
  }), [
    controller.activeOperation,
    controller.isLoading,
    controller.operationError,
    controller.status,
  ]);
  const isEnabled = controller.status?.enabled === true;
  const isModeSwitching = controller.activeOperation === NativeSandboxOperation.Enable
    || controller.activeOperation === NativeSandboxOperation.Disable;
  const switchDisabled = controller.isLoading
    || Boolean(controller.status?.busy)
    || isModeSwitching
    || (
      !isEnabled
      && (
        !controller.status?.supported
        || !controller.status.runtimeAvailable
        || !controller.status.activationAvailable
        || controller.status.managedByEnterprise === true
      )
    );
  const modeBadgeKey = isEnabled
    ? controller.status?.backendConnected
      ? 'sandboxBackendConnected'
      : 'sandboxBackendDegraded'
    : 'sandboxBackendDisabled';
  const modeBadgeClassName = isEnabled && controller.status?.backendConnected
    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
    : isEnabled
      ? 'bg-red-500/10 text-red-700 dark:text-red-400'
      : 'bg-surface-raised text-secondary';

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-primary/20 bg-primary-muted/50 p-4">
        <div className="flex items-start gap-3">
          <InformationCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold text-foreground">{i18nService.t('sandboxTab')}</h4>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {i18nService.t('sandboxTestBadge')}
              </span>
            </div>
            <p className="mt-1 text-sm leading-6 text-secondary">
              {i18nService.t('sandboxTestDescription')}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface">
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-medium text-foreground">{i18nService.t('sandboxEnableTitle')}</h4>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${modeBadgeClassName}`}>
                {i18nService.t(modeBadgeKey)}
              </span>
            </div>
            <p className="mt-1 max-w-[560px] text-sm leading-5 text-secondary">
              {i18nService.t('sandboxEnableDescription')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            aria-label={i18nService.t('sandboxEnableTitle')}
            onClick={() => { void controller.setEnabled(!isEnabled); }}
            disabled={switchDisabled}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              isEnabled ? 'bg-primary' : 'bg-border'
            } ${switchDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
          >
            <span className={`absolute left-0 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
              isEnabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>
      </section>

      <NativeSandboxStatusCard
        isLoading={controller.isLoading}
        onRefresh={controller.refreshStatus}
        onRunOperation={controller.runOperation}
        status={controller.status}
        viewModel={viewModel}
      />

      {controller.operationNotice ? (
        <section className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary-muted/40 p-4">
          <InformationCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p className="text-sm leading-5 text-secondary">{controller.operationNotice}</p>
        </section>
      ) : null}

      <section className={`rounded-xl border p-4 ${
        viewModel.latestError
          ? 'border-red-500/20 bg-red-500/5'
          : 'border-border bg-surface'
      }`}>
        <div className="flex items-start gap-3">
          {viewModel.latestError ? (
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          ) : (
            <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
          )}
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-foreground">{i18nService.t('sandboxLastErrorTitle')}</h4>
            <p className={`mt-1 break-words text-sm leading-5 ${viewModel.latestError ? 'text-red-600 dark:text-red-400' : 'text-secondary'}`}>
              {viewModel.latestError || i18nService.t('sandboxNoRecentError')}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
        <div className="flex items-start gap-3">
          <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-foreground">
                {i18nService.t('sandboxM2BoundaryTitle')}
            </h4>
            <p className="mt-1 text-sm leading-6 text-secondary">
              {i18nService.t('sandboxM2BoundaryDescription')}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default SandboxSettingsSection;
