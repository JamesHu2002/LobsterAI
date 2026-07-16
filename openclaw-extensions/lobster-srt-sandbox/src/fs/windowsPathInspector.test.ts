import { describe, expect, test } from 'vitest';

import {
  createWindowsPathIdentity,
  windowsPathIdentityEquals,
} from './windowsPathInspector.js';

describe('Windows path identity', () => {
  test('does not collapse adjacent file ids above Number.MAX_SAFE_INTEGER', () => {
    const firstFileId = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const secondFileId = firstFileId + 1n;

    const first = createWindowsPathIdentity(10n, firstFileId);
    const second = createWindowsPathIdentity(10n, secondFileId);

    expect(first.file).not.toBe(second.file);
    expect(windowsPathIdentityEquals(first, second)).toBe(false);
  });
});
