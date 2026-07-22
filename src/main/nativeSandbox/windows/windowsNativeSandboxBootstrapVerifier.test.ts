import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { NativeSandboxErrorCode } from '../../../shared/nativeSandbox/constants';
import { verifyWindowsNativeSandboxBootstrap } from './windowsNativeSandboxBootstrapVerifier';
import {
  WINDOWS_NATIVE_SANDBOX_MANIFEST_FILENAME,
  WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME,
  WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME,
} from './windowsNativeSandboxEnvironment';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const createBundle = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-sandbox-bootstrap-'));
  const contents = new Map([
    [WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME, 'runner'],
    [WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME, 'setup'],
    ['THIRD_PARTY_NOTICES.txt', 'notices'],
  ]);
  for (const [name, content] of contents) {
    fs.writeFileSync(path.join(directory, name), content);
  }
  const manifestPath = path.join(directory, WINDOWS_NATIVE_SANDBOX_MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: '0.4.0',
    protocolVersion: 4,
    policyVersion: 'workspace-write-v4',
    architecture: 'win32-x64',
    signaturePolicy: 'authenticode',
    files: Array.from(contents, ([name, content]) => ({
      name,
      sha256: sha256(content),
      authenticode: name.endsWith('.exe'),
    })),
  }));
  return {
    directory,
    manifestPath,
    setupPath: path.join(directory, WINDOWS_NATIVE_SANDBOX_SETUP_FILENAME),
  };
};

describe('verifyWindowsNativeSandboxBootstrap', () => {
  test('verifies hashes and both executable signatures before setup invocation', async () => {
    const bundle = createBundle();
    const verifyAuthenticode = vi.fn(async () => undefined);
    try {
      await verifyWindowsNativeSandboxBootstrap({
        manifestPath: bundle.manifestPath,
        setupPath: bundle.setupPath,
        requireSignature: true,
        verifyAuthenticode,
      });

      expect(verifyAuthenticode).toHaveBeenCalledTimes(2);
      expect(verifyAuthenticode).toHaveBeenCalledWith(
        path.join(bundle.directory, WINDOWS_NATIVE_SANDBOX_RUNNER_FILENAME),
      );
      expect(verifyAuthenticode).toHaveBeenCalledWith(bundle.setupPath);
    } finally {
      fs.rmSync(bundle.directory, { recursive: true, force: true });
    }
  });

  test('fails closed when a bootstrap file no longer matches the manifest', async () => {
    const bundle = createBundle();
    try {
      fs.writeFileSync(bundle.setupPath, 'tampered');
      await expect(verifyWindowsNativeSandboxBootstrap({
        manifestPath: bundle.manifestPath,
        setupPath: bundle.setupPath,
        requireSignature: false,
      })).rejects.toMatchObject({
        code: NativeSandboxErrorCode.RuntimeHashInvalid,
      });
    } finally {
      fs.rmSync(bundle.directory, { recursive: true, force: true });
    }
  });
});
