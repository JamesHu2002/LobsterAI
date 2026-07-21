import { createHash } from 'node:crypto';
import path from 'node:path';

import type { NativeSandboxPolicyContext } from '../runtime/nativeSandboxExecutor.js';

export type WindowsSandboxPolicyContextOptions = {
  sessionKey: string;
  agentWorkspaceDir: string;
  sandboxDataRoot: string;
  skillsRoot?: string;
};

const deriveAgentId = (sessionKey: string): string => {
  const match = sessionKey.match(/^agent:([^:]+)/i);
  return match?.[1]?.trim() || 'main';
};

const buildAgentDirectoryName = (agentId: string): string => {
  const normalizedAgentId = agentId.toLowerCase();
  const slug = normalizedAgentId
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'agent';
  const digest = createHash('sha256').update(normalizedAgentId).digest('hex').slice(0, 12);
  return `${slug}-${digest}`;
};

/** Builds stable per-agent roots without exposing a session key as a path. */
export function createWindowsSandboxPolicyContext(
  options: WindowsSandboxPolicyContextOptions,
): NativeSandboxPolicyContext {
  if (!options.agentWorkspaceDir.trim()) {
    throw new Error('Native Sandbox requires an agent workspace directory.');
  }
  if (!options.sandboxDataRoot.trim()) {
    throw new Error('Native Sandbox requires a product-owned data root.');
  }
  const agentId = deriveAgentId(options.sessionKey);
  const sandboxHomeDir = path.resolve(
    options.sandboxDataRoot,
    'agents',
    buildAgentDirectoryName(agentId),
    'home',
  );
  const skillsRoot = options.skillsRoot?.trim();
  return {
    agentWorkspaceDir: path.resolve(options.agentWorkspaceDir),
    sandboxHomeDir,
    writableRoots: [
      { id: 'agent', path: path.resolve(options.agentWorkspaceDir) },
      { id: 'sandbox-home', path: sandboxHomeDir },
    ],
    readableRoots: skillsRoot
      ? [{ id: 'skills', path: path.resolve(skillsRoot) }]
      : [],
    protectedPaths: [],
  };
}
