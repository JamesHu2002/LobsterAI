import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { SandboxFsErrorCode } from './sandboxFsError.js';
import {
  type WindowsPathEntry,
  WindowsPathEntryType,
  type WindowsPathInspector,
} from './windowsPathInspector.js';
import { windowsPathComparisonKey } from './windowsPathSyntax.js';
import {
  createWindowsWorkspacePathPolicy,
  SandboxPathIntent,
} from './windowsWorkspacePathPolicy.js';

class MemoryWindowsPathInspector implements WindowsPathInspector {
  private readonly entries = new Map<string, WindowsPathEntry>();
  private nextIdentity = 1;

  addDirectory(filePath: string, options?: { reparse?: boolean }): void {
    const parsed = path.win32.parse(filePath);
    let cursor = parsed.root;
    for (const segment of path.win32
      .relative(parsed.root, filePath)
      .split(path.win32.sep)
      .filter(Boolean)) {
      cursor = path.win32.join(cursor, segment);
      if (!this.entries.has(windowsPathComparisonKey(cursor))) {
        this.setEntry(cursor, WindowsPathEntryType.Directory);
      }
    }
    if (options?.reparse) {
      this.setEntry(filePath, WindowsPathEntryType.Directory, { reparse: true });
    }
  }

  addFile(filePath: string, options?: { links?: number; reparse?: boolean }): void {
    this.addDirectory(path.win32.dirname(filePath));
    this.setEntry(filePath, WindowsPathEntryType.File, options);
  }

  replaceIdentity(filePath: string): void {
    const current = this.entries.get(windowsPathComparisonKey(filePath));
    if (!current) {
      throw new Error('Missing memory inspector entry.');
    }
    this.entries.set(windowsPathComparisonKey(filePath), {
      ...current,
      identity: { ...current.identity, file: String(this.nextIdentity++) },
    });
  }

  async inspectNoFollow(filePath: string): Promise<WindowsPathEntry | null> {
    return this.entries.get(windowsPathComparisonKey(filePath)) ?? null;
  }

  async realpath(filePath: string): Promise<string> {
    if (!this.entries.has(windowsPathComparisonKey(filePath))) {
      throw new Error('Cannot canonicalize a missing memory inspector entry.');
    }
    return path.win32.normalize(filePath);
  }

  private setEntry(
    filePath: string,
    type: WindowsPathEntry['type'],
    options?: { links?: number; reparse?: boolean },
  ): void {
    this.entries.set(windowsPathComparisonKey(filePath), {
      type,
      identity: { device: 'memory', file: String(this.nextIdentity++) },
      isReparsePoint: options?.reparse ?? false,
      linkCount: options?.links ?? 1,
      size: type === WindowsPathEntryType.File ? 12 : 0,
      mtimeMs: 100,
    });
  }
}

class CanonicalizationSwapInspector extends MemoryWindowsPathInspector {
  private swapped = false;

  override async realpath(filePath: string): Promise<string> {
    if (!this.swapped && windowsPathComparisonKey(filePath) === 'c:\\tasks\\a') {
      this.swapped = true;
      this.addDirectory('C:\\Tasks\\A', { reparse: true });
      this.addDirectory('C:\\Tasks\\B');
      return 'C:\\Tasks\\B';
    }
    return await super.realpath(filePath);
  }
}

function createPolicy(params?: {
  task?: string;
  inspector?: MemoryWindowsPathInspector;
  readRoots?: readonly { id: string; path: string }[];
  writeRoots?: readonly { id: string; path: string }[];
}) {
  return createWindowsWorkspacePathPolicy({
    taskWorkspaceDir: params?.task ?? 'C:\\Tasks\\A',
    readRoots: params?.readRoots,
    writeRoots: params?.writeRoots,
    inspector: params?.inspector,
    protectedUserProfile: 'C:\\Users\\Alice',
    protectedSystemRoot: 'C:\\Windows',
  });
}

