import { randomUUID } from 'crypto';
import {
  BenchmarkDefaults,
  BenchmarkRunStatus,
  BenchmarkTaskStatus,
} from '../../benchmark/constants';
import type {
  BenchmarkRun,
  BenchmarkRunConfig,
  BenchmarkRunnerEvent,
  BenchmarkTask,
  BenchmarkTaskResult,
  TaskMetrics,
} from '../../benchmark/types';
import type { OpenClawEngineManager } from '../libs/openclawEngineManager';
import type { BenchmarkStore } from '../benchmarkStore';
import type { DatasetLoader } from './datasetLoader';
import { BenchmarkGatewayClient, type GatewayEventFrame } from './gatewayClient';
import { computeTaskMetrics, extractFinalAssistantText, matchAnswer } from './metrics';

type TurnEndReason = 'final' | 'max_steps' | 'timeout' | 'aborted' | 'cancelled' | 'error';

interface ActiveTask {
  sessionKey: string;
  /** Agent-qualified session key as seen in gateway events (e.g. "agent:main:eval-…"). */
  fullSessionKey: string;
  runId: string;
  taskId: string;
  maxSteps: number;
  steps: number;
  previousWasToolUse: boolean;
  timer: NodeJS.Timeout | null;
  settle: (outcome: { reason: TurnEndReason; errorMessage?: string }) => void;
  promise: Promise<{ reason: TurnEndReason; errorMessage?: string }>;
}

/** The gateway qualifies bare session keys with the agent namespace. */
function sessionKeyMatches(eventKey: string, activeKey: string): boolean {
  return eventKey === activeKey
    || eventKey.endsWith(`:${activeKey}`)
    || eventKey.endsWith(activeKey);
}

interface ChatEventPayload {
  sessionKey?: string;
  state?: 'delta' | 'final' | 'aborted' | 'error';
  stopReason?: string;
  message?: unknown;
  errorMessage?: string;
}

export interface BenchmarkRunnerDeps {
  getBenchmarkStore: () => BenchmarkStore;
  getDatasetLoader: () => DatasetLoader;
  getOpenClawEngineManager: () => OpenClawEngineManager;
  emit: (event: BenchmarkRunnerEvent) => void;
}

export class BenchmarkRunner {
  private client: BenchmarkGatewayClient | null = null;
  private active: ActiveTask | null = null;
  private cancelledRuns = new Set<string>();
  private queue: Array<() => Promise<void>> = [];
  private draining = false;

  constructor(private deps: BenchmarkRunnerDeps) {}

