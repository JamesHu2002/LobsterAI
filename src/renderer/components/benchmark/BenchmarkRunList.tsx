import React from 'react';
import { ArrowLeftIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useDispatch, useSelector } from 'react-redux';
import { BenchmarkRunStatus } from '../../../benchmark/constants';
import type { BenchmarkRun } from '../../../benchmark/types';
import { i18nService } from '../../services/i18n';
import { benchmarkService } from '../../services/benchmark';
import { RootState } from '../../store';
import { selectRun } from '../../store/slices/benchmarkSlice';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';

interface BenchmarkRunListProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  updateBadge?: React.ReactNode;
  onCreate: () => void;
}

function statusLabel(status: BenchmarkRun['status']): string {
  const key = `benchmarkStatus${status.charAt(0).toUpperCase()}${status.slice(1)}`;
  return i18nService.t(key);
}

function statusColor(status: BenchmarkRun['status']): string {
  switch (status) {
    case BenchmarkRunStatus.Running:
    case BenchmarkRunStatus.Pending:
      return 'text-primary bg-primary/10';
    case BenchmarkRunStatus.Completed:
      return 'text-emerald-600 bg-emerald-500/10';
    case BenchmarkRunStatus.Failed:
      return 'text-red-600 bg-red-500/10';
    case BenchmarkRunStatus.Cancelled:
      return 'text-secondary bg-surface-raised';
    default:
      return 'text-amber-600 bg-amber-500/10';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export const BenchmarkRunList: React.FC<BenchmarkRunListProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onCreate,
}) => {
  const dispatch = useDispatch();
  const runs = useSelector((state: RootState) => state.benchmark.runs);
  const runListStatus = useSelector((state: RootState) => state.benchmark.runListStatus);

  const handleDelete = async (id: string) => {
    if (window.confirm(i18nService.t('benchmarkDelete') + '?')) {
      await benchmarkService.deleteRun(id);
    }
  };

  return (
    <div data-skin-management-page="true" className="relative z-10 flex h-full flex-col bg-background">
      {/* Header */}
      <div className="draggable flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center space-x-3">
          {isSidebarCollapsed && (
            <div className="non-draggable flex items-center gap-1">
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold text-foreground">{i18nService.t('benchmarkTitle')}</h1>
        </div>
      </div>

      {/* Page header */}
      <div className="shrink-0 px-6 pt-5">
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 truncate text-sm text-secondary">{i18nService.t('benchmarkSubtitle')}</p>
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-[13px] font-medium leading-5 text-white transition-colors hover:bg-primary-hover"
          >
            <PlusIcon className="h-4 w-4" />
            {i18nService.t('benchmarkNewRun')}
          </button>
        </div>
      </div>

      {/* Run list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-4">
        {runListStatus === 'loading' && runs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-secondary">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : runs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <ArrowLeftIcon className="h-8 w-8 rotate-180 text-secondary/40" />
            <p className="text-sm text-secondary">{i18nService.t('benchmarkRunListEmpty')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <div
                key={run.id}
                className="group flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left shadow-subtle transition hover:border-primary/50 hover:shadow-card"
                onClick={() => dispatch(selectRun(run.id))}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-foreground">
                      {run.datasetLabel}
                    </span>
                    <span className="truncate text-[13px] text-secondary">· {run.modelLabel}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor(run.status)}`}>
                      {statusLabel(run.status)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-secondary">
                    {run.total > 0 && (
                      <span>
                        {run.done}/{run.total} · ✓ {run.passed} · ✗ {run.failed}
                      </span>
                    )}
                    {run.status === BenchmarkRunStatus.Completed && run.total > 0 && (
                      <span className="text-emerald-600">{Math.round((run.passed / run.total) * 100)}%</span>
                    )}
                    <span className="flex items-center gap-3">
                      <span className="text-[10px] text-secondary/60">
                        {new Date(run.startedAt).toLocaleString()}
                      </span>
                      {run.finishedAt && (
                        <span>{formatDuration(run.finishedAt - run.startedAt)}</span>
                      )}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch(selectRun(run.id));
                    }}
                    className="rounded-md px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
                  >
                    {i18nService.t('benchmarkViewDetail')}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(run.id);
                    }}
                    className="rounded-md px-2 py-1 text-xs text-red-500/80 transition-colors hover:bg-red-500/10"
                  >
                    {i18nService.t('benchmarkDelete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
