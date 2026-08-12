import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { LmEvalInstallStatus, ModelEvalDefaults } from '../../modelEval/constants';
import type { LmEvalInstallInfo } from '../../modelEval/types';
import {
  ensurePythonPipReady,
  ensurePythonRuntimeReady,
  getUserPythonRoot,
} from '../libs/pythonRuntime';
import type { SqliteStore } from '../sqliteStore';

const INSTALL_STORE_KEY = 'model_eval_install';

function pythonExe(): string {
  const root = getUserPythonRoot();
  const candidates = [path.join(root, 'python.exe'), path.join(root, 'python3.exe')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export class LmEvalInstaller {
  private running = false;

  constructor(
    private deps: {
      getStore: () => SqliteStore;
      emit: (event: { phase: 'downloading' | 'done' | 'error'; message?: string }) => void;
    },
  ) {}

  getStatus(): LmEvalInstallInfo {
    const stored = this.deps.getStore().get<LmEvalInstallInfo>(INSTALL_STORE_KEY);
    return stored ?? { status: LmEvalInstallStatus.NotInstalled };
  }

  private setStatus(info: LmEvalInstallInfo): void {
    this.deps.getStore().set(INSTALL_STORE_KEY, info);
  }

  async ensureInstalled(): Promise<{ success: boolean; error?: string }> {
    const current = this.getStatus();
    if (current.status === LmEvalInstallStatus.Ready) return { success: true };
    if (this.running) return { success: false, error: '评测框架安装中，请稍候' };
    this.running = true;
    this.setStatus({ status: LmEvalInstallStatus.Installing });
    try {
      const runtime = await ensurePythonRuntimeReady();
      if (!runtime.success) {
        const error = runtime.error || 'Python 运行时不可用';
        this.setStatus({ status: LmEvalInstallStatus.Error, error });
        return { success: false, error };
      }
      const pip = await ensurePythonPipReady();
      if (!pip.success) {
        const error = pip.error || 'pip 不可用';
        this.setStatus({ status: LmEvalInstallStatus.Error, error });
        return { success: false, error };
      }

      const installResult = await this.installLmEval();
      if (!installResult.success) {
        this.setStatus({ status: LmEvalInstallStatus.Error, error: installResult.error });
        return installResult;
      }
      this.setStatus({
        status: LmEvalInstallStatus.Ready,
        version: ModelEvalDefaults.lmEvalVersion,
        installedAt: Date.now(),
        error: undefined,
      });
      this.deps.emit({ phase: 'done', message: '评测框架安装完成' });
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.setStatus({ status: LmEvalInstallStatus.Error, error: msg });
      return { success: false, error: msg };
    } finally {
      this.running = false;
    }
  }

  private installLmEval(): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const child = spawn(pythonExe(), ['-m', 'pip', 'install', ModelEvalDefaults.lmEvalVersion], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrTail = '';
      const emitThrottled = () => {
        const last = stderrTail.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
        this.deps.emit({ phase: 'downloading', message: last || '安装评测框架中…' });
      };
      child.stdout?.on('data', () => emitThrottled());
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
        emitThrottled();
      });
      child.on('error', (err) => resolve({ success: false, error: String(err) }));
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          const tail = stderrTail.trim().split('\n').filter(Boolean).slice(-5).join('\n');
          resolve({ success: false, error: `pip 安装失败（退出码 ${code}）：${tail || '未知错误'}` });
        }
      });
    });
  }
}
