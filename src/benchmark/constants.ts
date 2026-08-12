/**
 * Centralized constants for the benchmark (model evaluation) module.
 *
 * Every dataset id, run status, task status, IPC channel name, default value
 * and magic string lives here as an `as const` object. Types are derived from
 * these objects so that values and types share a single source of truth.
 */

// ─── Dataset Ids ─────────────────────────────────────────────────────────────
export const BenchmarkDatasetId = {
  Gaia2023Val: 'gaia2023val',
  AgentBenchLateral: 'agentbench-lateral',
  /** User-imported dataset; at most one active (the latest import). */
  Custom: 'custom',
} as const;
export type BenchmarkDatasetId =
  typeof BenchmarkDatasetId[keyof typeof BenchmarkDatasetId];

// ─── Run Status ──────────────────────────────────────────────────────────────
export const BenchmarkRunStatus = {
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Partial: 'partial',
} as const;
export type BenchmarkRunStatus =
  typeof BenchmarkRunStatus[keyof typeof BenchmarkRunStatus];

// ─── Task Status ─────────────────────────────────────────────────────────────
export const BenchmarkTaskStatus = {
  Passed: 'passed',
  Failed: 'failed',
  Error: 'error',
  Timeout: 'timeout',
  MaxSteps: 'max_steps',
  Skipped: 'skipped',
  Cancelled: 'cancelled',
} as const;
export type BenchmarkTaskStatus =
  typeof BenchmarkTaskStatus[keyof typeof BenchmarkTaskStatus];

// ─── Defaults ────────────────────────────────────────────────────────────────
export const BenchmarkDefaults = {
  /** Max tool-calling assistant rounds per task before abort. */
  maxSteps: 30,
  /** Wall-clock budget per task in ms. */
  timeoutMsPerTask: 180_000,
  /** Gateway handshake timeout in ms. */
  gatewayReadyTimeoutMs: 60_000,
  /** chat.send request timeout in ms. */
  chatSendTimeoutMs: 90_000,
  /** Fallback price in USD per 1M tokens. */
  fallbackPrice: { in: 3, out: 15, read: 0.3, write: 3.75 },
} as const;

/**
 * The eval-enabled lightweight toolset. Tool-selection accuracy is computed
 * against this set: a tool call to any name outside it counts against the
 * model's tool-selection score (detects hallucinated or off-target tools).
 * Names follow the OpenClaw gateway's tool identifiers.
 */
export const EvalToolset = [
  'web_search',
  'web_fetch',
  'http_get',
  'url_fetch',
  'fetch_url',
  'tavily',
  'duckduckgo',
  'browser',
  'bash',
  'shell',
  'terminal',
  'python',
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'datetime',
  'calculate',
  'calculator',
] as const;

// ─── Answer Matching ─────────────────────────────────────────────────────────
export const BenchmarkMatchMethod = {
  Exact: 'exact',
  GaiaNormalized: 'gaia_normalized',
  NormalizedContainment: 'normalized_containment',
  None: 'none',
} as const;
export type BenchmarkMatchMethod =
  typeof BenchmarkMatchMethod[keyof typeof BenchmarkMatchMethod];

// ─── Dataset Source Config ───────────────────────────────────────────────────
export const DatasetSource = {
  /** HF base URL for GAIA. huggingface.co is unreliable in some networks, so
   *  default to the public mirror. Overridable via app_config if needed. */
  hfBaseUrl: 'https://hf-mirror.com',
  gaiaRepo: 'gaia-benchmark/GAIA',
  // GAIA metadata is now parquet-backed; the former metadata.jsonl no longer exists.
  gaiaValidationMetadataPath: '2023/validation/metadata.parquet',
  /** GitHub raw for AgentBench LTP data, proxied through the same mirror used
   *  for git operations because raw.githubusercontent.com is unreachable. */
  agentBenchRepo: 'THUDM/AgentBench',
  agentBenchLtpDir: 'data/lateralthinkingpuzzle',
  ghRawBaseUrl: 'https://ghproxy.net/https://raw.githubusercontent.com',
} as const;

// ─── IPC Channels ────────────────────────────────────────────────────────────
export const IpcChannel = {
  ListRuns: 'benchmark:listRuns',
  GetRun: 'benchmark:getRun',
  StartRun: 'benchmark:startRun',
  CancelRun: 'benchmark:cancelRun',
  DeleteRun: 'benchmark:deleteRun',
  ListTaskResults: 'benchmark:listTaskResults',
  GetReport: 'benchmark:getReport',
  DatasetList: 'benchmark:datasetList',
  DatasetGetStatus: 'benchmark:datasetGetStatus',
  DatasetLoad: 'benchmark:datasetLoad',
  SetHfToken: 'benchmark:setHfToken',
  ImportCustomDataset: 'benchmark:importCustomDataset',
  // push events
  ProgressUpdate: 'benchmark:progressUpdate',
  TaskCompleted: 'benchmark:taskCompleted',
  RunStatusChange: 'benchmark:runStatusChange',
  DatasetLoadProgress: 'benchmark:datasetLoadProgress',
} as const;