  // ─── Public API ────────────────────────────────────────────────────────────
  async run(
    runId: string,
    config: BenchmarkRunConfig,
    modelRef: string,
    modelLabel: string,
  ): Promise<void> {
    this.queue.push(() => this.executeRun(runId, config, modelRef, modelLabel));
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
  private async executeRun(
    runId: string,
    config: BenchmarkRunConfig,
    modelRef: string,
    modelLabel: string,
  ): Promise<void> {
    const store = this.deps.getBenchmarkStore();
    let run = store.getRun(runId);
    if (!run) return;

    // Resolve tasks (full dataset or subset).
    let tasks: BenchmarkTask[] = [];
    try {
      const allTasks = await this.deps.getDatasetLoader().getTasks(config.datasetId);
      tasks = config.taskIds && config.taskIds.length > 0
        ? allTasks.filter((t) => config.taskIds?.includes(t.id))
        : allTasks;
    } catch (error) {
      store.updateRunStatus(runId, BenchmarkRunStatus.Failed, {
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      this.emitRunStatus(store.getRun(runId));
      return;
    }

    store.updateRunStatus(runId, BenchmarkRunStatus.Running, {
      done: 0,
      passed: 0,
      failed: 0,
      error: null,
    });
    this.emitRunStatus(store.getRun(runId));

    let done = 0;
    let passed = 0;
    let failed = 0;

    for (const task of tasks) {
      if (this.cancelledRuns.has(runId)) {
        // Mark remaining tasks as cancelled.
        for (const remaining of tasks.slice(done)) {
          store.insertTaskResult(this.buildCancelledResult(runId, remaining));
        }
        store.updateRunStatus(runId, BenchmarkRunStatus.Cancelled, { finishedAt: Date.now() });
        this.emitRunStatus(store.getRun(runId));
        return;
      }

      let result: BenchmarkTaskResult;
      try {
        result = await this.runTask(runId, task, modelRef, {
          maxSteps: config.maxSteps ?? BenchmarkDefaults.maxSteps,
          timeoutMs: config.timeoutMsPerTask ?? BenchmarkDefaults.timeoutMsPerTask,
        });
      } catch (error) {
        result = this.buildErrorResult(runId, task, error instanceof Error ? error.message : String(error));
      }

      if (this.cancelledRuns.has(runId)) {
        result.status = BenchmarkTaskStatus.Cancelled;
      }
      store.insertTaskResult(result);
      done += 1;
      if (result.status === BenchmarkTaskStatus.Passed) passed += 1;
      else if (result.status !== BenchmarkTaskStatus.Skipped) failed += 1;

      store.updateRunProgress(runId, done, passed, failed);
      this.deps.emit({ type: 'taskCompleted', payload: result });
      this.emitProgress(runId, tasks.length, done, passed, failed);
    }

    const finalStatus = this.cancelledRuns.has(runId)
      ? BenchmarkRunStatus.Cancelled
      : BenchmarkRunStatus.Completed;
    store.updateRunStatus(runId, finalStatus, { finishedAt: Date.now(), error: null });
    this.emitRunStatus(store.getRun(runId));
  }

  // ─── Single task ───────────────────────────────────────────────────────────
  private async runTask(
    runId: string,
    task: BenchmarkTask,
    modelRef: string,
    opts: { maxSteps: number; timeoutMs: number },
  ): Promise<BenchmarkTaskResult> {
    const startedAt = Date.now();
    const sessionKey = `eval-${runId.replace(/-/g, '').slice(0, 8)}-${randomUUID()}`;
    const client = await this.getClient();

    const base: BenchmarkTaskResult = {
      id: `${runId}:${task.id}`,
      runId,
      task,
      status: BenchmarkTaskStatus.Error,
      sessionKey,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      metrics: emptyTaskMetrics(),
      match: null,
      error: null,
    };

    try {
      // Pin the session model before sending.
      try {
        await client.request('sessions.patch', { key: sessionKey, model: modelRef }, { timeoutMs: 15_000 });
      } catch (error) {
        console.warn('[Benchmark] sessions.patch failed, continuing with default model:', error instanceof Error ? error.message : String(error));
      }

      // Set up the active turn collector.
      let resolveTurn: ((o: { reason: TurnEndReason; errorMessage?: string }) => void) | null = null;
      const turnPromise = new Promise<{ reason: TurnEndReason; errorMessage?: string }>((resolve) => {
        resolveTurn = resolve;
      });
      const timer = setTimeout(() => this.settleActive({ reason: 'timeout' }), opts.timeoutMs);
      this.active = {
        sessionKey,
        fullSessionKey: sessionKey,
        runId,
        taskId: task.id,
        maxSteps: opts.maxSteps,
        steps: 0,
        previousWasToolUse: false,
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
            message: task.prompt,
            deliver: false,
            idempotencyKey: `${runId}-${task.id}-${startedAt}`,
          },
          { timeoutMs: BenchmarkDefaults.chatSendTimeoutMs },
        );
        gatewayRunId = typeof sendResult?.runId === 'string' ? sendResult.runId : '';
      } catch (error) {
        this.settleActive({ reason: 'error', errorMessage: error instanceof Error ? error.message : String(error) });
      }

      const outcome = await this.active.promise;
      if (this.active.timer) clearTimeout(this.active.timer);

      // Abort the gateway run if it did not finish on its own.
      const resolvedKey = this.active?.fullSessionKey || sessionKey;
      if (outcome.reason !== 'final') {
        try {
          await client.request('chat.abort', { sessionKey: resolvedKey, runId: gatewayRunId || undefined }, { timeoutMs: 5_000 });
        } catch {
          // best effort
        }
      }

      // Read the authoritative trajectory.
      let historyMessages: unknown[] = [];
      try {
        const history = await client.request<{ messages?: unknown[] }>('chat.history', { sessionKey: resolvedKey }, { timeoutMs: 10_000 });
        historyMessages = Array.isArray(history?.messages) ? history.messages : [];
      } catch (error) {
        console.warn('[Benchmark] chat.history failed:', error instanceof Error ? error.message : String(error));
      }

      const durationMs = Date.now() - startedAt;
      const metrics = computeTaskMetrics(historyMessages as never[], modelRef, durationMs);
      const finalText = extractFinalAssistantText(historyMessages as never[]);
      const match = matchAnswer(task, finalText);

      let status: BenchmarkTaskResult['status'];
      switch (outcome.reason) {
        case 'final':
          status = match.passed ? BenchmarkTaskStatus.Passed : BenchmarkTaskStatus.Failed;
          break;
        case 'max_steps':
          status = BenchmarkTaskStatus.MaxSteps;
          break;
        case 'timeout':
          status = BenchmarkTaskStatus.Timeout;
          break;
        case 'cancelled':
        case 'aborted':
          status = BenchmarkTaskStatus.Cancelled;
          break;
        default:
          status = BenchmarkTaskStatus.Error;
          break;
      }

      return {
        ...base,
        status,
        finishedAt: Date.now(),
        durationMs,
        metrics,
        match,
        error: outcome.errorMessage ?? null,
      };
    } catch (error) {
      return this.buildErrorResult(runId, task, error instanceof Error ? error.message : String(error), base);
    } finally {
      // Clean up the gateway transcript.
      try {
        await client.request('sessions.delete', { key: this.active?.fullSessionKey || sessionKey, deleteTranscript: true }, { timeoutMs: 5_000 });
      } catch {
        // best effort
      }
      this.active = null;
    }
  }

  // ─── Event routing ─────────────────────────────────────────────────────────
  private handleEvent = (event: GatewayEventFrame): void => {
    const active = this.active;
    if (!active) return;
    if (event.event !== 'chat') return;
    const payload = (event.payload ?? {}) as ChatEventPayload;
    const eventKey = payload.sessionKey ?? '';
    if (!sessionKeyMatches(eventKey, active.sessionKey)) return;
    // The gateway qualifies bare keys (e.g. "eval-…") with the agent namespace;
    // remember the canonical key for chat.history / sessions.delete.
    if (eventKey !== active.fullSessionKey && eventKey) {
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
      return;
    }

    // Count tool-calling steps for maxSteps.
    const message = payload.message;
    if (message && typeof message === 'object') {
      const rec = message as { type?: string; role?: string };
      const isToolUse = rec.type === 'tool_use' || rec.role === 'tool_use';
      if (isToolUse) {
        if (!active.previousWasToolUse) {
          active.steps += 1;
          if (active.steps >= active.maxSteps) {
            this.settleActive({ reason: 'max_steps' });
            return;
          }
        }
        active.previousWasToolUse = true;
        return;
      }
      active.previousWasToolUse = false;
    }
  };

  private settleActive(outcome: { reason: TurnEndReason; errorMessage?: string }): void {
    const active = this.active;
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.settle(outcome);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  private async getClient(): Promise<BenchmarkGatewayClient> {
    if (!this.client) {
      this.client = new BenchmarkGatewayClient({
        getOpenClawEngineManager: this.deps.getOpenClawEngineManager,
        onEvent: this.handleEvent,
      });
      await this.client.ensureReady();
    }
    return this.client;
  }

  private buildErrorResult(
    runId: string,
    task: BenchmarkTask,
    message: string,
    base?: BenchmarkTaskResult,
  ): BenchmarkTaskResult {
    const startedAt = Date.now();
    return {
      ...(base ?? {
        id: `${runId}:${task.id}`,
        runId,
        task,
        status: BenchmarkTaskStatus.Error,
        sessionKey: '',
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        metrics: emptyTaskMetrics(),
        match: null,
      }),
      status: BenchmarkTaskStatus.Error,
      error: message,
    };
  }

  private buildCancelledResult(runId: string, task: BenchmarkTask): BenchmarkTaskResult {
    const startedAt = Date.now();
    return {
      id: `${runId}:${task.id}`,
      runId,
      task,
      status: BenchmarkTaskStatus.Cancelled,
      sessionKey: '',
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      metrics: emptyTaskMetrics(),
      match: null,
      error: 'cancelled',
    };
  }

  private emitProgress(runId: string, total: number, done: number, passed: number, failed: number): void {
    this.deps.emit({
      type: 'progress',
      payload: { runId, total, done, passed, failed },
    });
  }

  private emitRunStatus(run: BenchmarkRun | null): void {
    if (run) this.deps.emit({ type: 'runStatusChange', payload: run });
  }
}

function emptyTaskMetrics(): TaskMetrics {
  return {
    steps: 0,
    toolCallCount: 0,
    toolCallNames: {},
    invalidToolCalls: 0,
    invalidCallRate: 0,
    toolSelectionAccuracy: null,
    paramAccuracy: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    executionTimeMs: 0,
    recoverability: 1,
  };
}
