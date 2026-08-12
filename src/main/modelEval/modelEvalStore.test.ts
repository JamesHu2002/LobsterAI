import Database from 'better-sqlite3';
import { describe,expect, test } from 'vitest';

import { ModelEvalRunStatus } from '../../modelEval/constants';
import type { ModelEvalRun, ModelEvalRunConfig } from '../../modelEval/types';
import { ModelEvalStore } from './modelEvalStore';

function createStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_eval_runs (
      id TEXT PRIMARY KEY, model_ref TEXT NOT NULL, model_label TEXT NOT NULL,
      config TEXT NOT NULL, status TEXT NOT NULL, tasks TEXT, total INTEGER NOT NULL DEFAULT 0,
      output_dir TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT
    );
    CREATE TABLE IF NOT EXISTS model_eval_task_results (
      run_id TEXT NOT NULL, task_id TEXT NOT NULL, exact_match REAL, f1 REAL,
      gaia_exact REAL, gaia_containment REAL, samples TEXT, stderr REAL, UNIQUE(run_id, task_id)
    );
  `);
  return new ModelEvalStore(db);
}

function makeRun(id: string, overrides: Partial<ModelEvalRun> = {}): ModelEvalRun {
  const config: ModelEvalRunConfig = {
    datasetId: 'gaia2023val',
    modelRef: 'deepseek-v4-flash',
    modelLabel: 'DeepSeek V4 Flash',
  };
  return {
    id,
    modelRef: config.modelRef,
    modelLabel: config.modelLabel,
    config,
    status: ModelEvalRunStatus.Pending,
    tasks: [],
    total: 0,
    outputDir: `/tmp/${id}`,
    startedAt: 1000,
    finishedAt: null,
    error: null,
    ...overrides,
  };
}

describe('ModelEvalStore', () => {
  test('insert + get roundtrip', () => {
    const store = createStore();
    store.insertRun(makeRun('run-1'));
    expect(store.getRun('run-1')?.modelRef).toBe('deepseek-v4-flash');
  });

  test('updateRunStatus changes status', () => {
    const store = createStore();
    store.insertRun(makeRun('run-1'));
    store.updateRunStatus('run-1', ModelEvalRunStatus.Completed, { finishedAt: 2000 });
    expect(store.getRun('run-1')?.status).toBe(ModelEvalRunStatus.Completed);
  });

  test('upsertTaskResult + listTaskResults', () => {
    const store = createStore();
    store.insertRun(makeRun('run-1'));
    store.upsertTaskResult({
      runId: 'run-1',
      taskId: 'gaia2023val',
      exactMatch: 0.5,
      f1: 0.4,
      gaiaExact: 0.25,
      gaiaContainment: 0.6,
      samples: [{ prompt: 'Q', answer: 'A', continuation: 'C' }],
    });
    const results = store.listTaskResults('run-1');
    expect(results).toHaveLength(1);
    expect(results[0].exactMatch).toBe(0.5);
    expect(results[0].samples[0].prompt).toBe('Q');
  });

  test('reconcileStaleRuns marks pending/running as failed', () => {
    const store = createStore();
    store.insertRun(makeRun('run-p', { status: ModelEvalRunStatus.Pending }));
    store.insertRun(makeRun('run-r', { status: ModelEvalRunStatus.Running }));
    store.insertRun(makeRun('run-done', { status: ModelEvalRunStatus.Completed }));

    store.reconcileStaleRuns();

    expect(store.getRun('run-p')?.status).toBe(ModelEvalRunStatus.Failed);
    expect(store.getRun('run-r')?.status).toBe(ModelEvalRunStatus.Failed);
    expect(store.getRun('run-done')?.status).toBe(ModelEvalRunStatus.Completed);
  });
});
