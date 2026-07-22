import fs from 'node:fs';
import path from 'node:path';

import { LobsterNativeSandboxBackendErrorCode } from '../backend/constants.js';
import { LobsterNativeSandboxBackendError } from '../backend/errors.js';

export const WindowsNativeSandboxEnvironmentGroup = {
  NodeRuntime: 'runtime.node',
  SkillDiscovery: 'skills.discovery',
  PythonRuntime: 'runtime.python',
  LocaleTimezone: 'locale.timezone',
} as const;

export type WindowsNativeSandboxEnvironmentGroup =
  typeof WindowsNativeSandboxEnvironmentGroup[
    keyof typeof WindowsNativeSandboxEnvironmentGroup
  ];

export const WindowsNativeSandboxHostEnvironmentName = {
  LobsterAiElectronPath: 'LOBSTERAI_ELECTRON_PATH',
  LobsterAiNpmBinDir: 'LOBSTERAI_NPM_BIN_DIR',
  SkillsRoot: 'SKILLS_ROOT',
  LobsterAiSkillsRoot: 'LOBSTERAI_SKILLS_ROOT',
  LobsterAiPythonRoot: 'LOBSTERAI_PYTHON_ROOT',
  Timezone: 'TZ',
} as const;

export type WindowsNativeSandboxHostEnvironmentName =
  typeof WindowsNativeSandboxHostEnvironmentName[
    keyof typeof WindowsNativeSandboxHostEnvironmentName
  ];

const WindowsNativeSandboxEnvironmentValueKind = {
  Path: 'path',
  Value: 'value',
} as const;

const WindowsNativeSandboxBlockedEnvironmentName = {
  LobsterAiOpenClawEntry: 'LOBSTERAI_OPENCLAW_ENTRY',
} as const;

interface WindowsNativeSandboxEnvironmentRegistration {
  name: WindowsNativeSandboxHostEnvironmentName;
  group: WindowsNativeSandboxEnvironmentGroup;
  valueKind: typeof WindowsNativeSandboxEnvironmentValueKind[
    keyof typeof WindowsNativeSandboxEnvironmentValueKind
  ];
}

export const WINDOWS_NATIVE_SANDBOX_TRUSTED_ENVIRONMENT_REGISTRY = [
  {
    name: WindowsNativeSandboxHostEnvironmentName.LobsterAiElectronPath,
    group: WindowsNativeSandboxEnvironmentGroup.NodeRuntime,
    valueKind: WindowsNativeSandboxEnvironmentValueKind.Path,
  },
  {
    name: WindowsNativeSandboxHostEnvironmentName.LobsterAiNpmBinDir,
    group: WindowsNativeSandboxEnvironmentGroup.NodeRuntime,
    valueKind: WindowsNativeSandboxEnvironmentValueKind.Path,
  },
  {
    name: WindowsNativeSandboxHostEnvironmentName.SkillsRoot,
    group: WindowsNativeSandboxEnvironmentGroup.SkillDiscovery,
    valueKind: WindowsNativeSandboxEnvironmentValueKind.Path,
  },
  {
    name: WindowsNativeSandboxHostEnvironmentName.LobsterAiSkillsRoot,
    group: WindowsNativeSandboxEnvironmentGroup.SkillDiscovery,
    valueKind: WindowsNativeSandboxEnvironmentValueKind.Path,
  },
  {
    name: WindowsNativeSandboxHostEnvironmentName.LobsterAiPythonRoot,
    group: WindowsNativeSandboxEnvironmentGroup.PythonRuntime,
    valueKind: WindowsNativeSandboxEnvironmentValueKind.Path,
  },
  {
    name: WindowsNativeSandboxHostEnvironmentName.Timezone,
    group: WindowsNativeSandboxEnvironmentGroup.LocaleTimezone,
    valueKind: WindowsNativeSandboxEnvironmentValueKind.Value,
  },
] as const satisfies readonly WindowsNativeSandboxEnvironmentRegistration[];

const WINDOWS_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_CHILD_ENV_NAME_PATTERN = /(KEY|SECRET|TOKEN)/i;
const PROTECTED_CHILD_ENV_NAMES = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'GIT_CONFIG_COUNT',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOCALAPPDATA',
  'LOBSTER_SANDBOX',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  WindowsNativeSandboxBlockedEnvironmentName.LobsterAiOpenClawEntry,
  ...WINDOWS_NATIVE_SANDBOX_TRUSTED_ENVIRONMENT_REGISTRY.map(entry => entry.name),
]);

const findEnvironmentValue = (
  environment: NodeJS.ProcessEnv,
  canonicalName: string,
): string | undefined => {
  const matchingName = Object.keys(environment).find(
    name => name.toUpperCase() === canonicalName.toUpperCase(),
  );
  return matchingName ? environment[matchingName] : undefined;
};

const validateRequestedEnvironment = (
  environment: Record<string, string>,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    const upperName = name.toUpperCase();
    if (
      !WINDOWS_ENV_NAME_PATTERN.test(name)
      || name.includes('\0')
      || typeof value !== 'string'
      || value.includes('\0')
    ) {
      throw new LobsterNativeSandboxBackendError(
        LobsterNativeSandboxBackendErrorCode.InvalidEnvironment,
        `Sandbox child environment variable is not allowed: ${name}`,
      );
    }
    if (
      PROTECTED_CHILD_ENV_NAMES.has(upperName)
      || upperName.startsWith('GIT_CONFIG_')
      || SENSITIVE_CHILD_ENV_NAME_PATTERN.test(upperName)
    ) {
      continue;
    }
    result[name] = value;
  }
  return result;
};

const validateTrustedValue = (
  registration: WindowsNativeSandboxEnvironmentRegistration,
  rawValue: string,
  pathExists: (filePath: string) => boolean,
): string => {
  const value = rawValue.trim();
  if (!value || value.includes('\0')) {
    throw new LobsterNativeSandboxBackendError(
      LobsterNativeSandboxBackendErrorCode.InvalidEnvironment,
      `Trusted Sandbox environment variable is invalid: ${registration.name}`,
    );
  }
  if (
    registration.valueKind === WindowsNativeSandboxEnvironmentValueKind.Path
    && (!path.win32.isAbsolute(value) || !pathExists(value))
  ) {
    throw new LobsterNativeSandboxBackendError(
      LobsterNativeSandboxBackendErrorCode.InvalidEnvironment,
      `Trusted Sandbox environment path is unavailable: ${registration.name}`,
    );
  }
  return value;
};

export function buildWindowsNativeSandboxChildEnvironment(options: {
  requestedEnvironment: Record<string, string>;
  trustedEnvironment?: NodeJS.ProcessEnv;
  pathExists?: (filePath: string) => boolean;
}): Record<string, string> {
  const result = validateRequestedEnvironment(options.requestedEnvironment);
  const trustedEnvironment = options.trustedEnvironment ?? process.env;
  const pathExists = options.pathExists ?? fs.existsSync;

  for (const registration of WINDOWS_NATIVE_SANDBOX_TRUSTED_ENVIRONMENT_REGISTRY) {
    const rawValue = findEnvironmentValue(trustedEnvironment, registration.name);
    if (rawValue === undefined || rawValue.trim() === '') continue;
    result[registration.name] = validateTrustedValue(registration, rawValue, pathExists);
  }
  return result;
}
