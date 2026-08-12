import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import type { ModelEvalRun } from '../../../modelEval/types';
import { i18nService } from '../../services/i18n';
import { modelEvalService } from '../../services/modelEval';
import type { RootState } from '../../store';

interface ModelEvalDetailViewProps {
  onBack: () => void;
}

const STATUS_KEYS: Record<ModelEvalRun['status'], string> = {
  pending: 'modelEvalStatusPending',
  running: 'modelEvalStatusRunning',
  completed: 'modelEvalStatusCompleted',
  failed: 'modelEvalStatusFailed',
  cancelled: 'modelEvalStatusCancelled',
};

export const ModelEvalDetailView: React.FC<ModelEvalDetailViewProps> = ({ onBack }) => {
  const selectedRunId = useSelector((state: RootState) => state.modelEval.selectedRunId);
  const run = useSelector((state: RootState) =>
    state.modelEval.runs.find((r) => r.id === state.modelEval.selectedRunId) ?? null,
  );
  const taskResults = useSelector((state: RootState) => state.modelEval.taskResults);
  const [samplesOpen, setSamplesOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!selectedRunId) return;
    void modelEvalService.loadTaskResults(selectedRunId);
    const timer = setInterval(() => {
      void modelEvalService.fetchRun(selectedRunId);
      void modelEvalService.loadTaskResults(selectedRunId);
    }, 4000);
    return () => clearInterval(timer);
  }, [selectedRunId]);

  if (!run) return null;

  return (
    <div className="flex h-full min-h-0 flex-col px-6 py-5">
      <div className="mb-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-secondary hover:bg-surface-raised"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-foreground">{run.modelLabel}</h2>
          <div className="text-xs text-secondary">
            {run.tasks.join(', ') || '—'} · {i18nService.t(STATUS_KEYS[run.status])}
          </div>
        </div>
        {run.status === 'running' && (
          <button
            type="button"
            onClick={() => void modelEvalService.cancelRun(run.id)}
            className="shrink-0 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-secondary hover:bg-surface-raised"
          >
            {i18nService.t('modelEvalCancel')}
          </button>
        )}
      </div>

      {run.error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{run.error}</div>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {taskResults.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-4 text-xs text-secondary">
            {i18nService.t('modelEvalNoResults')}
          </div>
        ) : (
          taskResults.map((tr) => (
            <div key={tr.taskId} className="rounded-xl border border-border bg-surface p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{tr.taskId}</span>
              </div>
              <div className="flex flex-wrap gap-3">
                <Score label="exact_match" value={tr.exactMatch} />
                <Score label="f1" value={tr.f1} />
                <Score label="gaia_exact" value={tr.gaiaExact} />
                <Score label="gaia_containment" value={tr.gaiaContainment} />
              </div>
              {tr.samples.length > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setSamplesOpen((s) => ({ ...s, [tr.taskId]: !s[tr.taskId] }))}
                    className="text-xs text-secondary hover:text-foreground"
                  >
                    {samplesOpen[tr.taskId] ? i18nService.t('modelEvalHideSamples') : i18nService.t('modelEvalShowSamples')}
                  </button>
                  {samplesOpen[tr.taskId] && (
                    <div className="mt-2 max-h-[360px] space-y-2 overflow-y-auto">
                      {tr.samples.map((s, i) => (
                        <div key={i} className="rounded-md bg-surface-raised p-2 text-xs">
                          <div className="text-secondary">Q: {(s.prompt ?? '').slice(0, 300)}</div>
                          <div className="mt-1 text-secondary">A: {(s.answer ?? '').slice(0, 200)}</div>
                          <div className="mt-1 text-foreground/80">→ {(s.continuation ?? '').slice(0, 300)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

function Score({ label, value }: { label: string; value: number | null }) {
  const v = typeof value === 'number' ? (value * 100).toFixed(1) + '%' : '—';
  return (
    <span className="rounded-md bg-surface-raised px-2 py-1 text-xs text-secondary">
      {label}: <span className="font-medium text-foreground">{v}</span>
    </span>
  );
}
