import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { BenchmarkDatasetId } from '../../../benchmark/constants';
import { LM_EVAL_BUILTIN_TASKS } from '../../../modelEval/builtinTasks';
import { LmEvalInstallStatus } from '../../../modelEval/constants';
import type { ModelEvalRunConfig } from '../../../modelEval/types';
import { benchmarkService } from '../../services/benchmark';
import { i18nService } from '../../services/i18n';
import { modelEvalService } from '../../services/modelEval';
import type { RootState } from '../../store';

interface ModelEvalCreatePanelProps {
  onBack: () => void;
}

const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50';
const LABEL_CLASS = 'block text-[13px] font-medium leading-5 text-foreground/85 mb-1';

export const ModelEvalCreatePanel: React.FC<ModelEvalCreatePanelProps> = ({ onBack }) => {
  const datasets = useSelector((state: RootState) => state.benchmark.datasets);
  const installStatus = useSelector((state: RootState) => state.modelEval.installStatus);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);

  const [selectedDataset, setSelectedDataset] = useState<string | null>(null);
  const [builtinTask, setBuiltinTask] = useState<string | null>(null);
  const [modelRef, setModelRef] = useState('');
  const [numFewshot, setNumFewshot] = useState(0);
  const [limit, setLimit] = useState(0);
  const [maxGenToks, setMaxGenToks] = useState(512);
  const [starting, setStarting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // All enabled models (single-select); provider resolved at run time from the model's providerKey.
  const modelOptions = useMemo(() => availableModels, [availableModels]);

  useEffect(() => {
    if (!installStatus) {
      void modelEvalService.loadInstallStatus();
    }
  }, [installStatus]);

  const handleLoadDataset = async (id: string) => {
    setBuiltinTask(null);
    setSelectedDataset(id);
    await benchmarkService.loadDataset(id as BenchmarkDatasetId, false);
    await benchmarkService.loadDatasets();
  };

  const handlePickBuiltin = (group: string) => {
    setSelectedDataset(null);
    setBuiltinTask(group);
  };

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await modelEvalService.ensureInstalled();
    } finally {
      setInstalling(false);
    }
  };

  const handleStart = async () => {
    if ((!selectedDataset && !builtinTask) || !modelRef) {
      setError(i18nService.t('modelEvalSelectAll'));
      return;
    }
    if (installStatus?.status !== LmEvalInstallStatus.Ready) {
      setError(i18nService.t('modelEvalInstallFirst'));
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const selected = availableModels.find((m) => m.id === modelRef);
      const config: ModelEvalRunConfig = {
        datasetId: selectedDataset ?? '',
        ...(builtinTask ? { builtinTask } : {}),
        modelRef,
        modelLabel: selected?.name ?? modelRef,
        ...(selected?.providerKey ? { providerKey: selected.providerKey } : {}),
        numFewshot,
        limit,
        maxGenToks,
      };
      const runId = await modelEvalService.startRun(config);
      if (runId) onBack();
    } finally {
      setStarting(false);
    }
  };

  const ready = installStatus?.status === LmEvalInstallStatus.Ready;

  return (
    <div className="flex h-full min-h-0 flex-col px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-secondary hover:bg-surface-raised"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <h2 className="text-lg font-semibold text-foreground">{i18nService.t('modelEvalCreateTitle')}</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {i18nService.t('modelEvalNote')}
        </p>

        {/* Install framework */}
        <div className="flex items-center justify-between rounded-xl border border-border bg-surface p-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{i18nService.t('modelEvalInstallTitle')}</div>
            <div className="text-xs text-secondary">{i18nService.t('modelEvalInstallDesc')}</div>
          </div>
          {ready ? (
            <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600">
              {i18nService.t('modelEvalInstalled')}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void handleInstall()}
              disabled={installing}
              className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {installing
                ? i18nService.t('modelEvalInstalling')
                : i18nService.t('modelEvalInstall')}
            </button>
          )}
        </div>

        {/* Built-in lm-eval tasks */}
        <div>
          <label className={LABEL_CLASS}>{i18nService.t('modelEvalBuiltin')}</label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {LM_EVAL_BUILTIN_TASKS.map((t) => (
              <button
                key={t.group}
                type="button"
                onClick={() => handlePickBuiltin(t.group)}
                className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                  builtinTask === t.group
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border bg-surface hover:bg-surface-raised'
                }`}
              >
                <div className="text-sm font-medium text-foreground">
                  {t.label}
                  {t.needsLogprobs && (
                    <span className="ml-1 rounded bg-slate-500/15 px-1 py-0.5 text-[10px] text-secondary">logprobs</span>
                  )}
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs text-secondary">{t.desc}</div>
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-secondary">{i18nService.t('modelEvalBuiltinHint')}</p>
        </div>

        {/* Existing datasets */}
        <div>
          <label className={LABEL_CLASS}>{i18nService.t('modelEvalDataset')}</label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {datasets.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => void handleLoadDataset(d.id)}
                className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                  selectedDataset === d.id
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border bg-surface hover:bg-surface-raised'
                }`}
              >
                <div className="text-sm font-medium text-foreground">{d.label}</div>
                <div className="mt-0.5 line-clamp-2 text-xs text-secondary">{d.description}</div>
                <div className="mt-1 text-[11px] text-secondary/70">
                  {d.cached ? i18nService.t('modelEvalCached') : i18nService.t('modelEvalNotCached')}
                  {d.size ? ` · ${d.size} 题` : ''}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Model */}
        <div>
          <label className={LABEL_CLASS}>{i18nService.t('modelEvalModel')}</label>
          <select value={modelRef} onChange={(e) => setModelRef(e.target.value)} className={INPUT_CLASS}>
            <option value="">{i18nService.t('modelEvalSelectModel')}</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}（{m.provider}）
              </option>
            ))}
          </select>
          {modelOptions.length === 0 && (
            <p className="mt-1 text-xs text-red-500">{i18nService.t('modelEvalNoModels')}</p>
          )}
        </div>

        {/* Params */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={LABEL_CLASS}>{i18nService.t('modelEvalFewshot')}</label>
            <input type="number" min={0} value={numFewshot} onChange={(e) => setNumFewshot(Number(e.target.value))} className={INPUT_CLASS} />
          </div>
          <div>
            <label className={LABEL_CLASS}>{i18nService.t('modelEvalLimit')}</label>
            <input type="number" min={0} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={INPUT_CLASS} />
          </div>
          <div>
            <label className={LABEL_CLASS}>{i18nService.t('modelEvalMaxGenToks')}</label>
            <input type="number" min={16} value={maxGenToks} onChange={(e) => setMaxGenToks(Number(e.target.value))} className={INPUT_CLASS} />
          </div>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={handleStart}
          disabled={starting}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {starting ? i18nService.t('modelEvalRunning') : i18nService.t('modelEvalStart')}
        </button>
      </div>
    </div>
  );
};
