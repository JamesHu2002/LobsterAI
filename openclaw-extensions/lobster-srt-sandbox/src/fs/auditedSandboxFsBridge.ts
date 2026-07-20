import type {
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from 'openclaw/plugin-sdk/sandbox';

import {
  SandboxAuditEventType,
  type SandboxAuditRecorder,
  SandboxAuditResult,
} from '../audit/sandboxAuditRecorder.js';

const errorCodeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : 'file-operation-failed';
};

export class AuditedSandboxFsBridge implements SandboxFsBridge {
  constructor(
    private readonly options: {
      delegate: SandboxFsBridge;
      audit: SandboxAuditRecorder;
      sessionKey: string;
      workspaceDir: string;
    },
  ) {}

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    return this.runSync('resolve', params.filePath, () => this.options.delegate.resolvePath(params));
  }

  readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    return this.run('read', params.filePath, () => this.options.delegate.readFile(params));
  }

  writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    return this.run('write', params.filePath, () => this.options.delegate.writeFile(params));
  }

  mkdirp(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    return this.run('mkdir', params.filePath, () => this.options.delegate.mkdirp(params));
  }

  remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    return this.run('remove', params.filePath, () => this.options.delegate.remove(params));
  }

  rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    return this.run('rename', `${params.from}\0${params.to}`, () => (
      this.options.delegate.rename(params)
    ));
  }

  stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    return this.run('stat', params.filePath, () => this.options.delegate.stat(params));
  }

  private runSync<T>(operation: string, targetPath: string, action: () => T): T {
    try {
      const result = action();
      this.record(operation, targetPath, SandboxAuditResult.Allowed);
      return result;
    } catch (error) {
      this.record(operation, targetPath, SandboxAuditResult.Denied, errorCodeOf(error));
      throw error;
    }
  }

  private async run<T>(
    operation: string,
    targetPath: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await action();
      this.record(operation, targetPath, SandboxAuditResult.Allowed);
      return result;
    } catch (error) {
      this.record(operation, targetPath, SandboxAuditResult.Denied, errorCodeOf(error));
      throw error;
    }
  }

  private record(
    operation: string,
    targetPath: string,
    result: typeof SandboxAuditResult.Allowed | typeof SandboxAuditResult.Denied,
    errorCode?: string,
  ): void {
    this.options.audit.record({
      type: SandboxAuditEventType.FileDecision,
      result,
      sessionKey: this.options.sessionKey,
      workspaceDir: this.options.workspaceDir,
      targetPath,
      operation,
      errorCode,
    });
  }
}
