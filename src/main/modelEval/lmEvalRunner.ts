import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ModelEvalDefaults, ModelEvalRunStatus } from '../../modelEval/constants';
import type {
  ModelEvalRun,
  ModelEvalRunConfig,
  ModelEvalRunnerEvent,
  ModelEvalSample,
  ModelEvalTaskResult,
} from '../../modelEval/types';
import type { DatasetLoader } from '../benchmark/datasetLoader';
import { appendPythonRuntimeToEnv, getUserPythonRoot } from '../libs/pythonRuntime';
import type { SqliteStore } from '../sqliteStore';
import { readModelEndpoint } from './modelEndpointAccessor';
import type { ModelEvalStore } from './modelEvalStore';
import { convertTasksToLmEval } from './taskConverter';

function pythonExe(): string {
  const root = getUserPythonRoot();
  return path.join(root, fs.existsSync(path.join(root, 'python.exe')) ? 'python.exe' : 'python3.exe');
}

/** Strip a provider/ prefix from a model ref (deepseek/xxx → xxx). */
export function toLmEvalModelId(modelRef: string): string {
  return modelRef.split('/').pop() ?? modelRef;
}

/** Recursively find the newest results_*.json under a dir. */
export function findNewestResultsFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files: Array<{ p: string; m: number }> = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^results_.*\.json$/.test(entry.name)) {
        files.push({ p: full, m: fs.statSync(full).mtimeMs });
      }
    }
  };
  walk(dir);
  // Newest by mtime, then by ISO filename (ties are broken deterministically).
  files.sort((a, b) => (b.m - a.m) || (b.p.localeCompare(a.p)));
  return files[0]?.p ?? null;
}

interface ParsedResults {
  exactMatch: number | null;
  f1: number | null;
  gaiaExact: number | null;
  gaiaContainment: number | null;
}

/** Parse the per-task aggregate from an lm-eval results JSON. */
export function parseResultsFile(filePath: string, taskName: string): ParsedResults {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const task = json?.results?.[taskName] ?? {};
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      exactMatch: num(task.exact_match),
      f1: num(task.f1),
      gaiaExact: num(task.gaia_exact),
      gaiaContainment: num(task.gaia_containment),
    };
  } catch {
    return { exactMatch: null, f1: null, gaiaExact: null, gaiaContainment: null };
  }
}

/** Parse per-sample rows from a samples_*.jsonl file. */
export function parseSamplesFile(filePath: string, cap = 200): ModelEvalSample[] {
  const samples: ModelEvalSample[] = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (samples.length >= cap) break;
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        const doc = o?.doc ?? {};
        const resps = Array.isArray(o?.resps) ? o.resps : [];
        const filtered = Array.isArray(o?.filtered_resps) ? o.filtered_resps : resps;
        const continuation = Array.isArray(filtered) ? (filtered[0] ?? '') : (o?.continuation ?? '');
        samples.push({
          docId: typeof o?.doc_id === 'number' ? o.doc_id : undefined,
          prompt: typeof doc?.prompt === 'string' ? doc.prompt : undefined,
          answer: typeof doc?.answer === 'string' ? doc.answer : undefined,
          continuation: typeof continuation === 'string' ? continuation.slice(0, 2000) : undefined,
          filteredResp: typeof continuation === 'string' ? continuation.slice(0, 2000) : undefined,
        });
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // ignore
  }
  return samples;
}

/** Recursively find the first samples_*.jsonl under a dir. */
export function findSamplesFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findSamplesFile(full);
      if (nested) return nested;
    } else if (entry.isFile() && /^samples_.*\.jsonl$/.test(entry.name)) {
      return full;
    }
  }
  return null;
}

export interface LmEvalRunnerDeps {
  getModelEvalStore: () => ModelEvalStore;
  getDatasetLoader: () => DatasetLoader;
  getStore: () => SqliteStore;
  getTasksRoot: () => string;
  getRunOutputDir: (runId: string) => string;
  emit: (event: ModelEvalRunnerEvent) => void;
}

export class LmEvalRunner {
  private children = new Map<string, ReturnType<typeof spawn>>();
  private queue: Array<() => Promise<void>> = [];
  private draining = false;

  constructor(private deps: LmEvalRunnerDeps) {}

  run(runId: string, config: ModelEvalRunConfig): void {
    this.queue.push(() => this.executeRun(runId, config));
    void this.drainQueue();
  }

