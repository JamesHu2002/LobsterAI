import type {
  BenchmarkDatasetId,
  BenchmarkMatchMethod,
  BenchmarkRunStatus,
  BenchmarkTaskStatus,
} from './constants';

// ─── Tasks ───────────────────────────────────────────────────────────────────
export interface BenchmarkTask {
  id: string;
  datasetId: BenchmarkDatasetId;
  prompt: string;
  referenceAnswer?: string | null;
  category?: string | null;
  extra?: Record<string, unknown>;
}

// ─── Run Config / Run ────────────────────────────────────────────────────────
export interface BenchmarkRunConfig {
  datasetId: BenchmarkDatasetId;
  /** One entry per selected model, rendered via toOpenClawModelRef(). */
  modelRefs: string[];
  maxSteps?: number;
  timeoutMsPerTask?: number;
  /** Optional task subset; defaults to the full dataset. */
  taskIds?: string[];
}

export interface BenchmarkRun {
  id: string;
  datasetId: BenchmarkDatasetId;
  datasetLabel: string;
  modelRef: string;
  modelLabel: string;
  config: BenchmarkRunConfig;
  status: BenchmarkRunStatus;
  total: number;
  done: number;
  passed: number;
  failed: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

// ─── Task Result / Metrics ───────────────────────────────────────────────────
export interface TaskMetrics {
  /** Assistant rounds containing at least one tool_use. */
  steps: number;
  /** Total tool_use messages. */
  toolCallCount: number;
  toolCallNames: Record<string, number>;
  /** tool_result messages with error=true. */
  invalidToolCalls: number;
  invalidCallRate: number;
  /** Fraction of tool calls targeting tools within the eval toolset. */
  toolSelectionAccuracy: number | null;
  /** Fraction of tool calls whose arguments passed a minimal schema check. */
  paramAccuracy: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  executionTimeMs: number;
  /** 0..1; 1 when no tool errors occurred. */
  recoverability: number;
}

export interface BenchmarkMatch {
  method: BenchmarkMatchMethod;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface BenchmarkTaskResult {
  id: string;
  runId: string;
  task: BenchmarkTask;
  status: BenchmarkTaskStatus;
  sessionKey: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  metrics: TaskMetrics;
  match?: BenchmarkMatch | null;
  error: string | null;
}

// ─── Report ──────────────────────────────────────────────────────────────────
export interface BenchmarkReport {
  runId: string;
  total: number;
  attempted: number;
  passed: number;
  successRate: number;
  avgTokens: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCacheReadTokens: number;
  avgSteps: number;
  avgToolCalls: number;
  invalidCallRate: number;
  toolSelectionAccuracy: number | null;
  paramAccuracy: number | null;
  recoverability: number;
  totalCostUsd: number;
  avgCostUsd: number;
  totalDurationMs: number;
  avgDurationMs: number;
  byStatus: Record<BenchmarkTaskStatus, number>;
}

// ─── Datasets ────────────────────────────────────────────────────────────────
export interface BenchmarkDatasetInfo {
  id: BenchmarkDatasetId;
  label: string;
  description: string;
  size?: number;
  cached: boolean;
  lastLoadedAt?: number;
  loadError?: string | null;
}

export interface DatasetStatus {
  cached: boolean;
  taskCount: number | null;
  lastLoadedAt: number | null;
  loadError: string | null;
  loading: boolean;
}

export type DatasetLoadPhase =
  | 'downloading'
  | 'parsing'
  | 'done'
  | 'error';

export interface DatasetLoadProgressEvent {
  datasetId: BenchmarkDatasetId;
  bytes: number;
  totalBytes: number | null;
  phase: DatasetLoadPhase;
  message?: string;
}

// ─── Progress Events ─────────────────────────────────────────────────────────
export interface BenchmarkProgressUpdateEvent {
  runId: string;
  done: number;
  total: number;
  passed: number;
  failed: number;
}

export type BenchmarkRunnerEvent =
  | { type: 'progress'; payload: BenchmarkProgressUpdateEvent }
  | { type: 'taskCompleted'; payload: BenchmarkTaskResult }
  | { type: 'runStatusChange'; payload: BenchmarkRun };

// ─── View ────────────────────────────────────────────────────────────────────
export type BenchmarkViewMode = 'list' | 'create' | 'detail';
