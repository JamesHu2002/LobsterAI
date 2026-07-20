/** Canonical Windows path syntax checks for native sandbox policies. */
import path from 'node:path';

import { SandboxFsError, SandboxFsErrorCode } from './sandboxFsError.js';

const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const WINDOWS_INVALID_SEGMENT_CHARACTER_PATTERN = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_LOCAL_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_RELATIVE_PATTERN = /^[A-Za-z]:/;

export const WindowsPathKind = {
  Absolute: 'absolute',
  Relative: 'relative',
} as const;
export type WindowsPathKind = (typeof WindowsPathKind)[keyof typeof WindowsPathKind];

export type ParsedWindowsPath = {
  kind: WindowsPathKind;
  normalized: string;
};

function unsupportedNamespace(message: string): never {
  throw new SandboxFsError(SandboxFsErrorCode.UnsupportedPathNamespace, message);
}

function validateSegments(input: string, kind: WindowsPathKind): void {
  const withoutDrive = kind === WindowsPathKind.Absolute ? input.slice(2) : input;
  const segments = withoutDrive.split(/[\\/]+/).filter((segment) => segment.length > 0);

  for (const segment of segments) {
    if (segment === '..') {
      throw new SandboxFsError(
        SandboxFsErrorCode.PathTraversal,
        'Parent path segments are not allowed in sandbox file paths.',
      );
    }
    if (segment === '.') {
      continue;
    }
    if (WINDOWS_INVALID_SEGMENT_CHARACTER_PATTERN.test(segment)) {
      throw new SandboxFsError(
        SandboxFsErrorCode.InvalidPath,
        'The sandbox file path contains a Windows-reserved character.',
      );
    }
    if (/[. ]$/.test(segment)) {
      throw new SandboxFsError(
        SandboxFsErrorCode.InvalidPath,
        'Windows path segments may not end in a dot or space.',
      );
    }
    if (WINDOWS_DEVICE_NAME_PATTERN.test(segment)) {
      throw new SandboxFsError(
        SandboxFsErrorCode.InvalidPath,
        'Windows device names are not valid sandbox file paths.',
      );
    }
  }
}

/**
 * Parses an untrusted path using Windows rules on every host platform.
 *
 * Only fully-qualified local DOS paths and relative paths are accepted. UNC,
 * device, extended-length, root-relative, and drive-relative namespaces are
 * rejected before normalization so that `C:foo` cannot be mistaken for an
 * absolute path by a later containment check.
 */
export function parseWindowsPath(input: string): ParsedWindowsPath {
  if (typeof input !== 'string' || input.length === 0) {
    throw new SandboxFsError(SandboxFsErrorCode.InvalidPath, 'Sandbox file path is empty.');
  }
  if (input.includes('\u0000')) {
    throw new SandboxFsError(
      SandboxFsErrorCode.InvalidPath,
      'Sandbox file path contains a null character.',
    );
  }

  const backslashPath = input.replaceAll('/', '\\');
  const lowerPath = backslashPath.toLowerCase();
  if (
    lowerPath.startsWith('\\\\?\\') ||
    lowerPath.startsWith('\\\\.\\') ||
    lowerPath.startsWith('\\??\\') ||
    lowerPath.startsWith('\\\\??\\')
  ) {
    unsupportedNamespace('Windows device and extended path namespaces are not supported.');
  }
  if (backslashPath.startsWith('\\\\')) {
    unsupportedNamespace('UNC paths are not supported by the sandbox file bridge.');
  }

  let kind: WindowsPathKind;
  if (WINDOWS_LOCAL_ABSOLUTE_PATTERN.test(input)) {
    kind = WindowsPathKind.Absolute;
  } else if (WINDOWS_DRIVE_RELATIVE_PATTERN.test(input)) {
    unsupportedNamespace('Drive-relative Windows paths are not supported.');
  } else if (backslashPath.startsWith('\\')) {
    unsupportedNamespace('Root-relative Windows paths are not supported.');
  } else {
    kind = WindowsPathKind.Relative;
  }

  validateSegments(input, kind);
  const normalized = path.win32.normalize(input);
  return { kind, normalized };
}

export function normalizeWindowsAbsolutePath(input: string): string {
  const parsed = parseWindowsPath(input);
  if (parsed.kind !== WindowsPathKind.Absolute) {
    throw new SandboxFsError(
      SandboxFsErrorCode.InvalidPath,
      'Expected a fully-qualified local Windows path.',
    );
  }
  return trimTrailingSeparators(parsed.normalized);
}

export function trimTrailingSeparators(input: string): string {
  const normalized = path.win32.normalize(input);
  const root = path.win32.parse(normalized).root;
  if (root.toLowerCase() === normalized.toLowerCase()) {
    return root;
  }
  return normalized.replace(/[\\/]+$/, '');
}

export function windowsPathEquals(left: string, right: string): boolean {
  return windowsPathComparisonKey(left) === windowsPathComparisonKey(right);
}

export function windowsPathComparisonKey(input: string): string {
  return trimTrailingSeparators(path.win32.normalize(input)).toLowerCase();
}

/** Segment-aware, case-insensitive containment. The root itself is included. */
export function isWindowsPathInside(root: string, candidate: string): boolean {
  const relative = path.win32.relative(
    windowsPathComparisonKey(root),
    windowsPathComparisonKey(candidate),
  );
  return (
    relative === '' ||
    (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.win32.sep}`))
  );
}

export function relativeWindowsPath(root: string, candidate: string): string {
  if (!isWindowsPathInside(root, candidate)) {
    throw new SandboxFsError(
      SandboxFsErrorCode.OutsideWorkspace,
      'Sandbox file path is outside the allowed root.',
    );
  }
  return path.win32.relative(root, candidate);
}

export function isWindowsDriveRoot(input: string): boolean {
  const normalized = normalizeWindowsAbsolutePath(input);
  return windowsPathEquals(normalized, path.win32.parse(normalized).root);
}
