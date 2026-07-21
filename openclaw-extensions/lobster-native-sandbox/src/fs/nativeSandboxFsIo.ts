import { Buffer } from 'node:buffer';
import path from 'node:path';

import type {
  NativeSandboxExecutor,
  NativeSandboxShell,
} from '../runtime/nativeSandboxExecutor.js';
import {
  SandboxFsError,
  SandboxFsErrorCode,
  throwIfAborted,
} from './sandboxFsError.js';
import type { SandboxFsIo } from './sandboxFsIo.js';

const POWERSHELL_FILE_HELPER_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Decode-Base64Url([string] $Value) {
  $Normalized = $Value.Replace('-', '+').Replace('_', '/')
  switch ($Normalized.Length % 4) {
    2 { $Normalized += '==' }
    3 { $Normalized += '=' }
  }
  return [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String($Normalized)
  )
}

function Write-Bytes([System.IO.Stream] $Stream, [byte[]] $Bytes) {
  $Stream.Write($Bytes, 0, $Bytes.Length)
  $Stream.Flush()
}

try {
  $RequestPath = Decode-Base64Url $EncodedRequest
  $RequestJson = [System.IO.File]::ReadAllText(
    $RequestPath,
    [System.Text.Encoding]::UTF8
  )
  $Request = ConvertFrom-Json -InputObject $RequestJson
  $Operation = [string] $Request.operation
  $First = [string] $Request.firstPath
  $Second = [string] $Request.secondPath
  $InputPath = [string] $Request.inputPath
  $Options = $Request.options

  switch ($Operation) {
    'read' {
      Write-Bytes ([Console]::OpenStandardOutput()) ([System.IO.File]::ReadAllBytes($First))
      break
    }
    'write' {
      $Parent = [System.IO.Path]::GetDirectoryName($First)
      if ($Options.mkdir -ne $false) {
        [System.IO.Directory]::CreateDirectory($Parent) | Out-Null
      }
      $Temporary = [System.IO.Path]::Combine(
        $Parent,
        '.' + [System.IO.Path]::GetFileName($First) + '.lobster-' +
          [System.Guid]::NewGuid().ToString('N') + '.tmp'
      )
      $TemporaryExists = $false
      try {
        [System.IO.File]::Copy($InputPath, $Temporary, $false)
        $TemporaryExists = $true
        if ([System.IO.File]::Exists($First)) {
          $Backup = $Temporary + '.bak'
          try {
            [System.IO.File]::Replace($Temporary, $First, $Backup)
            $TemporaryExists = $false
          } finally {
            if ([System.IO.File]::Exists($Backup)) {
              [System.IO.File]::Delete($Backup)
            }
          }
        } else {
          [System.IO.File]::Move($Temporary, $First)
          $TemporaryExists = $false
        }
      } finally {
        if ($TemporaryExists) {
          [System.IO.File]::Delete($Temporary)
        }
      }
      break
    }
    'mkdir' {
      [System.IO.Directory]::CreateDirectory($First) | Out-Null
      break
    }
    'remove' {
      if ([System.IO.Directory]::Exists($First)) {
        [System.IO.Directory]::Delete($First, $Options.recursive -eq $true)
      } elseif ([System.IO.File]::Exists($First)) {
        [System.IO.File]::Delete($First)
      } elseif ($Options.force -ne $true) {
        throw (New-Object System.IO.FileNotFoundException)
      }
      break
    }
    'rename' {
      if ($Options.mkdir -ne $false) {
        [System.IO.Directory]::CreateDirectory(
          [System.IO.Path]::GetDirectoryName($Second)
        ) | Out-Null
      }
      if ([System.IO.Directory]::Exists($First)) {
        [System.IO.Directory]::Move($First, $Second)
      } elseif ([System.IO.File]::Exists($First)) {
        if ([System.IO.File]::Exists($Second)) {
          $Backup = $First + '.lobster-' +
            [System.Guid]::NewGuid().ToString('N') + '.bak'
          try {
            [System.IO.File]::Replace($First, $Second, $Backup)
          } finally {
            if ([System.IO.File]::Exists($Backup)) {
              [System.IO.File]::Delete($Backup)
            }
          }
        } else {
          [System.IO.File]::Move($First, $Second)
        }
      } else {
        throw (New-Object System.IO.FileNotFoundException)
      }
      break
    }
    'list' {
      $Names = @(
        [System.IO.Directory]::EnumerateFileSystemEntries($First) |
          ForEach-Object { [System.IO.Path]::GetFileName($_) }
      )
      $Json = ConvertTo-Json -InputObject $Names -Compress
      Write-Bytes ([Console]::OpenStandardOutput()) (
        [System.Text.Encoding]::UTF8.GetBytes($Json)
      )
      break
    }
    default {
      throw (New-Object System.NotSupportedException)
    }
  }
} catch {
  $Exception = $_.Exception
  while ($null -ne $Exception.InnerException) {
    $Exception = $Exception.InnerException
  }
  $Code = 'EIO'
  if (
    $Exception -is [System.IO.FileNotFoundException] -or
    $Exception -is [System.IO.DirectoryNotFoundException]
  ) {
    $Code = 'ENOENT'
  } elseif ($Exception -is [System.UnauthorizedAccessException]) {
    $Code = 'EACCES'
  } elseif ($Exception -is [System.NotSupportedException]) {
    $Code = 'ENOTSUP'
  } elseif ($Exception -is [System.IO.IOException]) {
    $NativeCode = $Exception.HResult -band 0xffff
    if ($NativeCode -eq 80 -or $NativeCode -eq 183) {
      $Code = 'EEXIST'
    } elseif ($NativeCode -eq 145) {
      $Code = 'ENOTEMPTY'
    }
  }
  $ErrorJson = ConvertTo-Json -InputObject @{
    code = $Code
    exception = $Exception.GetType().FullName
    hresult = $Exception.HResult
  } -Compress
  Write-Bytes ([Console]::OpenStandardError()) (
    [System.Text.Encoding]::UTF8.GetBytes($ErrorJson)
  )
  exit 1
}
`;

const encodeArgument = (value: string): string => (
  Buffer.from(value, 'utf8').toString('base64url')
);

const buildFileHelperEncodedScript = (requestPath: string): string => {
  const bindings = `$EncodedRequest = '${encodeArgument(requestPath)}'`;
  const encodedScript = Buffer
    .from(`${bindings}\n${POWERSHELL_FILE_HELPER_SOURCE}`, 'utf16le')
    .toString('base64');
  return encodedScript;
};

const POWERSHELL_FILE_HELPER_SHELL: NativeSandboxShell = {
  exe: path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  ),
  args: [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
  ],
};

const mapHelperError = (stderr: Buffer): SandboxFsError => {
  let code = 'EIO';
  try {
    const parsed = JSON.parse(stderr.toString('utf8')) as { code?: unknown };
    if (typeof parsed.code === 'string') code = parsed.code;
  } catch {
    // Keep a generic, non-sensitive error when helper output is malformed.
  }
  switch (code) {
    case 'ENOENT':
      return new SandboxFsError(SandboxFsErrorCode.NotFound, 'Sandbox path was not found.');
    case 'EEXIST':
      return new SandboxFsError(
        SandboxFsErrorCode.AlreadyExists,
        'Sandbox destination already exists.',
      );
    case 'ENOTEMPTY':
      return new SandboxFsError(
        SandboxFsErrorCode.NotEmpty,
        'Sandbox directory is not empty.',
      );
    case 'ENOTSUP':
      return new SandboxFsError(
        SandboxFsErrorCode.OperationUnsupported,
        'Sandbox file operation is unsupported.',
      );
    default:
      return new SandboxFsError(
        SandboxFsErrorCode.IoError,
        'Sandboxed Windows file operation failed.',
      );
  }
};

/**
 * Executes the final file-system mutation/read through a native Sandbox executor.
 * The helper uses only machine-readable PowerShell/.NET components, avoiding
 * broad inheritable ACL grants to per-user Node or package-manager trees.
 */
export class NativeSandboxFsIo implements SandboxFsIo {
  constructor(
    private readonly options: {
      executor: NativeSandboxExecutor;
      workspaceDir: string;
      sessionKey: string;
    },
  ) {}

  async readFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    return (await this.run({
      operation: 'read',
      firstPath: filePath,
      signal,
    })).stdout;
  }

  async writeFileAtomic(params: {
    filePath: string;
    data: Buffer;
    mkdir: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.run({
      operation: 'write',
      firstPath: params.filePath,
      options: { mkdir: params.mkdir },
      stdin: params.data,
      signal: params.signal,
    });
  }

  async mkdirp(filePath: string, signal?: AbortSignal): Promise<void> {
    await this.run({
      operation: 'mkdir',
      firstPath: filePath,
      signal,
    });
  }

  async remove(params: {
    filePath: string;
    recursive: boolean;
    force: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.run({
      operation: 'remove',
      firstPath: params.filePath,
      options: {
        recursive: params.recursive,
        force: params.force,
      },
      signal: params.signal,
    });
  }

  async rename(params: {
    from: string;
    to: string;
    mkdir: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.run({
      operation: 'rename',
      firstPath: params.from,
      secondPath: params.to,
      options: { mkdir: params.mkdir },
      signal: params.signal,
    });
  }

  async listDirectory(filePath: string, signal?: AbortSignal): Promise<readonly string[]> {
    const result = await this.run({
      operation: 'list',
      firstPath: filePath,
      signal,
    });
    try {
      const parsed = JSON.parse(result.stdout.toString('utf8')) as unknown;
      if (
        Array.isArray(parsed)
        && parsed.every(entry => typeof entry === 'string')
      ) {
        return parsed;
      }
    } catch {
      // Fall through to a stable bridge error.
    }
    throw new SandboxFsError(
      SandboxFsErrorCode.IoError,
      'Sandboxed directory enumeration returned an invalid result.',
    );
  }

  private async run(params: {
    operation: string;
    firstPath: string;
    secondPath?: string;
    options?: Record<string, unknown>;
    stdin?: Buffer;
    signal?: AbortSignal;
  }) {
    throwIfAborted(params.signal);
    let stagedInput: Awaited<ReturnType<NativeSandboxExecutor['stageInput']>> | undefined;
    let stagedRequest: Awaited<ReturnType<NativeSandboxExecutor['stageInput']>> | undefined;
    try {
      stagedInput = params.stdin === undefined
        ? undefined
        : await this.options.executor.stageInput({
            data: params.stdin,
            workspaceDir: this.options.workspaceDir,
          });
      stagedRequest = await this.options.executor.stageInput({
        data: Buffer.from(JSON.stringify({
          operation: params.operation,
          firstPath: params.firstPath,
          secondPath: params.secondPath ?? '',
          inputPath: stagedInput?.filePath ?? '',
          options: params.options ?? {},
        }), 'utf8'),
        workspaceDir: this.options.workspaceDir,
      });
      const result = await this.options.executor.runIsolatedCommand({
        command: buildFileHelperEncodedScript(stagedRequest.filePath),
        workspaceDir: this.options.workspaceDir,
        cwd: this.options.workspaceDir,
        signal: params.signal,
        allowFailure: true,
        sessionKey: this.options.sessionKey,
        binShell: POWERSHELL_FILE_HELPER_SHELL,
      });
      if (result.code !== 0) {
        throw mapHelperError(result.stderr);
      }
      return result;
    } finally {
      stagedRequest?.dispose();
      stagedInput?.dispose();
    }
  }
}
