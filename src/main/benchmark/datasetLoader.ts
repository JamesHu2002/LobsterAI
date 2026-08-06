import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import {
  BenchmarkDatasetId,
  DatasetSource,
} from '../../benchmark/constants';
import type {
  BenchmarkDatasetInfo,
  BenchmarkTask,
  DatasetLoadPhase,
  DatasetLoadProgressEvent,
  DatasetStatus,
} from '../../benchmark/types';
import { fetchWithSystemProxy } from '../im/http';

interface DatasetFileDef {
  name: string;
  url: string;
}

interface DatasetDef {
  id: BenchmarkDatasetId;
  label: string;
  description: string;
  files: DatasetFileDef[];
  parse: (files: Record<string, string | Uint8Array>, rawByFileName: Record<string, string>) => BenchmarkTask[];
}

// ─── Dataset definitions ─────────────────────────────────────────────────────

const gaiaValidationUrl = `${DatasetSource.hfBaseUrl}/datasets/${DatasetSource.gaiaRepo}/resolve/main/${DatasetSource.gaiaValidationMetadataPath}`;

const agentBenchLtpUrl = (fileName: string) =>
  `${DatasetSource.ghRawBaseUrl}/${DatasetSource.agentBenchRepo}/main/${DatasetSource.agentBenchLtpDir}/${fileName}`;

const DATASET_DEFS: Record<BenchmarkDatasetId, DatasetDef> = {
  [BenchmarkDatasetId.Gaia2023Val]: {
    id: BenchmarkDatasetId.Gaia2023Val,
    label: 'GAIA (2023 validation)',
    description:
      'General AI Assistants 基准，166 道需工具使用与多步推理的真实问题（HF 门禁数据集，需 HF Token 授权）。',
    files: [
      { name: 'metadata.jsonl', url: gaiaValidationUrl },
    ],
    parse: (_files, rawByFileName) => {
      const raw = rawByFileName['metadata.jsonl'];
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const r = JSON.parse(line) as {
            task_id?: string;
            Question?: string;
            'Final answer'?: string;
            Level?: string | number;
            file_name?: string | null;
            file_path?: string | null;
            'Annotator Metadata'?: unknown;
          };
          const id = r.task_id ?? crypto.randomUUID();
          return {
            id: String(id),
            datasetId: BenchmarkDatasetId.Gaia2023Val,
            prompt: r.Question ?? '',
            referenceAnswer: r['Final answer'] ?? null,
            category: r.Level != null ? String(r.Level) : null,
            extra: {
              file_name: r.file_name ?? null,
              file_path: r.file_path ?? null,
              annotations: r['Annotator Metadata'] ?? null,
            },
          };
        });
    },
  },
  [BenchmarkDatasetId.AgentBenchLateral]: {
    id: BenchmarkDatasetId.AgentBenchLateral,
    label: 'AgentBench · 横向思维谜题',
    description:
      'AgentBench 的 Lateral Thinking Puzzle 子集（GitHub THUDM/AgentBench），自包含、无需外部环境，考察推理与准确作答。',
    files: [
      { name: 'standard.xlsx', url: agentBenchLtpUrl('standard.xlsx') },
      { name: 'dev.xlsx', url: agentBenchLtpUrl('dev.xlsx') },
    ],
    parse: (files) => {
      const tasks: BenchmarkTask[] = [];
      for (const fileName of ['standard.xlsx', 'dev.xlsx']) {
        const data = files[fileName];
        if (!data) continue;
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!sheet) continue;
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const prompt = pickCell(row, ['question', 'puzzle', 'instruction', 'problem', 'description']);
          const answer = pickCell(row, ['answer', 'reference_answer', 'solution', 'reference']);
          if (!prompt) continue;
          tasks.push({
            id: `agentbench-lateral-${tasks.length + 1}`,
            datasetId: BenchmarkDatasetId.AgentBenchLateral,
            prompt,
            referenceAnswer: answer || null,
            category: 'lateral-thinking',
            extra: { source: fileName, index: i + 1 },
          });
        }
      }
      return tasks;
    },
  },
};

