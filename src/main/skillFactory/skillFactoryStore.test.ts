import Database from 'better-sqlite3';
import { describe,expect, test } from 'vitest';

import { SkillFactoryRunStatus } from '../../skillFactory/constants';
import type { SkillFactoryRun } from '../../skillFactory/types';
import { SkillFactoryStore } from './skillFactoryStore';

function makeRun(id: string, overrides: Partial<SkillFactoryRun> = {}): SkillFactoryRun {
  return {
    id,
    name: 'test',
    requirement: 'req',
    docsDir: null,
    outputDir: `/tmp/${id}/output`,
    status: SkillFactoryRunStatus.Pending,
    stage: null,
    evalReport: null,
    securityReport: null,
    skillName: null,
    installedSkillId: null,
    installedAt: null,
    createdAt: 1000,
    finishedAt: null,
    lastError: null,
    ...overrides,
  };
}

function createStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_factory_runs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, requirement TEXT NOT NULL,
      docs_dir TEXT, output_dir TEXT NOT NULL, status TEXT NOT NULL, stage TEXT,
      eval_report TEXT, security_report TEXT, skill_name TEXT,
      installed_skill_id TEXT, installed_at INTEGER, created_at INTEGER NOT NULL,
      finished_at INTEGER, last_error TEXT
    );
  `);
  return new SkillFactoryStore(db);
}

describe('SkillFactoryStore', () => {
  test('insert + get roundtrip', () => {
    const store = createStore();
    const run = makeRun('run-1');
    store.insertRun(run);
    const got = store.getRun('run-1');
    expect(got).toEqual(run);
  });

  test('updateRunStatus changes status and stage', () => {
    const store = createStore();
    store.insertRun(makeRun('run-1'));
    store.updateRunStatus('run-1', SkillFactoryRunStatus.Running, { stage: 'requirements' });
    const got = store.getRun('run-1');
    expect(got?.status).toBe(SkillFactoryRunStatus.Running);
    expect(got?.stage).toBe('requirements');
  });

  test('updateEvalReport persists JSON report', () => {
    const store = createStore();
    store.insertRun(makeRun('run-1'));
    store.updateEvalReport('run-1', { decision: 'PASS', scores: { structure: 0.9 } });
    expect(store.getRun('run-1')?.evalReport?.decision).toBe('PASS');
  });

  test('markInstalled records the installed skill id', () => {
    const store = createStore();
    store.insertRun(makeRun('run-1'));
    store.markInstalled('run-1', 'my-skill');
    const got = store.getRun('run-1');
    expect(got?.status).toBe(SkillFactoryRunStatus.Installed);
    expect(got?.installedSkillId).toBe('my-skill');
  });

  test('reconcileStaleRuns marks pending/running as failed', () => {
    const store = createStore();
    store.insertRun(makeRun('run-running', { status: SkillFactoryRunStatus.Running }));
    store.insertRun(makeRun('run-pending', { status: SkillFactoryRunStatus.Pending }));
    store.insertRun(makeRun('run-review', { status: SkillFactoryRunStatus.Review }));

    store.reconcileStaleRuns();

    expect(store.getRun('run-running')?.status).toBe(SkillFactoryRunStatus.Failed);
    expect(store.getRun('run-pending')?.status).toBe(SkillFactoryRunStatus.Failed);
    expect(store.getRun('run-review')?.status).toBe(SkillFactoryRunStatus.Review);
  });

  test('deleteRun removes the row', () => {
    const store = createStore();
    store.insertRun(makeRun('run-1'));
    store.deleteRun('run-1');
    expect(store.getRun('run-1')).toBe(null);
  });
});
