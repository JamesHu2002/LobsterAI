import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import {
  LobsterNativeSandboxBackendErrorCode,
  LobsterNativeSandboxRuntimeState,
} from '../backend/constants.js';
import { WindowsNativeSandboxExecutor } from './windowsNativeSandboxExecutor.js';

const temporaryRoots: string[] = [];

const verificationReport = Buffer.from(JSON.stringify({
  protocolVersion: 1,
  policyVersion: 'workspace-write-v1',
  capabilitySids: ['S-1-5-21-test'],
  writableRoots: [],
  protectedPaths: [],
  restrictedToken: true,
  writeRestricted: true,
  ownerPreserved: true,
  networkIsolated: false,
  readIsolated: false,
  productionReady: false,
}));

const executionReport = JSON.stringify({
  protocolVersion: 1,
  outcome: 'completed',
  exitCode: 0,
  durationMs: 10,
  outputBytes: 2,
  capabilitySids: ['S-1-5-21-test'],
  writableRoots: [],
});

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-native-executor-test-'));
  const workspace = path.join(root, 'workspace');
  const otherWorkspace = path.join(root, 'other');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(workspace);
  fs.mkdirSync(otherWorkspace);
  temporaryRoots.push(root);
  const invokeRunner = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'verify') {
      return { exitCode: 0, stdout: verificationReport, stderr: Buffer.alloc(0) };
    }
    if (args[0] === 'run') {
      const reportIndex = args.indexOf('--report-file');
      if (reportIndex >= 0) fs.writeFileSync(args[reportIndex + 1], executionReport);
      return {
        exitCode: 0,
        stdout: Buffer.from('ok'),
        stderr: Buffer.alloc(0),
      };
    }
    return { exitCode: 0, stdout: Buffer.from('{"ok":true}'), stderr: Buffer.alloc(0) };
  });
  const executor = new WindowsNativeSandboxExecutor({
    runnerPath: path.join(root, 'lobster-command-runner.exe'),
    runtimeEnabled: true,
    audit: new SandboxAuditRecorder({
      policyVersion: 'workspace-write-v1',
      runtimeVersion: '0.1.0',
    }),
    platform: 'win32',
    pathExists: () => true,
    invokeRunner,
    createScratchDirectory: () => scratch,
    verifyWriteBoundary: async () => undefined,
    now: () => 100,
  });
  return { executor, invokeRunner, otherWorkspace, scratch, workspace };
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('WindowsNativeSandboxExecutor', () => {
  test('prepares one workspace and reports the honest M2 capability boundary', async () => {
    const { executor, invokeRunner, workspace } = createFixture();

    await executor.prepareWorkspace(workspace);
    await executor.prepareWorkspace(workspace.toUpperCase());

    expect(invokeRunner).toHaveBeenCalledTimes(1);
    expect(executor.getStatus()).toMatchObject({
      state: LobsterNativeSandboxRuntimeState.Ready,
      runtimeEnabled: true,
      activeCommands: 0,
      networkIsolated: false,
      readIsolated: false,
      productionReady: false,
    });
  });

  test('builds a runner request sidecar and filters host-owned environment values', async () => {
    const { executor, workspace } = createFixture();

    const wrapped = await executor.wrapCommand({
      command: 'npm test',
      workspaceDir: workspace,
      env: {
        CI: '1',
        PATH: 'C:\\untrusted',
        HTTPS_PROXY: 'http://proxy.invalid',
      },
      sessionKey: 'agent:main:session-1',
    });
    const request = JSON.parse(fs.readFileSync(wrapped.token.requestPath!, 'utf8'));

    expect(wrapped.argv).toEqual([
      expect.stringMatching(/lobster-command-runner\.exe$/),
      'run',
      wrapped.token.requestPath,
      '--report-file',
      wrapped.token.reportPath,
    ]);
    expect(request.policy).toMatchObject({
      policyVersion: 'workspace-write-v1',
      agentId: 'main',
      cwd: fs.realpathSync.native(workspace),
      writableRoots: [fs.realpathSync.native(workspace)],
      networkMode: 'disabled',
    });
    expect(request.command.env).toEqual({ CI: '1' });
    expect(request.command.argv.at(-1)).toBe('npm test');

    fs.writeFileSync(wrapped.token.reportPath!, executionReport);
    await executor.finalizeCommand({
      token: wrapped.token,
      status: 'completed',
      exitCode: 0,
      timedOut: false,
    });
    expect(executor.getStatus().activeCommands).toBe(0);
  });

  test('runs captured helper commands without leaking the runner report into stderr', async () => {
    const { executor, workspace } = createFixture();

    const result = await executor.runIsolatedCommand({
      command: 'Write-Output ok',
      workspaceDir: workspace,
      sessionKey: 'agent:main:session-2',
    });

    expect(result).toEqual({
      stdout: Buffer.from('ok'),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    expect(executor.getStatus().activeCommands).toBe(0);
  });

  test('rejects a second workspace until the first runtime is reset', async () => {
    const { executor, otherWorkspace, workspace } = createFixture();
    await executor.prepareWorkspace(workspace);

    await expect(executor.prepareWorkspace(otherWorkspace)).rejects.toMatchObject({
      code: LobsterNativeSandboxBackendErrorCode.WorkspaceConflict,
    });

    await executor.reset();
    await executor.prepareWorkspace(otherWorkspace);
    expect(executor.getStatus().state).toBe(LobsterNativeSandboxRuntimeState.Ready);
  });

  test('rejects non-empty stdin instead of silently running it on the host', async () => {
    const { executor, workspace } = createFixture();

    await expect(executor.runIsolatedCommand({
      command: 'more',
      workspaceDir: workspace,
      stdin: 'secret',
    })).rejects.toMatchObject({
      code: LobsterNativeSandboxBackendErrorCode.InteractiveInputUnsupported,
    });
  });
});
