import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { SandboxFsErrorCode } from './sandboxFsError.js';
import {
  isWindowsPathInside,
  parseWindowsPath,
  windowsPathEquals,
  WindowsPathKind,
} from './windowsPathSyntax.js';

function expectPathError(input: string, code: SandboxFsErrorCode): void {
  expect(() => parseWindowsPath(input)).toThrowError(expect.objectContaining({ code }));
}

describe('Native sandbox Windows path syntax policy', () => {
  test('normalizes relative and fully-qualified local paths with win32 semantics', () => {
    expect(parseWindowsPath('src/components/App.tsx')).toEqual({
      kind: WindowsPathKind.Relative,
      normalized: 'src\\components\\App.tsx',
    });
    expect(parseWindowsPath('C:/Work/Lobster/src/main.ts')).toEqual({
      kind: WindowsPathKind.Absolute,
      normalized: 'C:\\Work\\Lobster\\src\\main.ts',
    });
  });

  test.each(['..', '..\\secret', 'src\\..\\secret', 'C:\\Work\\..\\secret'])(
    'rejects lexical parent traversal before normalization: %s',
    (input) => expectPathError(input, SandboxFsErrorCode.PathTraversal),
  );

  test.each([
    'C:relative.txt',
    '\\root-relative.txt',
    '\\\\server\\share\\file.txt',
    '\\\\?\\C:\\Work\\file.txt',
    '\\\\.\\pipe\\name',
    '\\??\\C:\\Work\\file.txt',
  ])('rejects ambiguous and privileged Windows namespaces: %s', (input) => {
    expectPathError(input, SandboxFsErrorCode.UnsupportedPathNamespace);
  });

  test.each([
    'NUL',
    'nul.txt',
    'COM1.log',
    'LPT\u00b9.txt',
    'folder\\name. ',
    'folder\\name.',
    'folder\\file:stream',
    'folder\\bad?.txt',
  ])('rejects Windows-ambiguous path segments: %s', (input) => {
    expectPathError(input, SandboxFsErrorCode.InvalidPath);
  });

  test('uses case-insensitive, segment-aware containment', () => {
    expect(isWindowsPathInside('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe(true);
    expect(isWindowsPathInside('C:\\Repo', 'C:\\Repo')).toBe(true);
    expect(isWindowsPathInside('C:\\Repo', 'C:\\Repository\\secret.txt')).toBe(false);
    expect(isWindowsPathInside('C:\\Repo', 'D:\\Repo\\secret.txt')).toBe(false);
    expect(windowsPathEquals('C:\\Repo\\', 'c:/repo')).toBe(true);
  });

  test('accepts ordinary DOS paths longer than MAX_PATH without device syntax', () => {
    const longPath = `C:\\Work\\${'segment\\'.repeat(40)}file.txt`;
    expect(longPath.length).toBeGreaterThan(260);
    expect(parseWindowsPath(longPath).normalized).toBe(path.win32.normalize(longPath));
  });
});
