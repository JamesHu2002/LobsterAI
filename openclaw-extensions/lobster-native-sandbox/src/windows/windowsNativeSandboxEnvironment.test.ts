import { describe, expect, test } from 'vitest';

import { LobsterNativeSandboxBackendErrorCode } from '../backend/constants.js';
import {
  buildWindowsNativeSandboxChildEnvironment,
  WindowsNativeSandboxHostEnvironmentName,
} from './windowsNativeSandboxEnvironment.js';

const trustedPaths = {
  electron: 'C:\\LobsterAI\\runtime\\electron.exe',
  npmBin: 'C:\\LobsterAI\\runtime\\npm\\bin',
  skills: 'C:\\Users\\tester\\AppData\\Roaming\\LobsterAI\\SKILLs',
  python: 'C:\\LobsterAI\\runtime\\python',
};

const existingPaths = new Set(Object.values(trustedPaths).map(value => value.toLowerCase()));
const pathExists = (value: string): boolean => existingPaths.has(value.toLowerCase());

describe('buildWindowsNativeSandboxChildEnvironment', () => {
  test('injects registered host values and ignores case-insensitive tool overrides', () => {
    const environment = buildWindowsNativeSandboxChildEnvironment({
      requestedEnvironment: {
        CI: '1',
        lobsterai_electron_path: 'C:\\untrusted\\node.exe',
        LOBSTERAI_NPM_BIN_DIR: 'C:\\untrusted\\npm',
        skills_root: 'C:\\untrusted\\skills',
        TZ: 'UTC',
      },
      trustedEnvironment: {
        lobsterai_electron_path: trustedPaths.electron,
        LOBSTERAI_NPM_BIN_DIR: trustedPaths.npmBin,
        SKILLS_ROOT: trustedPaths.skills,
        LOBSTERAI_SKILLS_ROOT: trustedPaths.skills,
        LOBSTERAI_PYTHON_ROOT: trustedPaths.python,
        tz: 'Asia/Shanghai',
      },
      pathExists,
    });

    expect(environment).toEqual({
      CI: '1',
      [WindowsNativeSandboxHostEnvironmentName.LobsterAiElectronPath]: trustedPaths.electron,
      [WindowsNativeSandboxHostEnvironmentName.LobsterAiNpmBinDir]: trustedPaths.npmBin,
      [WindowsNativeSandboxHostEnvironmentName.SkillsRoot]: trustedPaths.skills,
      [WindowsNativeSandboxHostEnvironmentName.LobsterAiSkillsRoot]: trustedPaths.skills,
      [WindowsNativeSandboxHostEnvironmentName.LobsterAiPythonRoot]: trustedPaths.python,
      [WindowsNativeSandboxHostEnvironmentName.Timezone]: 'Asia/Shanghai',
    });
  });

  test('does not expose OpenClaw launch, proxy, certificate, or secret host values', () => {
    const environment = buildWindowsNativeSandboxChildEnvironment({
      requestedEnvironment: {
        HTTP_PROXY: 'http://tool-proxy.invalid',
        NODE_EXTRA_CA_CERTS: 'C:\\untrusted\\ca.pem',
        LOBSTERAI_OPENCLAW_ENTRY: 'C:\\untrusted\\openclaw.mjs',
        API_TOKEN: 'tool-secret',
        SAFE_FLAG: 'allowed',
      },
      trustedEnvironment: {
        HTTP_PROXY: 'http://host-proxy.invalid',
        NODE_EXTRA_CA_CERTS: 'C:\\LobsterAI\\ca.pem',
        LOBSTERAI_OPENCLAW_ENTRY: 'C:\\LobsterAI\\openclaw.mjs',
        OPENCLAW_GATEWAY_TOKEN: 'host-secret',
      },
      pathExists,
    });

    expect(environment).toEqual({ SAFE_FLAG: 'allowed' });
  });

  test.each([
    ['relative trusted path', 'runtime\\electron.exe', () => true],
    ['missing trusted path', trustedPaths.electron, () => false],
  ])('fails closed for a %s', (_label, electronPath, exists) => {
    expect(() => buildWindowsNativeSandboxChildEnvironment({
      requestedEnvironment: {},
      trustedEnvironment: {
        LOBSTERAI_ELECTRON_PATH: electronPath,
      },
      pathExists: exists,
    })).toThrow(expect.objectContaining({
      code: LobsterNativeSandboxBackendErrorCode.InvalidEnvironment,
    }));
  });

  test('skips optional registered values when the host did not provide them', () => {
    expect(buildWindowsNativeSandboxChildEnvironment({
      requestedEnvironment: { CI: '1' },
      trustedEnvironment: {},
      pathExists,
    })).toEqual({ CI: '1' });
  });
});
