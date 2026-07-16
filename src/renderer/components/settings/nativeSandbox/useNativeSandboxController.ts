import { useCallback, useEffect, useRef, useState } from 'react';

import { NativeSandboxOperation } from '../../../../shared/nativeSandbox/constants';
import type {
  NativeSandboxOperation as NativeSandboxOperationValue,
  NativeSandboxStatus,
} from '../../../../shared/nativeSandbox/types';
import { i18nService } from '../../../services/i18n';

export interface NativeSandboxController {
  activeOperation: NativeSandboxOperationValue | null;
  isLoading: boolean;
  operationError: string | null;
  operationNotice: string | null;
  refreshStatus: () => Promise<void>;
  runOperation: (operation: NativeSandboxOperationValue) => Promise<void>;
  status: NativeSandboxStatus | null;
}

export const useNativeSandboxController = (): NativeSandboxController => {
  const [status, setStatus] = useState<NativeSandboxStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeOperation, setActiveOperation] = useState<NativeSandboxOperationValue | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const isMountedRef = useRef(false);
  const operationInFlightRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    if (isMountedRef.current) {
      setIsLoading(true);
      setOperationError(null);
    }

    try {
      const result = await window.electron.nativeSandbox.getStatus();
      if (!isMountedRef.current) return;

      setStatus(result.status);
      if (!result.success) {
        setOperationError(
          result.error
          || result.status.lastError?.message
          || i18nService.t('sandboxStatusLoadFailed'),
        );
      }
    } catch (error) {
      if (!isMountedRef.current) return;

      console.error('[SandboxSettings] Failed to load native sandbox status', error);
      setOperationError(
        error instanceof Error ? error.message : i18nService.t('sandboxStatusLoadFailed'),
      );
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void refreshStatus();

    return () => {
      isMountedRef.current = false;
    };
  }, [refreshStatus]);

  const runOperation = useCallback(async (operation: NativeSandboxOperationValue) => {
    if (operationInFlightRef.current || status?.busy) return;

    operationInFlightRef.current = true;
    setActiveOperation(operation);
    setOperationError(null);
    setOperationNotice(null);

    try {
      const action = operation === NativeSandboxOperation.Install
        ? window.electron.nativeSandbox.install
        : window.electron.nativeSandbox.repair;
      const result = await action();
      if (!isMountedRef.current) return;

      setStatus(result.status);
      if (result.cancelled) {
        setOperationNotice(i18nService.t('sandboxActionCancelled'));
      } else if (!result.success) {
        setOperationError(
          result.error
          || result.status.lastError?.message
          || i18nService.t('sandboxOperationFailed'),
        );
      }
    } catch (error) {
      if (!isMountedRef.current) return;

      console.error(`[SandboxSettings] Native sandbox ${operation} failed`, error);
      setOperationError(
        error instanceof Error ? error.message : i18nService.t('sandboxOperationFailed'),
      );
    } finally {
      operationInFlightRef.current = false;
      if (isMountedRef.current) {
        setActiveOperation(null);
      }
    }
  }, [status?.busy]);

  return {
    activeOperation,
    isLoading,
    operationError,
    operationNotice,
    refreshStatus,
    runOperation,
    status,
  };
};
