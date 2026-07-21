import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import { WindowsNativeSandboxExecutor } from './windowsNativeSandboxExecutor.js';

const runnerPath = path.join(
  process.cwd(),
  'native',
  'sandbox-windows',
  'target',
  'release',
  'lobster-command-runner.exe',
);
const canRun = process.platform === 'win32' && fs.existsSync(runnerPath);

describe.skipIf(!canRun)('WindowsNativeSandboxExecutor smoke', () => {
  test('enforces the same write boundary for shell and file bridge operations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-native-m2-smoke-'));
    const workspace = path.join(root, 'workspace');
    const agentWorkspace = path.join(root, 'agent-workspace');
    const sandboxHome = path.join(root, 'sandbox-data', 'main', 'home');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(agentWorkspace);
    fs.mkdirSync(outside);
    const policyContext = {
      agentWorkspaceDir: agentWorkspace,
      sandboxHomeDir: sandboxHome,
      writableRoots: [
        { id: 'agent', path: agentWorkspace },
        { id: 'sandbox-home', path: sandboxHome },
      ],
      readableRoots: [],
      protectedPaths: [],
    };
    const executor = new WindowsNativeSandboxExecutor({
      runnerPath,
      runtimeEnabled: true,
      audit: new SandboxAuditRecorder({
        policyVersion: 'workspace-write-v2',
        runtimeVersion: '0.2.0',
      }),
    });
    try {
      await executor.prepareWorkspace(workspace, policyContext);
      const shellInside = await executor.runIsolatedCommand({
        command: 'Set-Content -LiteralPath shell-inside.txt -Value ok',
        workspaceDir: workspace,
        policyContext,
        sessionKey: 'agent:main:m2-smoke',
      });
      expect(shellInside.code).toBe(0);
      expect(fs.readFileSync(path.join(workspace, 'shell-inside.txt'), 'utf8').trim()).toBe('ok');

      const escapedPath = path.join(outside, 'shell-outside.txt');
      const shellOutside = await executor.runIsolatedCommand({
        command: `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${escapedPath}' -Value escape`,
        workspaceDir: workspace,
        policyContext,
        sessionKey: 'agent:main:m2-smoke',
        allowFailure: true,
      });
      expect(shellOutside.code).not.toBe(0);
      expect(fs.existsSync(escapedPath)).toBe(false);

      const io = executor.createFsIo({
        workspaceDir: workspace,
        sessionKey: 'agent:main:m2-smoke',
        policyContext,
      });
      await io.writeFileAtomic({
        filePath: path.join(workspace, 'file-tool-inside.txt'),
        data: Buffer.from('file-tool-ok'),
        mkdir: true,
      });
      expect(fs.readFileSync(path.join(workspace, 'file-tool-inside.txt'), 'utf8'))
        .toBe('file-tool-ok');
      await expect(io.writeFileAtomic({
        filePath: path.join(outside, 'file-tool-outside.txt'),
        data: Buffer.from('escape'),
        mkdir: true,
      })).rejects.toThrow();
      expect(fs.existsSync(path.join(outside, 'file-tool-outside.txt'))).toBe(false);
    } finally {
      await executor.reset().catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
