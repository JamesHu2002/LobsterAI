import type {
  SkillFactoryRun,
  SkillFactorySourceRef,
  SkillFactoryStartInput,
} from '../../skillFactory/types';
import { store } from '../store';
import {
  addRun,
  setRunListStatus,
  setRuns,
  updateRun,
  updateRunStage,
} from '../store/slices/skillFactorySlice';

function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
}

export class SkillFactoryService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.setupListeners();
    await this.loadRuns();
  }

  destroy(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.skillFactory;
    if (!api) return;

    const cleanupRun = api.onRunStatusChange((run: SkillFactoryRun) => {
      store.dispatch(updateRun(run));
    });
    this.cleanupFns.push(cleanupRun);

    const cleanupProgress = api.onProgressUpdate((event: { runId: string; stage: SkillFactoryRun['stage'] }) => {
      store.dispatch(updateRunStage(event));
    });
    this.cleanupFns.push(cleanupProgress);
  }

  async loadRuns(): Promise<void> {
    const api = window.electron?.skillFactory;
    if (!api) return;
    store.dispatch(setRunListStatus('loading'));
    const result = await api.listRuns();
    if (result.success && result.runs) {
      store.dispatch(setRuns(result.runs));
    } else {
      store.dispatch(setRunListStatus('error'));
    }
  }

  async startRun(input: SkillFactoryStartInput): Promise<string | null> {
    const api = window.electron?.skillFactory;
    if (!api) return null;
    const result = await api.startRun(input);
    if (result.success && result.runId) {
      const run = await this.fetchRun(result.runId);
      if (run) store.dispatch(addRun(run));
      return result.runId;
    }
    if (result.error) showToast(result.error);
    return null;
  }

  async fetchRun(runId: string): Promise<SkillFactoryRun | null> {
    const api = window.electron?.skillFactory;
    if (!api) return null;
    const result = await api.getRun(runId);
    return result.success && result.run ? result.run : null;
  }

  async installRun(runId: string): Promise<{ success: boolean; needConfirm?: boolean; error?: string }> {
    const api = window.electron?.skillFactory;
    if (!api) return { success: false };
    const result = await api.installRun(runId);
    if (result.success) {
      const run = await this.fetchRun(runId);
      if (run) store.dispatch(updateRun(run));
      showToast('技能已安装');
    } else if (!result.needConfirm && result.error) {
      showToast(result.error);
    }
    return result;
  }

  async deleteRun(runId: string): Promise<void> {
    const api = window.electron?.skillFactory;
    if (!api) return;
    await api.deleteRun(runId);
  }

  async openOutputDir(runId: string): Promise<void> {
    const api = window.electron?.skillFactory;
    if (!api) return;
    await api.openOutputDir(runId);
  }

  async getArtifact(runId: string, relPath: string): Promise<string | null> {
    const api = window.electron?.skillFactory;
    if (!api) return null;
    const result = await api.getArtifact(runId, relPath);
    if (result.success) {
      return result.text ?? (result.base64 ? atob(result.base64) : null);
    }
    return null;
  }

  async listSessions(limit = 50): Promise<SkillFactorySourceRef[]> {
    const api = window.electron?.skillFactory;
    if (!api) return [];
    const result = await api.listSessions(limit);
    return result.success && result.rows ? result.rows : [];
  }

  async listWorkflowRuns(limit = 50): Promise<SkillFactorySourceRef[]> {
    const api = window.electron?.skillFactory;
    if (!api) return [];
    const result = await api.listWorkflowRuns(limit);
    return result.success && result.rows ? result.rows : [];
  }

  async listImConversations(): Promise<SkillFactorySourceRef[]> {
    const api = window.electron?.skillFactory;
    if (!api) return [];
    const result = await api.listImConversations();
    return result.success && result.rows ? result.rows : [];
  }

  async listSkillUsageSessions(skillId: string): Promise<SkillFactorySourceRef[]> {
    const api = window.electron?.skillFactory;
    if (!api) return [];
    const result = await api.listSkillUsageSessions(skillId, 30);
    return result.success && result.rows ? result.rows : [];
  }
}

export const skillFactoryService = new SkillFactoryService();
