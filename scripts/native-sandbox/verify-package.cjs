'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRT_PACKAGE_NAME = '@anthropic-ai/sandbox-runtime';
const EXPECTED_SRT_VERSION = '0.0.65';
const EXPECTED_NATIVE_RUNNER_VERSION = '0.3.0';
const WINDOWS_X64_MACHINE = 0x8664;
const EXTENSION_ID = 'lobster-native-sandbox';
const NATIVE_RUNNER_FILENAME = 'lobster-command-runner.exe';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

function readPeMachine(filePath) {
  assertFile(filePath, 'Windows sandbox helper');
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 0x40 || bytes.toString('latin1', 0, 2) !== 'MZ') {
    throw new Error(`Windows sandbox helper is not a PE file (missing MZ header): ${filePath}`);
  }

  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset + 6 > bytes.length ||
    bytes.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    throw new Error(`Windows sandbox helper is not a PE file (missing PE signature): ${filePath}`);
  }
  return bytes.readUInt16LE(peOffset + 4);
}

function assertWindowsX64Helper(filePath) {
  const machine = readPeMachine(filePath);
  if (machine !== WINDOWS_X64_MACHINE) {
    throw new Error(
      `Windows sandbox helper has PE machine 0x${machine.toString(16)}, expected x64 ` +
        `(0x${WINDOWS_X64_MACHINE.toString(16)}): ${filePath}`,
    );
  }
}

