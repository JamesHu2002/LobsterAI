import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { SkillFactoryDefaults, SkillFactoryRunStatus, SkillFactoryStage } from '../../skillFactory/constants';
import type {
  SkillFactoryEvalReport,
  SkillFactoryRun,
  SkillFactoryRunnerEvent,
  SkillFactorySecurityReport,
  SkillFactoryStartInput,
} from '../../skillFactory/types';
import type { AgentManager } from '../agentManager';
import { BenchmarkGatewayClient, type GatewayEventFrame } from '../benchmark/gatewayClient';
import { cpRecursiveSync } from '../fsCompat';
import type { OpenClawEngineManager } from '../libs/openclawEngineManager';
import { mergeReports, scanMultipleSkillDirs } from '../libs/skillSecurity/skillSecurityScanner';
import type { SkillFactoryStore } from './skillFactoryStore';
import { exportTranscripts } from './transcriptExporter';

type TurnEndReason = 'final' | 'timeout' | 'aborted' | 'cancelled' | 'error';

interface ActiveTurn {
  sessionKey: string;
  fullSessionKey: string;
  runId: string;
  timer: NodeJS.Timeout | null;
  settle: (outcome: { reason: TurnEndReason; errorMessage?: string }) => void;
  promise: Promise<{ reason: TurnEndReason; errorMessage?: string }>;
}

function sessionKeyMatches(eventKey: string, activeKey: string): boolean {
  return eventKey === activeKey
    || eventKey.endsWith(`:${activeKey}`)
    || eventKey.endsWith(activeKey);
}

interface ChatEventPayload {
  sessionKey?: string;
  state?: 'delta' | 'final' | 'aborted' | 'error';
  stopReason?: string;
  errorMessage?: string;
}

/** Minimal gateway client surface the runner needs (injectable for tests). */
export interface SkillFactoryGatewayClient {
  ensureReady(): Promise<void>;
  request<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  stop(): Promise<void>;
}

export interface SkillFactoryRunnerDeps {
  getSkillFactoryStore: () => SkillFactoryStore;
  getOpenClawEngineManager: () => OpenClawEngineManager;
  getAgentManager: () => AgentManager;
  emit: (event: SkillFactoryRunnerEvent) => void;
  /** Injectable gateway client factory for tests; defaults to BenchmarkGatewayClient. */
  createClient?: (onEvent: (event: GatewayEventFrame) => void) => SkillFactoryGatewayClient;
  // Interaction-mining sources (all optional; used when input.source !== 'manual')
  getCoworkStore?: () => import('../coworkStore').CoworkStore;
  getSubagentRunStore?: () => import('../subagentRunStore').SubagentRunStore;
  getSubagentMessageStore?: () => import('../subagentMessageStore').SubagentMessageStore;
  getIMStore?: () => import('../im/imStore').IMStore | null | undefined;
  getOpenClawRuntimeAdapter?: () => {
    fetchSessionByKey: (key: string, opts?: unknown) => Promise<unknown>;
  } | null | undefined;
}

/** Root dir holding per-run jobs (docs + output) for skill-factory runs. */
export function getSkillFactoryJobsRoot(): string {
  return path.join(app.getPath('userData'), 'skill-factory', 'jobs');
}

