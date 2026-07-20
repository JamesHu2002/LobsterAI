import { createHash, randomUUID } from 'node:crypto';

export const SandboxAuditEventType = {
  BackendPrepared: 'backend.prepared',
  BackendFailedClosed: 'backend.failed-closed',
  BackendReset: 'backend.reset',
  CommandRequested: 'command.requested',
  CommandFinished: 'command.finished',
  FileDecision: 'file.decision',
} as const;

export type SandboxAuditEventType =
  typeof SandboxAuditEventType[keyof typeof SandboxAuditEventType];

export const SandboxAuditResult = {
  Allowed: 'allowed',
  Denied: 'denied',
  Failed: 'failed',
  Succeeded: 'succeeded',
} as const;

export type SandboxAuditResult =
  typeof SandboxAuditResult[keyof typeof SandboxAuditResult];

export interface SandboxAuditEvent {
  id: string;
  timestamp: number;
  type: SandboxAuditEventType;
  result: SandboxAuditResult;
  policyVersion: string;
  runtimeVersion: string;
  sessionDigest?: string;
  workspaceDigest?: string;
  commandDigest?: string;
  pathDigest?: string;
  operation?: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  errorCode?: string;
}

export interface SandboxAuditInput {
  type: SandboxAuditEventType;
  result: SandboxAuditResult;
  sessionKey?: string;
  workspaceDir?: string;
  command?: string;
  targetPath?: string;
  operation?: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  errorCode?: string;
}

export interface SandboxAuditLogger {
  debug: (message: string) => void;
}

export const digestSandboxAuditValue = (value: string): string => (
  createHash('sha256').update(value).digest('hex').slice(0, 16)
);

/**
 * M3 keeps a small in-memory diagnostic ring and emits metadata-only debug
 * records. Raw commands, paths, environment values, file contents and output
 * are deliberately excluded.
 */
export class SandboxAuditRecorder {
  private readonly events: SandboxAuditEvent[] = [];

  constructor(
    private readonly options: {
      policyVersion: string;
      runtimeVersion: string;
      logger?: SandboxAuditLogger;
      maxEvents?: number;
      now?: () => number;
    },
  ) {}

  record(input: SandboxAuditInput): SandboxAuditEvent {
    const event: SandboxAuditEvent = {
      id: randomUUID(),
      timestamp: (this.options.now ?? Date.now)(),
      type: input.type,
      result: input.result,
      policyVersion: this.options.policyVersion,
      runtimeVersion: this.options.runtimeVersion,
      sessionDigest: input.sessionKey
        ? digestSandboxAuditValue(input.sessionKey)
        : undefined,
      workspaceDigest: input.workspaceDir
        ? digestSandboxAuditValue(input.workspaceDir.toLowerCase())
        : undefined,
      commandDigest: input.command ? digestSandboxAuditValue(input.command) : undefined,
      pathDigest: input.targetPath
        ? digestSandboxAuditValue(input.targetPath.toLowerCase())
        : undefined,
      operation: input.operation,
      durationMs: input.durationMs,
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      errorCode: input.errorCode,
    };
    this.events.push(event);
    const maxEvents = this.options.maxEvents ?? 200;
    if (this.events.length > maxEvents) {
      this.events.splice(0, this.events.length - maxEvents);
    }
    this.options.logger?.debug(`[lobster-native-audit] ${JSON.stringify(event)}`);
    return event;
  }

  recent(limit = 20): readonly SandboxAuditEvent[] {
    const safeLimit = Math.max(0, Math.min(limit, this.events.length));
    return this.events.slice(this.events.length - safeLimit);
  }
}
