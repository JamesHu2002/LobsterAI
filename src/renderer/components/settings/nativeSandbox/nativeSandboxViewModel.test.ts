import { describe, expect, test } from 'vitest';

import {
  NativeSandboxOperation,
  NativeSandboxPlatform,
  NativeSandboxState,
} from '../../../../shared/nativeSandbox/constants';
import type { NativeSandboxStatus } from '../../../../shared/nativeSandbox/types';
import {
  buildNativeSandboxViewModel,
  NativeSandboxStatusTone,
  type NativeSandboxViewModelInput,
} from './nativeSandboxViewModel';

const makeStatus = (overrides: Partial<NativeSandboxStatus> = {}): NativeSandboxStatus => ({
  architecture: 'x64',
  backendConnected: false,
  busy: false,
  checkedAt: 1,
  enabled: false,
  healthy: false,
  helperAvailable: true,
  installed: false,
  platform: NativeSandboxPlatform.Windows,
  runtimeVersion: '0.0.65',
  state: NativeSandboxState.NotInstalled,
  supported: true,
  ...overrides,
});

const baseInput: NativeSandboxViewModelInput = {
  activeOperation: null,
  isLoading: false,
  operationError: null,
  status: null,
};

describe('buildNativeSandboxViewModel', () => {
  test.each([
    {
      expectedLabel: 'sandboxStatusLoading',
      expectedTone: NativeSandboxStatusTone.Busy,
      input: { ...baseInput, isLoading: true },
      name: 'loading before the first status response',
    },
    {
      expectedLabel: 'sandboxStatusUnknown',
      expectedTone: NativeSandboxStatusTone.Warning,
      input: baseInput,
      name: 'missing status after loading',
    },
    {
      expectedLabel: 'sandboxStatusReady',
      expectedTone: NativeSandboxStatusTone.Ready,
      input: { ...baseInput, status: makeStatus({ state: NativeSandboxState.Ready }) },
      name: 'ready runtime',
    },
    {
      expectedLabel: 'sandboxStatusDegraded',
      expectedTone: NativeSandboxStatusTone.Warning,
      input: { ...baseInput, status: makeStatus({ state: NativeSandboxState.Degraded }) },
      name: 'degraded runtime',
    },
  ])('derives status presentation for $name', ({ expectedLabel, expectedTone, input }) => {
    const viewModel = buildNativeSandboxViewModel(input);

    expect(viewModel.stateLabelKey).toBe(expectedLabel);
    expect(viewModel.statusTone).toBe(expectedTone);
  });

  test.each([
    {
      expectedAction: NativeSandboxOperation.Install,
      expectedCanOperate: true,
      expectedLabel: 'sandboxInstallAction',
      input: { ...baseInput, status: makeStatus() },
      name: 'an uninstalled runtime',
    },
    {
      expectedAction: NativeSandboxOperation.Repair,
      expectedCanOperate: true,
      expectedLabel: 'sandboxRepairAction',
      input: { ...baseInput, status: makeStatus({ installed: true }) },
      name: 'an installed runtime',
    },
    {
      expectedAction: NativeSandboxOperation.Install,
      expectedCanOperate: false,
      expectedLabel: 'sandboxInstallingAction',
      input: {
        ...baseInput,
        activeOperation: NativeSandboxOperation.Install,
        status: makeStatus(),
      },
      name: 'an active install',
    },
    {
      expectedAction: NativeSandboxOperation.Repair,
      expectedCanOperate: false,
      expectedLabel: 'sandboxRepairingAction',
      input: {
        ...baseInput,
        status: makeStatus({
          busy: true,
          installed: true,
          operation: NativeSandboxOperation.Repair,
        }),
      },
      name: 'a backend repair',
    },
  ])('derives action state for $name', ({
    expectedAction,
    expectedCanOperate,
    expectedLabel,
    input,
  }) => {
    const viewModel = buildNativeSandboxViewModel(input);

    expect(viewModel.actionOperation).toBe(expectedAction);
    expect(viewModel.actionLabelKey).toBe(expectedLabel);
    expect(viewModel.canOperate).toBe(expectedCanOperate);
  });

  test.each([
    { name: 'unsupported platform', status: makeStatus({ supported: false }) },
    { name: 'missing helper', status: makeStatus({ helperAvailable: false }) },
    { name: 'backend busy', status: makeStatus({ busy: true }) },
  ])('disables operations for $name', ({ status }) => {
    expect(buildNativeSandboxViewModel({ ...baseInput, status }).canOperate).toBe(false);
  });

  test('prefers the current operation error over a status error', () => {
    const viewModel = buildNativeSandboxViewModel({
      ...baseInput,
      operationError: 'operation failed',
      status: makeStatus({
        lastError: { code: 'status-check-failed', message: 'status failed' },
      }),
    });

    expect(viewModel.latestError).toBe('operation failed');
  });
});
