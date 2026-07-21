import fs from 'node:fs';
import path from 'node:path';

import {
  LobsterNativeSandboxBackendErrorCode,
  LobsterNativeSandboxProfileMode,
} from '../backend/constants.js';
import { LobsterNativeSandboxBackendError } from '../backend/errors.js';
import type {
  NativeSandboxHostProfile,
  NativeSandboxPolicyContext,
  NativeSandboxPolicyRoot,
} from '../runtime/nativeSandboxExecutor.js';

export interface PreparedNativeSandboxPolicyContext {
  agentWorkspaceDir: string;
  profile: NativeSandboxHostProfile;
  writableRoots: NativeSandboxPolicyRoot[];
  readableRoots: NativeSandboxPolicyRoot[];
  protectedPaths: string[];
}

const normalizeWindowsPath = (value: string): string => {
  const resolved = path.win32.resolve(value.trim());
  const parsed = path.win32.parse(resolved);
  return resolved.length > parsed.root.length
    ? resolved.replace(/[\\/]+$/, '')
    : resolved;
};

/**
 * Canonicalizes product-owned roots and retains the complete runtime-cycle
 * union needed to revoke every Capability ACE during reset.
 */
export class WindowsNativePolicyRegistry {
  private readonly registeredWritableRoots = new Map<string, string>();
  private readonly registeredReadableRoots = new Map<string, string>();
  private readonly registeredProtectedPaths = new Map<string, string>();
  private primaryPolicyContext: PreparedNativeSandboxPolicyContext | null = null;

  prepare(context: NativeSandboxPolicyContext): PreparedNativeSandboxPolicyContext {
    const agentWorkspaceDir = this.validateExistingDirectory(
      context.agentWorkspaceDir,
      'agent workspace',
    );
    const profile = this.prepareProfile(context.profile);
    const writableRoots = this.preparePolicyRoots(context.writableRoots, 'writable');
    this.addPolicyRoot(writableRoots, { id: 'agent', path: agentWorkspaceDir });
    return {
      agentWorkspaceDir,
      profile,
      writableRoots,
      readableRoots: this.preparePolicyRoots(context.readableRoots, 'readable'),
      protectedPaths: context.protectedPaths.map((protectedPath) => (
        this.validateExistingPath(protectedPath, 'protected path')
      )),
    };
  }

  register(context: PreparedNativeSandboxPolicyContext): void {
    this.primaryPolicyContext ??= context;
    for (const root of context.writableRoots) {
      this.registeredWritableRoots.set(this.pathKey(root.path), root.path);
    }
    for (const root of context.readableRoots) {
      this.registeredReadableRoots.set(this.pathKey(root.path), root.path);
    }
    for (const protectedPath of context.protectedPaths) {
      this.registeredProtectedPaths.set(this.pathKey(protectedPath), protectedPath);
    }
  }

  contains(context: PreparedNativeSandboxPolicyContext): boolean {
    return context.writableRoots.every(root => (
      this.registeredWritableRoots.has(this.pathKey(root.path))
    )) && context.readableRoots.every(root => (
      this.registeredReadableRoots.has(this.pathKey(root.path))
    )) && context.protectedPaths.every(protectedPath => (
      this.registeredProtectedPaths.has(this.pathKey(protectedPath))
    ));
  }

  require(context?: NativeSandboxPolicyContext): PreparedNativeSandboxPolicyContext {
    if (context) {
      const prepared = this.prepare(context);
      this.register(prepared);
      return prepared;
    }
    if (this.primaryPolicyContext) return this.primaryPolicyContext;
    throw new LobsterNativeSandboxBackendError(
      LobsterNativeSandboxBackendErrorCode.RuntimeInitializationFailed,
      'Native Sandbox policy roots have not been initialized.',
    );
  }

  createCleanupContext(): PreparedNativeSandboxPolicyContext {
    const primary = this.require();
    return {
      agentWorkspaceDir: primary.agentWorkspaceDir,
      profile: primary.profile,
      writableRoots: Array.from(this.registeredWritableRoots.values(), (rootPath, index) => ({
        id: `cleanup-write-${index}`,
        path: rootPath,
      })),
      readableRoots: Array.from(this.registeredReadableRoots.values(), (rootPath, index) => ({
        id: `cleanup-read-${index}`,
        path: rootPath,
      })),
      protectedPaths: Array.from(this.registeredProtectedPaths.values()),
    };
  }

  uniquePaths(paths: readonly string[]): string[] {
    return Array.from(new Map(paths.map(filePath => [this.pathKey(filePath), filePath])).values());
  }

  clear(): void {
    this.primaryPolicyContext = null;
    this.registeredWritableRoots.clear();
    this.registeredReadableRoots.clear();
    this.registeredProtectedPaths.clear();
  }

  private prepareProfile(profile: NativeSandboxHostProfile): NativeSandboxHostProfile {
    if (profile.mode !== LobsterNativeSandboxProfileMode.InheritHost) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        `Unsupported native Sandbox profile mode: ${String(profile.mode)}.`,
      );
    }
    return {
      mode: profile.mode,
      homeDir: this.validateExistingDirectory(profile.homeDir, 'host HOME'),
      userProfileDir: this.validateExistingDirectory(
        profile.userProfileDir,
        'host USERPROFILE',
      ),
      appDataDir: this.validateExistingDirectory(profile.appDataDir, 'host APPDATA'),
      localAppDataDir: this.validateExistingDirectory(
        profile.localAppDataDir,
        'host LOCALAPPDATA',
      ),
    };
  }

  private preparePolicyRoots(
    roots: readonly NativeSandboxPolicyRoot[],
    label: string,
  ): NativeSandboxPolicyRoot[] {
    const prepared: NativeSandboxPolicyRoot[] = [];
    const ids = new Set<string>();
    for (const root of roots) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(root.id) || ids.has(root.id)) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
          `Native Sandbox ${label} root ids must be unique short identifiers.`,
        );
      }
      ids.add(root.id);
      this.addPolicyRoot(prepared, {
        id: root.id,
        path: this.validateExistingDirectory(root.path, `${label} root`),
      });
    }
    return prepared;
  }

  private addPolicyRoot(
    roots: NativeSandboxPolicyRoot[],
    root: NativeSandboxPolicyRoot,
  ): void {
    if (roots.some(candidate => this.pathKey(candidate.path) === this.pathKey(root.path))) {
      return;
    }
    if (roots.some(candidate => candidate.id === root.id)) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        'Native Sandbox file-root ids must be unique.',
      );
    }
    roots.push(root);
  }

  private validateExistingDirectory(rawPath: string, label: string): string {
    const resolved = this.validateExistingPath(rawPath, label);
    if (!fs.statSync(resolved).isDirectory()) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        `Native Sandbox ${label} must be a directory.`,
      );
    }
    return resolved;
  }

  private validateExistingPath(rawPath: string, label: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        `Native Sandbox ${label} is required.`,
      );
    }
    try {
      const resolved = normalizeWindowsPath(fs.realpathSync.native(trimmed));
      if (resolved.toLowerCase() === path.win32.parse(resolved).root.toLowerCase()) {
        throw new Error('drive roots are not supported');
      }
      return resolved;
    } catch (error) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        `Native Sandbox ${label} is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private pathKey(filePath: string): string {
    return normalizeWindowsPath(filePath).toLowerCase();
  }
}
