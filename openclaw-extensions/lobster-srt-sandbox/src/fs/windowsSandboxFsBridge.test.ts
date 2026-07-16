import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { SandboxFsError, SandboxFsErrorCode } from './sandboxFsError.js';
import type { SandboxFsIo } from './sandboxFsIo.js';
import {
  type WindowsPathEntry,
  WindowsPathEntryType,
  type WindowsPathInspector,
} from './windowsPathInspector.js';
import { isWindowsPathInside, windowsPathComparisonKey } from './windowsPathSyntax.js';
import {
  createWindowsSandboxFsBridge,
  WindowsSandboxFsBridge,
} from './windowsSandboxFsBridge.js';
import {
  createWindowsWorkspacePathPolicy,
  SandboxRootAccess,
} from './windowsWorkspacePathPolicy.js';

class MemorySandboxFileSystem implements WindowsPathInspector, SandboxFsIo {
  private readonly entries = new Map<string, { path: string; entry: WindowsPathEntry }>();
  private readonly contents = new Map<string, Buffer>();
  private nextIdentity = 1;
  failNextWrite = false;

  addDirectory(filePath: string, options?: { reparse?: boolean }): void {
    const parsed = path.win32.parse(filePath);
    let cursor = parsed.root;
    for (const segment of path.win32
      .relative(parsed.root, filePath)
      .split(path.win32.sep)
      .filter(Boolean)) {
      cursor = path.win32.join(cursor, segment);
      if (!this.get(cursor)) {
        this.set(cursor, WindowsPathEntryType.Directory);
      }
    }
    if (options?.reparse) {
      this.set(filePath, WindowsPathEntryType.Directory, { reparse: true });
    }
  }

  addFile(filePath: string, content: string | Buffer): void {
    this.addDirectory(path.win32.dirname(filePath));
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    this.set(filePath, WindowsPathEntryType.File, { size: buffer.length });
    this.contents.set(windowsPathComparisonKey(filePath), buffer);
  }

  has(filePath: string): boolean {
    return Boolean(this.get(filePath));
  }

  async inspectNoFollow(filePath: string): Promise<WindowsPathEntry | null> {
    return this.get(filePath)?.entry ?? null;
  }

  async realpath(filePath: string): Promise<string> {
    const stored = this.get(filePath);
    if (!stored) {
      throw new Error('Cannot canonicalize a missing in-memory path.');
    }
    return stored.path;
  }

  async readFile(filePath: string): Promise<Buffer> {
    const content = this.contents.get(windowsPathComparisonKey(filePath));
    if (!content) {
      throw new SandboxFsError(SandboxFsErrorCode.NotFound, 'Missing in-memory file.');
    }
    return Buffer.from(content);
  }

  async writeFileAtomic(params: {
    filePath: string;
    data: Buffer;
    mkdir: boolean;
  }): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new SandboxFsError(SandboxFsErrorCode.IoError, 'Injected atomic write failure.');
    }
    const parent = path.win32.dirname(params.filePath);
    if (params.mkdir) {
      this.addDirectory(parent);
    } else if (!this.get(parent)) {
      throw new SandboxFsError(SandboxFsErrorCode.NotFound, 'Missing parent.');
    }
    this.addFile(params.filePath, params.data);
  }

  async mkdirp(filePath: string): Promise<void> {
    this.addDirectory(filePath);
  }

  async remove(params: {
    filePath: string;
    recursive: boolean;
    force: boolean;
  }): Promise<void> {
    const target = this.get(params.filePath);
    if (!target) {
      if (params.force) {
        return;
      }
      throw new SandboxFsError(SandboxFsErrorCode.NotFound, 'Missing in-memory path.');
    }
    const descendants = [...this.entries.values()].filter(
      (entry) =>
        windowsPathComparisonKey(entry.path) !== windowsPathComparisonKey(params.filePath) &&
        isWindowsPathInside(params.filePath, entry.path),
    );
    if (descendants.length > 0 && !params.recursive) {
      throw new SandboxFsError(SandboxFsErrorCode.NotEmpty, 'Directory is not empty.');
    }
    for (const entry of [target, ...descendants]) {
      const key = windowsPathComparisonKey(entry.path);
      this.entries.delete(key);
      this.contents.delete(key);
    }
  }

  async rename(params: { from: string; to: string; mkdir: boolean }): Promise<void> {
    const source = this.get(params.from);
    if (!source) {
      throw new SandboxFsError(SandboxFsErrorCode.NotFound, 'Missing rename source.');
    }
    if (params.mkdir) {
      this.addDirectory(path.win32.dirname(params.to));
    }
    const content = this.contents.get(windowsPathComparisonKey(params.from));
    this.entries.delete(windowsPathComparisonKey(params.from));
    this.contents.delete(windowsPathComparisonKey(params.from));
    this.set(params.to, source.entry.type, {
      size: source.entry.size,
      reparse: source.entry.isReparsePoint,
    });
    if (content) {
      this.contents.set(windowsPathComparisonKey(params.to), content);
    }
  }

  async listDirectory(filePath: string): Promise<readonly string[]> {
    return [...this.entries.values()]
      .filter((entry) => windowsPathComparisonKey(path.win32.dirname(entry.path)) === windowsPathComparisonKey(filePath))
      .map((entry) => path.win32.basename(entry.path));
  }

  private get(filePath: string) {
    return this.entries.get(windowsPathComparisonKey(filePath));
  }

  private set(
    filePath: string,
    type: WindowsPathEntry['type'],
    options?: { reparse?: boolean; size?: number },
  ): void {
    this.entries.set(windowsPathComparisonKey(filePath), {
      path: path.win32.normalize(filePath),
      entry: {
        type,
        identity: { device: 'memory', file: String(this.nextIdentity++) },
        isReparsePoint: options?.reparse ?? false,
        linkCount: 1,
        size: options?.size ?? 0,
        mtimeMs: 100,
      },
    });
  }
}

