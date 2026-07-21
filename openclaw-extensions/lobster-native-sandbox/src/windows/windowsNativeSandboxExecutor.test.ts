import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { SandboxAuditRecorder } from '../audit/sandboxAuditRecorder.js';
import {
  LobsterNativeSandboxBackendErrorCode,
  LobsterNativeSandboxRuntimeState,
} from '../backend/constants.js';
import type { NativeSandboxPolicyContext } from '../runtime/nativeSandboxExecutor.js';
import { WindowsNativeSandboxExecutor } from './windowsNativeSandboxExecutor.js';

const temporaryRoots: string[] = [];

type CapturedRunnerRequest = {
  policy: {
    writableRoots: string[];
  };
};

const verificationReport = Buffer.from(JSON.stringify({
  protocolVersion: 2,
  policyVersion: 'workspace-write-v2',
  capabilitySids: ['S-1-5-21-test'],
  writableRoots: [],
  readableRoots: [],
  protectedPaths: [],
  sandboxHomeDir: '',
  restrictedToken: true,
  writeRestricted: true,
  ownerPreserved: true,
  networkIsolated: false,
  readIsolated: false,
  productionReady: false,
}));

const executionReport = JSON.stringify({
  protocolVersion: 2,
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
  const agentWorkspace = path.join(root, 'agent-workspace');
  const sandboxHome = path.join(root, 'sandbox-data', 'main', 'home');
  const skillsRoot = path.join(root, 'SKILLs');
  const scratch = path.join(root, 'scratch');
  const runnerRequests: Array<{ command: string; request: CapturedRunnerRequest }> = [];
  fs.mkdirSync(workspace);
  fs.mkdirSync(otherWorkspace);
  fs.mkdirSync(agentWorkspace);
  fs.mkdirSync(skillsRoot);
  const policyContext: NativeSandboxPolicyContext = {
    agentWorkspaceDir: agentWorkspace,
    sandboxHomeDir: sandboxHome,
    writableRoots: [
      { id: 'agent', path: agentWorkspace },
      { id: 'sandbox-home', path: sandboxHome },
    ],
    readableRoots: [{ id: 'skills', path: skillsRoot }],
    protectedPaths: [],
  };
  temporaryRoots.push(root);
  const invokeRunner = vi.fn(async (args: readonly string[]) => {
    if (args[1] && fs.existsSync(args[1])) {
      runnerRequests.push({
        command: args[0],
        request: JSON.parse(fs.readFileSync(args[1], 'utf8')) as CapturedRunnerRequest,
      });
    }
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
      policyVersion: 'workspace-write-v2',
      runtimeVersion: '0.2.0',
    }),
    platform: 'win32',
    pathExists: () => true,
    invokeRunner,
    createScratchDirectory: () => scratch,
    verifyWriteBoundary: async () => undefined,
    now: () => 100,
  });
  return {
    agentWorkspace,
    executor,
    invokeRunner,
    otherWorkspace,
    policyContext,
    root,
    runnerRequests,
    sandboxHome,
    scratch,
    skillsRoot,
    workspace,
  };
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('WindowsNativeSandboxExecutor', () => {
  test('prepares one workspace and reports the honest M2 capability boundary', async () => {
    const { executor, invokeRunner, policyContext, workspace } = createFixture();

    await executor.prepareWorkspace(workspace, policyContext);
    await executor.prepareWorkspace(workspace.toUpperCase(), policyContext);

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
    const {
      agentWorkspace,
      executor,
      policyContext,
      sandboxHome,
      skillsRoot,
      workspace,
    } = createFixture();

    const wrapped = await executor.wrapCommand({
      command: 'npm test',
      workspaceDir: workspace,
      policyContext,
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
      policyVersion: 'workspace-write-v2',
      agentId: 'main',
      cwd: fs.realpathSync.native(workspace),
      writableRoots: [
        fs.realpathSync.native(workspace),
        fs.realpathSync.native(agentWorkspace),
        fs.realpathSync.native(sandboxHome),
      ],
      readableRoots: [fs.realpathSync.native(skillsRoot)],
      sandboxHomeDir: fs.realpathSync.native(sandboxHome),
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
    const { executor, policyContext, workspace } = createFixture();

    const result = await executor.runIsolatedCommand({
      command: 'Write-Output ok',
      workspaceDir: workspace,
      policyContext,
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
    const { executor, otherWorkspace, policyContext, workspace } = createFixture();
    await executor.prepareWorkspace(workspace, policyContext);

    await expect(executor.prepareWorkspace(otherWorkspace, policyContext)).rejects.toMatchObject({
      code: LobsterNativeSandboxBackendErrorCode.WorkspaceConflict,
    });

    await executor.reset();
    await executor.prepareWorkspace(otherWorkspace, policyContext);
    expect(executor.getStatus().state).toBe(LobsterNativeSandboxRuntimeState.Ready);
  });

  test('keeps the writable-root union for complete ACL cleanup', async () => {
    const {
      executor,
      policyContext,
      root,
      runnerRequests,
      workspace,
    } = createFixture();
    await executor.prepareWorkspace(workspace, policyContext);

    const secondAgentWorkspace = path.join(root, 'agent-workspace-2');
    const secondSandboxHome = path.join(root, 'sandbox-data', 'agent-2', 'home');
    fs.mkdirSync(secondAgentWorkspace);
    await executor.prepareWorkspace(workspace, {
      ...policyContext,
      agentWorkspaceDir: secondAgentWorkspace,
      sandboxHomeDir: secondSandboxHome,
      writableRoots: [
        { id: 'agent', path: secondAgentWorkspace },
        { id: 'sandbox-home', path: secondSandboxHome },
      ],
    });

    await executor.reset();
    const cleanup = runnerRequests.findLast(request => request.command === 'cleanup');
    expect(cleanup?.request.policy.writableRoots).toEqual(expect.arrayContaining([
      fs.realpathSync.native(workspace),
      fs.realpathSync.native(policyContext.agentWorkspaceDir),
      fs.realpathSync.native(policyContext.sandboxHomeDir),
      fs.realpathSync.native(secondAgentWorkspace),
      fs.realpathSync.native(secondSandboxHome),
    ]));
  });

  test('rejects non-empty stdin instead of silently running it on the host', async () => {
    const { executor, policyContext, workspace } = createFixture();

    await expect(executor.runIsolatedCommand({
      command: 'more',
      workspaceDir: workspace,
      policyContext,
      stdin: 'secret',
    })).rejects.toMatchObject({
      code: LobsterNativeSandboxBackendErrorCode.InteractiveInputUnsupported,
    });
  });
});
