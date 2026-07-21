/** Windows-specific path policy shared by current and future executors. */
import path from 'node:path';

import { SandboxFsError, SandboxFsErrorCode } from './sandboxFsError.js';
import {
  NodeWindowsPathInspector,
  type WindowsPathEntry,
  WindowsPathEntryType,
  type WindowsPathIdentity,
  windowsPathIdentityEquals,
  type WindowsPathInspector,
} from './windowsPathInspector.js';
import {
  isWindowsDriveRoot,
  isWindowsPathInside,
  normalizeWindowsAbsolutePath,
  parseWindowsPath,
  relativeWindowsPath,
  windowsPathEquals,
  WindowsPathKind,
} from './windowsPathSyntax.js';

export const SandboxPathIntent = {
  Mkdir: 'mkdir',
  Read: 'read',
  Remove: 'remove',
  RenameSource: 'rename_source',
  RenameTarget: 'rename_target',
  Resolve: 'resolve',
  Stat: 'stat',
  Write: 'write',
} as const;
export type SandboxPathIntent = (typeof SandboxPathIntent)[keyof typeof SandboxPathIntent];

export const SandboxRootAccess = {
  ReadOnly: 'ro',
  ReadWrite: 'rw',
} as const;
export type SandboxRootAccess = (typeof SandboxRootAccess)[keyof typeof SandboxRootAccess];

export type SandboxFileRoot = {
  id: string;
  path: string;
};

export type SandboxReadRoot = SandboxFileRoot;
export type SandboxWriteRoot = SandboxFileRoot;

type ConfiguredRoot = {
  id: string;
  path: string;
  access: SandboxRootAccess;
  isTaskWorkspace: boolean;
};

type InitializedRoot = ConfiguredRoot & {
  identity: WindowsPathIdentity;
};

type CheckedIdentity = {
  path: string;
  identity: WindowsPathIdentity;
};

export type ResolvedSandboxPath = {
  rootId: string;
  rootPath: string;
  access: SandboxRootAccess;
  hostPath: string;
  relativePath: string;
  containerPath: string;
};

export type PreparedSandboxPath = ResolvedSandboxPath & {
  exists: boolean;
  entry: WindowsPathEntry | null;
  checkedIdentities: readonly CheckedIdentity[];
  firstMissingPath: string | null;
};

export type WindowsWorkspacePathPolicyOptions = {
  taskWorkspaceDir: string;
  taskWorkspaceAccess?: SandboxRootAccess;
  writeRoots?: readonly SandboxWriteRoot[];
  readRoots?: readonly SandboxReadRoot[];
  inspector?: WindowsPathInspector;
  protectedUserProfile?: string;
  protectedSystemRoot?: string;
};

export type PrepareSandboxPathOptions = {
  filePath: string;
  cwd?: string;
  intent: SandboxPathIntent;
  allowMissing?: boolean;
};

function isMutationIntent(intent: SandboxPathIntent): boolean {
  return (
    intent === SandboxPathIntent.Mkdir ||
    intent === SandboxPathIntent.Remove ||
    intent === SandboxPathIntent.RenameSource ||
    intent === SandboxPathIntent.RenameTarget ||
    intent === SandboxPathIntent.Write
  );
}

function validateRootId(rootId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(rootId)) {
    throw new SandboxFsError(
      SandboxFsErrorCode.InvalidPath,
      'Sandbox file-root id must be a short alphanumeric identifier.',
    );
  }
}

function isRootTooBroad(params: {
  candidate: string;
  protectedUserProfile?: string;
  protectedSystemRoot?: string;
}): boolean {
  if (isWindowsDriveRoot(params.candidate)) {
    return true;
  }

  if (params.protectedUserProfile) {
    const profile = normalizeWindowsAbsolutePath(params.protectedUserProfile);
    // Reject the profile itself and any ancestor broad enough to contain it;
    // ordinary project directories below the profile remain valid.
    if (isWindowsPathInside(params.candidate, profile)) {
      return true;
    }
  }

  if (params.protectedSystemRoot) {
    const systemRoot = normalizeWindowsAbsolutePath(params.protectedSystemRoot);
    // Neither the Windows tree nor a parent capable of exposing it is a task root.
    if (
      isWindowsPathInside(params.candidate, systemRoot) ||
      isWindowsPathInside(systemRoot, params.candidate)
    ) {
      return true;
    }
  }

  return false;
}

