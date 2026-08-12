import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import {
  findNewestResultsFile,
  parseResultsFile,
  parseSamplesFile,
  toLmEvalModelId,
} from './lmEvalRunner';

describe('lmEvalRunner parsing helpers', () => {
  test('toLmEvalModelId strips the provider prefix', () => {
    expect(toLmEvalModelId('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(toLmEvalModelId('deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  test('parseResultsFile reads per-task aggregates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-res-'));
    const file = path.join(dir, 'results_2026-01-01-00-00-00.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        results: {
          gaia2023val: { exact_match: 0.5, f1: 0.4, gaia_exact: 0.25, gaia_containment: 0.6 },
        },
      }),
    );
    const parsed = parseResultsFile(file, 'gaia2023val');
    expect(parsed.exactMatch).toBe(0.5);
    expect(parsed.f1).toBe(0.4);
    expect(parsed.gaiaExact).toBe(0.25);
    expect(parsed.gaiaContainment).toBe(0.6);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('findNewestResultsFile picks the newest nested results file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-res-'));
    const nested = path.join(dir, 'deepseek-v4-flash');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'results_2026-01-01-00-00-00.json'), '{}');
    fs.writeFileSync(path.join(nested, 'results_2026-01-02-00-00-00.json'), '{}');
    const newest = findNewestResultsFile(dir);
    expect(newest).toBe(path.join(nested, 'results_2026-01-02-00-00-00.json'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('parseSamplesFile reads per-sample rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-res-'));
    const file = path.join(dir, 'samples_gaia2023val_2026-01-01.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ doc_id: 0, doc: { prompt: 'Q1', answer: 'A1' }, resps: [['answer-one']], filtered_resps: ['answer-one'] }),
        JSON.stringify({ doc_id: 1, doc: { prompt: 'Q2', answer: 'A2' }, resps: [['answer-two']], filtered_resps: ['answer-two'] }),
      ].join('\n'),
    );
    const samples = parseSamplesFile(file);
    expect(samples).toHaveLength(2);
    expect(samples[0].prompt).toBe('Q1');
    expect(samples[0].answer).toBe('A1');
    expect(samples[0].continuation).toBe('answer-one');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
