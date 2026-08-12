import { randomUUID } from 'crypto';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';

import { SkillFactoryIpc, SkillFactoryRunStatus } from '../../../skillFactory/constants';
import type {
  SkillFactoryInstallResult,
  SkillFactoryRun,
  SkillFactoryRunnerEvent,
  SkillFactorySecurityReport,
  SkillFactoryStartInput,
} from '../../../skillFactory/types';
import type { CoworkStore } from '../../coworkStore';
import { cpRecursiveSync } from '../../fsCompat';
import type { IMStore } from '../../im/imStore';
import type { OpenClawConfigImpact } from '../../libs/openclawConfigImpact';
import { mergeReports, scanMultipleSkillDirs } from '../../libs/skillSecurity/skillSecurityScanner';
import type { SkillFactoryRunner } from '../../skillFactory/skillFactoryRunner';
import { getSkillFactoryJobsRoot } from '../../skillFactory/skillFactoryRunner';
import type { SkillFactoryStore } from '../../skillFactory/skillFactoryStore';
import type { SkillManager } from '../../skills/skillManager';
import type { SqliteStore } from '../../sqliteStore';
import type { SubagentRunStore } from '../../subagentRunStore';

export interface SkillFactoryHandlerDeps {
  getSkillFactoryStore: () => SkillFactoryStore;
  getSkillFactoryRunner: () => SkillFactoryRunner;
  getStore: () => SqliteStore;
  getSkillManager: () => SkillManager;
  getCoworkStore: () => CoworkStore;
  getSubagentRunStore: () => SubagentRunStore;
  getIMStore: () => IMStore | null | undefined;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
    expectedImpact?: OpenClawConfigImpact;
  }) => Promise<{ success: boolean; changed: boolean; error?: string }>;
}

const SKILL_FILE_NAME = 'SKILL.md';
const SKILLS_DIR_NAME = 'SKILLs';

function errorPayload(error: unknown, fallback: string) {
  return { success: false, error: error instanceof Error ? error.message : fallback };
}

function getSkillsRoot(): string {
  return path.resolve(app.getPath('userData'), SKILLS_DIR_NAME);
}

function ensureSkillsRoot(): string {
  const root = getSkillsRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

function normalizeFolderName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'skill';
}

function normalizeWindowsAttrs(targetDir: string): void {
  if (process.platform !== 'win32') return;
  const { spawnSync } = require('child_process');
  const escapedPath = targetDir.replace(/"/g, '""');
  spawnSync('cmd.exe', ['/d', '/s', '/c', `attrib -r -s -h "${escapedPath}" /s /d`], {
    stdio: 'pipe',
    windowsHide: true,
    timeout: 10000,
  });
}

function notifySkillsChanged(): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send('skills:changed');
    }
  });
}

function collectSkillDirs(source: string): string[] {
  const resolved = path.resolve(source);
  const hasSkillMd = (dir: string) => fs.existsSync(path.join(dir, SKILL_FILE_NAME));
  if (hasSkillMd(resolved)) return [resolved];
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return [];
  return fs.readdirSync(resolved)
    .map((entry) => path.join(resolved, entry))
    .filter((entry) => {
      try {
        return fs.statSync(entry).isDirectory() && hasSkillMd(entry);
      } catch {
        return false;
      }
    });
}

function mapSecurityReport(report: Awaited<ReturnType<typeof mergeReports>>): SkillFactorySecurityReport | null {
  if (!report) return null;
  return {
    riskLevel: report.riskLevel,
    findings: (report.findings ?? []).map((f) => ({
      file: String(f.file ?? ''),
      ruleId: String(f.ruleId ?? ''),
      severity: String(f.severity ?? ''),
    })),
  };
}

/** Map a runner event to { channel, payload } for webContents.send. */
export function skillFactoryEventChannel(event: SkillFactoryRunnerEvent): {
  channel: string;
  payload: unknown;
} {
  switch (event.type) {
    case 'runStatusChange':
      return { channel: SkillFactoryIpc.RunStatusChange, payload: event.payload };
    case 'progress':
      return { channel: SkillFactoryIpc.ProgressUpdate, payload: event.payload };
  }
}

