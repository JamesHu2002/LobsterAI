import fs from 'node:fs/promises';
import path from 'node:path';

import { expect,test } from 'vitest';

import { SandboxFsErrorCode } from './sandboxFsError.js';
import { NodeSandboxFsIo } from './sandboxFsIo.js';
import { NodeWindowsPathInspector } from './windowsPathInspector.js';
import { WindowsSandboxFsBridge } from './windowsSandboxFsBridge.js';
import {
  createWindowsWorkspacePathPolicy,
  SandboxPathIntent,
} from './windowsWorkspacePathPolicy.js';

class FailingTemporaryWriteIo extends NodeSandboxFsIo {
  protected override async writeTemporaryFile(): Promise<void> {
    throw new Error('Injected failure after temporary file creation.');
  }
}

async function createWindowsTestArea(): Promise<string> {
  const testParent = path.join(process.cwd(), '.work');
  await fs.mkdir(testParent, { recursive: true });
  return await fs.mkdtemp(path.join(testParent, 'sandbox-fs-'));
}

test.runIf(process.platform === 'win32')(
  'Node mock bridge performs native Windows I/O, including ordinary long paths',
  async () => {
    const testArea = await createWindowsTestArea();
    const taskRoot = path.join(testArea, 'task');
    await fs.mkdir(taskRoot);
    try {
      const inspector = new NodeWindowsPathInspector();
      const policy = createWindowsWorkspacePathPolicy({
        taskWorkspaceDir: taskRoot,
        inspector,
      });
      const bridge = new WindowsSandboxFsBridge({
        policy,
        io: new NodeSandboxFsIo(),
      });
      const longRelativePath = `${'nested\\'.repeat(35)}answer.txt`;
      expect(path.join(taskRoot, longRelativePath).length).toBeGreaterThan(260);

      await bridge.writeFile({ filePath: longRelativePath, data: 'sandbox' });
      await bridge.writeFile({ filePath: longRelativePath, data: 'updated' });
      await expect(
        bridge.readFile({ filePath: path.join(taskRoot, longRelativePath).toUpperCase() }),
      ).resolves.toEqual(Buffer.from('updated'));
      await bridge.rename({ from: longRelativePath, to: 'moved\\answer.txt' });
      expect(await bridge.stat({ filePath: 'moved\\answer.txt' })).toMatchObject({
        type: 'file',
        size: 7,
      });
      await bridge.remove({ filePath: 'moved', recursive: true });
      await expect(bridge.stat({ filePath: 'moved\\answer.txt' })).resolves.toBeNull();
    } finally {
      await fs.rm(testArea, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform === 'win32')(
  'Node atomic writer removes its owned temporary file when writing fails after open',
  async () => {
    const testArea = await createWindowsTestArea();
    const taskRoot = path.join(testArea, 'task');
    await fs.mkdir(taskRoot);
    try {
      const policy = createWindowsWorkspacePathPolicy({ taskWorkspaceDir: taskRoot });
      const bridge = new WindowsSandboxFsBridge({
        policy,
        io: new FailingTemporaryWriteIo(),
      });

      await expect(
        bridge.writeFile({ filePath: 'failed.txt', data: 'sensitive partial content' }),
      ).rejects.toMatchObject({ code: SandboxFsErrorCode.IoError });
      expect(await fs.readdir(taskRoot)).toEqual([]);
    } finally {
      await fs.rm(testArea, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform === 'win32')(
  'Node policy rejects NTFS junction and hard-link escapes without SRT or elevation',
  async () => {
    const testArea = await createWindowsTestArea();
    const taskRoot = path.join(testArea, 'task');
    const outsideRoot = path.join(testArea, 'outside');
    await fs.mkdir(taskRoot);
    await fs.mkdir(outsideRoot);
    try {
      await fs.writeFile(path.join(outsideRoot, 'secret.txt'), 'outside');
      await fs.symlink(outsideRoot, path.join(taskRoot, 'junction'), 'junction');
      await fs.writeFile(path.join(taskRoot, 'original.txt'), 'inside');
      await fs.link(path.join(taskRoot, 'original.txt'), path.join(taskRoot, 'alias.txt'));

      const policy = createWindowsWorkspacePathPolicy({ taskWorkspaceDir: taskRoot });
      await expect(
        policy.prepare({
          filePath: 'junction\\secret.txt',
          intent: SandboxPathIntent.Read,
        }),
      ).rejects.toMatchObject({ code: SandboxFsErrorCode.ReparsePointUnsupported });
      await expect(
        policy.prepare({ filePath: 'alias.txt', intent: SandboxPathIntent.Read }),
      ).rejects.toMatchObject({ code: SandboxFsErrorCode.HardlinkUnsupported });
    } finally {
      await fs.rm(testArea, { recursive: true, force: true });
    }
  },
);