function assertNativeRunnerVersion(filePath) {
  const expected = `lobster-command-runner ${EXPECTED_NATIVE_RUNNER_VERSION}`;
  let reported;
  try {
    reported = execFileSync(filePath, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch (error) {
    throw new Error(
      `Unable to execute Windows native sandbox runner ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (reported !== expected) {
    throw new Error(`Windows native sandbox runner reported ${reported}; expected ${expected}.`);
  }
}

function findUnresolvedSrtImport(source) {
  const patterns = [
    /\bfrom\s*["']@anthropic-ai\/sandbox-runtime(?:\/[^"']*)?["']/,
    /\bimport\s*["']@anthropic-ai\/sandbox-runtime(?:\/[^"']*)?["']/,
    /\bimport\s*\(\s*["']@anthropic-ai\/sandbox-runtime(?:\/[^"']*)?["']\s*\)/,
    /\brequire\s*\(\s*["']@anthropic-ai\/sandbox-runtime(?:\/[^"']*)?["']\s*\)/,
  ];
  return patterns.find(pattern => pattern.test(source)) || null;
}

function verifySourceExtension(rootDir) {
  const extensionDir = path.join(rootDir, 'openclaw-extensions', EXTENSION_ID);
  const packageJsonPath = path.join(extensionDir, 'package.json');
  const manifestPath = path.join(extensionDir, 'openclaw.plugin.json');
  const entryPath = path.join(extensionDir, 'index.ts');
  assertFile(packageJsonPath, 'Sandbox extension package');
  assertFile(manifestPath, 'Sandbox extension manifest');
  assertFile(entryPath, 'Sandbox extension entry');

  const extensionPackage = readJson(packageJsonPath);
  const manifest = readJson(manifestPath);
  if (manifest.id !== EXTENSION_ID) {
    throw new Error(
      `Sandbox extension manifest id must be ${EXTENSION_ID}, received ${String(manifest.id)}`,
    );
  }
  if (
    !Array.isArray(extensionPackage.openclaw?.extensions) ||
    !extensionPackage.openclaw.extensions.includes('./index.ts')
  ) {
    throw new Error('Sandbox extension package must expose ./index.ts before precompilation.');
  }
}

function verifyCompiledExtension(runtimeRoot) {
  const extensionDir = path.join(runtimeRoot, 'third-party-extensions', EXTENSION_ID);
  const entryPath = path.join(extensionDir, 'index.js');
  const packageJsonPath = path.join(extensionDir, 'package.json');
  const manifestPath = path.join(extensionDir, 'openclaw.plugin.json');
  assertFile(entryPath, 'Compiled sandbox extension');
  assertFile(packageJsonPath, 'Compiled sandbox extension package');
  assertFile(manifestPath, 'Compiled sandbox extension manifest');

  const extensionPackage = readJson(packageJsonPath);
  if (
    !Array.isArray(extensionPackage.openclaw?.extensions) ||
    !extensionPackage.openclaw.extensions.includes('./index.js')
  ) {
    throw new Error('Compiled sandbox extension package must expose ./index.js.');
  }

  const entrySource = fs.readFileSync(entryPath, 'utf8');
  const unresolvedImport = findUnresolvedSrtImport(entrySource);
  if (unresolvedImport) {
    throw new Error(
      `Compiled sandbox extension contains an unresolved ${SRT_PACKAGE_NAME} import ` +
        `(${unresolvedImport}): ${entryPath}`,
    );
  }
}

function verifyConfiguredExtraResources(rootDir) {
  const config = readJson(path.join(rootDir, 'electron-builder.json'));
  const resources = Array.isArray(config.win?.extraResources) ? config.win.extraResources : [];
  const helperFrom = `node_modules/${SRT_PACKAGE_NAME}/vendor/srt-win/x64/srt-win.exe`;
  const licenseFrom = `node_modules/${SRT_PACKAGE_NAME}/LICENSE`;
  const nativeRunnerFrom = `native/sandbox-windows/target/release/${NATIVE_RUNNER_FILENAME}`;
  const hasHelper = resources.some(
    resource => resource?.from === helperFrom && resource?.to === 'sandbox-runtime/srt-win.exe',
  );
  const hasLicense = resources.some(
    resource => resource?.from === licenseFrom && resource?.to === 'sandbox-runtime/LICENSE.txt',
  );
  const hasNativeRunner = resources.some(
    resource => resource?.from === nativeRunnerFrom
      && resource?.to === `sandbox-runtime/${NATIVE_RUNNER_FILENAME}`,
  );
  if (!hasHelper || !hasLicense || !hasNativeRunner) {
    throw new Error(
      'electron-builder Windows extraResources must package both x64 runners and the legacy ' +
        `license under sandbox-runtime/ (legacy=${hasHelper}, native=${hasNativeRunner}, ` +
        `license=${hasLicense}).`,
    );
  }
}

function verifySandboxRuntimeBuildInputs(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..', '..'));
  const runtimeRoot = options.runtimeRoot
    ? path.resolve(options.runtimeRoot)
    : path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');
  const targetArch = options.targetArch || 'x64';
  if (targetArch !== 'x64') {
    throw new Error(
      `Native sandbox packaging currently supports Windows x64 only, received ${targetArch}.`,
    );
  }

  const packageJson = readJson(path.join(rootDir, 'package.json'));
  const declaredVersion = packageJson.dependencies?.[SRT_PACKAGE_NAME];
  if (declaredVersion !== EXPECTED_SRT_VERSION) {
    throw new Error(
      `${SRT_PACKAGE_NAME} must be pinned exactly to ${EXPECTED_SRT_VERSION}; ` +
        `package.json contains ${String(declaredVersion)}.`,
    );
  }

  // This repository intentionally does not commit its npm lockfile. Validate a
  // local lockfile when one exists, without making clean source checkouts fail.
  const lockPath = path.join(rootDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    const rootLockVersion = lock.packages?.['']?.dependencies?.[SRT_PACKAGE_NAME];
    const installedLockVersion = lock.packages?.[`node_modules/${SRT_PACKAGE_NAME}`]?.version;
    if (rootLockVersion !== EXPECTED_SRT_VERSION || installedLockVersion !== EXPECTED_SRT_VERSION) {
      throw new Error(
        `${SRT_PACKAGE_NAME} must be pinned to ${EXPECTED_SRT_VERSION} in package-lock.json ` +
          `(root=${String(rootLockVersion)}, installed=${String(installedLockVersion)}).`,
      );
    }
  }

  const installedPackagePath = path.join(rootDir, 'node_modules', SRT_PACKAGE_NAME, 'package.json');
  const installedPackage = readJson(installedPackagePath);
  if (installedPackage.version !== EXPECTED_SRT_VERSION) {
    throw new Error(
      `Installed ${SRT_PACKAGE_NAME} version must be ${EXPECTED_SRT_VERSION}, ` +
        `received ${String(installedPackage.version)}.`,
    );
  }

  const packageRoot = path.dirname(installedPackagePath);
  const helperPath = path.join(packageRoot, 'vendor', 'srt-win', 'x64', 'srt-win.exe');
  const licensePath = path.join(packageRoot, 'LICENSE');
  const nativeRunnerPath = path.join(
    rootDir,
    'native',
    'sandbox-windows',
    'target',
    'release',
    NATIVE_RUNNER_FILENAME,
  );
  assertWindowsX64Helper(helperPath);
  assertWindowsX64Helper(nativeRunnerPath);
  assertNativeRunnerVersion(nativeRunnerPath);
  assertFile(licensePath, 'Sandbox Runtime license');
  if (!fs.readFileSync(licensePath, 'utf8').includes('Apache License')) {
    throw new Error(
      `Sandbox Runtime license is missing the expected Apache License notice: ${licensePath}`,
    );
  }

  verifySourceExtension(rootDir);
  verifyCompiledExtension(runtimeRoot);
  verifyConfiguredExtraResources(rootDir);

  return {
    version: EXPECTED_SRT_VERSION,
    helperPath,
    licensePath,
    nativeRunnerPath,
    runtimeRoot,
  };
}

function verifyPackagedSandboxRuntime(appOutDir) {
  const resourceDir = path.join(path.resolve(appOutDir), 'resources', 'sandbox-runtime');
  const helperPath = path.join(resourceDir, 'srt-win.exe');
  const nativeRunnerPath = path.join(resourceDir, NATIVE_RUNNER_FILENAME);
  const licensePath = path.join(resourceDir, 'LICENSE.txt');
  assertWindowsX64Helper(helperPath);
  assertWindowsX64Helper(nativeRunnerPath);
  assertNativeRunnerVersion(nativeRunnerPath);
  assertFile(licensePath, 'Packaged Sandbox Runtime license');
  return { helperPath, licensePath, nativeRunnerPath };
}

function main() {
  const runtimeArg = process.argv.find(argument => argument.startsWith('--runtime-dir='));
  const archArg = process.argv.find(argument => argument.startsWith('--arch='));
  const result = verifySandboxRuntimeBuildInputs({
    runtimeRoot: runtimeArg ? runtimeArg.slice('--runtime-dir='.length) : undefined,
    targetArch: archArg ? archArg.slice('--arch='.length) : 'x64',
  });
  const helperSizeMb = (fs.statSync(result.helperPath).size / (1024 * 1024)).toFixed(1);
  console.log(
    `[sandbox-runtime-verify] Verified ${SRT_PACKAGE_NAME}@${result.version}, ` +
      `legacy Windows x64 helper (${helperSizeMb} MB), native runner ` +
      `${EXPECTED_NATIVE_RUNNER_VERSION}, license, extraResources, and compiled extension.`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      `[sandbox-runtime-verify] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  EXPECTED_SRT_VERSION,
  EXPECTED_NATIVE_RUNNER_VERSION,
  EXTENSION_ID,
  findUnresolvedSrtImport,
  readPeMachine,
  verifyPackagedSandboxRuntime,
  verifySandboxRuntimeBuildInputs,
};
