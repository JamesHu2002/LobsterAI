import Database from 'better-sqlite3';
import {
  BenchmarkRunStatus,
  BenchmarkTaskStatus,
} from '../benchmark/constants';
import type {
  BenchmarkReport,
  BenchmarkRun,
  BenchmarkRunConfig,
  BenchmarkTaskResult,
  TaskMetrics,
  BenchmarkMatch,
} from '../benchmark/types';

interface BenchmarkRunRow {
  id: string;
  dataset_id: string;
  dataset_label: string;
  model_ref: string;
  model_label: string;
  config: string;
  status: string;
  total: number;
  done: number;
  passed: number;
  failed: number;
  started_at: number;
  finished_at: number | null;
  error: string | null;
}

interface BenchmarkTaskResultRow {
  id: string;
  run_id: string;
  task_id: string;
  task_data: string;
  status: string;
  session_key: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  metrics: string | null;
  match: string | null;
  error: string | null;
}

function mapRunRow(row: BenchmarkRunRow): BenchmarkRun {
  return {
    id: row.id,
    datasetId: row.dataset_id as BenchmarkRun['datasetId'],
    datasetLabel: row.dataset_label,
    modelRef: row.model_ref,
    modelLabel: row.model_label,
    config: JSON.parse(row.config) as BenchmarkRunConfig,
    status: row.status as BenchmarkRunStatus,
    total: row.total,
    done: row.done,
    passed: row.passed,
    failed: row.failed,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

function mapTaskResultRow(row: BenchmarkTaskResultRow): BenchmarkTaskResult {
  return {
    id: row.id,
    runId: row.run_id,
    task: JSON.parse(row.task_data),
    status: row.status as BenchmarkTaskStatus,
    sessionKey: row.session_key ?? '',
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? row.started_at,
    durationMs: row.duration_ms ?? 0,
    metrics: row.metrics ? (JSON.parse(row.metrics) as TaskMetrics) : emptyMetrics(),
    match: row.match ? (JSON.parse(row.match) as BenchmarkMatch) : null,
    error: row.error,
  };
}

function emptyMetrics(): TaskMetrics {
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

export class BenchmarkStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────
  insertRun(run: BenchmarkRun): void {
    this.db
      .prepare(
        `INSERT INTO benchmark_runs (
          id, dataset_id, dataset_label, model_ref, model_label, config,
          status, total, done, passed, failed, started_at, finished_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.datasetId,
        run.datasetLabel,
        run.modelRef,
        run.modelLabel,
        JSON.stringify(run.config),
        run.status,
        run.total,
        run.done,
        run.passed,
        run.failed,
        run.startedAt,
        run.finishedAt,
        run.error,
      );
  }

  getRun(id: string): BenchmarkRun | null {
    const row = this.db
      .prepare('SELECT * FROM benchmark_runs WHERE id = ?')
      .get(id) as BenchmarkRunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  listRuns(): BenchmarkRun[] {
    const rows = this.db
      .prepare('SELECT * FROM benchmark_runs ORDER BY started_at DESC')
      .all() as BenchmarkRunRow[];
    return rows.map(mapRunRow);
  }

  updateRunStatus(id: string, status: BenchmarkRunStatus, fields?: { finishedAt?: number | null; error?: string | null; done?: number; passed?: number; failed?: number; }): void {
    const sets: string[] = ['status = ?'];
    const params: Array<string | number | null> = [status];
    if (fields?.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      params.push(fields.finishedAt);
    }
    if (fields?.error !== undefined) {
      sets.push('error = ?');
      params.push(fields.error);
    }
    if (fields?.done !== undefined) {
      sets.push('done = ?');
      params.push(fields.done);
    }
    if (fields?.passed !== undefined) {
      sets.push('passed = ?');
      params.push(fields.passed);
    }
    if (fields?.failed !== undefined) {
      sets.push('failed = ?');
      params.push(fields.failed);
    }
    params.push(id);
    this.db.prepare(`UPDATE benchmark_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  updateRunProgress(id: string, done: number, passed: number, failed: number): void {
    this.db
      .prepare('UPDATE benchmark_runs SET done = ?, passed = ?, failed = ? WHERE id = ?')
      .run(done, passed, failed, id);
  }

  deleteRun(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM benchmark_task_results WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM benchmark_runs WHERE id = ?').run(id);
    })();
  }

  // ─── Task Results ──────────────────────────────────────────────────────────
  insertTaskResult(result: BenchmarkTaskResult): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO benchmark_task_results (
          id, run_id, task_id, task_data, status, session_key,
          started_at, finished_at, duration_ms, metrics, match, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.runId,
        result.task.id,
        JSON.stringify(result.task),
        result.status,
        result.sessionKey,
        result.startedAt,
        result.finishedAt,
        result.durationMs,
        result.metrics ? JSON.stringify(result.metrics) : null,
        result.match ? JSON.stringify(result.match) : null,
        result.error,
      );
  }

  listTaskResults(runId: string, limit: number, offset: number): { results: BenchmarkTaskResult[]; total: number } {
    const rows = this.db
      .prepare(
        `SELECT * FROM benchmark_task_results WHERE run_id = ? ORDER BY started_at ASC LIMIT ? OFFSET ?`,
      )
      .all(runId, limit, offset) as BenchmarkTaskResultRow[];
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM benchmark_task_results WHERE run_id = ?')
      .get(runId) as { count: number };
    return {
      results: rows.map(mapTaskResultRow),
      total: countRow.count,
    };
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  getReport(runId: string): BenchmarkReport | null {
    const run = this.getRun(runId);
    if (!run) return null;

    const rows = this.db
      .prepare(
        'SELECT * FROM benchmark_task_results WHERE run_id = ? AND status != ?',
      )
      .all(runId, BenchmarkTaskStatus.Skipped) as BenchmarkTaskResultRow[];
    const results = rows.map(mapTaskResultRow);

    const byStatus: Record<BenchmarkTaskStatus, number> = {
      [BenchmarkTaskStatus.Passed]: 0,
      [BenchmarkTaskStatus.Failed]: 0,
      [BenchmarkTaskStatus.Error]: 0,
      [BenchmarkTaskStatus.Timeout]: 0,
      [BenchmarkTaskStatus.MaxSteps]: 0,
      [BenchmarkTaskStatus.Skipped]: 0,
      [BenchmarkTaskStatus.Cancelled]: 0,
    };
    for (const r of results) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }

    const attempted = results.length;
    const passed = byStatus[BenchmarkTaskStatus.Passed];

    // aggregate metrics
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let totalToolCalls = 0;
    let totalInvalidCalls = 0;
    let totalSteps = 0;
    let totalCostUsd = 0;
    let totalDurationMs = 0;
    let toolSelectionSum = 0;
    let toolSelectionCount = 0;
    let paramAccuracySum = 0;
    let paramAccuracyCount = 0;
    let recoverabilitySum = 0;
    let recoverabilityCount = 0;

    for (const r of results) {
      const m = r.metrics;
      totalTokens += m.totalTokens;
      inputTokens += m.inputTokens;
      outputTokens += m.outputTokens;
      cacheReadTokens += m.cacheReadTokens;
      totalToolCalls += m.toolCallCount;
      totalInvalidCalls += m.invalidToolCalls;
      totalSteps += m.steps;
      totalCostUsd += m.estimatedCostUsd;
      totalDurationMs += r.durationMs;
      if (m.toolSelectionAccuracy != null) {
        toolSelectionSum += m.toolSelectionAccuracy;
        toolSelectionCount += 1;
      }
      if (m.paramAccuracy != null) {
        paramAccuracySum += m.paramAccuracy;
        paramAccuracyCount += 1;
      }
      recoverabilitySum += m.recoverability;
      recoverabilityCount += 1;
    }

    return {
      runId,
      total: run.total,
      attempted,
      passed,
      successRate: attempted > 0 ? passed / attempted : 0,
      avgTokens: attempted > 0 ? totalTokens / attempted : 0,
      avgInputTokens: attempted > 0 ? inputTokens / attempted : 0,
      avgOutputTokens: attempted > 0 ? outputTokens / attempted : 0,
      avgCacheReadTokens: attempted > 0 ? cacheReadTokens / attempted : 0,
      avgSteps: attempted > 0 ? totalSteps / attempted : 0,
      avgToolCalls: attempted > 0 ? totalToolCalls / attempted : 0,
      invalidCallRate: totalToolCalls > 0 ? totalInvalidCalls / totalToolCalls : 0,
      toolSelectionAccuracy: toolSelectionCount > 0 ? toolSelectionSum / toolSelectionCount : null,
      paramAccuracy: paramAccuracyCount > 0 ? paramAccuracySum / paramAccuracyCount : null,
      recoverability: recoverabilityCount > 0 ? recoverabilitySum / recoverabilityCount : 1,
      totalCostUsd,
      avgCostUsd: attempted > 0 ? totalCostUsd / attempted : 0,
      totalDurationMs,
      avgDurationMs: attempted > 0 ? totalDurationMs / attempted : 0,
      byStatus,
    };
  }
}
