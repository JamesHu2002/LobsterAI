import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { createWindowsSandboxPolicyContext } from './windowsSandboxPolicyContext.js';

describe('Windows sandbox policy context', () => {
  test('uses one stable persistent home per agent and keeps Skills read-only', () => {
    const base = {
      agentWorkspaceDir: 'C:\\LobsterAI\\openclaw\\state\\workspace-main',
      sandboxDataRoot: 'C:\\LobsterAI\\sandbox-data',
      skillsRoot: 'C:\\LobsterAI\\SKILLs',
    };
    const first = createWindowsSandboxPolicyContext({
      ...base,
      sessionKey: 'agent:main:session-one',
    });
    const second = createWindowsSandboxPolicyContext({
      ...base,
      sessionKey: 'agent:MAIN:session-two',
    });
    const anotherAgent = createWindowsSandboxPolicyContext({
      ...base,
      sessionKey: 'agent:reviewer:session-one',
    });

    expect(first.sandboxHomeDir).toBe(second.sandboxHomeDir);
    expect(anotherAgent.sandboxHomeDir).not.toBe(first.sandboxHomeDir);
    expect(first.sandboxHomeDir).toContain(path.join('sandbox-data', 'agents'));
    expect(first.writableRoots.map(root => root.id)).toEqual(['agent', 'sandbox-home']);
    expect(first.readableRoots).toEqual([
      { id: 'skills', path: path.resolve(base.skillsRoot) },
    ]);
  });

  test('fails closed when product-owned roots are missing', () => {
    expect(() => createWindowsSandboxPolicyContext({
      sessionKey: 'agent:main:session-one',
      agentWorkspaceDir: 'C:\\workspace',
      sandboxDataRoot: '',
    })).toThrow('product-owned data root');
  });
});
