/**
 * Centralized constants for the skill-factory (multi-agent skill authoring) module.
 *
 * Mirrors the benchmark module: every run status, stage, IPC channel name and
 * default lives here as an `as const` object so values and types share a single
 * source of truth.
 */

// ─── Run Status ─────────────────────────────────────────────────────────────
export const SkillFactoryRunStatus = {
  Pending: 'pending',
  Running: 'running',
  /** Pipeline finished; output is ready for review (and optional install). */
  Review: 'review',
  Installed: 'installed',
  /** Requirements analyst asked clarifying questions; the run is paused for input. */
  NeedsInput: 'needs_input',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type SkillFactoryRunStatus =
  typeof SkillFactoryRunStatus[keyof typeof SkillFactoryRunStatus];

// ─── Run Stage (coarse progress) ────────────────────────────────────────────
export const SkillFactoryStage = {
  Preparing: 'preparing',
  Requirements: 'requirements',
  Making: 'making',
  Evaluating: 'evaluating',
  Finalizing: 'finalizing',
} as const;
export type SkillFactoryStage =
  typeof SkillFactoryStage[keyof typeof SkillFactoryStage];

// ─── IPC Channels ───────────────────────────────────────────────────────────
export const SkillFactoryIpc = {
  ListRuns: 'skillFactory:listRuns',
  GetRun: 'skillFactory:getRun',
  StartRun: 'skillFactory:startRun',
  CancelRun: 'skillFactory:cancelRun',
  DeleteRun: 'skillFactory:deleteRun',
  InstallRun: 'skillFactory:installRun',
  OpenOutputDir: 'skillFactory:openOutputDir',
  /** Read a file from the run's output dir (e.g. SKILL.md preview). */
  GetArtifact: 'skillFactory:getArtifact',
  // source pickers + usage optimization
  ListSessions: 'skillFactory:listSessions',
  ListWorkflowRuns: 'skillFactory:listWorkflowRuns',
  ListImConversations: 'skillFactory:listImConversations',
  ListSkillUsageSessions: 'skillFactory:listSkillUsageSessions',
  // push events
  RunStatusChange: 'skillFactory:runStatusChange',
  ProgressUpdate: 'skillFactory:progressUpdate',
} as const;

// ─── Defaults ───────────────────────────────────────────────────────────────
export const SkillFactoryDefaults = {
  /** Wall-clock budget for the whole run in ms. */
  timeoutMsPerRun: 1_800_000,
  /** Gateway handshake timeout in ms. */
  gatewayReadyTimeoutMs: 60_000,
  /** chat.send request timeout in ms. */
  chatSendTimeoutMs: 90_000,
  /** Cap on evaluator re-eval rounds in the coordinator loop. */
  maxEvalRounds: 2,
  // Transcript mining caps (keep analyst context bounded)
  /** Per-source tail window: take the LAST N messages of a session. */
  transcriptMaxMessagesPerSource: 200,
  /** Truncate a single message to this many chars. */
  transcriptMaxCharsPerMessage: 2_000,
  /** Truncate a single transcript file to this many chars. */
  transcriptMaxCharsPerFile: 40_000,
  /** Stop writing further transcript files once this many chars accumulated. */
  transcriptMaxCharsPerRun: 150_000,
} as const;
