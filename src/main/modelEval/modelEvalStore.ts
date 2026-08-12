import type Database from 'better-sqlite3';

import { ModelEvalRunStatus } from '../../modelEval/constants';
import type {
  ModelEvalRun,
  ModelEvalRunConfig,
  ModelEvalSample,
  ModelEvalTaskResult,
} from '../../modelEval/types';

interface ModelEvalRunRow {
  id: string;
  model_ref: string;
  model_label: string;
  config: string;
  status: string;
  tasks: string | null;
  total: number;
  output_dir: string;
  started_at: number;
  finished_at: number | null;
  error: string | null;
}

interface ModelEvalTaskResultRow {
  run_id: string;
  task_id: string;
  exact_match: number | null;
  f1: number | null;
  gaia_exact: number | null;
  gaia_containment: number | null;
  samples: string | null;
  stderr: number | null;
}

function mapRunRow(row: ModelEvalRunRow): ModelEvalRun {
  const config = JSON.parse(row.config) as ModelEvalRunConfig;
  return {
    id: row.id,
    modelRef: row.model_ref,
    modelLabel: row.model_label,
    config,
    status: row.status as ModelEvalRunStatus,
    tasks: row.tasks ? (JSON.parse(row.tasks) as string[]) : [],
    total: row.total,
    outputDir: row.output_dir,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

export class ModelEvalStore {
  constructor(private db: Database.Database) {}

  insertRun(run: ModelEvalRun): void {
    this.db
      .prepare(
        `INSERT INTO model_eval_runs (
          id, model_ref, model_label, config, status, tasks, total, output_dir, started_at, finished_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.modelRef,
        run.modelLabel,
        JSON.stringify(run.config),
        run.status,
        run.tasks.length > 0 ? JSON.stringify(run.tasks) : null,
        run.total,
        run.outputDir,
        run.startedAt,
        run.finishedAt,
        run.error,
      );
  }

  getRun(id: string): ModelEvalRun | null {
    const row = this.db
      .prepare('SELECT * FROM model_eval_runs WHERE id = ?')
      .get(id) as ModelEvalRunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  listRuns(): ModelEvalRun[] {
    const rows = this.db
      .prepare('SELECT * FROM model_eval_runs ORDER BY started_at DESC')
      .all() as ModelEvalRunRow[];
    return rows.map(mapRunRow);
  }

  updateRunStatus(
    id: string,
    status: ModelEvalRunStatus,
    fields?: { finishedAt?: number | null; error?: string | null; tasks?: string[] },
  ): void {
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
    if (fields?.tasks !== undefined) {
      sets.push('tasks = ?');
      params.push(fields.tasks.length > 0 ? JSON.stringify(fields.tasks) : null);
    }
    params.push(id);
    this.db.prepare(`UPDATE model_eval_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteRun(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM model_eval_task_results WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM model_eval_runs WHERE id = ?').run(id);
    })();
  }

  upsertTaskResult(result: ModelEvalTaskResult): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO model_eval_task_results (
          run_id, task_id, exact_match, f1, gaia_exact, gaia_containment, samples, stderr
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.runId,
        result.taskId,
        result.exactMatch,
        result.f1,
        result.gaiaExact,
        result.gaiaContainment,
        result.samples.length > 0 ? JSON.stringify(result.samples) : null,
        null,
      );
  }

  listTaskResults(runId: string): ModelEvalTaskResult[] {
    const rows = this.db
      .prepare('SELECT * FROM model_eval_task_results WHERE run_id = ? ORDER BY task_id ASC')
      .all(runId) as ModelEvalTaskResultRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      taskId: row.task_id,
      exactMatch: row.exact_match,
      f1: row.f1,
      gaiaExact: row.gaia_exact,
      gaiaContainment: row.gaia_containment,
      samples: row.samples ? (JSON.parse(row.samples) as ModelEvalSample[]) : [],
    }));
  }

  /** Mark runs left pending/running as failed on app restart. */
  reconcileStaleRuns(): void {
    const stale = this.db
      .prepare("SELECT id FROM model_eval_runs WHERE status IN ('pending', 'running')")
      .all() as Array<{ id: string }>;
    for (const r of stale) {
      this.db
        .prepare('UPDATE model_eval_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?')
        .run(ModelEvalRunStatus.Failed, Date.now(), '应用重启，模型评测已中断', r.id);
    }
  }
}