  cancel(runId: string): Promise<void> {
    return new Promise((resolve) => {
      const child = this.children.get(runId);
      if (!child) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      try {
        child.kill('SIGTERM');
        // Reap the process tree on Windows.
        if (process.platform === 'win32' && child.pid) {
          const { spawn: killSpawn } = require('child_process');
          killSpawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        }
      } catch {
        resolve();
      }
      setTimeout(resolve, 3000);
    });
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

  private async executeRun(runId: string, config: ModelEvalRunConfig): Promise<void> {
    const store = this.deps.getModelEvalStore();
    const run = store.getRun(runId);
    if (!run) return;

    try {
      store.updateRunStatus(runId, ModelEvalRunStatus.Running, { error: null });
      this.emitRun(store.getRun(runId));

      // Built-in lm-eval task (no conversion) or a converted custom dataset.
      const tasksRoot = this.deps.getTasksRoot();
      let taskName: string;
      let includePathArgs: string[] = [];
      if (config.builtinTask) {
        taskName = config.builtinTask;
      } else {
        const loader = this.deps.getDatasetLoader();
        const tasks = await loader.getTasks(config.datasetId as never);
        taskName = convertTasksToLmEval(tasksRoot, config.datasetId, tasks, config.maxGenToks ?? ModelEvalDefaults.maxGenToks);
        includePathArgs = ['--include_path', tasksRoot];
      }
      store.updateRunStatus(runId, ModelEvalRunStatus.Running, { tasks: [taskName] });

      const providerKey = config.providerKey ?? 'deepseek';
      const endpoint = readModelEndpoint(this.deps.getStore, providerKey);
      if (!endpoint) {
        throw new Error(`未配置模型端点（${providerKey}），请在模型设置中添加 baseUrl。`);
      }

      const outputDir = this.deps.getRunOutputDir(runId);
      fs.mkdirSync(outputDir, { recursive: true });
      const args = [
        '-m', 'lm_eval',
        '--model', 'openai-chat-completions',
        '--model_args',
        `model=${toLmEvalModelId(config.modelRef)},base_url=${endpoint.lmEvalBaseUrl},num_concurrent=1,max_retries=3,timeout=120`,
        '--tasks', taskName,
        ...includePathArgs,
        '--num_fewshot', String(config.numFewshot ?? ModelEvalDefaults.numFewshot),
        '--batch_size', '1',
        ...(config.limit && config.limit > 0 ? ['--limit', String(config.limit)] : []),
        '--output_path', outputDir,
        '--log_samples',
        '--apply_chat_template',
      ];
      const env = appendPythonRuntimeToEnv({ ...process.env }) as Record<string, string>;
      env.OPENAI_API_KEY = endpoint.apiKey || 'EMPTY';

      await this.spawnLmEval(runId, args, env, outputDir, taskName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      store.updateRunStatus(runId, ModelEvalRunStatus.Failed, { finishedAt: Date.now(), error: msg });
      this.emitRun(store.getRun(runId));
    } finally {
      this.children.delete(runId);
    }
  }

  private spawnLmEval(
    runId: string,
    args: string[],
    env: Record<string, string>,
    outputDir: string,
    taskName: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(pythonExe(), args, {
        cwd: this.deps.getTasksRoot(),
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.children.set(runId, child);
      let stderrTail = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        this.deps.emit({ type: 'progress', payload: { runId, message: line.slice(0, 200) } });
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
        const last = stderrTail.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
        this.deps.emit({ type: 'progress', payload: { runId, message: last.slice(0, 200) } });
      });
      child.on('error', (err) => {
        const store = this.deps.getModelEvalStore();
        store.updateRunStatus(runId, ModelEvalRunStatus.Failed, {
          finishedAt: Date.now(),
          error: String(err),
        });
        this.emitRun(store.getRun(runId));
        resolve();
      });
      child.on('close', (code) => {
        const store = this.deps.getModelEvalStore();
        if (code === 0) {
          this.finalizeRun(runId, outputDir, taskName);
        } else {
          const tail = stderrTail.trim().split('\n').filter(Boolean).slice(-5).join('\n');
          store.updateRunStatus(runId, ModelEvalRunStatus.Failed, {
            finishedAt: Date.now(),
            error: `lm-eval 退出码 ${code}：${tail || '未知错误'}`,
          });
          this.emitRun(store.getRun(runId));
        }
        resolve();
      });
    });
  }

  private finalizeRun(runId: string, outputDir: string, taskName: string): void {
    const store = this.deps.getModelEvalStore();
    const run = store.getRun(runId);
    if (!run) return;

    const resultsFile = findNewestResultsFile(outputDir);
    let result: ModelEvalTaskResult = {
      runId,
      taskId: taskName,
      exactMatch: null,
      f1: null,
      gaiaExact: null,
      gaiaContainment: null,
      samples: [],
    };
    if (resultsFile) {
      const parsed = parseResultsFile(resultsFile, taskName);
      result = { ...result, ...parsed };
    }
    const samplesFile = findSamplesFile(outputDir);
    if (samplesFile) {
      result.samples = parseSamplesFile(samplesFile);
    }
    store.upsertTaskResult(result);
    store.updateRunStatus(runId, ModelEvalRunStatus.Completed, { finishedAt: Date.now(), error: null });
    this.emitRun(store.getRun(runId));
  }

  private emitRun(run: ModelEvalRun | null): void {
    if (!run) return;
    this.deps.emit({ type: 'runStatusChange', payload: run });
  }
}