function toRelativeDisplayPath(relativePath: string): string {
  return relativePath.split(path.win32.sep).join(path.posix.sep);
}

/**
 * M2 Windows task-workspace policy.
 *
 * The synchronous resolver is deliberately lexical and is not an authorization
 * token. Every operation must call `prepare` and keep the returned identity
 * checks coupled to its I/O adapter. The Node inspector can detect common
 * races, but it does not replace the handle-relative native implementation
 * required before the real backend is enabled.
 */
export class WindowsWorkspacePathPolicy {
  private readonly inspector: WindowsPathInspector;
  private readonly configuredRoots: readonly ConfiguredRoot[];
  private readonly protectedUserProfile?: string;
  private readonly protectedSystemRoot?: string;
  private initializedRootsPromise: Promise<readonly InitializedRoot[]> | null = null;

  constructor(options: WindowsWorkspacePathPolicyOptions) {
    this.inspector = options.inspector ?? new NodeWindowsPathInspector();
    this.protectedUserProfile = options.protectedUserProfile ?? process.env.USERPROFILE;
    this.protectedSystemRoot = options.protectedSystemRoot ?? process.env.SystemRoot;

    const taskWorkspacePath = normalizeWindowsAbsolutePath(options.taskWorkspaceDir);
    this.assertRootScope(taskWorkspacePath);

    const roots: ConfiguredRoot[] = [
      {
        id: 'task',
        path: taskWorkspacePath,
        access: options.taskWorkspaceAccess ?? SandboxRootAccess.ReadWrite,
        isTaskWorkspace: true,
      },
    ];
    const rootIds = new Set(roots.map((root) => root.id));
    for (const writeRoot of options.writeRoots ?? []) {
      this.addConfiguredRoot({
        root: writeRoot,
        access: SandboxRootAccess.ReadWrite,
        roots,
        rootIds,
      });
    }
    for (const readRoot of options.readRoots ?? []) {
      this.addConfiguredRoot({
        root: readRoot,
        access: SandboxRootAccess.ReadOnly,
        roots,
        rootIds,
      });
    }
    this.configuredRoots = roots;
  }

  private addConfiguredRoot(params: {
    root: SandboxFileRoot;
    access: SandboxRootAccess;
    roots: ConfiguredRoot[];
    rootIds: Set<string>;
  }): void {
    validateRootId(params.root.id);
    if (params.rootIds.has(params.root.id)) {
      throw new SandboxFsError(
        SandboxFsErrorCode.InvalidPath,
        'Sandbox file-root ids must be unique.',
      );
    }
    params.rootIds.add(params.root.id);
    const rootPath = normalizeWindowsAbsolutePath(params.root.path);
    this.assertRootScope(rootPath);
    const sameRoot = params.roots.find((root) => windowsPathEquals(root.path, rootPath));
    if (sameRoot) {
      if (sameRoot.access !== params.access) {
        throw new SandboxFsError(
          SandboxFsErrorCode.InvalidPath,
          'A sandbox file root cannot be both read-only and writable.',
        );
      }
      return;
    }
    const accessOverlap = params.roots.find((root) => (
      root.access !== params.access
      && (
        isWindowsPathInside(root.path, rootPath)
        || isWindowsPathInside(rootPath, root.path)
      )
    ));
    if (accessOverlap) {
      throw new SandboxFsError(
        SandboxFsErrorCode.InvalidPath,
        'Read-only and writable sandbox roots must not overlap.',
      );
    }
    params.roots.push({
      id: params.root.id,
      path: rootPath,
      access: params.access,
      isTaskWorkspace: false,
    });
  }

  resolveLexical(params: {
    filePath: string;
    cwd?: string;
    intent?: SandboxPathIntent;
  }): ResolvedSandboxPath {
    return this.resolveAgainstRoots(params, this.configuredRoots);
  }