function pickCell(
  row: Record<string, unknown>,
  candidates: string[],
): string {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) {
    lower.set(k.toLowerCase().replace(/[\s_-]+/g, ''), String(v ?? '').trim());
  }
  for (const c of candidates) {
    const key = c.toLowerCase().replace(/[\s_-]+/g, '');
    if (lower.has(key) && lower.get(key)) return lower.get(key) as string;
  }
  // fall back to the first non-empty column value
  for (const v of Object.values(row)) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

// ─── Dataset loader ──────────────────────────────────────────────────────────

export interface DatasetLoaderOptions {
  /** Optional HF token for gated datasets (GAIA). */
  getHfToken?: () => string | null;
  /** Progress callback (bytes) while downloading. */
  emitProgress: (event: DatasetLoadProgressEvent) => void;
}

export class DatasetLoader {
  private cacheDir = path.join(app.getPath('userData'), 'benchmark', 'datasets');

  constructor(private options: DatasetLoaderOptions) {}

  private datasetDir(datasetId: BenchmarkDatasetId): string {
    return path.join(this.cacheDir, datasetId);
  }

  private metaPath(datasetId: BenchmarkDatasetId): string {
    return path.join(this.datasetDir(datasetId), '.meta.json');
  }

  private filePath(datasetId: BenchmarkDatasetId, fileName: string): string {
    return path.join(this.datasetDir(datasetId), fileName);
  }

  list(): BenchmarkDatasetInfo[] {
    return Object.values(DATASET_DEFS).map((def) => {
      const status = this.readStatus(def.id);
      return {
        id: def.id,
        label: def.label,
        description: def.description,
        size: status.taskCount ?? undefined,
        cached: status.cached,
        lastLoadedAt: status.lastLoadedAt ?? undefined,
        loadError: status.loadError,
      };
    });
  }

  getStatus(datasetId: BenchmarkDatasetId): DatasetStatus {
    return this.readStatus(datasetId);
  }

  private readStatus(datasetId: BenchmarkDatasetId): DatasetStatus {
    const dir = this.datasetDir(datasetId);
    const def = DATASET_DEFS[datasetId];
    const cached = def.files.every((f) => {
      const p = this.filePath(datasetId, f.name);
      try {
        return fs.existsSync(p) && fs.statSync(p).size > 0;
      } catch {
        return false;
      }
    });
    let taskCount: number | null = null;
    let lastLoadedAt: number | null = null;
    let loadError: string | null = null;
    try {
      if (fs.existsSync(this.metaPath(datasetId))) {
        const meta = JSON.parse(fs.readFileSync(this.metaPath(datasetId), 'utf-8')) as {
          taskCount?: number;
          lastLoadedAt?: number;
          loadError?: string | null;
        };
        taskCount = meta.taskCount ?? null;
        lastLoadedAt = meta.lastLoadedAt ?? null;
        loadError = meta.loadError ?? null;
      }
    } catch {
      // ignore corrupt meta
    }
    return { cached, taskCount, lastLoadedAt, loadError, loading: false };
  }

