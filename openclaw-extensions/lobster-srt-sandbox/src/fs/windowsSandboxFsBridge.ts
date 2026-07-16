import path from 'node:path';

import type {
  SandboxBackendHandle,
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from 'openclaw/plugin-sdk/sandbox';

import { SandboxFsError, SandboxFsErrorCode, throwIfAborted } from './sandboxFsError.js';
import { NodeSandboxFsIo, type SandboxFsIo } from './sandboxFsIo.js';
import type { WindowsPathInspector } from './windowsPathInspector.js';
import { WindowsPathEntryType } from './windowsPathInspector.js';
import {
  createWindowsWorkspacePathPolicy,
  type PreparedSandboxPath,
  SandboxPathIntent,
  type SandboxReadRoot,
  SandboxRootAccess,
  type WindowsWorkspacePathPolicy,
} from './windowsWorkspacePathPolicy.js';

export type SandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle['createFsBridge']>
>[0]['sandbox'];

export type CreateWindowsSandboxFsBridgeOptions = {
  sandbox: SandboxFsBridgeContext;
  readRoots?: readonly SandboxReadRoot[];
  inspector?: WindowsPathInspector;
  io?: SandboxFsIo;
};

export function createWindowsSandboxFsBridge(
  options: CreateWindowsSandboxFsBridgeOptions,
): SandboxFsBridge {
  const taskWorkspaceDir = (
    options.sandbox as SandboxFsBridgeContext & { taskWorkspaceDir?: string }
  ).taskWorkspaceDir?.trim() || options.sandbox.workspaceDir;
  const policy = createWindowsWorkspacePathPolicy({
    taskWorkspaceDir,
    taskWorkspaceAccess:
      options.sandbox.workspaceAccess === 'rw'
        ? SandboxRootAccess.ReadWrite
        : SandboxRootAccess.ReadOnly,
    readRoots: options.readRoots,
    inspector: options.inspector,
  });
  return new WindowsSandboxFsBridge({
    policy,
    io: options.io ?? new NodeSandboxFsIo(),
    workspaceAccess: options.sandbox.workspaceAccess,
  });
}

export class WindowsSandboxFsBridge implements SandboxFsBridge {
  private readonly policy: WindowsWorkspacePathPolicy;
  private readonly io: SandboxFsIo;
  private readonly workspaceAccess: SandboxFsBridgeContext['workspaceAccess'];

  constructor(options: {
    policy: WindowsWorkspacePathPolicy;
    io: SandboxFsIo;
    workspaceAccess?: SandboxFsBridgeContext['workspaceAccess'];
  }) {
    this.policy = options.policy;
    this.io = options.io;
    this.workspaceAccess = options.workspaceAccess ?? 'rw';
  }

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const resolved = this.policy.resolveLexical({
      ...params,
      intent: SandboxPathIntent.Resolve,
    });
    return {
      hostPath: resolved.hostPath,
      relativePath: resolved.relativePath,
      containerPath: resolved.containerPath,
    };
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    this.ensureReadable();
    throwIfAborted(params.signal);
    const prepared = await this.policy.prepare({
      ...params,
      intent: SandboxPathIntent.Read,
    });
    if (prepared.entry?.type !== WindowsPathEntryType.File) {
      throw new SandboxFsError(
        SandboxFsErrorCode.FileTypeUnsupported,
        'Sandbox read target must be a regular file.',
      );
    }
    await this.policy.revalidate(prepared);
    const content = await this.io.readFile(prepared.hostPath, params.signal);
    await this.policy.revalidate(prepared);
    return content;
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    this.ensureWritable();
    throwIfAborted(params.signal);
    const prepared = await this.policy.prepare({
      ...params,
      intent: SandboxPathIntent.Write,
      allowMissing: true,
    });
    if (prepared.exists && prepared.entry?.type !== WindowsPathEntryType.File) {
      throw new SandboxFsError(
        SandboxFsErrorCode.FileTypeUnsupported,
        'Sandbox write target must be a regular file.',
      );
    }
    await this.policy.revalidate(prepared);
    await this.io.writeFileAtomic({
      filePath: prepared.hostPath,
      data: Buffer.isBuffer(params.data)
        ? params.data
        : Buffer.from(params.data, params.encoding ?? 'utf8'),
      mkdir: params.mkdir !== false,
      signal: params.signal,
    });
    await this.policy.prepare({
      filePath: prepared.hostPath,
      intent: SandboxPathIntent.Write,
    });
  }

  async mkdirp(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    this.ensureWritable();
    throwIfAborted(params.signal);
    const prepared = await this.policy.prepare({
      ...params,
      intent: SandboxPathIntent.Mkdir,
      allowMissing: true,
    });
    if (prepared.exists && prepared.entry?.type !== WindowsPathEntryType.Directory) {
      throw new SandboxFsError(
        SandboxFsErrorCode.FileTypeUnsupported,
        'Sandbox mkdir target is not a directory.',
      );
    }
    await this.policy.revalidate(prepared);
    await this.io.mkdirp(prepared.hostPath, params.signal);
    await this.policy.prepare({
      filePath: prepared.hostPath,
      intent: SandboxPathIntent.Stat,
    });
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    this.ensureWritable();
    throwIfAborted(params.signal);
    const force = params.force !== false;
    const prepared = await this.policy.prepare({
      ...params,
      intent: SandboxPathIntent.Remove,
      allowMissing: force,
    });
    if (!prepared.exists) {
      return;
    }
    if (params.recursive && prepared.entry?.type === WindowsPathEntryType.Directory) {
      await this.assertSafeTree(prepared, params.signal, new Set());
    }
    await this.policy.revalidate(prepared);
    await this.io.remove({
      filePath: prepared.hostPath,
      recursive: params.recursive ?? false,
      force,
      signal: params.signal,
    });
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    this.ensureWritable();
    throwIfAborted(params.signal);
    const from = await this.policy.prepare({
      filePath: params.from,
      cwd: params.cwd,
      intent: SandboxPathIntent.RenameSource,
    });
    const to = await this.policy.prepare({
      filePath: params.to,
      cwd: params.cwd,
      intent: SandboxPathIntent.RenameTarget,
      allowMissing: true,
    });
    if (from.rootId !== to.rootId) {
      throw new SandboxFsError(
        SandboxFsErrorCode.OutsideWorkspace,
        'Sandbox rename may not cross file roots.',
      );
    }
    await this.policy.revalidate(from);
    await this.policy.revalidate(to);
    await this.io.rename({
      from: from.hostPath,
      to: to.hostPath,
      mkdir: true,
      signal: params.signal,
    });
    await this.policy.prepare({
      filePath: to.hostPath,
      intent: SandboxPathIntent.Stat,
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    this.ensureReadable();
    throwIfAborted(params.signal);
    const prepared = await this.policy.prepare({
      ...params,
      intent: SandboxPathIntent.Stat,
      allowMissing: true,
    });
    if (!prepared.exists || !prepared.entry) {
      return null;
    }
    await this.policy.revalidate(prepared);
    return {
      type:
        prepared.entry.type === WindowsPathEntryType.Directory
          ? 'directory'
          : prepared.entry.type === WindowsPathEntryType.File
            ? 'file'
            : 'other',
      size: prepared.entry.size,
      mtimeMs: prepared.entry.mtimeMs,
    };
  }

  private async assertSafeTree(
    prepared: PreparedSandboxPath,
    signal: AbortSignal | undefined,
    visitedIdentities: Set<string>,
  ): Promise<void> {
    throwIfAborted(signal);
    if (!prepared.entry) {
      return;
    }
    if (prepared.entry.type !== WindowsPathEntryType.Directory) {
      await this.policy.revalidate(prepared);
      return;
    }
    const identityKey = `${prepared.entry.identity.device}:${prepared.entry.identity.file}`;
    if (visitedIdentities.has(identityKey)) {
      throw new SandboxFsError(
        SandboxFsErrorCode.PathRaceDetected,
        'Sandbox directory tree contains a repeated file identity.',
      );
    }
    visitedIdentities.add(identityKey);

    const childNames = await this.io.listDirectory(prepared.hostPath, signal);
    for (const childName of childNames) {
      const child = await this.policy.prepare({
        filePath: path.win32.join(prepared.hostPath, childName),
        intent: SandboxPathIntent.Remove,
      });
      await this.assertSafeTree(child, signal, visitedIdentities);
    }
    await this.policy.revalidate(prepared);
  }

  private ensureReadable(): void {
    if (this.workspaceAccess === 'none') {
      throw new SandboxFsError(
        SandboxFsErrorCode.ReadOnlyRoot,
        'Sandbox workspace access is disabled.',
      );
    }
  }

  private ensureWritable(): void {
    if (this.workspaceAccess !== 'rw') {
      throw new SandboxFsError(
        SandboxFsErrorCode.ReadOnlyRoot,
        'Sandbox workspace is read-only.',
      );
    }
  }
}
