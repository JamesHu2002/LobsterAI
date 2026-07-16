import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

import { mapNodeFsError, throwIfAborted } from './sandboxFsError.js';

export interface SandboxFsIo {
  readFile(filePath: string, signal?: AbortSignal): Promise<Buffer>;
  writeFileAtomic(params: {
    filePath: string;
    data: Buffer;
    mkdir: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  mkdirp(filePath: string, signal?: AbortSignal): Promise<void>;
  remove(params: {
    filePath: string;
    recursive: boolean;
    force: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  rename(params: {
    from: string;
    to: string;
    mkdir: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  listDirectory(filePath: string, signal?: AbortSignal): Promise<readonly string[]>;
}

/**
 * Mock-grade Node adapter used by M2 tests. It intentionally remains separate
 * from the policy so a future native, handle-relative implementation can be
 * substituted without weakening path decisions.
 */
export class NodeSandboxFsIo implements SandboxFsIo {
  async readFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);
    try {
      return await fs.readFile(filePath, { signal });
    } catch (error) {
      throw mapNodeFsError(error, 'Unable to read sandbox file.');
    }
  }

  async writeFileAtomic(params: {
    filePath: string;
    data: Buffer;
    mkdir: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    throwIfAborted(params.signal);
    const parentPath = path.win32.dirname(params.filePath);
    const temporaryPath = path.win32.join(
      parentPath,
      `.${path.win32.basename(params.filePath)}.lobster-${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;
    let temporaryHandle: FileHandle | null = null;
    try {
      if (params.mkdir) {
        await fs.mkdir(parentPath, { recursive: true });
      }
      temporaryHandle = await fs.open(temporaryPath, 'wx');
      temporaryCreated = true;
      try {
        await this.writeTemporaryFile(temporaryHandle, params.data, params.signal);
      } finally {
        await temporaryHandle.close();
        temporaryHandle = null;
      }
      throwIfAborted(params.signal);
      await fs.rename(temporaryPath, params.filePath);
      temporaryCreated = false;
    } catch (error) {
      if (temporaryHandle) {
        await temporaryHandle.close().catch(() => undefined);
      }
      if (temporaryCreated) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      throw mapNodeFsError(error, 'Unable to atomically write sandbox file.');
    }
  }

  async mkdirp(filePath: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    try {
      await fs.mkdir(filePath, { recursive: true });
    } catch (error) {
      throw mapNodeFsError(error, 'Unable to create sandbox directory.');
    }
    throwIfAborted(signal);
  }

  async remove(params: {
    filePath: string;
    recursive: boolean;
    force: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    throwIfAborted(params.signal);
    try {
      await fs.rm(params.filePath, {
        recursive: params.recursive,
        force: params.force,
      });
    } catch (error) {
      throw mapNodeFsError(error, 'Unable to remove sandbox path.');
    }
    throwIfAborted(params.signal);
  }

  async rename(params: {
    from: string;
    to: string;
    mkdir: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    throwIfAborted(params.signal);
    try {
      if (params.mkdir) {
        await fs.mkdir(path.win32.dirname(params.to), { recursive: true });
      }
      await fs.rename(params.from, params.to);
    } catch (error) {
      throw mapNodeFsError(error, 'Unable to rename sandbox path.');
    }
    throwIfAborted(params.signal);
  }

  async listDirectory(filePath: string, signal?: AbortSignal): Promise<readonly string[]> {
    throwIfAborted(signal);
    try {
      return await fs.readdir(filePath);
    } catch (error) {
      throw mapNodeFsError(error, 'Unable to enumerate sandbox directory.');
    }
  }

  protected async writeTemporaryFile(
    handle: FileHandle,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    await handle.writeFile(data, { signal });
  }
}
