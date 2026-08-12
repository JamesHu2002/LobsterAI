import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { SkillFactoryRunStatus } from '../../skillFactory/constants';
import type { SkillFactoryRun, SkillFactoryStartInput } from '../../skillFactory/types';
import { getSkillFactoryJobsRoot, SkillFactoryRunner } from './skillFactoryRunner';

function makeRun(id: string, outputDir: string): SkillFactoryRun {
  return {
    id,
    name: 'test skill',
    requirement: 'req',
    docsDir: null,
    outputDir,
    status: SkillFactoryRunStatus.Pending,
    stage: null,
    evalReport: null,
    securityReport: null,
    skillName: null,
    installedSkillId: null,
    installedAt: null,
    createdAt: Date.now(),
    finishedAt: null,
    lastError: null,
  };
}

function makeStore(run: SkillFactoryRun) {
  const calls = {
    updates: [] as Array<{ status: string; fields?: unknown }>,
    skills: [] as Array<{ fields: { status?: string } }>,
    evals: [] as Array<{ report?: unknown }>,
  };
  const store = {
    getRun: vi.fn(() => run),
    updateRunStatus: vi.fn((_id: string, status: string, fields?: unknown) => {
      calls.updates.push({ status, fields });
    }),
    updateStage: vi.fn(),
    updateSkillResult: vi.fn((_id: string, fields: { status?: string }) => {
      calls.skills.push({ fields });
    }),
    updateEvalReport: vi.fn((_id: string, report?: unknown) => {
      calls.evals.push({ report });
    }),
    updateSecurityReport: vi.fn(),
  };
  return { store, calls };
}

function makeClient(mode: 'final' | 'needs_input' | 'error' = 'final') {
  const requestCalls: Array<[string, unknown]> = [];
  const createClient = (onEvent: (event: { event: string; payload?: unknown }) => void) => ({
    ensureReady: vi.fn(async () => {}),
    request: vi.fn(async (method: string, params: { sessionKey?: string } = {}) => {
      requestCalls.push([method, params]);
      if (method === 'chat.send') {
        const state = mode === 'error' ? 'error' : 'final';
        setTimeout(() => {
          onEvent({
            event: 'chat',
            payload: {
              sessionKey: params.sessionKey,
              state,
              ...(mode === 'error' ? { errorMessage: 'llm boom' } : { stopReason: 'end_turn' }),
            },
          });
        }, 0);
        return { runId: 'g-run' };
      }
      if (method === 'chat.history') return { messages: [] };
      return {};
    }),
    stop: vi.fn(async () => {}),
  });
  return { createClient, requestCalls };
}

function makeDeps(
  store: unknown,
  createClient: unknown,
  emitted: Array<{ type: string }>,
  extra: Record<string, unknown> = {},
) {
  return {
    getSkillFactoryStore: () => store,
    getOpenClawEngineManager: () => ({} as never),
    getAgentManager: () => ({ updateAgent: vi.fn() }) as never,
    emit: (e: { type: string }) => emitted.push(e),
    createClient,
    ...extra,
  };
}

const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe('SkillFactoryRunner', () => {
  afterEach(() => {
    try {
      fs.rmSync(path.join(getSkillFactoryJobsRoot()), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('Pending -> Running -> Review on a successful coordinator turn with PASS eval', async () => {
    const runId = 'run-pass';
    const outputDir = path.join(getSkillFactoryJobsRoot(), runId, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'eval_report.json'),
      JSON.stringify({ decision: 'PASS', scores: { structure: 0.9 }, issues: [] }),
    );

    const { store, calls } = makeStore(makeRun(runId, outputDir));
    const { createClient } = makeClient('final');
    const emitted: Array<{ type: string }> = [];
    const runner = new SkillFactoryRunner(makeDeps(store, createClient, emitted) as never);

    const input: SkillFactoryStartInput = { name: 'x', requirement: 'req', docPaths: [] };
    runner.run(runId, input);
    await wait();

    const lastSkill = calls.skills[calls.skills.length - 1];
    expect(calls.updates.some((u) => u.status === SkillFactoryRunStatus.Running)).toBe(true);
    expect(lastSkill?.fields.status).toBe(SkillFactoryRunStatus.Review);
    expect(store.updateEvalReport).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ decision: 'PASS' }),
    );
  });

  test('NEEDS_INPUT eval -> run lands in needs_input', async () => {
    const runId = 'run-input';
    const outputDir = path.join(getSkillFactoryJobsRoot(), runId, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'eval_report.json'),
      JSON.stringify({ decision: 'NEEDS_INPUT', questions: ['skill 名是什么？'] }),
    );

    const { store, calls } = makeStore(makeRun(runId, outputDir));
    const { createClient } = makeClient('final');
    const emitted: Array<{ type: string }> = [];
    const runner = new SkillFactoryRunner(makeDeps(store, createClient, emitted) as never);

    runner.run(runId, { name: 'x', requirement: 'req', docPaths: [] });
    await wait();

    const lastSkill = calls.skills[calls.skills.length - 1];
    expect(lastSkill?.fields.status).toBe(SkillFactoryRunStatus.NeedsInput);
  });

  test('coordinator turn error -> run fails', async () => {
    const runId = 'run-err';
    const outputDir = path.join(getSkillFactoryJobsRoot(), runId, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const { store, calls } = makeStore(makeRun(runId, outputDir));
    const { createClient } = makeClient('error');
    const emitted: Array<{ type: string }> = [];
    const runner = new SkillFactoryRunner(makeDeps(store, createClient, emitted) as never);

    runner.run(runId, { name: 'x', requirement: 'req', docPaths: [] });
    await wait();

    const failed = calls.updates.find((u) => u.status === SkillFactoryRunStatus.Failed);
    expect(failed).toBeTruthy();
  });

  test('interaction mining mode exports transcripts and passes the source to the coordinator', async () => {
    const runId = 'run-mine';
    const outputDir = path.join(getSkillFactoryJobsRoot(), runId, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const { store } = makeStore(makeRun(runId, outputDir));
    const { createClient, requestCalls } = makeClient('final');
    const emitted: Array<{ type: string }> = [];
    const deps = makeDeps(store, createClient, emitted, {
      getCoworkStore: () => ({
        getSession: () => ({ title: '会话' }),
        countSessionMessages: () => 1,
        getPagedSessionMessages: () => [{ id: 'm1', type: 'user', content: '帮我做个会议纪要技能', timestamp: 1 }],
      }),
    }) as never;
    const runner = new SkillFactoryRunner(deps);

    runner.run(runId, {
      name: 'x',
      requirement: '',
      docPaths: [],
      source: 'sessions',
      sourceRefs: ['s1'],
    });
    await wait();

    const docsDir = path.join(getSkillFactoryJobsRoot(), runId, 'docs');
    expect(fs.existsSync(path.join(docsDir, 'transcript-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'SOURCE.md'))).toBe(true);
    const send = requestCalls.find(([m]) => m === 'chat.send')?.[1] as { message?: string } | undefined;
    expect(send?.message).toContain('## 输入来源');
    expect(send?.message).toContain('挖掘模式');
  });
});
