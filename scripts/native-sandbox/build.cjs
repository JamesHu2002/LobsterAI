'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..', '..');
const workspace = path.join(rootDir, 'native', 'sandbox-windows');
const debug = process.argv.includes('--debug');
const signIfConfigured = process.argv.includes('--sign-if-configured');
const profile = debug ? 'debug' : 'release';
const cargoArgs = [
  'build',
  '--manifest-path',
  path.join(workspace, 'Cargo.toml'),
  '--package',
  'lobster-command-runner',
  '--package',
  'lobster-sandbox-setup',
];
if (!debug) cargoArgs.push('--release');

const cargo = spawnSync('cargo', cargoArgs, { cwd: rootDir, stdio: 'inherit', shell: false });
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

async function finalizeArtifacts() {
  const outputDir = path.join(workspace, 'target', profile);
  if (signIfConfigured) {
    const { signFile } = require('../win-sign.cjs');
    await signFile(path.join(outputDir, 'lobster-command-runner.exe'));
    await signFile(path.join(outputDir, 'lobster-sandbox-setup.exe'));
  }
  const noticeName = 'THIRD_PARTY_NOTICES.txt';
  fs.copyFileSync(path.join(workspace, 'THIRD_PARTY_NOTICES.md'), path.join(outputDir, noticeName));

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const cargoToml = fs.readFileSync(path.join(workspace, 'Cargo.toml'), 'utf8');
  const runtimeVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!runtimeVersion) throw new Error('Unable to resolve native Sandbox runtime version.');

  const fileSpecs = [
    { name: 'lobster-command-runner.exe', authenticode: true },
    { name: 'lobster-sandbox-setup.exe', authenticode: true },
    { name: noticeName, authenticode: false },
  ];
  const files = fileSpecs.map(file => {
    const filePath = path.join(outputDir, file.name);
    if (!fs.existsSync(filePath)) throw new Error(`Missing native Sandbox artifact: ${filePath}`);
    return {
      ...file,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    };
  });
  let gitCommit = 'unknown';
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    // Source archives may not contain Git metadata; hashes remain authoritative.
  }
  const manifest = {
    schemaVersion: 1,
    runtimeVersion,
    protocolVersion: 4,
    policyVersion: 'workspace-write-v4',
    architecture: 'win32-x64',
    gitCommit,
    builtAt: new Date().toISOString(),
    minimumLobsterVersion: packageJson.version,
    signaturePolicy: 'authenticode',
    files,
  };
  const manifestPath = path.join(outputDir, 'lobster-sandbox-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `[sandbox-native-build] Built runtime ${runtimeVersion} (${profile}) and wrote ${manifestPath}.`,
  );
}

finalizeArtifacts().catch(error => {
  console.error(`[sandbox-native-build] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
