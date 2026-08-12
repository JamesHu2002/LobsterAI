import type {
  LmEvalInstallInfo,
  ModelEvalRun,
  ModelEvalRunConfig,
  ModelEvalTaskResult,
} from '../../modelEval/types';
import { store } from '../store';
import {
  addRun,
  setInstallStatus,
  setRunListStatus,
  setRuns,
  setTaskResults,
  updateRun,
} from '../store/slices/modelEvalSlice';

function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
}

export class ModelEvalService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.setupListeners();
    await Promise.all([this.loadRuns(), this.loadInstallStatus()]);
  }

  destroy(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.modelEval;
    if (!api) return;

    this.cleanupFns.push(
      api.onRunStatusChange((run: ModelEvalRun) => store.dispatch(updateRun(run))),
    );
    this.cleanupFns.push(
      api.onInstallProgress(() => {
        void this.loadInstallStatus();
      }),
    );
  }

  async loadRuns(): Promise<void> {
    const api = window.electron?.modelEval;
    if (!api) return;
    store.dispatch(setRunListStatus('loading'));
    const result = await api.listRuns();
    if (result.success && result.runs) {
      store.dispatch(setRuns(result.runs));
    } else {
      store.dispatch(setRunListStatus('error'));
    }
  }

  async loadInstallStatus(): Promise<LmEvalInstallInfo | null> {
    const api = window.electron?.modelEval;
    if (!api) return null;
    const result = await api.installStatus();
    const status = result.success && result.status ? result.status : null;
    store.dispatch(setInstallStatus(status));
    return status;
  }

  async startRun(config: ModelEvalRunConfig): Promise<string | null> {
    const api = window.electron?.modelEval;
    if (!api) return null;
    const result = await api.startRun(config);
    if (result.success && result.runId) {
      const run = await this.fetchRun(result.runId);
      if (run) store.dispatch(addRun(run));
      return result.runId;
    }
    if (result.error) showToast(result.error);
    return null;
  }

  async fetchRun(runId: string): Promise<ModelEvalRun | null> {
    const api = window.electron?.modelEval;
    if (!api) return null;
    const result = await api.getRun(runId);
    if (result.success && result.run) {
      if (result.results) store.dispatch(setTaskResults(result.results));
      return result.run;
    }
    return null;
  }

  async cancelRun(runId: string): Promise<void> {
    await window.electron?.modelEval?.cancelRun(runId);
  }

  async deleteRun(runId: string): Promise<void> {
    await window.electron?.modelEval?.deleteRun(runId);
  }

  async ensureInstalled(): Promise<LmEvalInstallInfo | null> {
    const api = window.electron?.modelEval;
    if (!api) return null;
    const result = await api.ensureInstalled();
    await this.loadInstallStatus();
    if (!result.success && result.error) showToast(result.error);
    return result.status ?? null;
  }

  async loadTaskResults(runId: string): Promise<ModelEvalTaskResult[]> {
    const api = window.electron?.modelEval;
    if (!api) return [];
    const result = await api.getRun(runId);
    if (result.success && result.results) {
      store.dispatch(setTaskResults(result.results));
      return result.results;
    }
    return [];
  }
}

export const modelEvalService = new ModelEvalService();
