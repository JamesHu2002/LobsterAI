import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import { LobsterNativeSandboxFilesystemCapability } from '../backend/constants.js';
import { WindowsNativeSandboxExecutor } from './windowsNativeSandboxExecutor.js';
import { createWindowsSandboxPolicyContext } from './windowsSandboxPolicyContext.js';

const runnerPath = path.join(
  process.env.ProgramData ?? 'C:\\ProgramData',
  'LobsterAI-SandboxRuntime',
  'current',
  'lobster-command-runner.exe',
);
const canRun = process.platform === 'win32'
  && process.env.LOBSTER_NATIVE_SANDBOX_RUN_INSTALLED_SMOKE === '1'
  && fs.existsSync(runnerPath);

describe.skipIf(!canRun)('WindowsNativeSandboxExecutor smoke', () => {
  test('enforces the same write boundary for shell and file bridge operations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-native-m2-smoke-'));
    const workspace = path.join(root, 'workspace');
    const agentWorkspace = path.join(root, 'agent-workspace');
    const profileRoot = path.join(root, 'profile');
    const appData = path.join(profileRoot, 'AppData', 'Roaming');
    const localAppData = path.join(profileRoot, 'AppData', 'Local');
    const npmCache = path.join(localAppData, 'npm-cache');
    const npmBinDir = path.join(process.cwd(), 'node_modules', 'npm', 'bin');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(agentWorkspace);
    fs.mkdirSync(outside);
    fs.mkdirSync(appData, { recursive: true });
    const policyContext = createWindowsSandboxPolicyContext({
      agentWorkspaceDir: agentWorkspace,
      filesystemCapabilities: [
        LobsterNativeSandboxFilesystemCapability.NpmCacheWrite,
      ],
      environment: {
        APPDATA: appData,
        HOME: profileRoot,
        LOCALAPPDATA: localAppData,
        USERPROFILE: profileRoot,
      },
    });
    const executor = new WindowsNativeSandboxExecutor({
      runnerPath,
      runtimeEnabled: true,
      audit: new SandboxAuditRecorder({
        policyVersion: 'workspace-write-v4',
        runtimeVersion: '0.4.0',
      }),
      trustedEnvironment: {
        LOBSTERAI_ELECTRON_PATH: process.execPath,
        LOBSTERAI_NPM_BIN_DIR: npmBinDir,
        TZ: 'Asia/Shanghai',
      },
    });
    try {
      await executor.prepareWorkspace(workspace, policyContext);
      const trustedEnvironment = await executor.runIsolatedCommand({
        command: [
          "$ErrorActionPreference='Stop'",
          'if (-not (Test-Path -LiteralPath $env:LOBSTERAI_ELECTRON_PATH -PathType Leaf)) { exit 31 }',
          'if (-not (Test-Path -LiteralPath $env:LOBSTERAI_NPM_BIN_DIR -PathType Container)) { exit 32 }',
          "if ($env:TZ -ne 'Asia/Shanghai') { exit 33 }",
          "Write-Output 'trusted-env-ok'",
        ].join('; '),
        workspaceDir: workspace,
        policyContext,
        sessionKey: 'agent:main:m2-smoke',
      });
      expect(trustedEnvironment.code).toBe(0);
      expect(trustedEnvironment.stdout.toString('utf8').trim()).toBe('trusted-env-ok');

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

      const cacheWrite = await executor.runIsolatedCommand({
        command: "Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'npm-cache\\smoke.txt') -Value cached",
        workspaceDir: workspace,
        policyContext,
        sessionKey: 'agent:main:m2-smoke',
      });
      expect(cacheWrite.code).toBe(0);
      expect(fs.readFileSync(path.join(npmCache, 'smoke.txt'), 'utf8').trim()).toBe('cached');

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
