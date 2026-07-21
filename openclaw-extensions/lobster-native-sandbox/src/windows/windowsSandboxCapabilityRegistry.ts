import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LobsterNativeSandboxBackendErrorCode,
  LobsterNativeSandboxFilesystemCapability,
  type LobsterNativeSandboxFilesystemCapability as LobsterNativeSandboxFilesystemCapabilityValue,
  LobsterNativeSandboxProfileMode,
} from '../backend/constants.js';
import { LobsterNativeSandboxBackendError } from '../backend/errors.js';
import type {
  NativeSandboxHostProfile,
  NativeSandboxPolicyRoot,
} from '../runtime/nativeSandboxExecutor.js';

export const WindowsSandboxCapabilityAccess = {
  Read: 'read',
  Write: 'write',
} as const;

export const WindowsSandboxCapabilityScope = {
  UserShared: 'user-shared',
} as const;

export const WindowsSandboxCapabilityRisk = {
  SharedCacheMutation: 'shared-cache-mutation',
} as const;

type WindowsSandboxCapabilityAccess =
  typeof WindowsSandboxCapabilityAccess[keyof typeof WindowsSandboxCapabilityAccess];

type WindowsSandboxCapabilityDefinition = {
  access: WindowsSandboxCapabilityAccess;
  rootId: string;
  scope: typeof WindowsSandboxCapabilityScope[keyof typeof WindowsSandboxCapabilityScope];
  risk: typeof WindowsSandboxCapabilityRisk[keyof typeof WindowsSandboxCapabilityRisk];
  resolvePath: (profile: NativeSandboxHostProfile) => string;
};

export type ResolvedWindowsSandboxCapabilities = {
  readableRoots: NativeSandboxPolicyRoot[];
  writableRoots: NativeSandboxPolicyRoot[];
};

const WINDOWS_LOCAL_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

const CAPABILITY_DEFINITIONS: Record<
  LobsterNativeSandboxFilesystemCapabilityValue,
  WindowsSandboxCapabilityDefinition
> = {
  [LobsterNativeSandboxFilesystemCapability.NpmCacheWrite]: {
    access: WindowsSandboxCapabilityAccess.Write,
    rootId: 'npm-cache',
    scope: WindowsSandboxCapabilityScope.UserShared,
    risk: WindowsSandboxCapabilityRisk.SharedCacheMutation,
    resolvePath: profile => path.join(profile.localAppDataDir, 'npm-cache'),
  },
};

const normalizeWindowsPath = (value: string): string => {
  const resolved = path.resolve(value.trim());
  const parsed = path.parse(resolved);
  return resolved.length > parsed.root.length
    ? resolved.replace(/[\\/]+$/, '')
    : resolved;
};

const isPathWithin = (rootPath: string, candidatePath: string): boolean => {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isSupportedAbsolutePath = (candidate: string): boolean => (
  process.platform === 'win32'
    ? WINDOWS_LOCAL_DRIVE_PATH_PATTERN.test(candidate)
    : path.isAbsolute(candidate)
);

const resolveProfilePath = (
  value: string | undefined,
  fallback: string,
): string => {
  const candidate = value?.trim() || fallback;
  if (candidate.includes('\0') || !isSupportedAbsolutePath(candidate)) {
    return normalizeWindowsPath(fallback);
  }
  return normalizeWindowsPath(candidate);
};

/** Captures trusted profile paths from the OpenClaw host, never from a tool call. */
export const resolveWindowsHostProfile = (
  environment: NodeJS.ProcessEnv = process.env,
): NativeSandboxHostProfile => {
  const homeFallback = os.homedir();
  const userProfileDir = resolveProfilePath(
    environment.USERPROFILE,
    homeFallback,
  );
  return {
    mode: LobsterNativeSandboxProfileMode.InheritHost,
    homeDir: resolveProfilePath(environment.HOME, userProfileDir),
    userProfileDir,
    appDataDir: resolveProfilePath(
      environment.APPDATA,
      path.join(userProfileDir, 'AppData', 'Roaming'),
    ),
    localAppDataDir: resolveProfilePath(
      environment.LOCALAPPDATA,
      path.join(userProfileDir, 'AppData', 'Local'),
    ),
  };
};

export const parseWindowsSandboxFilesystemCapabilities = (
  value: unknown,
): LobsterNativeSandboxFilesystemCapabilityValue[] => {
  if (!Array.isArray(value)) return [];
  const known = new Set<LobsterNativeSandboxFilesystemCapabilityValue>(
    Object.values(LobsterNativeSandboxFilesystemCapability),
  );
  return Array.from(new Set(value.filter(
    (entry): entry is LobsterNativeSandboxFilesystemCapabilityValue => (
      typeof entry === 'string'
      && known.has(entry as LobsterNativeSandboxFilesystemCapabilityValue)
    ),
  )));
};

/** Resolves semantic compatibility grants into concrete, narrowly scoped roots. */
export class WindowsSandboxCapabilityRegistry {
  constructor(
    private readonly profile: NativeSandboxHostProfile,
    private readonly ensureDirectory: (directoryPath: string) => void = directoryPath => {
      fs.mkdirSync(directoryPath, { recursive: true });
    },
  ) {}

  resolve(
    enabledCapabilities: readonly LobsterNativeSandboxFilesystemCapabilityValue[],
  ): ResolvedWindowsSandboxCapabilities {
    const readableRoots: NativeSandboxPolicyRoot[] = [];
    const writableRoots: NativeSandboxPolicyRoot[] = [];
    for (const capability of new Set(enabledCapabilities)) {
      const definition = CAPABILITY_DEFINITIONS[capability];
      if (!definition) {
        throw new LobsterNativeSandboxBackendError(
          LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
          `Unsupported native Sandbox filesystem capability: ${String(capability)}.`,
        );
      }
      const root = this.prepareLeafRoot(definition);
      const target = definition.access === WindowsSandboxCapabilityAccess.Write
        ? writableRoots
        : readableRoots;
      target.push({ id: definition.rootId, path: root });
    }
    return { readableRoots, writableRoots };
  }

  private prepareLeafRoot(definition: WindowsSandboxCapabilityDefinition): string {
    const rawRoot = normalizeWindowsPath(definition.resolvePath(this.profile));
    try {
      this.ensureDirectory(rawRoot);
      if (fs.lstatSync(rawRoot).isSymbolicLink()) {
        throw new Error('symbolic links and junctions are not supported');
      }
      const localAppData = normalizeWindowsPath(
        fs.realpathSync.native(this.profile.localAppDataDir),
      );
      const resolvedRoot = normalizeWindowsPath(fs.realpathSync.native(rawRoot));
      if (resolvedRoot === localAppData || !isPathWithin(localAppData, resolvedRoot)) {
        throw new Error('resolved path is outside LOCALAPPDATA');
      }
      return resolvedRoot;
    } catch (error) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidWorkspace,
        `Native Sandbox capability ${definition.rootId} could not be prepared: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
