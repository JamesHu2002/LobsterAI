export const SandboxFsErrorCode = {
  Aborted: 'aborted',
  AlreadyExists: 'already_exists',
  CwdOutsideWorkspace: 'cwd_outside_workspace',
  FileTypeUnsupported: 'file_type_unsupported',
  HardlinkUnsupported: 'hardlink_unsupported',
  InvalidPath: 'invalid_path',
  IoError: 'io_error',
  NotEmpty: 'not_empty',
  NotFound: 'not_found',
  OperationUnsupported: 'operation_unsupported',
  OutsideWorkspace: 'outside_workspace',
  PathRaceDetected: 'path_race_detected',
  PathTraversal: 'path_traversal',
  ReadOnlyRoot: 'read_only_root',
  ReparsePointUnsupported: 'reparse_point_unsupported',
  UnsupportedPathNamespace: 'unsupported_path_namespace',
  WorkspaceRootTooBroad: 'workspace_root_too_broad',
  WorkspaceRootUnavailable: 'workspace_root_unavailable',
} as const;

export type SandboxFsErrorCode =
  (typeof SandboxFsErrorCode)[keyof typeof SandboxFsErrorCode];

export class SandboxFsError extends Error {
  readonly code: SandboxFsErrorCode;

  constructor(code: SandboxFsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxFsError';
    this.code = code;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SandboxFsError(SandboxFsErrorCode.Aborted, 'Sandbox file operation was aborted.');
  }
}

export function mapNodeFsError(error: unknown, fallbackMessage: string): SandboxFsError {
  if (error instanceof SandboxFsError) {
    return error;
  }

  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ABORT_ERR':
      return new SandboxFsError(
        SandboxFsErrorCode.Aborted,
        'Sandbox file operation was aborted.',
        { cause: error },
      );
    case 'ENOENT':
      return new SandboxFsError(SandboxFsErrorCode.NotFound, fallbackMessage, { cause: error });
    case 'EEXIST':
      return new SandboxFsError(SandboxFsErrorCode.AlreadyExists, fallbackMessage, {
        cause: error,
      });
    case 'ENOTEMPTY':
      return new SandboxFsError(SandboxFsErrorCode.NotEmpty, fallbackMessage, { cause: error });
    default:
      return new SandboxFsError(SandboxFsErrorCode.IoError, fallbackMessage, { cause: error });
  }
}