export function registerSkillFactoryHandlers(deps: SkillFactoryHandlerDeps): void {
  const { getSkillFactoryStore, getSkillFactoryRunner, getStore, getSkillManager, syncOpenClawConfig } = deps;

  ipcMain.handle(SkillFactoryIpc.ListRuns, async () => {
    try {
      return { success: true, runs: getSkillFactoryStore().listRuns() };
    } catch (error) {
      return errorPayload(error, 'Failed to list skill-factory runs');
    }
  });

  ipcMain.handle(SkillFactoryIpc.GetRun, async (_event, id: string) => {
    try {
      return { success: true, run: getSkillFactoryStore().getRun(id) };
    } catch (error) {
      return errorPayload(error, 'Failed to get skill-factory run');
    }
  });

  ipcMain.handle(SkillFactoryIpc.StartRun, async (_event, input: SkillFactoryStartInput) => {
    try {
      const source = input?.source ?? 'manual';
      const sourceRefs = Array.isArray(input?.sourceRefs) ? input.sourceRefs.filter((r) => typeof r === 'string') : [];
      const requirement = typeof input?.requirement === 'string' ? input.requirement.trim() : '';
      if (source === 'manual' && !requirement) {
        return { success: false, error: '请填写技能制作需求（或在来源中选择从会话/工作流提炼）。' };
      }
      if (source !== 'manual' && sourceRefs.length === 0) {
        return { success: false, error: '请选择至少一个交互/工作流样本。' };
      }
      const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : '未命名技能';
      const runId = randomUUID();
      const run: SkillFactoryRun = {
        id: runId,
        name,
        requirement,
        source,
        sourceRefs,
        docsDir: null,
        outputDir: path.join(getSkillFactoryJobsRoot(), runId, 'output'),
        status: SkillFactoryRunStatus.Pending,
        stage: null,
        evalReport: null,
        securityReport: null,
        skillName: null,
        installedSkillId: null,
        installedAt: null,
        createdAt: Date.now(),
        finishedAt: null,
        lastError: null,
      };
      getSkillFactoryStore().insertRun(run);
      const startInput: SkillFactoryStartInput = {
        name,
        requirement,
        docPaths: Array.isArray(input.docPaths) ? input.docPaths.filter((p) => typeof p === 'string') : [],
        source,
        sourceRefs,
      };
      getSkillFactoryRunner().run(runId, startInput);
      return { success: true, runId };
    } catch (error) {
      return errorPayload(error, 'Failed to start skill-factory run');
    }
  });

  ipcMain.handle(SkillFactoryIpc.ListSessions, async (_event, limit?: number, offset?: number) => {
    try {
      const rows = deps.getCoworkStore().listSessions(limit ?? 50, offset ?? 0).map((s) => ({
        ref: s.id,
        title: s.title || s.id.slice(0, 8),
        subtitle: `${s.agentId ?? 'main'} · ${new Date(s.updatedAt).toLocaleString()}`,
      }));
      return { success: true, rows };
    } catch (error) {
      return errorPayload(error, 'Failed to list sessions');
    }
  });

  ipcMain.handle(SkillFactoryIpc.ListWorkflowRuns, async (_event, limit?: number, offset?: number) => {
    try {
      const rows = deps.getSubagentRunStore().listRecentSubagentRuns(limit ?? 50, offset ?? 0).map((r) => ({
        ref: r.id,
        title: r.label ?? r.task ?? r.id.slice(0, 8),
        subtitle: `${r.status} · ${new Date(r.createdAt).toLocaleString()}`,
      }));
      return { success: true, rows };
    } catch (error) {
      return errorPayload(error, 'Failed to list workflow runs');
    }
  });

  ipcMain.handle(SkillFactoryIpc.ListImConversations, async () => {
    try {
      const imStore = deps.getIMStore?.();
      const mappings = imStore ? imStore.listSessionMappings() : [];
      const coworkStore = deps.getCoworkStore();
      const rows = mappings.slice(0, 100).map((m) => {
        const title = m.coworkSessionId
          ? (coworkStore.getSession(m.coworkSessionId, 0)?.title ?? m.imConversationId)
          : m.imConversationId;
        return {
          ref: `${m.imConversationId}:${m.platform}`,
          title,
          subtitle: `${m.platform} · ${m.agentId ?? 'main'}`,
        };
      });
      return { success: true, rows };
    } catch (error) {
      return errorPayload(error, 'Failed to list IM conversations');
    }
  });

  ipcMain.handle(
    SkillFactoryIpc.ListSkillUsageSessions,
    async (_event, skillId: string, limit?: number, offset?: number) => {
      try {
        if (!skillId) return { success: true, rows: [] };
        const rows = deps.getCoworkStore().listSessionsUsingSkill(skillId, limit ?? 30, offset ?? 0).map((s) => ({
          ref: s.id,
          title: s.title || s.id.slice(0, 8),
          subtitle: `${s.agentId ?? 'main'} · ${new Date(s.updatedAt).toLocaleString()}`,
        }));
        return { success: true, rows };
      } catch (error) {
        return errorPayload(error, 'Failed to list skill usage sessions');
      }
    },
  );

  ipcMain.handle(SkillFactoryIpc.CancelRun, async (_event, id: string) => {
    try {
      await getSkillFactoryRunner().cancel(id);
      return { success: true };
    } catch (error) {
      return errorPayload(error, 'Failed to cancel skill-factory run');
    }
  });

  ipcMain.handle(SkillFactoryIpc.DeleteRun, async (_event, id: string) => {
    try {
      const store = getSkillFactoryStore();
      const run = store.getRun(id);
      if (run) {
        try {
          fs.rmSync(path.dirname(run.outputDir), { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      store.deleteRun(id);
      return { success: true };
    } catch (error) {
      return errorPayload(error, 'Failed to delete skill-factory run');
    }
  });

  ipcMain.handle(
    SkillFactoryIpc.InstallRun,
    async (_event, id: string): Promise<SkillFactoryInstallResult> => {
      try {
        const store = getSkillFactoryStore();
        const run = store.getRun(id);
        if (!run) return { success: false, error: '未找到该制作任务' };
        if (run.status !== SkillFactoryRunStatus.Review && run.status !== SkillFactoryRunStatus.Installed) {
          return { success: false, error: '该任务尚未处于可安装状态' };
        }

        const skillDirs = collectSkillDirs(run.outputDir);
        if (skillDirs.length === 0) {
          return { success: false, error: '制作结果中未找到 SKILL.md（产出可能不完整）' };
        }

        // Security gate: only safe skills install automatically.
        const reports = await scanMultipleSkillDirs(skillDirs);
        const merged = mergeReports(reports);
        const securityReport = mapSecurityReport(merged);
        if (merged && merged.riskLevel !== 'safe') {
          return { success: false, needConfirm: true, securityReport: securityReport ?? undefined };
        }

        const skillManager = getSkillManager();
        skillManager.stopWatching();
        const root = ensureSkillsRoot();
        const installedSkillIds: string[] = [];
        for (const skillDir of skillDirs) {
          const folderName = normalizeFolderName(path.basename(skillDir));
          let targetDir = path.resolve(root, folderName);
          let suffix = 1;
          while (fs.existsSync(targetDir)) {
            targetDir = path.resolve(root, `${folderName}-${suffix}`);
            suffix += 1;
          }
          cpRecursiveSync(skillDir, targetDir);
          normalizeWindowsAttrs(targetDir);
          installedSkillIds.push(path.basename(targetDir));
        }

        const stateMap = getStore().get<Record<string, { enabled: boolean }>>('skills_state') ?? {};
        for (const skillId of installedSkillIds) {
          stateMap[skillId] = { enabled: true };
        }
        getStore().set('skills_state', stateMap);
        for (const skillId of installedSkillIds) {
          try {
            skillManager.setSkillEnabled(skillId, true);
          } catch {
            // ignore
          }
        }
        skillManager.startWatching();
        notifySkillsChanged();
        void syncOpenClawConfig({
          reason: 'skill-factory-install',
          restartGatewayIfRunning: false,
        }).catch(() => {});

        const installedSkillId = installedSkillIds[0] ?? null;
        if (installedSkillId) {
          store.markInstalled(run.id, installedSkillId);
        }
        return { success: true, skillId: installedSkillId ?? undefined, securityReport: securityReport ?? undefined };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '安装失败' };
      }
    },
  );

  ipcMain.handle(SkillFactoryIpc.OpenOutputDir, async (_event, id: string) => {
    try {
      const run = getSkillFactoryStore().getRun(id);
      if (!run || !fs.existsSync(run.outputDir)) return { success: false, error: '输出目录不存在' };
      await shell.openPath(run.outputDir);
      return { success: true };
    } catch (error) {
      return errorPayload(error, 'Failed to open output dir');
    }
  });

  ipcMain.handle(SkillFactoryIpc.GetArtifact, async (_event, id: string, relPath: string) => {
    try {
      const run = getSkillFactoryStore().getRun(id);
      if (!run) return { success: false, error: '未找到该制作任务' };
      const resolved = path.resolve(run.outputDir, relPath);
      if (!resolved.startsWith(path.resolve(run.outputDir))) {
        return { success: false, error: '非法路径' };
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { success: false, error: '文件不存在' };
      }
      if (path.extname(resolved) === '.md' || path.extname(resolved) === '.txt') {
        return { success: true, text: fs.readFileSync(resolved, 'utf8') };
      }
      return { success: true, base64: fs.readFileSync(resolved).toString('base64') };
    } catch (error) {
      return errorPayload(error, 'Failed to read artifact');
    }
  });
}