/** Extract a JSON object from the final assistant text (fallback parsing). */
function parseJsonFromText(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    const start = candidate.indexOf('{');
    if (start < 0) return null;
    return JSON.parse(candidate.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class SkillFactoryRunner {
  private client: SkillFactoryGatewayClient | null = null;
  private active: ActiveTurn | null = null;
  private cancelledRuns = new Set<string>();
  private queue: Array<() => Promise<void>> = [];
  private draining = false;

  constructor(private deps: SkillFactoryRunnerDeps) {}

  // ─── Public API ────────────────────────────────────────────────────────────
  run(runId: string, input: SkillFactoryStartInput): void {
    this.queue.push(() => this.executeRun(runId, input));
    void this.drainQueue();
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRuns.add(runId);
    const active = this.active;
    if (active && active.runId === runId) {
      this.settleActive({ reason: 'cancelled' });
      try {
        await this.client?.request('chat.abort', { sessionKey: active.sessionKey });
      } catch {
        // best effort
      }
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) break;
        await job();
      }
    } finally {
      this.draining = false;
    }
  }

  // ─── Run orchestration ─────────────────────────────────────────────────────
  private async executeRun(runId: string, input: SkillFactoryStartInput): Promise<void> {
    const store = this.deps.getSkillFactoryStore();
    let run = store.getRun(runId);
    if (!run) return;

    const jobsRoot = getSkillFactoryJobsRoot();
    const jobDir = path.join(jobsRoot, runId);
    const docsDir = path.join(jobDir, 'docs');
    const outputDir = path.join(jobDir, 'output');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    store.updateRunStatus(runId, SkillFactoryRunStatus.Running, { stage: SkillFactoryStage.Preparing });
    this.emitRun(store.getRun(runId));

    try {
      // 1. Copy attached docs into the run's docs dir + write requirement.txt.
      for (const doc of input.docPaths) {
        try {
          const base = path.basename(doc);
          cpRecursiveSync(doc, path.join(docsDir, base));
        } catch (error) {
          console.warn('[SkillFactory] failed to copy doc:', doc, error);
        }
      }
      fs.writeFileSync(path.join(docsDir, 'requirement.txt'), input.requirement ?? '', 'utf8');

      // 1b. Interaction mining: export selected sessions/runs/IM transcripts.
      const transcriptResult = await exportTranscripts(this.deps, input, docsDir);
      if (transcriptResult.warnings.length > 0) {
        console.warn('[SkillFactory] transcript warnings:', transcriptResult.warnings.join('; '));
      }

      store.updateStage(runId, SkillFactoryStage.Requirements);
      this.emitProgress(runId, SkillFactoryStage.Requirements);

      // 2. Let the content-maker/evaluator write to the shared output dir.
      const agentManager = this.deps.getAgentManager();
      const workingAgents = ['skill-content-maker', 'skill-evaluator'];
      for (const agentId of workingAgents) {
        agentManager.updateAgent(agentId, { workingDirectory: outputDir });
      }

      // 3. Drive the coordinator through the gateway.
      const sessionKey = `agent:skill-coordinator:skill-factory-${runId}`;
      const message = this.buildCoordinatorMessage(input, docsDir, outputDir);
      const outcome = await this.driveCoordinator(runId, sessionKey, message, outputDir);

      if (this.cancelledRuns.has(runId)) {
        store.updateRunStatus(runId, SkillFactoryRunStatus.Cancelled, {
          stage: null,
          finishedAt: Date.now(),
        });
        this.emitRun(store.getRun(runId));
        return;
      }
      if (outcome.reason !== 'final') {
        store.updateRunStatus(runId, SkillFactoryRunStatus.Failed, {
          stage: null,
          finishedAt: Date.now(),
          lastError: outcome.errorMessage ?? `coordinator turn ended: ${outcome.reason}`,
        });
        this.emitRun(store.getRun(runId));
        return;
      }

      // 4. Collect the produced skill + eval report.
      store.updateStage(runId, SkillFactoryStage.Finalizing);
      this.emitProgress(runId, SkillFactoryStage.Finalizing);
      const evalReport = this.collectEvalReport(outputDir);
      const skillDirs = this.collectSkillDirs(outputDir);
      let securityReport: SkillFactorySecurityReport | null = null;
      if (skillDirs.length > 0) {
        const reports = await scanMultipleSkillDirs(skillDirs);
        const merged = mergeReports(reports);
        if (merged) {
          securityReport = {
            riskLevel: merged.riskLevel,
            findings: (merged.findings ?? []).map((f) => ({
              file: String(f.file ?? ''),
              ruleId: String(f.ruleId ?? ''),
              severity: String(f.severity ?? ''),
            })),
          };
        }
      }
      const skillName = skillDirs.length > 0 ? path.basename(skillDirs[0]) : null;

      store.updateEvalReport(runId, evalReport);
      store.updateSecurityReport(runId, securityReport);
      const finalStatus = evalReport?.decision === 'NEEDS_INPUT'
        ? SkillFactoryRunStatus.NeedsInput
        : SkillFactoryRunStatus.Review;
      store.updateSkillResult(runId, {
        skillName,
        status: finalStatus,
        finishedAt: Date.now(),
        lastError: null,
      });
      this.emitRun(store.getRun(runId));
    } catch (error) {
      store.updateRunStatus(runId, SkillFactoryRunStatus.Failed, {
        stage: null,
        finishedAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.emitRun(store.getRun(runId));
    } finally {
      // Reset agent working directories and drop the gateway client.
      const agentManager = this.deps.getAgentManager();
      for (const agentId of ['skill-content-maker', 'skill-evaluator']) {
        try {
          agentManager.updateAgent(agentId, { workingDirectory: '' });
        } catch {
          // ignore
        }
      }
      await this.stopClient();
    }
  }

  private buildCoordinatorMessage(
    input: SkillFactoryStartInput,
    docsDir: string,
    outputDir: string,
  ): string {
    const source = input.source ?? 'manual';
    const isMining = source !== 'manual';
    const refs = Array.isArray(input.sourceRefs) ? input.sourceRefs : [];
    const lines = [
      '请执行技能制作流水线。',
      '',
      `## 输入来源\n${source}${refs.length > 0 ? `（样本：${refs.join(', ')}）` : ''}`,
      `## 需求\n${input.requirement || '(空——当输入是交互转录时，规格由需求解析 Agent 从样本中提炼)'}`,
      `## 文档目录（读取参考，可留空）\n${docsDir}`,
      `## 输出目录（把最终 skill 写到这里）\n${outputDir}`,
    ];
    if (isMining) {
      lines.push(
        '',
        '## 挖掘模式',
        '输入是真实的交互转录（docs 目录下的 transcript-*.md 与 SOURCE.md）。',
        '要求 skill-requirements-analyst 从这些真实交互中**推断** skill 规格（用户反复问什么→triggers、Agent 怎么做→steps/tools、输出偏好→outputs、边界→constraints），而不是依赖手写需求。',
        '若样本不足/不典型/相互矛盾 → 按 NEEDS_INPUT 协议返回待确认问题，不要强行猜测。',
      );
    }
    lines.push(
      '',
      '要求：委派 skill-requirements-analyst 解析 → skill-content-maker（用 skill-creator 技能）制作到输出目录 → skill-evaluator 评估，按评估结果回退（最多 2 次复评）。结束后把 eval_report.json 与 final_summary.md 写入输出目录。',
    );
    return lines.join('\n');
  }

  private async driveCoordinator(
    runId: string,
    sessionKey: string,
    message: string,
    outputDir: string,
  ): Promise<{ reason: TurnEndReason; errorMessage?: string }> {
    const client = await this.getClient();
    let resolveTurn: ((o: { reason: TurnEndReason; errorMessage?: string }) => void) | null = null;
    const turnPromise = new Promise<{ reason: TurnEndReason; errorMessage?: string }>((resolve) => {
      resolveTurn = resolve;
    });
    const timer = setTimeout(
      () => this.settleActive({ reason: 'timeout', errorMessage: '技能生成超时' }),
      SkillFactoryDefaults.timeoutMsPerRun,
    );
    this.active = {
      sessionKey,
      fullSessionKey: sessionKey,
      runId,
      timer,
      settle: (o) => resolveTurn?.(o),
      promise: turnPromise,
    };

    let gatewayRunId = '';
    try {
      const sendResult = await client.request<{ runId?: string }>(
        'chat.send',
        {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: `skill-factory-${Date.now()}`,
        },
        { timeoutMs: SkillFactoryDefaults.chatSendTimeoutMs },
      );
      gatewayRunId = typeof sendResult?.runId === 'string' ? sendResult.runId : '';
    } catch (error) {
      this.settleActive({ reason: 'error', errorMessage: error instanceof Error ? error.message : String(error) });
    }

    const outcome = await this.active.promise;
    if (this.active.timer) clearTimeout(this.active.timer);

    const resolvedKey = this.active?.fullSessionKey || sessionKey;
    if (outcome.reason !== 'final') {
      try {
        await client.request('chat.abort', { sessionKey: resolvedKey, runId: gatewayRunId || undefined }, { timeoutMs: 5_000 });
      } catch {
        // best effort
      }
    }

    // Best-effort transcript capture for the fallback eval-report parsing.
    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', { sessionKey: resolvedKey }, { timeoutMs: 10_000 });
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      if (messages.length > 0 && !fs.existsSync(path.join(outputDir, 'eval_report.json'))) {
        this.tryParseEvalFromHistory(outputDir, messages);
      }
    } catch {
      // ignore
    }

    try {
      await client.request('sessions.delete', { key: resolvedKey, deleteTranscript: true }, { timeoutMs: 5_000 });
    } catch {
      // best effort
    }
    this.active = null;
    return outcome;
  }

  private tryParseEvalFromHistory(outputDir: string, messages: unknown[]): void {
    const texts = messages
      .map((m) => {
        const rec = m as { message?: { role?: string; content?: unknown } };
        if (rec.message?.role !== 'assistant' || !Array.isArray(rec.message.content)) return '';
        return rec.message.content
          .filter((c: { type?: string; text?: string }) => c?.type === 'text')
          .map((c: { text?: string }) => c.text ?? '')
          .join('\n');
      })
      .filter((t) => t.length > 40);
    const last = texts[texts.length - 1] ?? '';
    if (!last) return;
    const parsed = parseJsonFromText(last);
    if (!parsed || !parsed.decision) return;
    const report: SkillFactoryEvalReport = {
      decision: String(parsed.decision) as SkillFactoryEvalReport['decision'],
      ...(parsed.scores && typeof parsed.scores === 'object' ? { scores: parsed.scores as Record<string, number> } : {}),
      ...(Array.isArray(parsed.issues) ? { issues: parsed.issues.map(String) } : {}),
      ...(Array.isArray(parsed.questions) ? { questions: parsed.questions.map(String) } : {}),
      ...(typeof parsed.round === 'number' ? { round: parsed.round } : {}),
      ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
    };
    fs.writeFileSync(path.join(outputDir, 'eval_report.json'), JSON.stringify(report, null, 2), 'utf8');
  }

  private collectEvalReport(outputDir: string): SkillFactoryEvalReport | null {
    const evalPath = path.join(outputDir, 'eval_report.json');
    if (fs.existsSync(evalPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(evalPath, 'utf8')) as SkillFactoryEvalReport;
        if (parsed && typeof parsed.decision === 'string') return parsed;
      } catch (error) {
        console.warn('[SkillFactory] invalid eval_report.json:', error);
      }
    }
    return null;
  }

  /** Find skill directories (dirs containing SKILL.md) under a source dir. */
  private collectSkillDirs(source: string): string[] {
    const resolved = path.resolve(source);
    const hasSkillMd = (dir: string) => fs.existsSync(path.join(dir, 'SKILL.md'));
    if (hasSkillMd(resolved)) return [resolved];
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return [];
    return fs.readdirSync(resolved)
      .map((entry) => path.join(resolved, entry))
      .filter((entry) => {
        try {
          return fs.statSync(entry).isDirectory() && hasSkillMd(entry);
        } catch {
          return false;
        }
      });
  }

  // ─── Client / event routing ────────────────────────────────────────────────
  private async getClient(): Promise<SkillFactoryGatewayClient> {
    if (this.client) return this.client;
    const create = this.deps.createClient ?? ((onEvent: (e: GatewayEventFrame) => void) => new BenchmarkGatewayClient({
      getOpenClawEngineManager: this.deps.getOpenClawEngineManager,
      onEvent,
    }));
    this.client = create((e: GatewayEventFrame) => this.handleEvent(e));
    await this.client.ensureReady();
    return this.client;
  }

  private async stopClient(): Promise<void> {
    if (this.client) {
      await this.client.stop().catch(() => {});
      this.client = null;
    }
  }

  private handleEvent = (event: GatewayEventFrame): void => {
    const active = this.active;
    if (!active) return;
    if (event.event !== 'chat') return;
    const payload = (event.payload ?? {}) as ChatEventPayload;
    const eventKey = payload.sessionKey ?? '';
    if (!sessionKeyMatches(eventKey, active.sessionKey)) return;
    if (eventKey && eventKey !== active.fullSessionKey) {
      active.fullSessionKey = eventKey;
    }
    const state = payload.state;
    if (state === 'final') {
      const stopReason = payload.stopReason ?? '';
      if (stopReason !== 'toolUse' && stopReason !== 'tool_use') {
        this.settleActive({ reason: 'final' });
      }
      return;
    }
    if (state === 'aborted') {
      this.settleActive({ reason: 'aborted' });
      return;
    }
    if (state === 'error') {
      this.settleActive({ reason: 'error', errorMessage: payload.errorMessage });
    }
  };

  private settleActive(outcome: { reason: TurnEndReason; errorMessage?: string }): void {
    const active = this.active;
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.settle(outcome);
  }

  // ─── Emit helpers ──────────────────────────────────────────────────────────
  private emitRun(run: SkillFactoryRun | null): void {
    if (!run) return;
    this.deps.emit({ type: 'runStatusChange', payload: run });
  }

  private emitProgress(runId: string, stage: SkillFactoryStage): void {
    this.deps.emit({ type: 'progress', payload: { runId, stage } });
  }
}
