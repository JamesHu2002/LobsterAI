import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import { IpcChannel, BenchmarkRunStatus } from '../../../benchmark/constants';
import type {
  BenchmarkRun,
  BenchmarkRunConfig,
  BenchmarkRunnerEvent,
  DatasetLoadProgressEvent,
} from '../../../benchmark/types';
import type { BenchmarkStore } from '../../benchmarkStore';
import type { BenchmarkRunner } from '../../benchmark/benchmarkRunner';
import type { DatasetLoader } from '../../benchmark/datasetLoader';
import type { SqliteStore } from '../../sqliteStore';

export interface BenchmarkHandlerDeps {
  getBenchmarkStore: () => BenchmarkStore;
  getBenchmarkRunner: () => BenchmarkRunner;
  getDatasetLoader: () => DatasetLoader;
  getStore: () => SqliteStore;
}

const BENCHMARK_CONFIG_KEY = 'benchmark_config';

function errorPayload(error: unknown, fallback: string) {
  return { success: false, error: error instanceof Error ? error.message : fallback };
}

export function registerBenchmarkHandlers(deps: BenchmarkHandlerDeps): void {
  const { getBenchmarkStore, getBenchmarkRunner, getDatasetLoader } = deps;

  ipcMain.handle(IpcChannel.ListRuns, async () => {
    try {
      const runs = getBenchmarkStore().listRuns();
      return { success: true, runs };
    } catch (error) {
      return errorPayload(error, 'Failed to list benchmark runs');
    }
  });

  ipcMain.handle(IpcChannel.GetRun, async (_event, id: string) => {
    try {
      return { success: true, run: getBenchmarkStore().getRun(id) };
    } catch (error) {
      return errorPayload(error, 'Failed to get benchmark run');
    }
  });

  ipcMain.handle(
    IpcChannel.StartRun,
    async (_event, config: BenchmarkRunConfig, modelLabels?: string[]) => {
      try {
        if (!config || !config.datasetId || !Array.isArray(config.modelRefs) || config.modelRefs.length === 0) {
          return { success: false, error: '评测配置不完整：请选择评测集与至少一个模型。' };
        }
        const loader = getDatasetLoader();
        const tasks = await loader.getTasks(config.datasetId);
        const total = config.taskIds && config.taskIds.length > 0 ? config.taskIds.length : tasks.length;
        if (total === 0) {
          return { success: false, error: '评测集为空，请先加载数据集。' };
        }

        const store = getBenchmarkStore();
        const runner = getBenchmarkRunner();
        const datasetLabel = loader.list().find((d) => d.id === config.datasetId)?.label ?? config.datasetId;
        const labels = modelLabels ?? [];
        const runIds: string[] = [];

        for (let i = 0; i < config.modelRefs.length; i += 1) {
          const ref = config.modelRefs[i];
          const modelLabel = labels[i] ?? ref.split('/').pop() ?? ref;
          const runId = randomUUID();
          const run: BenchmarkRun = {
            id: runId,
            datasetId: config.datasetId,
            datasetLabel,
            modelRef: ref,
            modelLabel,
            config,
            status: BenchmarkRunStatus.Pending,
            total,
            done: 0,
            passed: 0,
            failed: 0,
            startedAt: Date.now(),
            finishedAt: null,
            error: null,
          };
          store.insertRun(run);
          void runner.run(runId, config, ref, modelLabel);
          runIds.push(runId);
        }
        return { success: true, runIds };
      } catch (error) {
        return errorPayload(error, 'Failed to start benchmark run');
      }
    },
  );

  ipcMain.handle(IpcChannel.CancelRun, async (_event, id: string) => {
    try {
      await getBenchmarkRunner().cancel(id);
      return { success: true };
    } catch (error) {
      return errorPayload(error, 'Failed to cancel benchmark run');
    }
  });

  ipcMain.handle(IpcChannel.DeleteRun, async (_event, id: string) => {
    try {
      getBenchmarkStore().deleteRun(id);
      return { success: true };
    } catch (error) {
      return errorPayload(error, 'Failed to delete benchmark run');
    }
  });

  ipcMain.handle(
    IpcChannel.ListTaskResults,
    async (_event, runId: string, limit = 50, offset = 0) => {
      try {
        const { results, total } = getBenchmarkStore().listTaskResults(runId, limit, offset);
        return { success: true, results, total, hasMore: offset + results.length < total };
      } catch (error) {
        return errorPayload(error, 'Failed to list benchmark task results');
      }
    },
  );

  ipcMain.handle(IpcChannel.GetReport, async (_event, runId: string) => {
    try {
      return { success: true, report: getBenchmarkStore().getReport(runId) };
    } catch (error) {
      return errorPayload(error, 'Failed to get benchmark report');
    }
  });

  ipcMain.handle(IpcChannel.DatasetList, async () => {
    try {
      return { success: true, datasets: getDatasetLoader().list() };
    } catch (error) {
      return errorPayload(error, 'Failed to list datasets');
    }
  });

  ipcMain.handle(IpcChannel.DatasetGetStatus, async (_event, datasetId: string) => {
    try {
      return { success: true, status: getDatasetLoader().getStatus(datasetId as never) };
    } catch (error) {
      return errorPayload(error, 'Failed to get dataset status');
    }
  });

  ipcMain.handle(
    IpcChannel.DatasetLoad,
    async (_event, datasetId: string, opts: { forceRefresh?: boolean } = {}) => {
      try {
        const tasks = await getDatasetLoader().load(datasetId as never, opts);
        return { success: true, tasks, size: tasks.length };
      } catch (error) {
        return errorPayload(error, '数据集加载失败');
      }
    },
  );

  ipcMain.handle(IpcChannel.SetHfToken, async (_event, token: string) => {
    try {
      const store = deps.getStore();
      const current = store.get<{ hfToken?: string }>(BENCHMARK_CONFIG_KEY) ?? {};
      store.set(BENCHMARK_CONFIG_KEY, { ...current, hfToken: token.trim() || undefined });
      return { success: true };
    } catch (error) {
      return errorPayload(error, 'Failed to save HF token');
    }
  });
}

/** Map a runner/loader event to the renderer IPC channel + payload. */
export function benchmarkEventChannel(
  event: BenchmarkRunnerEvent | DatasetLoadProgressEvent,
): { channel: string; payload: unknown } {
  if ('type' in event) {
    switch (event.type) {
      case 'progress':
        return { channel: IpcChannel.ProgressUpdate, payload: event.payload };
      case 'taskCompleted':
        return { channel: IpcChannel.TaskCompleted, payload: event.payload };
      case 'runStatusChange':
        return { channel: IpcChannel.RunStatusChange, payload: event.payload };
      default:
        return { channel: IpcChannel.ProgressUpdate, payload: event };
    }
  }
  // DatasetLoadProgressEvent (uses `phase`, not `type`)
  return { channel: IpcChannel.DatasetLoadProgress, payload: event };
}