  async prepare(options: PrepareSandboxPathOptions): Promise<PreparedSandboxPath> {
    const roots = await this.getInitializedRoots();
    const resolved = this.resolveAgainstRoots(options, roots);
    const selectedRoot = roots.find((root) => root.id === resolved.rootId);
    if (!selectedRoot) {
      throw new SandboxFsError(
        SandboxFsErrorCode.WorkspaceRootUnavailable,
        'Sandbox path root was not initialized.',
      );
    }

    await this.assertRootIdentity(selectedRoot);
    const checkedIdentities: CheckedIdentity[] = [
      { path: selectedRoot.path, identity: selectedRoot.identity },
    ];
    const relative = relativeWindowsPath(selectedRoot.path, resolved.hostPath);
    const segments = relative.split(path.win32.sep).filter(Boolean);
    let cursor = selectedRoot.path;
    let entry: WindowsPathEntry | null = await this.inspector.inspectNoFollow(cursor);
    let firstMissingPath: string | null = null;

    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.win32.join(cursor, segments[index]);
      entry = await this.inspector.inspectNoFollow(cursor);
      if (!entry) {
        firstMissingPath = cursor;
        if (!options.allowMissing) {
          throw new SandboxFsError(
            SandboxFsErrorCode.NotFound,
            'Sandbox file path does not exist.',
          );
        }
        break;
      }

      this.assertSupportedEntry(entry);
      const isFinal = index === segments.length - 1;
      if (!isFinal && entry.type !== WindowsPathEntryType.Directory) {
        throw new SandboxFsError(
          SandboxFsErrorCode.FileTypeUnsupported,
          'A sandbox path parent is not a directory.',
        );
      }
      const canonicalPath = await this.inspector.realpath(cursor);
      if (!isWindowsPathInside(selectedRoot.path, canonicalPath)) {
        throw new SandboxFsError(
          SandboxFsErrorCode.OutsideWorkspace,
          'Canonical sandbox file path escapes the allowed root.',
        );
      }
      checkedIdentities.push({ path: cursor, identity: entry.identity });
    }

    const exists = firstMissingPath === null;
    if (
      isMutationIntent(options.intent) &&
      options.intent !== SandboxPathIntent.Mkdir &&
      relative === ''
    ) {
      throw new SandboxFsError(
        SandboxFsErrorCode.InvalidPath,
        'The task workspace root cannot be mutated by a file tool.',
      );
    }

