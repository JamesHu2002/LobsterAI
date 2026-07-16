import { describe, expect, test } from 'vitest';

import { expectPatchContains, readCurrentOpenClawPatch } from './patchTestUtils';

const patchFile = 'zzz-openclaw-sandbox-task-workspace.patch';

describe('OpenClaw sandbox task workspace patch', () => {
  test('carries distinct agent and task workspace semantics through normal and compact turns', () => {
    expectPatchContains(patchFile, [
      'taskWorkspaceDir?: string',
      'const hasDistinctTaskWorkspace = !areSandboxHostPathsEqual(',
      'taskWorkspaceDir: requestedCwd ?? resolvedWorkspace',
      'sandbox.taskWorkspaceDir ?? resolvedWorkspace',
      'sandbox.agentWorkspaceDir ?? resolvedWorkspace',
      'compares task and agent workspace casing with $platform path semantics',
      'normalizes Windows separators and casing with win32 path semantics',
      'uses a distinct task cwd for sandboxed runtime tools',
      'uses a distinct sandbox task cwd while preserving the agent compaction workspace',
    ]);

    const patchContent = readCurrentOpenClawPatch(patchFile);
    const addedLines = patchContent
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');
    expect(addedLines).not.toContain('cwd override is not supported for sandboxed embedded');
  });

  test('keeps native sandbox paths backend-neutral and memory writes agent-scoped', () => {
    expectPatchContains(patchFile, [
      'workspacePathSemantics?: "container" | "host"',
      'const usesHostSandboxPaths =',
      'Persistent agent files are managed by OpenClaw',
      'Task workspace access:',
      'memoryFlushWorkspaceDir?: string',
      'const memoryFlushUsesSandboxBridge =',
      'keeps sandbox memory flush writes in the persistent agent workspace',
      'does not expose a distinct persistent agent workspace as a task mount',
      'does not advertise an agent mount for a distinct task workspace',
    ]);
  });
});
