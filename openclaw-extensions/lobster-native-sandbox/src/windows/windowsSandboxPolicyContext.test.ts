import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { LobsterNativeSandboxFilesystemCapability } from '../backend/constants.js';
import { parseWindowsSandboxFilesystemCapabilities } from './windowsSandboxCapabilityRegistry.js';
import { createWindowsSandboxPolicyContext } from './windowsSandboxPolicyContext.js';

const temporaryRoots: string[] = [];

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-policy-context-'));
  const agentWorkspaceDir = path.join(root, 'agent-workspace');
  const skillsRoot = path.join(root, 'SKILLs');
  const userProfile = path.join(root, 'profile');
  const appData = path.join(userProfile, 'AppData', 'Roaming');
  const localAppData = path.join(userProfile, 'AppData', 'Local');
  fs.mkdirSync(agentWorkspaceDir);
  fs.mkdirSync(skillsRoot);
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  temporaryRoots.push(root);
  return {
    agentWorkspaceDir,
    appData,
    environment: {
      APPDATA: appData,
      HOME: userProfile,
      LOCALAPPDATA: localAppData,
      USERPROFILE: userProfile,
    },
    localAppData,
    skillsRoot,
    userProfile,
  };
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Windows sandbox policy context', () => {
  test('parses only known semantic filesystem capabilities', () => {
    expect(parseWindowsSandboxFilesystemCapabilities([
      LobsterNativeSandboxFilesystemCapability.NpmCacheWrite,
      'unknown-capability',
      LobsterNativeSandboxFilesystemCapability.NpmCacheWrite,
    ])).toEqual([LobsterNativeSandboxFilesystemCapability.NpmCacheWrite]);
  });

  test('inherits the host profile and resolves the npm cache compatibility grant', () => {
    const fixture = createFixture();
    const context = createWindowsSandboxPolicyContext({
      agentWorkspaceDir: fixture.agentWorkspaceDir,
      skillsRoot: fixture.skillsRoot,
      filesystemCapabilities: [
        LobsterNativeSandboxFilesystemCapability.NpmCacheWrite,
      ],
      environment: fixture.environment,
    });

    expect(context.profile).toEqual({
      mode: 'inherit-host',
      homeDir: path.resolve(fixture.userProfile),
      userProfileDir: path.resolve(fixture.userProfile),
      appDataDir: path.resolve(fixture.appData),
      localAppDataDir: path.resolve(fixture.localAppData),
    });
    expect(context.writableRoots).toEqual([
      { id: 'agent', path: path.resolve(fixture.agentWorkspaceDir) },
      { id: 'npm-cache', path: path.resolve(fixture.localAppData, 'npm-cache') },
    ]);
    expect(context.readableRoots).toEqual([
      { id: 'skills', path: path.resolve(fixture.skillsRoot) },
    ]);
    expect(fs.statSync(path.join(fixture.localAppData, 'npm-cache')).isDirectory()).toBe(true);
  });

  test('can revoke compatibility grants without changing the base roots', () => {
    const fixture = createFixture();
    const context = createWindowsSandboxPolicyContext({
      agentWorkspaceDir: fixture.agentWorkspaceDir,
      skillsRoot: fixture.skillsRoot,
      filesystemCapabilities: [],
      environment: fixture.environment,
    });

    expect(context.writableRoots).toEqual([
      { id: 'agent', path: path.resolve(fixture.agentWorkspaceDir) },
    ]);
    expect(fs.existsSync(path.join(fixture.localAppData, 'npm-cache'))).toBe(false);
  });

  test('fails closed when the Agent workspace is missing', () => {
    const fixture = createFixture();
    expect(() => createWindowsSandboxPolicyContext({
      agentWorkspaceDir: '',
      environment: fixture.environment,
    })).toThrow('agent workspace directory');
  });
});
