import type {
  SkillFactoryRunStatus,
  SkillFactoryStage,
} from './constants';

// ─── Input Source ───────────────────────────────────────────────────────────
/** Where the skill spec comes from: a hand-written requirement or mined from
 *  real interactions (Cowork sessions / agent workflow runs / IM conversations). */
export type SkillFactorySource = 'manual' | 'sessions' | 'runs' | 'im';

export interface SkillFactorySourceRef {
  ref: string;
  title: string;
  subtitle?: string;
}

// ─── Eval Report ────────────────────────────────────────────────────────────
export type SkillFactoryEvalDecision = 'PASS' | 'FAIL' | 'NEEDS_INPUT';

export interface SkillFactoryEvalReport {
  decision: SkillFactoryEvalDecision;
  /** Dimension scores (0..1 or 0..100, per evaluator contract). */
  scores?: Record<string, number>;
  issues?: string[];
  /** Clarifying questions surfaced by the requirements analyst. */
  questions?: string[];
  /** Eval round this report corresponds to (1-based). */
  round?: number;
  summary?: string;
}

// ─── Security Report ─────────────────────────────────────────────────────────
export interface SkillFactorySecurityReport {
  riskLevel?: string;
  findings?: Array<{ file: string; ruleId: string; severity: string }>;
  [key: string]: unknown;
}

// ─── Run ────────────────────────────────────────────────────────────────────
export interface SkillFactoryRun {
  id: string;
  name: string;
  requirement: string;
  /** Input source: manual requirement, or mined from real interactions. */
  source: SkillFactorySource;
  /** Source refs (cowork session ids / subagent run ids / im conversation refs). */
  sourceRefs: string[];
  /** Absolute path of the per-run docs dir (copied attachments). */
  docsDir: string | null;
  /** Absolute path where the pipeline writes the produced skill. */
  outputDir: string;
  status: SkillFactoryRunStatus;
  stage: SkillFactoryStage | null;
  evalReport: SkillFactoryEvalReport | null;
  securityReport: SkillFactorySecurityReport | null;
  /** Skill folder name detected in the output dir (if any). */
  skillName: string | null;
  /** Installed skill id in the app skills list (after install). */
  installedSkillId: string | null;
  installedAt: number | null;
  createdAt: number;
  finishedAt: number | null;
  lastError: string | null;
}

// ─── Inputs ─────────────────────────────────────────────────────────────────
export interface SkillFactoryStartInput {
  name: string;
  /** Required for manual source; optional when mining from interactions. */
  requirement: string;
  /** Absolute paths of attached documents, copied into the run's docs dir. */
  docPaths: string[];
  /** Defaults to 'manual'. */
  source?: SkillFactorySource;
  /** Source refs (cowork session ids / subagent run ids / im conversation refs). */
  sourceRefs?: string[];
}

export interface SkillFactoryInstallResult {
  success: boolean;
  needConfirm?: boolean;
  securityReport?: SkillFactorySecurityReport;
  skillId?: string;
  error?: string;
}

// ─── Events ─────────────────────────────────────────────────────────────────
export type SkillFactoryRunnerEvent =
  | { type: 'runStatusChange'; payload: SkillFactoryRun }
  | { type: 'progress'; payload: { runId: string; stage: SkillFactoryStage | null } };

// ─── View ───────────────────────────────────────────────────────────────────
export type SkillFactoryViewMode = 'list' | 'create' | 'detail';
