import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import type { SkillFactoryStartInput } from '../../skillFactory/types';
import { exportTranscripts } from './transcriptExporter';

function tmpDocs(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-exp-'));
  return dir;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    getCoworkStore: () => ({
      getSession: (_id: string) => ({ title: '我的会话' }),
      countSessionMessages: (_id: string) => 2,
      getPagedSessionMessages: (_id: string) => [
        { id: 'm1', type: 'user', content: '帮我整理会议纪要', timestamp: 1 },
        { id: 'm2', type: 'assistant', content: '好的，已整理成结构化纪要。', timestamp: 2 },
        { id: 'm3', type: 'tool_use', content: '', metadata: { toolName: 'file_write', toolInput: { path: '/x.md' } }, timestamp: 3 },
      ],
      listSessions: () => [],
    }),
    getSubagentMessageStore: () => ({
      getMessages: (_runId: string) => [
        { id: 'r1', type: 'user', content: '检索相关论文', metadata: null },
        { id: 'r2', type: 'tool_use', content: '', metadata: JSON.stringify({ toolName: 'web_search', toolInput: { q: 'RAG' } }) },
      ],
    }),
    getSubagentRunStore: () => ({
      getSubagentRun: (_id: string) => ({ label: '检索任务', task: 'search' }),
      listRecentSubagentRuns: () => [],
    }),
    getIMStore: () => null,
    ...overrides,
  } as never;
}

describe('transcriptExporter', () => {
  test('manual source writes no transcript files', async () => {
    const docs = tmpDocs();
    const result = await exportTranscripts(makeDeps(), { name: 'x', requirement: 'req', source: 'manual' } as SkillFactoryStartInput, docs);
    expect(result.files).toHaveLength(0);
    expect(fs.existsSync(path.join(docs, 'SOURCE.md'))).toBe(false);
    fs.rmSync(docs, { recursive: true, force: true });
  });

  test('sessions source writes a transcript with USER/ASSISTANT/TOOL lines + SOURCE.md', async () => {
    const docs = tmpDocs();
    const result = await exportTranscripts(
      makeDeps(),
      { name: 'x', requirement: '', source: 'sessions', sourceRefs: ['s1'] } as SkillFactoryStartInput,
      docs,
    );
    expect(result.files).toHaveLength(1);
    const text = fs.readFileSync(path.join(docs, 'transcript-1.md'), 'utf8');
    expect(text).toContain('USER: 帮我整理会议纪要');
    expect(text).toContain('ASSISTANT: 好的');
    expect(text).toContain('[TOOL] file_write');
    const sourceMeta = fs.readFileSync(path.join(docs, 'SOURCE.md'), 'utf8');
    expect(sourceMeta).toContain('source: sessions');
    expect(sourceMeta).toContain('transcript-1.md');
    fs.rmSync(docs, { recursive: true, force: true });
  });

  test('empty source produces an [EMPTY] stub + warning', async () => {
    const docs = tmpDocs();
    const result = await exportTranscripts(
      makeDeps({
        getCoworkStore: () => ({
          getSession: () => ({ title: '' }),
          countSessionMessages: () => 0,
          getPagedSessionMessages: () => [],
        }),
      }),
      { name: 'x', requirement: '', source: 'sessions', sourceRefs: ['empty'] } as SkillFactoryStartInput,
      docs,
    );
    expect(result.warnings.some((w) => w.includes('无可用消息'))).toBe(true);
    const text = fs.readFileSync(path.join(docs, 'transcript-1.md'), 'utf8');
    expect(text).toContain('[EMPTY]');
    fs.rmSync(docs, { recursive: true, force: true });
  });

  test('per-file char cap truncates long transcripts', async () => {
    const docs = tmpDocs();
    const longContent = 'x'.repeat(50_000);
    await exportTranscripts(
      makeDeps({
        getCoworkStore: () => ({
          getSession: () => ({ title: '' }),
          countSessionMessages: () => 1,
          getPagedSessionMessages: () => [{ id: 'm1', type: 'user', content: longContent, timestamp: 1 }],
        }),
      }),
      { name: 'x', requirement: '', source: 'sessions', sourceRefs: ['s1'] } as SkillFactoryStartInput,
      docs,
    );
    const text = fs.readFileSync(path.join(docs, 'transcript-1.md'), 'utf8');
    expect(text.length).toBeLessThan(41_000);
    expect(text).toContain('truncated');
    fs.rmSync(docs, { recursive: true, force: true });
  });
});
