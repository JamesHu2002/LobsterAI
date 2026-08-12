/**
 * Centralized constants for the model-eval (lm-evaluation-harness) module.
 */

// ─── Run Status ─────────────────────────────────────────────────────────────
export const ModelEvalRunStatus = {
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type ModelEvalRunStatus =
  typeof ModelEvalRunStatus[keyof typeof ModelEvalRunStatus];

// ─── Install Status ──────────────────────────────────────────────────────────
export const LmEvalInstallStatus = {
  NotInstalled: 'not_installed',
  Installing: 'installing',
  Ready: 'ready',
  Error: 'error',
} as const;
export type LmEvalInstallStatus =
  typeof LmEvalInstallStatus[keyof typeof LmEvalInstallStatus];

// ─── IPC Channels ───────────────────────────────────────────────────────────
export const ModelEvalIpc = {
  ListRuns: 'modelEval:listRuns',
  GetRun: 'modelEval:getRun',
  StartRun: 'modelEval:startRun',
  CancelRun: 'modelEval:cancelRun',
  DeleteRun: 'modelEval:deleteRun',
  EnsureInstalled: 'modelEval:ensureInstalled',
  InstallStatus: 'modelEval:installStatus',
  // push events
  RunStatusChange: 'modelEval:runStatusChange',
  ProgressUpdate: 'modelEval:progressUpdate',
  InstallProgress: 'modelEval:installProgress',
} as const;

// ─── Defaults ───────────────────────────────────────────────────────────────
export const ModelEvalDefaults = {
  /** Max generated tokens per sample. */
  maxGenToks: 512,
  numFewshot: 0,
  /** 0 = all samples. */
  limit: 0,
  /** lm-eval pinned version (installed via pip). */
  lmEvalVersion: 'lm_eval[api]==0.4.12',
  /** Wall-clock budget per run in ms. */
  timeoutMsPerRun: 30 * 60_000,
} as const;

// ─── DeepSeek endpoint ───────────────────────────────────────────────────────
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
