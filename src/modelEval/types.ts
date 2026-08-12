import type {
  LmEvalInstallStatus,
  ModelEvalRunStatus,
} from './constants';

// ─── Run Config / Run ───────────────────────────────────────────────────────
export interface ModelEvalRunConfig {
  /** Dataset id: gaia2023val | agentbench-lateral | custom (used when not builtinTask). */
  datasetId: string;
  /** lm-eval built-in task/group name (e.g. 'gsm8k', 'mmlu'); when set, datasetId is ignored. */
  builtinTask?: string;
  modelRef: string;
  modelLabel: string;
  /** Provider key (e.g. 'deepseek', 'qwen-local') used to resolve the model endpoint. */
  providerKey?: string;
  numFewshot?: number;
  limit?: number;
  maxGenToks?: number;
}

export interface ModelEvalRun {
  id: string;
  modelRef: string;
  modelLabel: string;
  config: ModelEvalRunConfig;
  status: ModelEvalRunStatus;
  /** Task names this run evaluated (e.g. ['gaia2023val']). */
  tasks: string[];
  total: number;
  outputDir: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

// ─── Task Result ────────────────────────────────────────────────────────────
export interface ModelEvalTaskResult {
  runId: string;
  taskId: string;
  exactMatch: number | null;
  f1: number | null;
  gaiaExact: number | null;
  gaiaContainment: number | null;
  /** Per-sample rows (doc/resps/continuation), capped. */
  samples: ModelEvalSample[];
}

export interface ModelEvalSample {
  docId?: number;
  prompt?: string;
  answer?: string;
  continuation?: string;
  filteredResp?: string;
  exactMatch?: boolean;
}

// ─── Install Status ──────────────────────────────────────────────────────────
export interface LmEvalInstallInfo {
  status: LmEvalInstallStatus;
  version?: string;
  installedAt?: number;
  error?: string;
}

export interface LmEvalInstallProgressEvent {
  phase: 'downloading' | 'done' | 'error';
  message?: string;
}

// ─── Events / View ──────────────────────────────────────────────────────────
export type ModelEvalRunnerEvent =
  | { type: 'runStatusChange'; payload: ModelEvalRun }
  | { type: 'progress'; payload: { runId: string; message?: string } }
  | { type: 'installProgress'; payload: LmEvalInstallProgressEvent };

export type ModelEvalViewMode = 'list' | 'create' | 'detail';