function createBridge(options?: { access?: SandboxRootAccess }) {
  const fileSystem = new MemorySandboxFileSystem();
  fileSystem.addDirectory('C:\\Tasks\\A');
  const policy = createWindowsWorkspacePathPolicy({
    taskWorkspaceDir: 'C:\\Tasks\\A',
    taskWorkspaceAccess: options?.access,
    inspector: fileSystem,
    protectedUserProfile: 'C:\\Users\\Alice',
    protectedSystemRoot: 'C:\\Windows',
  });
  const bridge = new WindowsSandboxFsBridge({
    policy,
    io: fileSystem,
    workspaceAccess: options?.access === SandboxRootAccess.ReadOnly ? 'ro' : 'rw',
  });
  return { bridge, fileSystem };
}

describe('Windows SandboxFsBridge mock I/O', () => {
  test('uses the explicit task workspace instead of the legacy workspace field', () => {
    const fileSystem = new MemorySandboxFileSystem();
    const bridge = createWindowsSandboxFsBridge({
      sandbox: {
        workspaceDir: 'C:\\Legacy\\Workspace',
        taskWorkspaceDir: 'C:\\Tasks\\A',
        workspaceAccess: 'rw',
      } as never,
      inspector: fileSystem,
      io: fileSystem,
    });

    expect(bridge.resolvePath({ filePath: 'README.md' }).hostPath).toBe(
      'C:\\Tasks\\A\\README.md',
    );
  });

  test('supports resolve, read, write, mkdir, rename, stat, and remove', async () => {
    const { bridge, fileSystem } = createBridge();
    fileSystem.addFile('C:\\Tasks\\A\\README.md', 'hello');

    expect(bridge.resolvePath({ filePath: 'README.md' })).toMatchObject({
      hostPath: 'C:\\Tasks\\A\\README.md',
      relativePath: 'README.md',
      containerPath: 'C:\\Tasks\\A\\README.md',
    });
    await expect(bridge.readFile({ filePath: 'README.md' })).resolves.toEqual(
      Buffer.from('hello'),
    );

    await bridge.writeFile({ filePath: 'generated\\answer.txt', data: '42' });
    await expect(bridge.readFile({ filePath: 'generated\\answer.txt' })).resolves.toEqual(
      Buffer.from('42'),
    );
    expect(await bridge.stat({ filePath: 'generated\\answer.txt' })).toMatchObject({
      type: 'file',
      size: 2,
    });

    await bridge.mkdirp({ filePath: 'empty\\nested' });
    await expect(bridge.mkdirp({ filePath: '.' })).resolves.toBeUndefined();
    expect(await bridge.stat({ filePath: 'empty\\nested' })).toMatchObject({
      type: 'directory',
    });

    await bridge.rename({ from: 'generated\\answer.txt', to: 'moved\\answer.txt' });
    expect(fileSystem.has('C:\\Tasks\\A\\generated\\answer.txt')).toBe(false);
    await expect(bridge.readFile({ filePath: 'moved\\answer.txt' })).resolves.toEqual(
      Buffer.from('42'),
    );

    await bridge.remove({ filePath: 'moved', recursive: true });
    expect(fileSystem.has('C:\\Tasks\\A\\moved')).toBe(false);
    await expect(bridge.stat({ filePath: 'moved\\answer.txt' })).resolves.toBeNull();
    await expect(bridge.remove({ filePath: 'missing', force: true })).resolves.toBeUndefined();
  });

  test('preserves existing content when the atomic adapter fails before replacement', async () => {
    const { bridge, fileSystem } = createBridge();
    fileSystem.addFile('C:\\Tasks\\A\\file.txt', 'before');
    fileSystem.failNextWrite = true;

    await expect(bridge.writeFile({ filePath: 'file.txt', data: 'after' })).rejects.toMatchObject({
      code: SandboxFsErrorCode.IoError,
    });
    await expect(bridge.readFile({ filePath: 'file.txt' })).resolves.toEqual(
      Buffer.from('before'),
    );
  });

  test('fails closed before recursively traversing a reparse point', async () => {
    const { bridge, fileSystem } = createBridge();
    fileSystem.addDirectory('C:\\Tasks\\A\\tree');
    fileSystem.addDirectory('C:\\Tasks\\A\\tree\\junction', { reparse: true });

    await expect(bridge.remove({ filePath: 'tree', recursive: true })).rejects.toMatchObject({
      code: SandboxFsErrorCode.ReparsePointUnsupported,
    });
    expect(fileSystem.has('C:\\Tasks\\A\\tree')).toBe(true);
  });

  test('rejects writes in a read-only workspace', async () => {
    const { bridge, fileSystem } = createBridge({ access: SandboxRootAccess.ReadOnly });
    fileSystem.addFile('C:\\Tasks\\A\\file.txt', 'value');

    await expect(bridge.readFile({ filePath: 'file.txt' })).resolves.toEqual(
      Buffer.from('value'),
    );
    await expect(bridge.writeFile({ filePath: 'file.txt', data: 'new' })).rejects.toMatchObject({
      code: SandboxFsErrorCode.ReadOnlyRoot,
    });
  });

  test('honors already-aborted signals without invoking I/O', async () => {
    const { bridge, fileSystem } = createBridge();
    fileSystem.addFile('C:\\Tasks\\A\\file.txt', 'value');
    const controller = new AbortController();
    controller.abort();

    await expect(
      bridge.readFile({ filePath: 'file.txt', signal: controller.signal }),
    ).rejects.toMatchObject({ code: SandboxFsErrorCode.Aborted });
  });
});
