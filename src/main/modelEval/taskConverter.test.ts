import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import type { BenchmarkTask } from '../../benchmark/types';
import { convertTasksToLmEval } from './taskConverter';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-tasks-'));
}

function makeTasks(): BenchmarkTask[] {
  return [
    { id: '1', datasetId: 'gaia2023val', prompt: 'What is 2+2?', referenceAnswer: '4' },
    { id: '2', datasetId: 'gaia2023val', prompt: 'Capital of France?', referenceAnswer: 'Paris' },
    { id: '3', datasetId: 'gaia2023val', prompt: 'No answer here', referenceAnswer: '' },
  ];
}

describe('taskConverter', () => {
  test('writes jsonl + yaml + utils.py, skipping tasks without answers', () => {
    const root = tmpRoot();
    const taskName = convertTasksToLmEval(root, 'gaia2023val', makeTasks(), 512);

    expect(taskName).toBe('gaia2023val');
    const jsonl = fs.readFileSync(path.join(root, 'gaia2023val', 'gaia2023val.jsonl'), 'utf8');
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2); // task 3 (no answer) skipped
    expect(JSON.parse(lines[0])).toEqual({ prompt: 'What is 2+2?', answer: '4' });

    const yaml = fs.readFileSync(path.join(root, 'gaia2023val', 'gaia2023val.yaml'), 'utf8');
    expect(yaml).toContain('task: gaia2023val');
    expect(yaml).toContain('dataset_path: json');
    expect(yaml).toContain('exact_match');
    expect(yaml).toContain('process_results: !function utils.gaia_score');
    // data_files must be an absolute forward-slash path
    const dataFiles = yaml.match(/data_files: "([^"]+)"/)?.[1] ?? '';
    expect(path.isAbsolute(dataFiles.replace(/\//g, path.sep))).toBe(true);
    expect(dataFiles).not.toContain('\\');

    const utils = fs.readFileSync(path.join(root, 'gaia2023val', 'utils.py'), 'utf8');
    expect(utils).toContain('def gaia_score');
    expect(utils).toContain('gaia_exact');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
