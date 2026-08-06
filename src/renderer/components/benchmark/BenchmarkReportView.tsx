import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useSelector } from 'react-redux';
import { BenchmarkRunStatus } from '../../../benchmark/constants';
import { benchmarkService } from '../../services/benchmark';
import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import { BenchmarkTaskTable } from './BenchmarkTaskTable';

interface BenchmarkReportViewProps {
  onBack: () => void;
  onNewChat: () => void;
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

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

const StatCard: React.FC<{ label: string; value: string; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div className={`rounded-xl border bg-surface p-3 ${highlight ? 'border-primary/50 shadow-card' : 'border-border shadow-subtle'}`}>
    <div className="text-[11px] text-secondary">{label}</div>
    <div className={`mt-1 text-lg font-semibold ${highlight ? 'text-primary' : 'text-foreground'}`}>{value}</div>
  </div>
);

export const BenchmarkReportView: React.FC<BenchmarkReportViewProps> = ({ onBack }) => {
  const selectedRunId = useSelector((state: RootState) => state.benchmark.selectedRunId);
  const runs = useSelector((state: RootState) => state.benchmark.runs);
  const report = useSelector((state: RootState) => state.benchmark.report);
  const taskResults = useSelector((state: RootState) => state.benchmark.taskResults);
  const taskResultsTotal = useSelector((state: RootState) => state.benchmark.taskResultsTotal);
  const taskResultsHasMore = useSelector((state: RootState) => state.benchmark.taskResultsHasMore);
  const [loading, setLoading] = useState(false);
  const loadedRunRef = useRef<string | null>(null);

  const run = runs.find((r) => r.id === selectedRunId) ?? null;
  const isRunning = run?.status === BenchmarkRunStatus.Running || run?.status === BenchmarkRunStatus.Pending;

  const load = useCallback(async () => {
    if (!selectedRunId) return;
    setLoading(true);
    await benchmarkService.loadReport(selectedRunId);
    await benchmarkService.loadTaskResults(selectedRunId, 50, 0, false);
    loadedRunRef.current = selectedRunId;
    setLoading(false);
  }, [selectedRunId]);

  useEffect(() => {
    if (selectedRunId && loadedRunRef.current !== selectedRunId) {
      void load();
    }
  }, [selectedRunId, load, isRunning]);

  // While running, poll the report periodically.
  useEffect(() => {
    if (!isRunning || !selectedRunId) return;
    const timer = setInterval(() => {
      void benchmarkService.loadReport(selectedRunId);
    }, 5000);
    return () => clearInterval(timer);
  }, [isRunning, selectedRunId]);

  const handleLoadMore = async () => {
    if (!selectedRunId) return;
    const hasMore = await benchmarkService.loadTaskResults(selectedRunId, 50, taskResults.length, true);
    if (!hasMore) {
      // noop
    }
  };

  const handleStop = async () => {
    if (selectedRunId) await benchmarkService.cancelRun(selectedRunId);
  };

  // Multi-model comparison: all runs sharing the same dataset.
  const siblingRuns = run ? runs.filter((r) => r.datasetId === run.datasetId) : [];

  const progressPct = run && run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;

  return (
    <div data-skin-management-page="true" className="relative z-10 flex h-full flex-col bg-background">
      {/* Header */}
      <div className="draggable flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="non-draggable rounded-lg p-2 text-secondary transition-colors hover:bg-surface-raised"
            aria-label={i18nService.t('benchmarkBackToList')}
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold text-foreground">
            {run ? `${run.datasetLabel} · ${run.modelLabel}` : i18nService.t('benchmarkTitle')}
          </h1>
        </div>
        {isRunning && (
          <button
            type="button"
            onClick={() => void handleStop()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/20"
          >
            <XMarkIcon className="h-3.5 w-3.5" />
            {i18nService.t('benchmarkStop')}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-5">
        {!run ? (
          <p className="text-sm text-secondary">—</p>
        ) : (
          <>
            {/* Progress while running */}
            {isRunning && (
              <div className="mb-6 rounded-xl border border-border bg-surface p-4">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">
                    {i18nService.t('benchmarkProgressDone')
                      .replace('{done}', String(run.done))
                      .replace('{total}', String(run.total))
                      .replace('{passed}', String(run.passed))
                      .replace('{failed}', String(run.failed))}
                  </span>
                  <span className="text-secondary">{progressPct}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Stat cards */}
            {report && (
              <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
                <StatCard label={i18nService.t('benchmarkSuccessRate')} value={fmtPercent(report.successRate)} highlight />
                <StatCard label={i18nService.t('benchmarkAvgToolCalls')} value={report.avgToolCalls.toFixed(1)} />
                <StatCard label={i18nService.t('benchmarkInvalidCallRate')} value={fmtPercent(report.invalidCallRate)} />
                <StatCard label={i18nService.t('benchmarkToolAccuracy')} value={fmtPercent(report.toolSelectionAccuracy)} />
                <StatCard label={i18nService.t('benchmarkParamAccuracy')} value={fmtPercent(report.paramAccuracy)} />
                <StatCard label={i18nService.t('benchmarkRecoverability')} value={fmtPercent(report.recoverability)} />
                <StatCard label={i18nService.t('benchmarkAvgTokens')} value={String(Math.round(report.avgTokens))} />
                <StatCard label={i18nService.t('benchmarkAvgSteps')} value={report.avgSteps.toFixed(1)} />
                <StatCard label={i18nService.t('benchmarkAvgCost')} value={fmtCost(report.avgCostUsd)} />
                <StatCard label={i18nService.t('benchmarkAvgDuration')} value={fmtDuration(report.avgDurationMs)} />
              </div>
            )}

            {/* Model comparison */}
            {report && siblingRuns.length > 1 && (
              <div className="mb-6">
                <h2 className="mb-2 text-[13px] font-semibold text-foreground">{i18nService.t('benchmarkCompareModels')}</h2>
                <div className="overflow-x-auto rounded-xl border border-border bg-surface">
                  <table className="w-full min-w-[640px] text-left text-xs">
                    <thead>
                      <tr className="border-b border-border bg-surface-raised/50 text-[11px] text-secondary">
                        <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkModel')}</th>
                        <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkSuccessRate')}</th>
                        <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkAvgToolCalls')}</th>
                        <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkInvalidCallRate')}</th>
                        <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkToolAccuracy')}</th>
                        <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkParamAccuracy')}</th>
                        <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkRecoverability')}</th>
                        <th className="px-3 py-2 font-medium">{i18nService.t('benchmarkAvgCost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {siblingRuns.map((r) => {
                        const reportForRun = r.id === run.id ? report : undefined;
                        // For sibling runs, fetch their reports lazily is skipped in MVP.
                        const success = r.id === run.id && report
                          ? fmtPercent(report.successRate)
                          : r.total > 0 ? `${Math.round((r.passed / r.total) * 100)}%` : '—';
                        return (
                          <tr key={r.id} className={`border-b border-border/60 last:border-0 ${r.id === run.id ? 'bg-primary/5' : ''}`}>
                            <td className="px-3 py-2 font-medium text-foreground">{r.modelLabel}</td>
                            <td className="px-3 py-2">{success}</td>
                            <td className="px-3 py-2">{reportForRun ? reportForRun.avgToolCalls.toFixed(1) : '—'}</td>
                            <td className="px-3 py-2">{reportForRun ? fmtPercent(reportForRun.invalidCallRate) : '—'}</td>
                            <td className="px-3 py-2">{reportForRun ? fmtPercent(reportForRun.toolSelectionAccuracy) : '—'}</td>
                            <td className="px-3 py-2">{reportForRun ? fmtPercent(reportForRun.paramAccuracy) : '—'}</td>
                            <td className="px-3 py-2">{reportForRun ? fmtPercent(reportForRun.recoverability) : '—'}</td>
                            <td className="px-3 py-2">{reportForRun ? fmtCost(reportForRun.avgCostUsd) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Task table */}
            <div>
              <h2 className="mb-2 text-[13px] font-semibold text-foreground">
                {`Tasks (${taskResultsTotal})`}
              </h2>
              <BenchmarkTaskTable
                results={taskResults}
                hasMore={taskResultsHasMore}
                onLoadMore={() => void handleLoadMore()}
              />
            </div>

            {loading && <div className="mt-4 flex justify-center"><div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>}
          </>
        )}
      </div>
    </div>
  );
};