  async load(
    datasetId: BenchmarkDatasetId,
    opts: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<BenchmarkTask[]> {
    const def = DATASET_DEFS[datasetId];
    const cachedTasks = await this.getTasksIfCached(datasetId);
    if (cachedTasks && !opts.forceRefresh) {
      return cachedTasks;
    }

    fs.mkdirSync(this.datasetDir(datasetId), { recursive: true });
    const files: Record<string, string | Uint8Array> = {};
    const rawByFileName: Record<string, string> = {};

    for (const file of def.files) {
      this.options.emitProgress({
        datasetId,
        bytes: 0,
        totalBytes: null,
        phase: 'downloading',
        message: file.name,
      });
      const buf = await this.download(file.url, file.name, datasetId, opts.signal);
      files[file.name] = buf;
      if (file.name.endsWith('.jsonl')) {
        rawByFileName[file.name] = new TextDecoder('utf-8').decode(buf);
      }
      fs.writeFileSync(this.filePath(datasetId, file.name), buf);
    }

    this.options.emitProgress({ datasetId, bytes: 0, totalBytes: null, phase: 'parsing' });
    const tasks = def.parse(files, rawByFileName);

    fs.writeFileSync(
      this.metaPath(datasetId),
      JSON.stringify({ taskCount: tasks.length, lastLoadedAt: Date.now(), loadError: null }, null, 2),
    );
    this.options.emitProgress({
      datasetId,
      bytes: 0,
      totalBytes: null,
      phase: 'done',
      message: `${tasks.length} tasks`,
    });
    return tasks;
  }

  async getTasks(datasetId: BenchmarkDatasetId): Promise<BenchmarkTask[]> {
    const tasks = await this.getTasksIfCached(datasetId);
    if (!tasks) {
      throw new Error('数据集尚未下载，请先在评测面板中加载。');
    }
    return tasks;
  }

  private async getTasksIfCached(datasetId: BenchmarkDatasetId): Promise<BenchmarkTask[] | null> {
    const def = DATASET_DEFS[datasetId];
    const files: Record<string, string | Uint8Array> = {};
    const rawByFileName: Record<string, string> = {};
    const dir = this.datasetDir(datasetId);
    for (const file of def.files) {
      const p = this.filePath(datasetId, file.name);
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null;
      const buf = new Uint8Array(fs.readFileSync(p));
      files[file.name] = buf;
      if (file.name.endsWith('.jsonl')) {
        rawByFileName[file.name] = new TextDecoder('utf-8').decode(buf);
      }
    }
    try {
      return def.parse(files, rawByFileName);
    } catch (error) {
      console.error(`[Benchmark] failed to parse cached dataset ${datasetId}:`, error);
      return null;
    }
  }

  private async download(
    url: string,
    fileName: string,
    datasetId: BenchmarkDatasetId,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const headers: Record<string, string> = {};
    const token = this.options.getHfToken?.();
    if (token && (url.includes('huggingface.co') || url.includes('hf-mirror.com'))) {
      headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await fetchWithSystemProxy(url, { headers, signal });
    } catch (error) {
      this.recordLoadError(datasetId, `下载失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = this.classifyDownloadError(response.status, body);
      this.recordLoadError(datasetId, `${fileName}：${detail}`);
      throw new Error(`${fileName}：${detail}`);
    }

    const totalBytes = Number(response.headers.get('content-length')) || null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let lastEmit = Date.now();

    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          bytes += value.length;
        }
        const now = Date.now();
        if (bytes >= 512 * 1024 || now - lastEmit >= 1000) {
          lastEmit = now;
          this.options.emitProgress({
            datasetId,
            bytes,
            totalBytes,
            phase: 'downloading',
            message: fileName,
          });
        }
      }
    } else {
      const buf = await response.arrayBuffer();
      bytes = buf.byteLength;
      chunks.push(new Uint8Array(buf));
    }

    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return merged;
  }

  private classifyDownloadError(status: number, body: string): string {
    if (status === 401 || status === 403) {
      const lower = body.toLowerCase();
      if (lower.includes('gated') || lower.includes('restricted') || lower.includes('authorized')) {
        return '数据集已门禁（gated）：请先在 Hugging Face 同意 GAIA 数据集条款，并在评测设置中配置 HF Token。';
      }
      return 'HTTP 401/403：需要授权。请检查 HF Token 是否正确。';
    }
    if (status === 404) {
      return 'HTTP 404：远程文件不存在，可能已改版。';
    }
    return `HTTP ${status}`;
  }

  private recordLoadError(datasetId: BenchmarkDatasetId, message: string): void {
    try {
      const dir = this.datasetDir(datasetId);
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.existsSync(this.metaPath(datasetId))
        ? JSON.parse(fs.readFileSync(this.metaPath(datasetId), 'utf-8'))
        : {};
      fs.writeFileSync(
        this.metaPath(datasetId),
        JSON.stringify({ ...existing, loadError: message }, null, 2),
      );
    } catch {
      // best effort
    }
    this.options.emitProgress({
      datasetId,
      bytes: 0,
      totalBytes: null,
      phase: 'error',
      message,
    });
  }
}
