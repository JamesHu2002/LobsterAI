import { PlusIcon } from '@heroicons/react/24/outline';
import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import type { ModelEvalRun } from '../../../modelEval/types';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import { selectRun } from '../../store/slices/modelEvalSlice';

interface ModelEvalRunListProps {
  onCreate: () => void;
}

const STATUS_KEYS: Record<ModelEvalRun['status'], string> = {
  pending: 'modelEvalStatusPending',
  running: 'modelEvalStatusRunning',
  completed: 'modelEvalStatusCompleted',
  failed: 'modelEvalStatusFailed',
  cancelled: 'modelEvalStatusCancelled',
};

const STATUS_COLORS: Record<ModelEvalRun['status'], string> = {
  pending: 'bg-slate-500/15 text-slate-500',
  running: 'bg-blue-500/15 text-blue-500',
  completed: 'bg-emerald-500/15 text-emerald-600',
  failed: 'bg-red-500/15 text-red-500',
  cancelled: 'bg-slate-400/15 text-slate-400',
};

function formatTime(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const ModelEvalRunList: React.FC<ModelEvalRunListProps> = ({ onCreate }) => {
  const dispatch = useDispatch();
  const runs = useSelector((state: RootState) => state.modelEval.runs);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-6 py-4">
        <h2 className="text-lg font-semibold text-foreground">{i18nService.t('modelEvalTitle')}</h2>
        <button
          type="button"
          onClick={onCreate}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <PlusIcon className="h-4 w-4" />
          {i18nService.t('modelEvalNew')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        {runs.length === 0 ? (
          <div className="mt-10 text-center text-sm text-secondary">{i18nService.t('modelEvalEmpty')}</div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => dispatch(selectRun(run.id))}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left hover:bg-surface-raised"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{run.modelLabel}</div>
                  <div className="mt-0.5 text-xs text-secondary">
                    {formatTime(run.startedAt)}
                    {run.tasks.length > 0 ? ` · ${run.tasks.join(', ')}` : ''}
                  </div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[run.status]}`}>
                  {i18nService.t(STATUS_KEYS[run.status])}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
