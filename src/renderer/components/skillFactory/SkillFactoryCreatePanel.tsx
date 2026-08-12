import { ArrowLeftIcon, DocumentPlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import type { SkillFactorySource, SkillFactorySourceRef } from '../../../skillFactory/types';
import { i18nService } from '../../services/i18n';
import { skillFactoryService } from '../../services/skillFactory';

interface SkillFactoryCreatePanelProps {
  onBack: () => void;
}

const SOURCE_KEYS: Array<{ value: SkillFactorySource; label: string }> = [
  { value: 'manual', label: 'skillFactorySourceManual' },
  { value: 'sessions', label: 'skillFactorySourceSessions' },
  { value: 'runs', label: 'skillFactorySourceRuns' },
  { value: 'im', label: 'skillFactorySourceIm' },
];

export const SkillFactoryCreatePanel: React.FC<SkillFactoryCreatePanelProps> = ({ onBack }) => {
  const [name, setName] = useState('');
  const [source, setSource] = useState<SkillFactorySource>('manual');
  const [requirement, setRequirement] = useState('');
  const [docs, setDocs] = useState<string[]>([]);
  const [sourceOptions, setSourceOptions] = useState<SkillFactorySourceRef[]>([]);
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source === 'manual') return;
    let cancelled = false;
    (source === 'sessions'
      ? skillFactoryService.listSessions()
      : source === 'runs'
        ? skillFactoryService.listWorkflowRuns()
        : skillFactoryService.listImConversations()
    ).then((rows) => {
      if (!cancelled) setSourceOptions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const handlePickDocs = async () => {
    const res = await window.electron?.dialog?.selectFiles({
      title: i18nService.t('skillFactoryPickDocs'),
      filters: [
        { name: 'Documents', extensions: ['md', 'txt', 'json', 'yaml', 'yml', 'pdf', 'docx'] },
      ],
    });
    if (!res || !res.success || !res.paths || res.paths.length === 0) return;
    setDocs((prev) => [...new Set([...prev, ...res.paths])]);
  };

  const toggleRef = (ref: string) => {
    setSelectedRefs((prev) => (prev.includes(ref) ? prev.filter((r) => r !== ref) : [...prev, ref]));
  };

  const handleStart = async () => {
    if (source === 'manual' && !requirement.trim()) {
      setError(i18nService.t('skillFactoryRequirementRequired'));
      return;
    }
    if (source !== 'manual' && selectedRefs.length === 0) {
      setError(i18nService.t('skillFactorySourceRequired'));
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const runId = await skillFactoryService.startRun({
        name: name.trim() || '未命名技能',
        requirement: requirement.trim(),
        docPaths: docs,
        source,
        sourceRefs: selectedRefs,
      });
      if (runId) onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50';
  const labelClass = 'block text-[13px] font-medium leading-5 text-foreground/85 mb-1';

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
        <h2 className="text-lg font-semibold text-foreground">{i18nService.t('skillFactoryCreateTitle')}</h2>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div>
          <label className={labelClass}>{i18nService.t('skillFactoryName')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder={i18nService.t('skillFactoryNamePlaceholder')}
          />
        </div>

        {/* Source switcher */}
        <div>
          <label className={labelClass}>{i18nService.t('skillFactorySource')}</label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SOURCE_KEYS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setSource(opt.value);
                  setSelectedRefs([]);
                  setError(null);
                }}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  source === opt.value
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border bg-surface text-secondary hover:bg-surface-raised'
                }`}
              >
                {i18nService.t(opt.label)}
              </button>
            ))}
          </div>
          {source !== 'manual' && (
            <p className="mt-1 text-xs text-secondary">{i18nService.t('skillFactorySourceHint')}</p>
          )}
        </div>

        {source === 'manual' ? (
          <>
            <div>
              <label className={labelClass}>
                {i18nService.t('skillFactoryRequirement')}
                <span className="ml-0.5 text-red-500">*</span>
              </label>
              <textarea
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                className={`${inputClass} min-h-[180px] resize-y`}
                placeholder={i18nService.t('skillFactoryRequirementPlaceholder')}
              />
            </div>

            <div>
              <label className={labelClass}>{i18nService.t('skillFactoryDocs')}</label>
              <button
                type="button"
                onClick={handlePickDocs}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface/50 px-3 py-3 text-sm text-secondary hover:bg-surface"
              >
                <DocumentPlusIcon className="h-4 w-4" />
                {i18nService.t('skillFactoryAddDocs')}
              </button>
              {docs.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {docs.map((doc) => (
                    <li key={doc} className="flex items-center gap-2 rounded-md bg-surface px-2 py-1 text-xs text-secondary">
                      <span className="min-w-0 flex-1 truncate">{doc}</span>
                      <button
                        type="button"
                        onClick={() => setDocs((prev) => prev.filter((d) => d !== doc))}
                        className="shrink-0 text-secondary/60 hover:text-red-400"
                      >
                        <XMarkIcon className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <div>
            <label className={labelClass}>{i18nService.t('skillFactoryPickSamples')}</label>
            {sourceOptions.length === 0 ? (
              <p className="rounded-lg border border-border bg-surface px-3 py-3 text-xs text-secondary">
                {i18nService.t('skillFactoryNoSamples')}
              </p>
            ) : (
              <div className="max-h-[300px] space-y-1 overflow-y-auto">
                {sourceOptions.map((opt) => (
                  <label
                    key={opt.ref}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs hover:bg-surface-raised"
                  >
                    <input
                      type="checkbox"
                      checked={selectedRefs.includes(opt.ref)}
                      onChange={() => toggleRef(opt.ref)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{opt.title}</span>
                      {opt.subtitle && <span className="block truncate text-secondary">{opt.subtitle}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-secondary">{i18nService.t('skillFactorySamplesHint')}</p>
          </div>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={handleStart}
          disabled={starting}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {starting ? i18nService.t('skillFactoryStarting') : i18nService.t('skillFactoryStart')}
        </button>
      </div>
    </div>
  );
};
