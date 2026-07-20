import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from 'vitest';

import { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import { SandboxFsErrorCode } from '../fs/sandboxFsError.js';
import { SrtSandboxFsIo } from '../fs/srtSandboxFsIo.js';
import { createWindowsSandboxFsBridge } from '../fs/windowsSandboxFsBridge.js';
import {
  LOBSTER_SRT_POLICY_VERSION,
  LOBSTER_SRT_RUNTIME_VERSION,
  LobsterSrtSandboxBackendErrorCode,
} from './constants.js';
import { SrtWindowsSession } from './srtWindowsSession.js';

const runSmoke = process.platform === 'win32'
  && process.env.LOBSTER_SRT_WINDOWS_SMOKE === '1';

const quotePowerShellLiteral = (value: string): string => (
  `'${value.replaceAll('\'', '\'\'')}'`
);

const secureSmokeRoot = (testRoot: string): void => {
  const sidResult = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const currentSid = sidResult.stdout.trim();
  if (sidResult.status !== 0 || !/^S-\d+(?:-\d+)+$/.test(currentSid)) {
    throw new Error(`Unable to resolve the smoke-test owner SID: ${sidResult.stderr.trim()}`);
  }

  const aclResult = spawnSync('icacls.exe', [
    testRoot,
    '/inheritance:r',
    '/grant:r',
    `*${currentSid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (aclResult.status !== 0) {
    throw new Error(`Unable to secure the smoke-test root: ${aclResult.stderr.trim()}`);
  }
};

const grantBroadSmokeWrite = (testRoot: string): void => {
  const aclResult = spawnSync('icacls.exe', [
    testRoot,
    '/grant',
    '*S-1-5-11:(OI)(CI)M',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (aclResult.status !== 0) {
    throw new Error(`Unable to create the broad-ACL smoke fixture: ${aclResult.stderr.trim()}`);
  }
};

const resolveHelperPath = (): string => path.join(
  process.cwd(),
  'node_modules',
  '@anthropic-ai',
  'sandbox-runtime',
  'vendor',
  'srt-win',
  process.arch,
  'srt-win.exe',
);

test.runIf(runSmoke)(
  'real SRT account enforces the M3 workspace and offline boundaries',
  async () => {
    const testParent = path.join(process.cwd(), '.work');
    await fs.mkdir(testParent, { recursive: true });
    const testRoot = await fs.mkdtemp(path.join(testParent, 'sandbox-srt-smoke-'));
    secureSmokeRoot(testRoot);
    const workspaceDir = path.join(testRoot, 'workspace');
    const outsideDir = path.join(testRoot, 'outside');
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.mkdir(workspaceDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(outsideFile, 'outside-secret');

    const session = new SrtWindowsSession({
      helperPath: resolveHelperPath(),
      runtimeEnabled: true,
      audit: new SandboxAuditRecorder({
        policyVersion: LOBSTER_SRT_POLICY_VERSION,
        runtimeVersion: LOBSTER_SRT_RUNTIME_VERSION,
      }),
    });
    const runCommand = async (
      stage: string,
      params: Parameters<SrtWindowsSession['runIsolatedCommand']>[0],
    ) => {
      console.log(`[srt-windows-smoke] ${stage}: start`);
      try {
        const result = await session.runIsolatedCommand({
          ...params,
          signal: AbortSignal.timeout(20_000),
        });
        console.log(`[srt-windows-smoke] ${stage}: exit=${result.code}`);
        return result;
      } catch (error) {
        throw new Error(
          `${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    };

    try {
      console.log('[srt-windows-smoke] initialize: start');
      await session.prepareWorkspace(workspaceDir);
      console.log('[srt-windows-smoke] initialize: ready');

      const identity = await runCommand('identity', {
        command: 'whoami',
        workspaceDir,
      });
      expect(identity.stdout.toString('utf8').toLowerCase()).toContain('srt-sandbox');

      await runCommand('workspace-write', {
        command: 'Set-Content -LiteralPath .\\inside.txt -Value sandbox',
        workspaceDir,
      });
      await runCommand('child-process', {
        command: 'cmd.exe /d /s /c "echo child>child.txt"',
        workspaceDir,
      });
      await expect(fs.readFile(path.join(workspaceDir, 'inside.txt'), 'utf8'))
        .resolves.toContain('sandbox');
      await expect(fs.readFile(path.join(workspaceDir, 'child.txt'), 'utf8'))
        .resolves.toContain('child');

      const outsideRead = await runCommand('outside-read', {
        command: `Get-Content -LiteralPath ${quotePowerShellLiteral(outsideFile)}`,
        workspaceDir,
        allowFailure: true,
      });
      expect(outsideRead.code).not.toBe(0);

      const outsideWrite = await runCommand('outside-write', {
        command: `Set-Content -LiteralPath ${
          quotePowerShellLiteral(path.join(outsideDir, 'escaped.txt'))
        } -Value escaped`,
        workspaceDir,
        allowFailure: true,
      });
      expect(outsideWrite.code).not.toBe(0);

      const directNetwork = await runCommand('direct-network', {
        command: [
          '$client = [System.Net.Sockets.TcpClient]::new();',
          'try {',
          '$task = $client.ConnectAsync("1.1.1.1", 443);',
          'if ($task.Wait(2000) -and $client.Connected) { exit 0 }',
          'exit 23',
          '} catch { exit 23 } finally { $client.Dispose() }',
        ].join(' '),
        workspaceDir,
        allowFailure: true,
      });
      expect(directNetwork.code).not.toBe(0);

      const bridge = createWindowsSandboxFsBridge({
        sandbox: {
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          taskWorkspaceDir: workspaceDir,
          workspaceAccess: 'rw',
          containerName: 'lobster-srt-smoke',
          containerWorkdir: workspaceDir,
          docker: {},
        },
        io: new SrtSandboxFsIo({ session, workspaceDir }),
      });
      console.log('[srt-windows-smoke] file-bridge: start');
      await bridge.writeFile({
        filePath: 'bridge.txt',
        data: 'bridge-data',
        signal: AbortSignal.timeout(20_000),
      });
      await expect(bridge.readFile({
        filePath: 'bridge.txt',
        signal: AbortSignal.timeout(20_000),
      }))
        .resolves.toEqual(Buffer.from('bridge-data'));
      await bridge.writeFile({
        filePath: 'bridge.txt',
        data: 'bridge-replaced',
        signal: AbortSignal.timeout(20_000),
      });
      await expect(bridge.readFile({ filePath: 'bridge.txt' }))
        .resolves.toEqual(Buffer.from('bridge-replaced'));
      await bridge.mkdirp({ filePath: 'nested' });
      const binaryData = Buffer.from([0, 1, 2, 255]);
      await bridge.writeFile({
        filePath: 'nested\\source.bin',
        data: binaryData,
      });
      await expect(bridge.rename({
        from: 'nested\\source.bin',
        to: 'nested\\renamed.bin',
      })).resolves.toBeUndefined();
      await expect(bridge.readFile({ filePath: 'nested\\renamed.bin' }))
        .resolves.toEqual(binaryData);
      await bridge.remove({ filePath: 'nested', recursive: true });
      await expect(fs.stat(path.join(workspaceDir, 'nested'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(bridge.readFile({ filePath: outsideFile })).rejects.toMatchObject({
        code: SandboxFsErrorCode.OutsideWorkspace,
      });
      console.log('[srt-windows-smoke] file-bridge: complete');
    } finally {
      console.log('[srt-windows-smoke] reset: start');
      await session.reset().catch(() => undefined);
      console.log('[srt-windows-smoke] reset: complete');
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  },
  180_000,
);

test.runIf(runSmoke)(
  'real SRT session rejects a workspace with broad inherited write access',
  async () => {
    const testParent = path.join(process.cwd(), '.work');
    await fs.mkdir(testParent, { recursive: true });
    const testRoot = await fs.mkdtemp(path.join(testParent, 'sandbox-srt-broad-acl-'));
    grantBroadSmokeWrite(testRoot);
    const workspaceDir = path.join(testRoot, 'workspace');
    await fs.mkdir(workspaceDir);
    const session = new SrtWindowsSession({
      helperPath: resolveHelperPath(),
      runtimeEnabled: true,
      audit: new SandboxAuditRecorder({
        policyVersion: LOBSTER_SRT_POLICY_VERSION,
        runtimeVersion: LOBSTER_SRT_RUNTIME_VERSION,
      }),
    });

    try {
      await expect(session.prepareWorkspace(workspaceDir)).rejects.toMatchObject({
        code: LobsterSrtSandboxBackendErrorCode.UnsafeWorkspaceAcl,
      });
    } finally {
      await session.reset().catch(() => undefined);
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  },
  180_000,
);
