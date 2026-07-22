import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  NATIVE_SANDBOX_POLICY_VERSION,
  NATIVE_SANDBOX_PROTOCOL_VERSION,
  NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION,
  NativeSandboxErrorCode,
} from '../../../shared/nativeSandbox/constants';
import type { NativeSandboxError } from '../../../shared/nativeSandbox/types';
import {
  WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME,
  WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME,
} from './windowsNativeSandboxEnvironment';

const BOOTSTRAP_SCHEMA_VERSION = 1;
const WINDOWS_X64_ARCHITECTURE = 'win32-x64';
const AUTHENTICODE_SIGNATURE_POLICY = 'authenticode';
const THIRD_PARTY_NOTICES_FILENAME = 'THIRD_PARTY_NOTICES.txt';
const SIGNATURE_TIMEOUT_MS = 30_000;

interface BootstrapManifestFile {
  name: string;
  sha256: string;
  authenticode: boolean;
}

interface BootstrapManifest {
  schemaVersion: number;
  runtimeVersion: string;
  protocolVersion: number;
  policyVersion: string;
  architecture: string;
  signaturePolicy: string;
  files: BootstrapManifestFile[];
}

export interface WindowsNativeSandboxBootstrapVerifierOptions {
  manifestPath: string;
  setupPath: string;
  requireSignature: boolean;
  verifyAuthenticode?: (filePath: string) => Promise<void>;
}

const bootstrapError = (
  code: NativeSandboxError['code'],
  message: string,
): Error => Object.assign(new Error(message), { code });

const readManifest = (manifestPath: string): BootstrapManifest => {
  let manifest: BootstrapManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BootstrapManifest;
  } catch (error) {
    throw bootstrapError(
      NativeSandboxErrorCode.RuntimeManifestInvalid,
      `Windows Sandbox bootstrap manifest is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    manifest.schemaVersion !== BOOTSTRAP_SCHEMA_VERSION
    || manifest.runtimeVersion !== NATIVE_SANDBOX_WINDOWS_RUNTIME_VERSION
    || manifest.protocolVersion !== NATIVE_SANDBOX_PROTOCOL_VERSION
    || manifest.policyVersion !== NATIVE_SANDBOX_POLICY_VERSION
    || manifest.architecture !== WINDOWS_X64_ARCHITECTURE
    || manifest.signaturePolicy !== AUTHENTICODE_SIGNATURE_POLICY
    || !Array.isArray(manifest.files)
  ) {
    throw bootstrapError(
      NativeSandboxErrorCode.RuntimeManifestInvalid,
      'Windows Sandbox bootstrap manifest is incompatible with this LobsterAI build.',
    );
  }
  return manifest;
};

const assertSafeFileName = (name: string): void => {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw bootstrapError(
      NativeSandboxErrorCode.RuntimeManifestInvalid,
      `Windows Sandbox bootstrap manifest contains an unsafe filename: ${name || '<empty>'}.`,
    );
  }
};

const sha256File = (filePath: string): string => createHash('sha256')
  .update(fs.readFileSync(filePath))
  .digest('hex');

const verifyAuthenticodeWithPowerShell = (filePath: string): Promise<void> => new Promise(
  (resolve, reject) => {
    const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows';
    const executable = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:LOBSTER_SANDBOX_VERIFY_FILE',
      "if ($signature.Status -ne 'Valid') { [Console]::Error.Write($signature.Status); exit 1 }",
    ].join('; ');
    execFile(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        windowsHide: true,
        timeout: SIGNATURE_TIMEOUT_MS,
        env: {
          ComSpec: process.env.ComSpec,
          LOBSTER_SANDBOX_VERIFY_FILE: filePath,
          PATH: path.join(systemRoot, 'System32'),
          SystemRoot: systemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          WINDIR: systemRoot,
        },
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        reject(bootstrapError(
          NativeSandboxErrorCode.RuntimeSignatureInvalid,
          `Windows Sandbox bootstrap signature verification failed for ${
            path.basename(filePath)
          }${stderr.trim() ? ` (${stderr.trim()})` : ''}.`,
        ));
      },
    );
  },
);

export const verifyWindowsNativeSandboxBootstrap = async (
  options: WindowsNativeSandboxBootstrapVerifierOptions,
): Promise<void> => {
  const manifest = readManifest(options.manifestPath);
  const bootstrapDirectory = path.dirname(options.manifestPath);
  const expectedFiles = new Map([
    [WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME, true],
    [WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME, true],
    [THIRD_PARTY_NOTICES_FILENAME, false],
  ]);
  const seen = new Set<string>();

  for (const file of manifest.files) {
    if (
      !file
      || typeof file.name !== 'string'
      || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(file.sha256)
      || typeof file.authenticode !== 'boolean'
    ) {
      throw bootstrapError(
        NativeSandboxErrorCode.RuntimeManifestInvalid,
        'Windows Sandbox bootstrap manifest contains an invalid file record.',
      );
    }
    assertSafeFileName(file.name);
    if (seen.has(file.name)) {
      throw bootstrapError(
        NativeSandboxErrorCode.RuntimeManifestInvalid,
        `Windows Sandbox bootstrap manifest contains a duplicate file: ${file.name}.`,
      );
    }
    seen.add(file.name);
    const authenticodeRequired = expectedFiles.get(file.name);
    if (authenticodeRequired === undefined) {
      throw bootstrapError(
        NativeSandboxErrorCode.RuntimeManifestInvalid,
        `Windows Sandbox bootstrap manifest contains an unexpected file: ${file.name}.`,
      );
    }
    if (authenticodeRequired && file.authenticode !== true) {
      throw bootstrapError(
        NativeSandboxErrorCode.RuntimeManifestInvalid,
        `Windows Sandbox bootstrap manifest does not require Authenticode for ${file.name}.`,
      );
    }
    const filePath = path.join(bootstrapDirectory, file.name);
    let actualHash: string;
    try {
      actualHash = sha256File(filePath);
    } catch (error) {
      throw bootstrapError(
        NativeSandboxErrorCode.RuntimeHashInvalid,
        `Windows Sandbox bootstrap file is unavailable: ${file.name} (${
          error instanceof Error ? error.message : String(error)
        }).`,
      );
    }
    if (actualHash.toLowerCase() !== file.sha256.toLowerCase()) {
      throw bootstrapError(
        NativeSandboxErrorCode.RuntimeHashInvalid,
        `Windows Sandbox bootstrap hash mismatch for ${file.name}.`,
      );
    }
  }

  for (const name of expectedFiles.keys()) {
    if (!seen.has(name)) {
      throw bootstrapError(
        NativeSandboxErrorCode.RuntimeManifestInvalid,
        `Windows Sandbox bootstrap manifest is missing ${name}.`,
      );
    }
  }
  if (
    path.resolve(options.setupPath).toLowerCase()
    !== path.resolve(bootstrapDirectory, WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME).toLowerCase()
  ) {
    throw bootstrapError(
      NativeSandboxErrorCode.RuntimeManifestInvalid,
      'Windows Sandbox setup path is outside the verified bootstrap bundle.',
    );
  }
  if (!options.requireSignature) return;
  const verifyAuthenticode = options.verifyAuthenticode ?? verifyAuthenticodeWithPowerShell;
  await verifyAuthenticode(path.join(bootstrapDirectory, WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME));
  await verifyAuthenticode(path.join(bootstrapDirectory, WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME));
};
