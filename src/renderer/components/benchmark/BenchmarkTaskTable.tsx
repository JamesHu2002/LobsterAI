import React from 'react';
import { BenchmarkTaskStatus } from '../../../benchmark/constants';
import type { BenchmarkTaskResult } from '../../../benchmark/types';
import { i18nService } from '../../services/i18n';

interface BenchmarkTaskTableProps {
  results: BenchmarkTaskResult[];
  hasMore: boolean;
  onLoadMore: () => void;
}

function statusLabel(status: BenchmarkTaskResult['status']): string {
  const keyMap: Record<string, string> = {
    [BenchmarkTaskStatus.Passed]: 'benchmarkStatusPassed',
    [BenchmarkTaskStatus.Failed]: 'benchmarkStatusFailedShort',
    [BenchmarkTaskStatus.Error]: 'benchmarkStatusError',
    [BenchmarkTaskStatus.Timeout]: 'benchmarkStatusTimeout',
    [BenchmarkTaskStatus.MaxSteps]: 'benchmarkStatusMaxSteps',
    [BenchmarkTaskStatus.Skipped]: 'benchmarkStatusSkipped',
    [BenchmarkTaskStatus.Cancelled]: 'benchmarkStatusCancelledShort',
  };
  return i18nService.t(keyMap[status] ?? 'benchmarkStatusError');
}

function statusColor(status: BenchmarkTaskResult['status']): string {
  switch (status) {
    case BenchmarkTaskStatus.Passed:
      return 'text-emerald-600';
    case BenchmarkTaskStatus.Failed:
      return 'text-red-500';
    default:
      return 'text-secondary';
  }
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null) return '—';
  if (v === 0) return '0';
  return v.toFixed(digits);
}

function fmtPercent(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export const BenchmarkTaskTable: React.FC<BenchmarkTaskTableProps> = ({
  results,
  hasMore,
  onLoadMore,
}) => {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead>
            <tr className="border-b border-border bg-surface-raised/50 text-[11px] text-secondary">
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">—</th>
              <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkSteps')}</th>
              <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkAvgToolCalls')}</th>
              <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkInvalidCallRate')}</th>
              <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkTokens')}</th>
              <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkCost')}</th>
              <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkDuration')}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-surface-raised/30">
                <td className="px-3 py-2 text-secondary">{i + 1}</td>
                <td className={`px-3 py-2 font-medium ${statusColor(r.status)}`}>{statusLabel(r.status)}</td>
                <td className="px-3 py-2">{r.metrics.steps}</td>
                <td className="px-3 py-2">{r.metrics.toolCallCount}</td>
                <td className="px-3 py-2">{fmtPercent(r.metrics.invalidCallRate)}</td>
                <td className="px-3 py-2">{fmt(r.metrics.totalTokens, 0)}</td>
                <td className="px-3 py-2">{fmtCost(r.metrics.estimatedCostUsd)}</td>
                <td className="px-3 py-2">{(r.durationMs / 1000).toFixed(1)}s</td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-secondary">
                  —
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="flex justify-center border-t border-border/60 py-2">
          <button
            type="button"
            onClick={onLoadMore}
            className="rounded-md px-3 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
};
