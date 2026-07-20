import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  syncLocalOpenClawExtensions,
} = require('../scripts/sync-local-openclaw-extensions.cjs') as {
  syncLocalOpenClawExtensions: (runtimeRoot: string) => {
    copied: string[];
  };
};

describe('syncLocalOpenClawExtensions', () => {
  let temporaryRoot: string | undefined;

  afterEach(() => {
    if (temporaryRoot) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = undefined;
    }
  });

  test('removes the retired Sandbox extension while syncing the renamed extension', () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-extension-sync-'));
    const extensionsRoot = path.join(temporaryRoot, 'third-party-extensions');
    const retiredExtension = path.join(extensionsRoot, 'lobster-srt-sandbox');
    fs.mkdirSync(retiredExtension, { recursive: true });
    fs.writeFileSync(path.join(retiredExtension, 'index.js'), 'stale');

    const result = syncLocalOpenClawExtensions(temporaryRoot);

    expect(result.copied).toContain('lobster-native-sandbox');
    expect(fs.existsSync(retiredExtension)).toBe(false);
    expect(
      fs.existsSync(path.join(extensionsRoot, 'lobster-native-sandbox', 'index.ts')),
    ).toBe(true);
  });
});