describe('Native sandbox Windows workspace path policy', () => {
  test('resolves relative paths against only the task workspace and cwd', () => {
    const policy = createPolicy();

    expect(policy.resolveLexical({ filePath: 'src\\index.ts' }).hostPath).toBe(
      'C:\\Tasks\\A\\src\\index.ts',
    );
    expect(
      policy.resolveLexical({ filePath: 'index.ts', cwd: 'src' }).hostPath,
    ).toBe('C:\\Tasks\\A\\src\\index.ts');
    expect(policy.resolveLexical({ filePath: 'c:\\tasks\\a\\README.md' })).toMatchObject({
      rootId: 'task',
      hostPath: 'C:\\Tasks\\A\\README.md',
    });
  });

  test('anchors case-insensitive absolute matches to the selected root spelling', () => {
    const policy = createPolicy();

    expect(
      policy.resolveLexical({ filePath: 'C:\\Tasks\\a\\outside.txt' }).hostPath,
    ).toBe('C:\\Tasks\\A\\outside.txt');
  });

  test('isolates session roots even when both roots could exist in one OS permission union', () => {
    const policyA = createPolicy({ task: 'C:\\Tasks\\A' });
    const policyB = createPolicy({ task: 'C:\\Tasks\\B' });

    expect(() => policyA.resolveLexical({ filePath: 'C:\\Tasks\\B\\secret.txt' })).toThrowError(
      expect.objectContaining({ code: SandboxFsErrorCode.OutsideWorkspace }),
    );
    expect(() => policyB.resolveLexical({ filePath: 'C:\\Tasks\\A\\secret.txt' })).toThrowError(
      expect.objectContaining({ code: SandboxFsErrorCode.OutsideWorkspace }),
    );
  });

  test('rejects cwd escape, prefix collisions, other drives, and agent workspace paths', () => {
    const policy = createPolicy();

    expect(() =>
      policy.resolveLexical({ filePath: 'file.txt', cwd: 'C:\\Tasks\\B' }),
    ).toThrowError(expect.objectContaining({ code: SandboxFsErrorCode.CwdOutsideWorkspace }));
    for (const filePath of [
      'C:\\Tasks\\AB\\file.txt',
      'D:\\Tasks\\A\\file.txt',
      'C:\\OpenClaw\\workspace-main\\MEMORY.md',
    ]) {
      expect(() => policy.resolveLexical({ filePath })).toThrowError(
        expect.objectContaining({ code: SandboxFsErrorCode.OutsideWorkspace }),
      );
    }
  });

  test('permits explicit read roots but rejects mutations there', () => {
    const policy = createPolicy({
      readRoots: [{ id: 'sdk', path: 'D:\\SDK' }],
    });

    expect(
      policy.resolveLexical({
        filePath: 'D:\\SDK\\types.d.ts',
        intent: SandboxPathIntent.Read,
      }).rootId,
    ).toBe('sdk');
    expect(() =>
      policy.resolveLexical({
        filePath: 'D:\\SDK\\types.d.ts',
        intent: SandboxPathIntent.Write,
      }),
    ).toThrowError(expect.objectContaining({ code: SandboxFsErrorCode.ReadOnlyRoot }));
  });

  test('permits reads and mutations in explicit product-owned write roots', () => {
    const policy = createPolicy({
      writeRoots: [
        { id: 'agent', path: 'C:\\LobsterAI\\workspace-main' },
        { id: 'sandbox-home', path: 'C:\\LobsterAI\\sandbox-data\\main\\home' },
      ],
    });

    expect(policy.resolveLexical({
      filePath: 'C:\\LobsterAI\\workspace-main\\MEMORY.md',
      intent: SandboxPathIntent.Write,
    }).rootId).toBe('agent');
    expect(policy.resolveLexical({
      filePath: 'C:\\LobsterAI\\sandbox-data\\main\\home\\cache.json',
      intent: SandboxPathIntent.Write,
    }).rootId).toBe('sandbox-home');
  });

  test('rejects overlap between read-only and writable roots', () => {
    expect(() => createPolicy({
      readRoots: [{ id: 'task-parent', path: 'C:\\Tasks' }],
    })).toThrowError(expect.objectContaining({ code: SandboxFsErrorCode.InvalidPath }));
  });

  test('rejects duplicate capability ids instead of resolving an ambiguous root', () => {
    expect(() =>
      createPolicy({
        readRoots: [
          { id: 'sdk', path: 'D:\\SDK' },
          { id: 'sdk', path: 'E:\\SDK' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: SandboxFsErrorCode.InvalidPath }));
  });

  test.each(['C:\\', 'C:\\Users', 'C:\\Users\\Alice', 'C:\\Windows\\Temp'])(
    'rejects an overly broad or protected workspace root: %s',
    (task) => {
      expect(() => createPolicy({ task })).toThrowError(
        expect.objectContaining({ code: SandboxFsErrorCode.WorkspaceRootTooBroad }),
      );
    },
  );

  test('prepares existing and nonexistent write targets from canonical parents', async () => {
    const inspector = new MemoryWindowsPathInspector();
    inspector.addDirectory('C:\\Tasks\\A');
    inspector.addFile('C:\\Tasks\\A\\README.md');
    const policy = createPolicy({ inspector });

    const existing = await policy.prepare({
      filePath: 'README.md',
      intent: SandboxPathIntent.Read,
    });
    expect(existing.exists).toBe(true);
    expect(existing.entry?.type).toBe(WindowsPathEntryType.File);

    const missing = await policy.prepare({
      filePath: 'generated\\nested\\file.txt',
      intent: SandboxPathIntent.Write,
      allowMissing: true,
    });
    expect(missing.exists).toBe(false);
    expect(missing.firstMissingPath).toBe('C:\\Tasks\\A\\generated');
  });

  test('rejects intermediate and final reparse points, including inside-to-inside links', async () => {
    const inspector = new MemoryWindowsPathInspector();
    inspector.addDirectory('C:\\Tasks\\A');
    inspector.addDirectory('C:\\Tasks\\A\\target');
    inspector.addDirectory('C:\\Tasks\\A\\link', { reparse: true });
    const policy = createPolicy({ inspector });

    await expect(
      policy.prepare({ filePath: 'link', intent: SandboxPathIntent.Read }),
    ).rejects.toMatchObject({ code: SandboxFsErrorCode.ReparsePointUnsupported });
    await expect(
      policy.prepare({ filePath: 'link\\file.txt', intent: SandboxPathIntent.Read }),
    ).rejects.toMatchObject({ code: SandboxFsErrorCode.ReparsePointUnsupported });
  });

  test('rejects a workspace whose configured path passes through a reparse-point parent', async () => {
    const inspector = new MemoryWindowsPathInspector();
    inspector.addDirectory('C:\\Mount', { reparse: true });
    inspector.addDirectory('C:\\Mount\\Task');
    const policy = createPolicy({ task: 'C:\\Mount\\Task', inspector });

    await expect(
      policy.prepare({ filePath: '.', intent: SandboxPathIntent.Stat }),
    ).rejects.toMatchObject({ code: SandboxFsErrorCode.ReparsePointUnsupported });
  });

  test('detects a root swapped to a junction while canonicalizing it', async () => {
    const inspector = new CanonicalizationSwapInspector();
    inspector.addDirectory('C:\\Tasks\\A');
    const policy = createPolicy({ inspector });

    await expect(
      policy.prepare({ filePath: '.', intent: SandboxPathIntent.Stat }),
    ).rejects.toMatchObject({ code: SandboxFsErrorCode.PathRaceDetected });
  });

  test('rejects regular files with multiple hard links', async () => {
    const inspector = new MemoryWindowsPathInspector();
    inspector.addDirectory('C:\\Tasks\\A');
    inspector.addFile('C:\\Tasks\\A\\linked.txt', { links: 2 });
    const policy = createPolicy({ inspector });

    await expect(
      policy.prepare({ filePath: 'linked.txt', intent: SandboxPathIntent.Read }),
    ).rejects.toMatchObject({ code: SandboxFsErrorCode.HardlinkUnsupported });
  });

  test('detects root and path identity changes during revalidation', async () => {
    const inspector = new MemoryWindowsPathInspector();
    inspector.addDirectory('C:\\Tasks\\A');
    inspector.addFile('C:\\Tasks\\A\\file.txt');
    const policy = createPolicy({ inspector });
    const prepared = await policy.prepare({
      filePath: 'file.txt',
      intent: SandboxPathIntent.Read,
    });

    inspector.replaceIdentity('C:\\Tasks\\A');
    await expect(policy.revalidate(prepared)).rejects.toMatchObject({
      code: SandboxFsErrorCode.PathRaceDetected,
    });
  });

  test('detects a missing target that appears before a write', async () => {
    const inspector = new MemoryWindowsPathInspector();
    inspector.addDirectory('C:\\Tasks\\A');
    const policy = createPolicy({ inspector });
    const prepared = await policy.prepare({
      filePath: 'new.txt',
      intent: SandboxPathIntent.Write,
      allowMissing: true,
    });

    inspector.addFile('C:\\Tasks\\A\\new.txt');
    await expect(policy.revalidate(prepared)).rejects.toMatchObject({
      code: SandboxFsErrorCode.PathRaceDetected,
    });
  });
});