    return {
      ...resolved,
      exists,
      entry: exists ? entry : null,
      checkedIdentities,
      firstMissingPath,
    };
  }

  async revalidate(prepared: PreparedSandboxPath): Promise<void> {
    for (const checked of prepared.checkedIdentities) {
      const current = await this.inspector.inspectNoFollow(checked.path);
      if (!current || !windowsPathIdentityEquals(current.identity, checked.identity)) {
        throw new SandboxFsError(
          SandboxFsErrorCode.PathRaceDetected,
          'Sandbox path identity changed during the file operation.',
        );
      }
      this.assertSupportedEntry(current);
    }

    if (prepared.firstMissingPath) {
      const current = await this.inspector.inspectNoFollow(prepared.firstMissingPath);
      if (current) {
        throw new SandboxFsError(
          SandboxFsErrorCode.PathRaceDetected,
          'A previously missing sandbox path appeared during the file operation.',
        );
      }
    }
  }

  private resolveAgainstRoots(
    params: { filePath: string; cwd?: string; intent?: SandboxPathIntent },
    roots: readonly ConfiguredRoot[],
  ): ResolvedSandboxPath {
    const taskRoot = roots.find((root) => root.isTaskWorkspace);
    if (!taskRoot) {
      throw new SandboxFsError(
        SandboxFsErrorCode.WorkspaceRootUnavailable,
        'Task workspace root is unavailable.',
      );
    }

    let cwd = taskRoot.path;
    if (params.cwd) {
      const parsedCwd = parseWindowsPath(params.cwd);
      cwd =
        parsedCwd.kind === WindowsPathKind.Absolute
          ? parsedCwd.normalized
          : path.win32.resolve(taskRoot.path, parsedCwd.normalized);
      if (!isWindowsPathInside(taskRoot.path, cwd)) {
        throw new SandboxFsError(
          SandboxFsErrorCode.CwdOutsideWorkspace,
          'Sandbox cwd must stay inside the task workspace.',
        );
      }
    }

    const parsedPath = parseWindowsPath(params.filePath);
    const candidate =
      parsedPath.kind === WindowsPathKind.Absolute
        ? parsedPath.normalized
        : path.win32.resolve(cwd, parsedPath.normalized);

    const matchingRoots = roots
      .filter((root) => isWindowsPathInside(root.path, candidate))
      .sort((left, right) => {
        if (left.isTaskWorkspace !== right.isTaskWorkspace) {
          return left.isTaskWorkspace ? -1 : 1;
        }
        return right.path.length - left.path.length;
      });
    const selectedRoot = matchingRoots[0];
    if (!selectedRoot) {
      throw new SandboxFsError(
        SandboxFsErrorCode.OutsideWorkspace,
        'Sandbox file path is outside the configured file roots.',
      );
    }

    const intent = params.intent ?? SandboxPathIntent.Resolve;
    if (isMutationIntent(intent) && selectedRoot.access !== SandboxRootAccess.ReadWrite) {
      throw new SandboxFsError(
        SandboxFsErrorCode.ReadOnlyRoot,
        'Sandbox file path belongs to a read-only root.',
      );
    }

    const relativePath = relativeWindowsPath(selectedRoot.path, candidate);
    // Never carry the untrusted absolute spelling into I/O. Windows usually
    // compares case-insensitively, but a directory can opt into case-sensitive
    // lookup. Re-anchor the already-authorized relative suffix to the selected
    // root so policy checks and the eventual filesystem operation use exactly
    // the same path.
    const anchoredCandidate =
      relativePath === ''
        ? selectedRoot.path
        : path.win32.join(selectedRoot.path, relativePath);
    return {
      rootId: selectedRoot.id,
      rootPath: selectedRoot.path,
      access: selectedRoot.access,
      hostPath: anchoredCandidate,
      relativePath: toRelativeDisplayPath(relativePath),
      // A native Windows backend executes against host paths; this is not a
      // POSIX container alias.
      containerPath: anchoredCandidate,
    };
  }

  private async getInitializedRoots(): Promise<readonly InitializedRoot[]> {
    this.initializedRootsPromise ??= Promise.all(
      this.configuredRoots.map((root) => this.initializeRoot(root)),
    );
    return await this.initializedRootsPromise;
  }

  private async initializeRoot(root: ConfiguredRoot): Promise<InitializedRoot> {
    const originalEntry = await this.inspector.inspectNoFollow(root.path);
    if (!originalEntry || originalEntry.type !== WindowsPathEntryType.Directory) {
      throw new SandboxFsError(
        SandboxFsErrorCode.WorkspaceRootUnavailable,
        'Sandbox root must be an existing directory.',
      );
    }
    if (originalEntry.isReparsePoint) {
      throw new SandboxFsError(
        SandboxFsErrorCode.ReparsePointUnsupported,
        'Sandbox roots may not be reparse points.',
      );
    }

    // Check the configured spelling before realpath so a junction in an
    // ancestor cannot silently relocate and redefine the allowed root.
    await this.assertNoReparsePathComponents(root.path);
    const firstCanonicalPath = normalizeWindowsAbsolutePath(
      await this.inspector.realpath(root.path),
    );
    const stableOriginalEntry = await this.inspector.inspectNoFollow(root.path);
    if (
      !stableOriginalEntry ||
      stableOriginalEntry.type !== WindowsPathEntryType.Directory ||
      stableOriginalEntry.isReparsePoint ||
      !windowsPathIdentityEquals(stableOriginalEntry.identity, originalEntry.identity)
    ) {
      throw new SandboxFsError(
        SandboxFsErrorCode.PathRaceDetected,
        'Sandbox root changed while it was being canonicalized.',
      );
    }
    await this.assertNoReparsePathComponents(root.path);
    const canonicalPath = normalizeWindowsAbsolutePath(await this.inspector.realpath(root.path));
    if (!windowsPathEquals(firstCanonicalPath, canonicalPath)) {
      throw new SandboxFsError(
        SandboxFsErrorCode.PathRaceDetected,
        'Sandbox root canonical path changed during initialization.',
      );
    }
    this.assertRootScope(canonicalPath);
    await this.assertNoReparsePathComponents(canonicalPath);
    const canonicalEntry = await this.inspector.inspectNoFollow(canonicalPath);
    if (!canonicalEntry || canonicalEntry.type !== WindowsPathEntryType.Directory) {
      throw new SandboxFsError(
        SandboxFsErrorCode.WorkspaceRootUnavailable,
        'Canonical sandbox root is not an existing directory.',
      );
    }
    this.assertSupportedEntry(canonicalEntry);
    if (!windowsPathIdentityEquals(stableOriginalEntry.identity, canonicalEntry.identity)) {
      throw new SandboxFsError(
        SandboxFsErrorCode.PathRaceDetected,
        'Configured and canonical sandbox roots have different identities.',
      );
    }

    return {
      ...root,
      path: canonicalPath,
      identity: canonicalEntry.identity,
    };
  }

  private async assertNoReparsePathComponents(absolutePath: string): Promise<void> {
    const driveRoot = path.win32.parse(absolutePath).root;
    const segments = path.win32.relative(driveRoot, absolutePath).split(path.win32.sep).filter(Boolean);
    let cursor = driveRoot;
    for (const segment of segments) {
      cursor = path.win32.join(cursor, segment);
      const entry = await this.inspector.inspectNoFollow(cursor);
      if (!entry) {
        throw new SandboxFsError(
          SandboxFsErrorCode.WorkspaceRootUnavailable,
          'A sandbox root parent does not exist.',
        );
      }
      if (entry.isReparsePoint) {
        throw new SandboxFsError(
          SandboxFsErrorCode.ReparsePointUnsupported,
          'Sandbox roots may not pass through a reparse point.',
        );
      }
      if (entry.type !== WindowsPathEntryType.Directory) {
        throw new SandboxFsError(
          SandboxFsErrorCode.WorkspaceRootUnavailable,
          'A sandbox root parent is not a directory.',
        );
      }
    }
  }

  private async assertRootIdentity(root: InitializedRoot): Promise<void> {
    const current = await this.inspector.inspectNoFollow(root.path);
    if (!current || !windowsPathIdentityEquals(current.identity, root.identity)) {
      throw new SandboxFsError(
        SandboxFsErrorCode.PathRaceDetected,
        'Sandbox root identity changed after policy initialization.',
      );
    }
    this.assertSupportedEntry(current);
  }

  private assertRootScope(candidate: string): void {
    if (
      isRootTooBroad({
        candidate,
        protectedUserProfile: this.protectedUserProfile,
        protectedSystemRoot: this.protectedSystemRoot,
      })
    ) {
      throw new SandboxFsError(
        SandboxFsErrorCode.WorkspaceRootTooBroad,
        'Sandbox root is broader than the supported task-workspace scope.',
      );
    }
  }

  private assertSupportedEntry(entry: WindowsPathEntry): void {
    if (entry.isReparsePoint) {
      throw new SandboxFsError(
        SandboxFsErrorCode.ReparsePointUnsupported,
        'Reparse points are not supported by the Windows sandbox file bridge.',
      );
    }
    if (entry.type === WindowsPathEntryType.File && entry.linkCount > 1) {
      throw new SandboxFsError(
        SandboxFsErrorCode.HardlinkUnsupported,
        'Hard-linked files are not supported by the Windows sandbox file bridge.',
      );
    }
    if (entry.type === WindowsPathEntryType.Other) {
      throw new SandboxFsError(
        SandboxFsErrorCode.FileTypeUnsupported,
        'This Windows file type is not supported by the sandbox file bridge.',
      );
    }
  }
}

export function createWindowsWorkspacePathPolicy(
  options: WindowsWorkspacePathPolicyOptions,
): WindowsWorkspacePathPolicy {
  return new WindowsWorkspacePathPolicy(options);
}
