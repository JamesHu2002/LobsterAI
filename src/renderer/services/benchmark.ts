import type {
  BenchmarkProgressUpdateEvent,
  BenchmarkRun,
  BenchmarkRunConfig,
  BenchmarkTaskResult,
  DatasetLoadProgressEvent,
} from '../../benchmark/types';
import { store } from '../store';
import {
  addRun,
  appendTaskResult,
  appendTaskResults,
  setDatasets,
  setDatasetLoading,
  setDatasetStatus,
  setReport,
  setReportStatus,
  setRuns,
  setRunListStatus,
  setTaskResults,
  updateRun,
  updateRunProgress,
} from '../store/slices/benchmarkSlice';

function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
}

export class BenchmarkService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.setupListeners();
    await Promise.allSettled([this.loadRuns(), this.loadDatasets()]);
  }

  destroy(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.benchmark;
    if (!api) return;

    const cleanupProgress = api.onProgressUpdate((event: BenchmarkProgressUpdateEvent) => {
      store.dispatch(updateRunProgress(event));
    });
    this.cleanupFns.push(cleanupProgress);

    const cleanupTask = api.onTaskCompleted((result: BenchmarkTaskResult) => {
      store.dispatch(appendTaskResult(result));
    });
    this.cleanupFns.push(cleanupTask);

    const cleanupRun = api.onRunStatusChange((run: BenchmarkRun) => {
      store.dispatch(updateRun(run));
    });
    this.cleanupFns.push(cleanupRun);

    const cleanupDataset = api.onDatasetLoadProgress((event: DatasetLoadProgressEvent) => {
      if (event.phase === 'done') {
        store.dispatch(setDatasetLoading({ datasetId: event.datasetId, loading: false }));
        void this.refreshDatasetStatus(event.datasetId);
      } else if (event.phase === 'error') {
        store.dispatch(setDatasetLoading({ datasetId: event.datasetId, loading: false }));
        void this.refreshDatasetStatus(event.datasetId);
      } else {
        store.dispatch(setDatasetLoading({ datasetId: event.datasetId, loading: true }));
      }
    });
    this.cleanupFns.push(cleanupDataset);
  }

  async loadRuns(): Promise<void> {
    const api = window.electron?.benchmark;
    if (!api) return;
    try {
      store.dispatch(setRunListStatus('loading'));
      const res = await api.listRuns();
      if (res.success && res.runs) {
        store.dispatch(setRuns(res.runs));
      } else if (res.error) {
        store.dispatch(setRunListStatus('error'));
      }
    } catch {
      store.dispatch(setRunListStatus('error'));
    }
  }

  async loadDatasets(): Promise<void> {
    const api = window.electron?.benchmark;
    if (!api) return;
    try {
      const res = await api.datasetList();
      if (res.success && res.datasets) {
        store.dispatch(setDatasets(res.datasets));
      }
    } catch {
      // ignore
    }
  }

  async importCustomDataset(filePath: string): Promise<boolean> {
    const api = window.electron?.benchmark;
    if (!api) return false;
    try {
      const res = await api.importCustomDataset(filePath);
      if (res.success) {
        await this.loadDatasets();
        return true;
      }
      if (res.error) showToast(res.error);
      return false;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '自定义数据集导入失败');
      return false;
    }
  }

  async setHfToken(token: string): Promise<void> {
    const api = window.electron?.benchmark;
    if (!api) return;
    try {
      await api.setHfToken(token);
    } catch {
      // ignore
    }
  }

  async refreshDatasetStatus(datasetId: string): Promise<void> {
    const api = window.electron?.benchmark;
    if (!api) return;
    try {
      const res = await api.datasetGetStatus(datasetId);
      if (res.success && res.status) {
        store.dispatch(setDatasetStatus({ datasetId, status: res.status }));
      }
    } catch {
      // ignore
    }
  }

  async loadDataset(datasetId: string, forceRefresh = false): Promise<boolean> {
    const api = window.electron?.benchmark;
    if (!api) return false;
    store.dispatch(setDatasetLoading({ datasetId, loading: true }));
    try {
      const res = await api.datasetLoad(datasetId, { forceRefresh });
      if (res.success) {
        await this.refreshDatasetStatus(datasetId);
        return true;
      }
      if (res.error) {
        showToast(res.error);
        await this.refreshDatasetStatus(datasetId);
        return false;
      }
      return false;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '数据集加载失败');
      await this.refreshDatasetStatus(datasetId);
      return false;
    } finally {
      store.dispatch(setDatasetLoading({ datasetId, loading: false }));
    }
  }

  async startRun(config: BenchmarkRunConfig, modelLabels?: string[]): Promise<string[]> {
    const api = window.electron?.benchmark;
    if (!api) return [];
    try {
      const res = await api.startRun(config, modelLabels);
      if (res.success && res.runIds) {
        for (const id of res.runIds) {
          const get = await api.getRun(id);
          if (get.success && get.run) {
            store.dispatch(addRun(get.run));
          }
        }
        return res.runIds;
      }
      if (res.error) showToast(res.error);
      return [];
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动评测失败');
      return [];
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const api = window.electron?.benchmark;
    if (!api) return;
    try {
      await api.cancelRun(runId);
    } catch {
      // ignore
    }
  }

  async deleteRun(runId: string): Promise<void> {
    const api = window.electron?.benchmark;
    if (!api) return;
    try {
      const res = await api.deleteRun(runId);
      if (res.success) {
        await this.loadRuns();
      } else if (res.error) {
        showToast(res.error);
      }
    } catch {
      // ignore
    }
  }

  async loadReport(runId: string): Promise<void> {
    const api = window.electron?.benchmark;
    if (!api) return;
    store.dispatch(setReportStatus('loading'));
    try {
      const res = await api.getReport(runId);
      if (res.success) {
        store.dispatch(setReport(res.report ?? null));
      } else {
        store.dispatch(setReportStatus('error'));
      }
    } catch {
      store.dispatch(setReportStatus('error'));
    }
  }

  async loadTaskResults(runId: string, limit = 50, offset = 0, append = false): Promise<boolean> {
    const api = window.electron?.benchmark;
    if (!api) return false;
    try {
      const res = await api.listTaskResults(runId, limit, offset);
      if (res.success && res.results) {
        const payload = { results: res.results, total: res.total ?? 0, hasMore: res.hasMore ?? false };
        if (append) {
          store.dispatch(appendTaskResults(payload));
        } else {
          store.dispatch(setTaskResults(payload));
        }
        return res.hasMore ?? false;
      }
      return false;
    } catch {
      return false;
    }
  }
}

export const benchmarkService = new BenchmarkService();
