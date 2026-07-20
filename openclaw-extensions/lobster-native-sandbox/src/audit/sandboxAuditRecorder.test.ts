import { describe, expect, test, vi } from 'vitest';

import {
  SandboxAuditEventType,
  SandboxAuditRecorder,
  SandboxAuditResult,
} from './sandboxAuditRecorder.js';

describe('SandboxAuditRecorder', () => {
  test('records correlation digests without exposing raw session, path, or command data', () => {
    const debug = vi.fn();
    const recorder = new SandboxAuditRecorder({
      policyVersion: 'm3-test',
      runtimeVersion: '0.0.65',
      logger: { debug },
      now: () => 123,
    });

    const event = recorder.record({
      type: SandboxAuditEventType.CommandRequested,
      result: SandboxAuditResult.Allowed,
      sessionKey: 'agent:main:private-session',
      workspaceDir: 'D:\\private\\project',
      command: 'Write-Output secret-value',
      targetPath: 'D:\\private\\project\\secret.txt',
    });

    expect(event).toMatchObject({
      timestamp: 123,
      policyVersion: 'm3-test',
      runtimeVersion: '0.0.65',
    });
    expect(event.sessionDigest).toHaveLength(16);
    expect(event.workspaceDigest).toHaveLength(16);
    expect(event.commandDigest).toHaveLength(16);
    expect(event.pathDigest).toHaveLength(16);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('private-session');
    expect(serialized).not.toContain('private\\project');
    expect(serialized).not.toContain('secret-value');
    expect(debug).toHaveBeenCalledWith(`[lobster-native-audit] ${serialized}`);
  });

  test('keeps only the configured in-memory diagnostic window', () => {
    const recorder = new SandboxAuditRecorder({
      policyVersion: 'm3-test',
      runtimeVersion: '0.0.65',
      maxEvents: 2,
    });

    for (let index = 0; index < 3; index += 1) {
      recorder.record({
        type: SandboxAuditEventType.FileDecision,
        result: SandboxAuditResult.Allowed,
        operation: `read-${index}`,
      });
    }

    expect(recorder.recent(10).map(event => event.operation)).toEqual([
      'read-1',
      'read-2',
    ]);
  });
});
