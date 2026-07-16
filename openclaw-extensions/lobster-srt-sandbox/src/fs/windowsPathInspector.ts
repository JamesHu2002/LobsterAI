import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';

import { mapNodeFsError } from './sandboxFsError.js';

export const WindowsPathEntryType = {
  Directory: 'directory',
  File: 'file',
  Other: 'other',
} as const;
export type WindowsPathEntryType =
  (typeof WindowsPathEntryType)[keyof typeof WindowsPathEntryType];

export type WindowsPathIdentity = {
  device: string;
  file: string;
};

export type WindowsPathEntry = {
  type: WindowsPathEntryType;
  identity: WindowsPathIdentity;
  isReparsePoint: boolean;
  linkCount: number;
  size: number;
  mtimeMs: number;
};

/**
 * Abstracted because Node cannot expose every Windows reparse tag or provide
 * handle-relative `NtCreateFile` operations. M2 uses the Node implementation
 * for mock validation; a native inspector is required before backend opt-in.
 */
export interface WindowsPathInspector {
  inspectNoFollow(filePath: string): Promise<WindowsPathEntry | null>;
  realpath(filePath: string): Promise<string>;
}

export function windowsPathIdentityEquals(
  left: WindowsPathIdentity,
  right: WindowsPathIdentity,
): boolean {
  return left.device === right.device && left.file === right.file;
}

export function createWindowsPathIdentity(
  device: bigint,
  file: bigint,
): WindowsPathIdentity {
  return {
    device: device.toString(),
    file: file.toString(),
  };
}

function bigintToSafeStatNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number.MIN_SAFE_INTEGER;
  }
  return Number(value);
}

export class NodeWindowsPathInspector implements WindowsPathInspector {
  async inspectNoFollow(filePath: string): Promise<WindowsPathEntry | null> {
    let stats: BigIntStats;
    try {
      // Windows volume/file IDs can exceed Number.MAX_SAFE_INTEGER. BigInt is
      // required here because these fields participate in race detection.
      stats = await fs.lstat(filePath, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null;
      }
      throw mapNodeFsError(error, 'Unable to inspect sandbox file path.');
    }

    return {
      type: stats.isDirectory()
        ? WindowsPathEntryType.Directory
        : stats.isFile()
          ? WindowsPathEntryType.File
          : WindowsPathEntryType.Other,
      identity: createWindowsPathIdentity(stats.dev, stats.ino),
      // Junctions and ordinary symlinks report as symbolic links through
      // lstat. Other reparse tags require the future native inspector.
      isReparsePoint: stats.isSymbolicLink(),
      linkCount: bigintToSafeStatNumber(stats.nlink),
      size: bigintToSafeStatNumber(stats.size),
      mtimeMs: bigintToSafeStatNumber(stats.mtimeMs),
    };
  }

  async realpath(filePath: string): Promise<string> {
    try {
      return await fs.realpath(filePath);
    } catch (error) {
      throw mapNodeFsError(error, 'Unable to canonicalize sandbox file path.');
    }
  }
}
