import path from 'node:path';

import type { LobsterNativeSandboxFilesystemCapability } from '../backend/constants.js';
import type { NativeSandboxPolicyContext } from '../runtime/nativeSandboxExecutor.js';
import {
  resolveWindowsHostProfile,
  WindowsSandboxCapabilityRegistry,
} from './windowsSandboxCapabilityRegistry.js';

export type WindowsSandboxPolicyContextOptions = {
  agentWorkspaceDir: string;
  skillsRoot?: string;
  filesystemCapabilities?: readonly LobsterNativeSandboxFilesystemCapability[];
  environment?: NodeJS.ProcessEnv;
};

/** Builds the host-profile policy and semantic fixed roots for one Agent. */
export function createWindowsSandboxPolicyContext(
  options: WindowsSandboxPolicyContextOptions,
): NativeSandboxPolicyContext {
  if (!options.agentWorkspaceDir.trim()) {
    throw new Error('Native Sandbox requires an agent workspace directory.');
  }
  const profile = resolveWindowsHostProfile(options.environment);
  const capabilities = new WindowsSandboxCapabilityRegistry(profile).resolve(
    options.filesystemCapabilities ?? [],
  );
  const skillsRoot = options.skillsRoot?.trim();
  return {
    agentWorkspaceDir: path.resolve(options.agentWorkspaceDir),
    profile,
    writableRoots: [
      { id: 'agent', path: path.resolve(options.agentWorkspaceDir) },
      ...capabilities.writableRoots,
    ],
    readableRoots: skillsRoot
      ? [{ id: 'skills', path: path.resolve(skillsRoot) }, ...capabilities.readableRoots]
      : capabilities.readableRoots,
    protectedPaths: [],
  };
}
