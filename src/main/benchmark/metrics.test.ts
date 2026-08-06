import { describe, expect, it } from 'vitest';
import { BenchmarkMatchMethod, BenchmarkDatasetId } from '../../benchmark/constants';
import type { BenchmarkTask } from '../../benchmark/types';
import { computeTaskMetrics, extractFinalAssistantText, matchAnswer, normalizeGaiaAnswer, type RawHistoryMessage } from './metrics';

describe('normalizeGaiaAnswer', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeGaiaAnswer('  The   Answer  ')).toBe('answer');
  });

  it('strips leading articles', () => {
    expect(normalizeGaiaAnswer('An apple')).toBe('apple');
    expect(normalizeGaiaAnswer('The answer is 42')).toBe('answer is 42');
  });

  it('normalizes thousands separators and dollar signs', () => {
    expect(normalizeGaiaAnswer('$1,000')).toBe('1000');
    expect(normalizeGaiaAnswer('1,000')).toBe('1000');
  });

  it('removes punctuation', () => {
    expect(normalizeGaiaAnswer('Paris, France.')).toBe('paris france');
  });
});

describe('matchAnswer', () => {
  const task = (answer: string): BenchmarkTask => ({
    id: 't1',
    datasetId: BenchmarkDatasetId.Gaia2023Val,
    prompt: 'question',
    referenceAnswer: answer,
  });

  it('passes on exact normalized match', () => {
    const result = matchAnswer(task('Paris'), 'Paris.');
    expect(result.passed).toBe(true);
    expect(result.method).toBe(BenchmarkMatchMethod.GaiaNormalized);
  });

  it('passes on containment', () => {
    const result = matchAnswer(task('1,000'), '1,000 dollars (1000)');
    expect(result.passed).toBe(true);
  });

  it('fails on mismatch', () => {
    const result = matchAnswer(task('London'), 'Paris');
    expect(result.passed).toBe(false);
  });
});

describe('computeTaskMetrics', () => {
  const history: RawHistoryMessage[] = [
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search.' },
        { type: 'toolCall', name: 'web_search', arguments: { query: 'gaia' } },
      ],
      usage: { input: 100, output: 20 },
    },
    { type: 'tool_result', content: 'result', error: false },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', name: 'nonexistent_tool', arguments: '{bad json' },
      ],
      usage: { input: 50, output: 10 },
    },
    { type: 'tool_result', content: 'boom', error: true },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'The answer is 42.' }],
      usage: { input: 30, output: 5 },
    },
  ];

  it('computes tool metrics from a trajectory', () => {
    const m = computeTaskMetrics(history, 'deepseek-v3', 1234);
    expect(m.steps).toBe(2); // two tool-calling assistant rounds
    expect(m.toolCallCount).toBe(2);
    expect(m.invalidToolCalls).toBe(1);
    expect(m.invalidCallRate).toBeCloseTo(0.5);
    expect(m.toolSelectionAccuracy).toBeCloseTo(0.5); // 1 of 2 in toolset
    expect(m.paramAccuracy).toBeCloseTo(0.5); // first args object valid, second invalid
    expect(m.inputTokens).toBe(180);
    expect(m.outputTokens).toBe(35);
    expect(m.totalTokens).toBe(215);
    expect(m.executionTimeMs).toBe(1234);
    // one errored result, and the model kept going after it → recovered
    expect(m.recoverability).toBe(1);
  });

  it('returns recoverability 1 with no errors', () => {
    const clean: RawHistoryMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'python', arguments: { code: 'print(1)' } }] },
      { type: 'tool_result', content: 'ok', error: false },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const m = computeTaskMetrics(clean, 'claude-opus-4', 100);
    expect(m.recoverability).toBe(1);
    expect(m.invalidCallRate).toBe(0);
  });

  it('computes recoverability 0 when the model stops after an error', () => {
    const stopped: RawHistoryMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'rm -rf /' } }] },
      { type: 'tool_result', content: 'permission denied', error: true },
    ];
    const m = computeTaskMetrics(stopped, 'claude-haiku', 200);
    expect(m.recoverability).toBe(0);
  });
});

describe('extractFinalAssistantText', () => {
  it('returns the last non-empty assistant text', () => {
    const messages: RawHistoryMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: '  ' }, { type: 'toolCall', name: 'python', arguments: {} }] },
      { type: 'tool_result', content: 'ok' },
      { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
    ];
    expect(extractFinalAssistantText(messages)).toBe('final answer');
  });
});
