import { ArrowLeftIcon, FolderOpenIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import type { SkillFactoryRun, SkillFactorySourceRef } from '../../../skillFactory/types';
import { i18nService } from '../../services/i18n';
import { skillFactoryService } from '../../services/skillFactory';
import type { RootState } from '../../store';

interface SkillFactoryDetailViewProps {
  onBack: () => void;
  onNewChat: () => void;
}

const STATUS_KEYS: Record<SkillFactoryRun['status'], string> = {
  pending: 'skillFactoryStatusPending',
  running: 'skillFactoryStatusRunning',
  review: 'skillFactoryStatusReview',
  installed: 'skillFactoryStatusInstalled',
  needs_input: 'skillFactoryStatusNeedsInput',
  failed: 'skillFactoryStatusFailed',
  cancelled: 'skillFactoryStatusCancelled',
};

const STAGE_KEYS: Record<string, string> = {
  preparing: 'skillFactoryStagePreparing',
  requirements: 'skillFactoryStageRequirements',
  making: 'skillFactoryStageMaking',
  evaluating: 'skillFactoryStageEvaluating',
  finalizing: 'skillFactoryStageFinalizing',
};

export const SkillFactoryDetailView: React.FC<SkillFactoryDetailViewProps> = ({ onBack }) => {
  const selectedRunId = useSelector((state: RootState) => state.skillFactory.selectedRunId);
  const run = useSelector((state: RootState) =>
    state.skillFactory.runs.find((r) => r.id === state.skillFactory.selectedRunId) ?? null,
  );
  const [skillMd, setSkillMd] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [usageSessions, setUsageSessions] = useState<SkillFactorySourceRef[]>([]);
  const [optimizeRefs, setOptimizeRefs] = useState<string[]>([]);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeLoading, setOptimizeLoading] = useState(false);

  // Live-refresh while running.
  useEffect(() => {
    if (!selectedRunId) return;
    const timer = setInterval(() => {
      void skillFactoryService.fetchRun(selectedRunId);
    }, 4000);
    return () => clearInterval(timer);
  }, [selectedRunId]);

  const skillIdForOptimize = run?.installedSkillId ?? run?.skillName ?? null;

  const openOptimize = async () => {
    if (!skillIdForOptimize) return;
    setOptimizeLoading(true);
    const rows = await skillFactoryService.listSkillUsageSessions(skillIdForOptimize);
    setUsageSessions(rows);
    setOptimizeRefs(rows.map((r) => r.ref));
    setOptimizeOpen(true);
    setOptimizeLoading(false);
  };

  const startOptimize = async () => {
    if (!skillIdForOptimize || optimizeRefs.length === 0) return;
    setOptimizing(true);
    try {
      const runId = await skillFactoryService.startRun({
        name: `优化 ${run?.name ?? skillIdForOptimize}`,
        requirement: `优化已安装技能「${run?.name ?? skillIdForOptimize}」：分析以下真实使用样本，指出当前 skill 的问题并改进。`,
        docPaths: [],
        source: 'sessions',
        sourceRefs: optimizeRefs,
      });
      if (runId) setOptimizeOpen(false);
    } finally {
      setOptimizing(false);
    }
  };

  // Load the SKILL.md preview once the run reaches review/installed.
  useEffect(() => {
    if (!selectedRunId) return;
    if (run?.status === 'review' || run?.status === 'installed') {
      void skillFactoryService.getArtifact(selectedRunId, run.skillName ? `${run.skillName}/SKILL.md` : 'SKILL.md')
        .then((text) => setSkillMd(text));
    }
  }, [selectedRunId, run?.status, run?.skillName]);

  if (!run) return null;

  const handleInstall = async () => {
    setInstalling(true);
    setConfirmError(null);
    try {
      const result = await skillFactoryService.installRun(run.id);
      if (!result.success && result.needConfirm) {
        setConfirmInstall(true);
        setConfirmError(result.error ?? i18nService.t('skillFactoryInstallConfirm'));
      }
    } finally {
      setInstalling(false);
    }
  };

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
          <h2 className="truncate text-lg font-semibold text-foreground">{run.name}</h2>
          <div className="text-xs text-secondary">
            {i18nService.t(STATUS_KEYS[run.status])}
            {run.stage && <span> · {i18nService.t(STAGE_KEYS[run.stage] ?? run.stage)}</span>}
            {run.skillName && <span> · {run.skillName}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {run.outputDir && (
            <button
              type="button"
              onClick={() => void skillFactoryService.openOutputDir(run.id)}
              className="flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-secondary hover:bg-surface-raised"
            >
              <FolderOpenIcon className="h-3.5 w-3.5" />
              {i18nService.t('skillFactoryOpenDir')}
            </button>
          )}
          {(run.status === 'review' || run.status === 'installed') && (
            <button
              type="button"
              onClick={handleInstall}
              disabled={installing || run.status === 'installed'}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {run.status === 'installed'
                ? i18nService.t('skillFactoryInstalled')
                : i18nService.t('skillFactoryInstall')}
            </button>
          )}
          {skillIdForOptimize && (
            <button
              type="button"
              onClick={() => void openOptimize()}
              disabled={optimizeLoading}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-secondary hover:bg-surface-raised disabled:opacity-50"
            >
              {i18nService.t('skillFactoryOptimize')}
            </button>
          )}
        </div>
      </div>

      {optimizeOpen && (
        <div className="mb-3 rounded-xl border border-border bg-surface p-4">
          <div className="mb-2 text-sm font-medium text-foreground">
            {i18nService.t('skillFactoryOptimizeTitle')}
          </div>
          {usageSessions.length === 0 ? (
            <p className="text-xs text-secondary">{i18nService.t('skillFactoryNoUsage')}</p>
          ) : (
            <div className="max-h-[180px] space-y-1 overflow-y-auto">
              {usageSessions.map((opt) => (
                <label key={opt.ref} className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-xs">
                  <input
                    type="checkbox"
                    checked={optimizeRefs.includes(opt.ref)}
                    onChange={() => setOptimizeRefs((prev) => (prev.includes(opt.ref) ? prev.filter((r) => r !== opt.ref) : [...prev, opt.ref]))}
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
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void startOptimize()}
              disabled={optimizing || optimizeRefs.length === 0}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {optimizing ? i18nService.t('skillFactoryStarting') : i18nService.t('skillFactoryOptimizeRun')}
            </button>
            <button
              type="button"
              onClick={() => setOptimizeOpen(false)}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-secondary"
            >
              {i18nService.t('skillFactoryCancel')}
            </button>
          </div>
        </div>
      )}

      {run.lastError && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {run.lastError}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {/* Needs input: show clarifying questions */}
        {run.status === 'needs_input' && run.evalReport?.questions && (
          <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
            <div className="text-sm font-medium text-orange-700">
              {i18nService.t('skillFactoryNeedsInputTitle')}
            </div>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-orange-800">
              {run.evalReport.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-orange-600">{i18nService.t('skillFactoryNeedsInputHint')}</p>
          </div>
        )}

        {/* Eval report */}
        {run.evalReport && (
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="mb-2 text-sm font-medium text-foreground">
              {i18nService.t('skillFactoryEvalTitle')}
            </div>
            {run.evalReport.scores && (
              <div className="mb-2 flex flex-wrap gap-2">
                {Object.entries(run.evalReport.scores).map(([dim, score]) => (
                  <span key={dim} className="rounded-md bg-surface-raised px-2 py-1 text-xs text-secondary">
                    {dim}: <span className="font-medium text-foreground">{score}</span>
                  </span>
                ))}
              </div>
            )}
            {run.evalReport.summary && (
              <p className="text-xs text-secondary">{run.evalReport.summary}</p>
            )}
            {run.evalReport.issues && run.evalReport.issues.length > 0 && (
              <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-secondary">
                {run.evalReport.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Security findings */}
        {run.securityReport && run.securityReport.riskLevel && (
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="mb-1 text-sm font-medium text-foreground">
              {i18nService.t('skillFactorySecurityTitle')} · {run.securityReport.riskLevel}
            </div>
            {Array.isArray(run.securityReport.findings) && run.securityReport.findings.length > 0 && (
              <ul className="list-inside list-disc space-y-1 text-xs text-secondary">
                {run.securityReport.findings.map((f, i) => (
                  <li key={i}>{f.file} — {f.ruleId}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* SKILL.md preview */}
        {skillMd ? (
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="mb-2 text-sm font-medium text-foreground">{i18nService.t('skillFactoryPreview')}</div>
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-background p-3 font-mono text-xs leading-relaxed text-foreground/90">
              {skillMd.slice(0, 20000)}
            </pre>
          </div>
        ) : run.status === 'review' || run.status === 'installed' ? (
          <div className="rounded-xl border border-border bg-surface p-4 text-xs text-secondary">
            {i18nService.t('skillFactoryNoPreview')}
          </div>
        ) : null}

        {/* Install confirm for non-safe skills */}
        {confirmInstall && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <div className="text-sm font-medium text-amber-700">
              {i18nService.t('skillFactoryInstallConfirmTitle')}
            </div>
            {confirmError && <p className="mt-1 text-xs text-amber-700">{confirmError}</p>}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={installing}
                onClick={() => void handleInstall()}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {i18nService.t('skillFactoryInstallAnyway')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmInstall(false)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-secondary"
              >
                {i18nService.t('skillFactoryCancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
