import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import fs from 'fs';

import { ModelEvalIpc, ModelEvalRunStatus } from '../../../modelEval/constants';
import type {
  ModelEvalRun,
  ModelEvalRunConfig,
  ModelEvalRunnerEvent,
} from '../../../modelEval/types';
import type { LmEvalInstaller } from '../../modelEval/lmEvalInstaller';
import type { LmEvalRunner } from '../../modelEval/lmEvalRunner';
import type { ModelEvalStore } from '../../modelEval/modelEvalStore';

export interface ModelEvalHandlerDeps {
  getModelEvalStore: () => ModelEvalStore;
  getModelEvalRunner: () => LmEvalRunner;
  getLmEvalInstaller: () => LmEvalInstaller;
  getRunOutputDir: (runId: string) => string;
}

function errorPayload(error: unknown, fallback: string) {
  return { success: false, error: error instanceof Error ? error.message : fallback };
}

/** Map a runner event to { channel, payload } for webContents.send. */
export function modelEvalEventChannel(event: ModelEvalRunnerEvent): {
  channel: string;
  payload: unknown;
} {
  switch (event.type) {
    case 'runStatusChange':
      return { channel: ModelEvalIpc.RunStatusChange, payload: event.payload };
    case 'progress':
      return { channel: ModelEvalIpc.ProgressUpdate, payload: event.payload };
    case 'installProgress':
      return { channel: ModelEvalIpc.InstallProgress, payload: event.payload };
  }
}

export function registerModelEvalHandlers(deps: ModelEvalHandlerDeps): void {
  const { getModelEvalStore, getModelEvalRunner, getLmEvalInstaller } = deps;

  ipcMain.handle(ModelEvalIpc.ListRuns, async () => {
    try {
      return { success: true, runs: getModelEvalStore().listRuns() };
    } catch (error) {
      return errorPayload(error, 'Failed to list model-eval runs');
    }
  });

  ipcMain.handle(ModelEvalIpc.GetRun, async (_event, id: string) => {
    try {
      const run = getModelEvalStore().getRun(id);
      const results = run ? getModelEvalStore().listTaskResults(id) : [];
      return { success: true, run, results };
    } catch (error) {
      return errorPayload(error, 'Failed to get model-eval run');
    }
  });

  ipcMain.handle(ModelEvalIpc.StartRun, async (_event, config: ModelEvalRunConfig) => {
    try {
      const hasTask = !!config?.builtinTask || !!config?.datasetId;
      if (!hasTask || !config?.modelRef) {
        return { success: false, error: '请选择评测集与模型。' };
      }
      const installer = getLmEvalInstaller();
      const install = installer.getStatus();
      if (install.status !== 'ready') {
        return { success: false, error: '评测框架尚未安装，请先点击「安装评测框架」。' };
      }
      const runId = randomUUID();
      const run: ModelEvalRun = {
        id: runId,
        modelRef: config.modelRef,
        modelLabel: config.modelLabel ?? config.modelRef,
        config,
        status: ModelEvalRunStatus.Pending,
        tasks: [],
        total: 0,
        outputDir: deps.getRunOutputDir(runId),
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
      };
      getModelEvalStore().insertRun(run);
      getModelEvalRunner().run(runId, config);
      return { success: true, runId };
    } catch (error) {
      return errorPayload(error, 'Failed to start model-eval run');
    }
  });

  ipcMain.handle(ModelEvalIpc.CancelRun, async (_event, id: string) => {
    try {
      await getModelEvalRunner().cancel(id);
      return { success: true };
    } catch (error) {
      return errorPayload(error, 'Failed to cancel model-eval run');
    }
  });

  ipcMain.handle(ModelEvalIpc.DeleteRun, async (_event, id: string) => {
    try {
      const store = getModelEvalStore();
      const run = store.getRun(id);
      if (run) {
        try {
          fs.rmSync(run.outputDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      store.deleteRun(id);
      return { success: true };
    } catch (error) {
      return errorPayload(error, 'Failed to delete model-eval run');
    }
  });

  ipcMain.handle(ModelEvalIpc.InstallStatus, async () => {
    try {
      return { success: true, status: getLmEvalInstaller().getStatus() };
    } catch (error) {
      return errorPayload(error, 'Failed to read install status');
    }
  });

  ipcMain.handle(ModelEvalIpc.EnsureInstalled, async () => {
    try {
      const result = await getLmEvalInstaller().ensureInstalled();
      return { success: result.success, status: getLmEvalInstaller().getStatus(), error: result.error };
    } catch (error) {
      return errorPayload(error, 'Failed to install eval framework');
    }
  });
}
