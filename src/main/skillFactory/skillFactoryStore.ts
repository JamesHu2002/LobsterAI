import type Database from 'better-sqlite3';

import type { SkillFactoryStage } from '../../skillFactory/constants';
import { SkillFactoryRunStatus } from '../../skillFactory/constants';
import type {
  SkillFactoryEvalReport,
  SkillFactoryRun,
  SkillFactorySecurityReport,
  SkillFactorySource,
} from '../../skillFactory/types';

interface SkillFactoryRunRow {
  id: string;
  name: string;
  requirement: string;
  source: string;
  source_refs: string | null;
  docs_dir: string | null;
  output_dir: string;
  status: string;
  stage: string | null;
  eval_report: string | null;
  security_report: string | null;
  skill_name: string | null;
  installed_skill_id: string | null;
  installed_at: number | null;
  created_at: number;
  finished_at: number | null;
  last_error: string | null;
}

function mapRunRow(row: SkillFactoryRunRow): SkillFactoryRun {
  return {
    id: row.id,
    name: row.name,
    requirement: row.requirement,
    source: (row.source as SkillFactorySource) ?? 'manual',
    sourceRefs: row.source_refs ? safeParseRefs(row.source_refs) : [],
    docsDir: row.docs_dir,
    outputDir: row.output_dir,
    status: row.status as SkillFactoryRunStatus,
    stage: (row.stage as SkillFactoryStage | null) ?? null,
    evalReport: row.eval_report ? (JSON.parse(row.eval_report) as SkillFactoryEvalReport) : null,
    securityReport: row.security_report
      ? (JSON.parse(row.security_report) as SkillFactorySecurityReport)
      : null,
    skillName: row.skill_name,
    installedSkillId: row.installed_skill_id,
    installedAt: row.installed_at,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
  };
}

function safeParseRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

export class SkillFactoryStore {
  constructor(private db: Database.Database) {}

  insertRun(run: SkillFactoryRun): void {
    this.db
      .prepare(
        `INSERT INTO skill_factory_runs (
          id, name, requirement, source, source_refs, docs_dir, output_dir, status, stage,
          eval_report, security_report, skill_name, installed_skill_id,
          installed_at, created_at, finished_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.name,
        run.requirement,
        run.source ?? 'manual',
        run.sourceRefs && run.sourceRefs.length > 0 ? JSON.stringify(run.sourceRefs) : null,
        run.docsDir,
        run.outputDir,
        run.status,
        run.stage,
        run.evalReport ? JSON.stringify(run.evalReport) : null,
        run.securityReport ? JSON.stringify(run.securityReport) : null,
        run.skillName,
        run.installedSkillId,
        run.installedAt,
        run.createdAt,
        run.finishedAt,
        run.lastError,
      );
  }

  getRun(id: string): SkillFactoryRun | null {
    const row = this.db
      .prepare('SELECT * FROM skill_factory_runs WHERE id = ?')
      .get(id) as SkillFactoryRunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  listRuns(): SkillFactoryRun[] {
    const rows = this.db
      .prepare('SELECT * FROM skill_factory_runs ORDER BY created_at DESC')
      .all() as SkillFactoryRunRow[];
    return rows.map(mapRunRow);
  }

  updateRunStatus(
    id: string,
    status: SkillFactoryRunStatus,
    fields?: {
      stage?: SkillFactoryStage | null;
      finishedAt?: number | null;
      lastError?: string | null;
    },
  ): void {
    const sets: string[] = ['status = ?'];
    const params: Array<string | number | null> = [status];
    if (fields?.stage !== undefined) {
      sets.push('stage = ?');
      params.push(fields.stage);
    }
    if (fields?.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      params.push(fields.finishedAt);
    }
    if (fields?.lastError !== undefined) {
      sets.push('last_error = ?');
      params.push(fields.lastError);
    }
    params.push(id);
    this.db.prepare(`UPDATE skill_factory_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  updateStage(id: string, stage: SkillFactoryStage): void {
    this.db.prepare('UPDATE skill_factory_runs SET stage = ? WHERE id = ?').run(stage, id);
  }

  updateEvalReport(id: string, report: SkillFactoryEvalReport | null): void {
    this.db
      .prepare('UPDATE skill_factory_runs SET eval_report = ? WHERE id = ?')
      .run(report ? JSON.stringify(report) : null, id);
  }

  updateSecurityReport(id: string, report: SkillFactorySecurityReport | null): void {
    this.db
      .prepare('UPDATE skill_factory_runs SET security_report = ? WHERE id = ?')
      .run(report ? JSON.stringify(report) : null, id);
  }

  updateSkillResult(
    id: string,
    fields: { skillName?: string | null; status?: SkillFactoryRunStatus; finishedAt?: number | null; lastError?: string | null },
  ): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (fields.skillName !== undefined) {
      sets.push('skill_name = ?');
      params.push(fields.skillName);
    }
    if (fields.status !== undefined) {
      sets.push('status = ?');
      params.push(fields.status);
    }
    if (fields.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      params.push(fields.finishedAt);
    }
    if (fields.lastError !== undefined) {
      sets.push('last_error = ?');
      params.push(fields.lastError);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE skill_factory_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  markInstalled(id: string, installedSkillId: string): void {
    this.db
      .prepare(
        'UPDATE skill_factory_runs SET status = ?, installed_skill_id = ?, installed_at = ? WHERE id = ?',
      )
      .run(SkillFactoryRunStatus.Installed, installedSkillId, Date.now(), id);
  }

  deleteRun(id: string): void {
    this.db.prepare('DELETE FROM skill_factory_runs WHERE id = ?').run(id);
  }

  /**
   * Mark runs left in a live state (pending/running) as failed on app startup —
   * the runner is not alive, so they can never complete on their own.
   */
  reconcileStaleRuns(): void {
    const stale = this.db
      .prepare("SELECT id FROM skill_factory_runs WHERE status IN ('pending', 'running')")
      .all() as Array<{ id: string }>;
    for (const r of stale) {
      this.db
        .prepare('UPDATE skill_factory_runs SET status = ?, finished_at = ?, last_error = ? WHERE id = ?')
        .run(SkillFactoryRunStatus.Failed, Date.now(), '应用重启，技能生成已中断', r.id);
    }
  }
}
