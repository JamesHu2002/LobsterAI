# Lobster Windows Sandbox Runtime

This workspace contains the Windows-only native sandbox prototype.

The runtime is consumed by LobsterAI's OpenClaw sandbox backend. The CLI also
remains independently testable for native policy verification.

## Build

```powershell
cargo build --manifest-path native/sandbox-windows/Cargo.toml `
  --package lobster-command-runner
```

## Request format

`lobster-command-runner` consumes a versioned JSON request:

```json
{
  "protocolVersion": 3,
  "policy": {
    "policyVersion": "workspace-write-v3",
    "taskId": "manual-smoke",
    "agentId": "main",
    "cwd": "D:\\projects\\demo",
    "writableRoots": [
      "D:\\projects\\demo",
      "C:\\Users\\alice\\AppData\\Roaming\\LobsterAI\\openclaw\\state\\workspace-main",
      "C:\\Users\\alice\\AppData\\Local\\npm-cache"
    ],
    "readableRoots": ["C:\\LobsterAI\\SKILLs"],
    "protectedPaths": [],
    "profile": {
      "mode": "inherit-host",
      "homeDir": "C:\\Users\\alice",
      "userProfileDir": "C:\\Users\\alice",
      "appDataDir": "C:\\Users\\alice\\AppData\\Roaming",
      "localAppDataDir": "C:\\Users\\alice\\AppData\\Local"
    },
    "scratchDir": "D:\\projects\\demo\\.lobster-sandbox-scratch",
    "networkMode": "disabled",
    "limits": {
      "timeoutMs": 120000,
      "maxProcesses": 64,
      "maxOutputBytes": 67108864
    }
  },
  "command": {
    "argv": ["cmd.exe", "/d", "/s", "/c", "echo ok>inside.txt"],
    "env": {}
  }
}
```

Commands:

```powershell
lobster-command-runner verify request.json
lobster-command-runner run request.json
lobster-command-runner cleanup request.json
```

`verify` prepares workspace ACLs and creates a restricted token but does not
run the command. `run` repeats the same fail-closed preparation before spawning
the process. Child stdout and stderr remain streamed to the corresponding CLI
streams; the final machine-readable report is emitted to stderr with the
`LOBSTER_SANDBOX_REPORT ` prefix. `cleanup` removes only Lobster capability
ACEs for the request. Use `-` instead of a filename to read a request from
stdin.

Repository shortcuts:

```powershell
npm run sandbox-native:build
npm run sandbox-native:test
npm run sandbox-native:lint
```

The test suite exercises an existing ordinary directory, broad `Users` and
`Authenticated Users` ACLs, writes inside and outside the workspace,
PowerShell/cmd child processes, Node.js, Python, npm, inherited profile paths,
an explicit shared cache root, read-only roots, protected paths, junction escape
attempts, timeout, and process-tree cleanup.

## Current boundaries

- Windows x64 development prototype only.
- Enforces write roots through a `WRITE_RESTRICTED` token and path-scoped SIDs.
- Assigns the suspended child to a kill-on-close Job Object before resuming it.
- Rejects UNC/device/drive-root policies and reparse points in policy roots.
- Inherits trusted host `HOME`/`USERPROFILE` and AppData paths without making
  the profile a writable root; temporary files remain in a disposable scratch
  directory.
- Allows product-selected compatibility roots such as the shared npm cache.
  These grants improve tool compatibility but permit cross-task cache mutation.
- Supports multiple writable roots and explicit read-only roots.
- Does not yet implement system network isolation, setup/upgrade, signing,
  multi-task authorization lifecycle, or macOS.
- Uses the caller identity with a restricted token and path capabilities.
- Keeps a non-Windows protocol/core entry that returns `unsupported-platform`,
  so a later macOS executor can implement the same public contract without
  changing the CLI protocol.
