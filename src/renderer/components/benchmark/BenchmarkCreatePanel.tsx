import React, { useState } from 'react';
import { ArrowLeftIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useSelector } from 'react-redux';
import { BenchmarkDatasetId } from '../../../benchmark/constants';
import type { BenchmarkRunConfig } from '../../../benchmark/types';
import { benchmarkService } from '../../services/benchmark';
import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import type { Model } from '../../store/slices/modelSlice';
import ModelSelector from '../ModelSelector';

interface BenchmarkCreatePanelProps {
  onBack: () => void;
}

export const BenchmarkCreatePanel: React.FC<BenchmarkCreatePanelProps> = ({ onBack }) => {
  const datasets = useSelector((state: RootState) => state.benchmark.datasets);
  const datasetStatus = useSelector((state: RootState) => state.benchmark.datasetStatus);
  const datasetLoading = useSelector((state: RootState) => state.benchmark.datasetLoading);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);

  const [selectedDataset, setSelectedDataset] = useState<BenchmarkDatasetId | null>(null);
  const [selectedModels, setSelectedModels] = useState<Model[]>([]);
  const [maxSteps, setMaxSteps] = useState(30);
  const [timeoutMin, setTimeoutMin] = useState(3);
  const [maxTasks, setMaxTasks] = useState(0);
  const [starting, setStarting] = useState(false);
  const [hfToken, setHfToken] = useState('');

  const handleSaveHfToken = () => {
    void benchmarkService.setHfToken(hfToken.trim());
  };

  const statusOf = (id: BenchmarkDatasetId) => datasetStatus[id];
  const loadingOf = (id: BenchmarkDatasetId) => datasetLoading[id] === true;

  const handleLoadDataset = async (id: BenchmarkDatasetId) => {
    setSelectedDataset(id);
    const ok = await benchmarkService.loadDataset(id, false);
    if (ok) {
      await benchmarkService.loadDatasets();
    }
  };

  const handleImportCustom = async () => {
    const res = await window.electron?.dialog?.selectFile({
      title: i18nService.t('benchmarkCustomPick'),
      filters: [
        { name: 'Dataset', extensions: ['jsonl', 'json', 'csv', 'ndjson', 'txt'] },
      ],
    });
    if (!res || !res.success || !res.path) return;
    setSelectedDataset(BenchmarkDatasetId.Custom);
    const ok = await benchmarkService.importCustomDataset(res.path);
    if (ok) {
      await benchmarkService.loadDatasets();
    }
  };

  const addModel = (model: Model) => {
    if (model && !selectedModels.some((m) => m.id === model.id)) {
      setSelectedModels([...selectedModels, model]);
    }
  };

  const removeModel = (modelId: string) => {
    setSelectedModels(selectedModels.filter((m) => m.id !== modelId));
  };

  const showToast = (message: string) => {
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
  };

  const handleStart = async () => {
    if (!selectedDataset) {
      showToast(i18nService.t('benchmarkNoDatasetLoaded'));
      return;
    }
    if (selectedModels.length === 0) {
      showToast(i18nService.t('benchmarkNoModelSelected'));
      return;
    }
    const config: BenchmarkRunConfig = {
      datasetId: selectedDataset,
      modelRefs: selectedModels.map((m) => toOpenClawModelRef(m)),
      maxSteps,
      timeoutMsPerTask: timeoutMin * 60_000,
      maxTasks: maxTasks > 0 ? maxTasks : undefined,
    };
    const labels = selectedModels.map((m) => m.name || m.id);
    setStarting(true);
    const runIds = await benchmarkService.startRun(config, labels);
    setStarting(false);
    if (runIds.length > 0) {
      onBack();
    }
  };

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
          <h1 className="text-lg font-semibold text-foreground">{i18nService.t('benchmarkNewRun')}</h1>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-5">
        {/* Dataset selection */}
        <div className="mb-6">
          <h2 className="mb-2 text-[13px] font-semibold text-foreground">{i18nService.t('benchmarkDataset')}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {datasets.map((ds) => {
              const status = statusOf(ds.id);
              const loading = loadingOf(ds.id);
              const selected = selectedDataset === ds.id;
              const cached = ds.cached || status?.cached;
              const taskCount = ds.size ?? status?.taskCount;
              return (
                <div
                  key={ds.id}
                  onClick={() => setSelectedDataset(ds.id)}
                  className={`cursor-pointer rounded-xl border p-4 transition ${
                    selected
                      ? 'border-primary/60 bg-primary/5 shadow-card'
                      : 'border-border bg-surface shadow-subtle hover:border-primary/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{ds.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        cached ? 'bg-emerald-500/10 text-emerald-600' : 'bg-surface-raised text-secondary'
                      }`}
                    >
                      {cached && taskCount != null
                        ? i18nService.t('benchmarkDatasetLoaded').replace('{n}', String(taskCount))
                        : i18nService.t('benchmarkDatasetDownload')}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-secondary">{ds.description}</p>
                  {ds.id === BenchmarkDatasetId.Gaia2023Val && (
                    <p className="mt-1 text-[11px] text-amber-600/80">{i18nService.t('benchmarkDatasetGatedHint')}</p>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    {ds.id === BenchmarkDatasetId.Custom ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleImportCustom();
                        }}
                        className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
                      >
                        <PlusIcon className="h-3 w-3" />
                        {cached
                          ? i18nService.t('benchmarkCustomReimport')
                          : i18nService.t('benchmarkCustomImport')}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleLoadDataset(ds.id);
                          }}
                          disabled={loading}
                          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                        >
                          {loading ? (
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                          ) : (
                            <PlusIcon className="h-3 w-3" />
                          )}
                          {loading
                            ? i18nService.t('benchmarkDatasetDownloading')
                            : i18nService.t('benchmarkDatasetDownload')}
                        </button>
                        {cached && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void benchmarkService.loadDataset(ds.id, true);
                            }}
                            className="rounded-md px-2 py-1 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                          >
                            {i18nService.t('benchmarkDatasetRefresh')}
                          </button>
                        )}
                      </>
                    )}
                    {ds.loadError && (
                      <span className="truncate text-[11px] text-red-500">{ds.loadError}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Model selection */}
        <div className="mb-6">
          <h2 className="mb-2 text-[13px] font-semibold text-foreground">{i18nService.t('benchmarkModel')}</h2>
          <div className="space-y-2 rounded-xl border border-border bg-surface p-4">
            {selectedModels.map((model) => (
              <div key={model.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ModelSelector
                    value={model}
                    onChange={(next) => {
                      if (next) {
                        setSelectedModels(selectedModels.map((m) => (m.id === model.id ? next : m)));
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeModel(model.id)}
                  className="shrink-0 rounded-md p-1.5 text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500"
                  aria-label={i18nService.t('benchmarkModelsRemove')}
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>
            ))}
            {availableModels.length === 0 ? (
              <p className="text-xs text-secondary">{i18nService.t('benchmarkSelectModelPlaceholder')}</p>
            ) : (
              <ModelSelector
                value={null}
                onChange={(model) => {
                  if (model) addModel(model);
                }}
                defaultLabel={`+ ${i18nService.t('benchmarkModelsAdd')}`}
              />
            )}
          </div>
        </div>

        {/* Params */}
        <div className="mb-6 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-secondary">{i18nService.t('benchmarkMaxSteps')}</span>
            <input
              type="number"
              min={1}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Math.max(1, Number(e.target.value) || 30))}
              className="h-9 w-32 rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary/60 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-secondary">{i18nService.t('benchmarkTimeoutMin')}</span>
            <input
              type="number"
              min={1}
              value={timeoutMin}
              onChange={(e) => setTimeoutMin(Math.max(1, Number(e.target.value) || 3))}
              className="h-9 w-32 rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary/60 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-secondary">{i18nService.t('benchmarkMaxTasks')}</span>
            <input
              type="number"
              min={0}
              value={maxTasks}
              onChange={(e) => setMaxTasks(Math.max(0, Number(e.target.value) || 0))}
              placeholder={i18nService.t('benchmarkMaxTasksAll')}
              className="h-9 w-32 rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary/60 focus:outline-none"
            />
          </label>
          {selectedDataset === BenchmarkDatasetId.Gaia2023Val && (
            <label className="flex min-w-[260px] flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-secondary">
                {i18nService.t('benchmarkHfToken')}
                <span className="ml-1 text-[10px] text-secondary/60">({i18nService.t('benchmarkDatasetGatedHint')})</span>
              </span>
              <input
                type="password"
                value={hfToken}
                onChange={(e) => setHfToken(e.target.value)}
                onBlur={handleSaveHfToken}
                placeholder="hf_..."
                className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary/60 focus:outline-none"
              />
            </label>
          )}
        </div>

        {/* Start */}
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={starting || !selectedDataset || selectedModels.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />}
          {i18nService.t('benchmarkStart')}
        </button>
      </div>
    </div>
  );
};
