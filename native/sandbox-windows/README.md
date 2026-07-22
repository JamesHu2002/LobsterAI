# Lobster Windows Sandbox Runtime

This workspace contains the Windows-only native sandbox runtime and its
fixed-operation installer.

The runtime is consumed by LobsterAI's OpenClaw sandbox backend. The CLI also
remains independently testable for native policy verification.

## Build

```powershell
npm run sandbox-native:build
```

## Request format

`lobster-command-runner` consumes a versioned JSON request:

```json
{
  "protocolVersion": 4,
  "policy": {
    "policyVersion": "workspace-write-v4",
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

The public runner is a non-elevated broker. `verify` validates the protected
installation, prepares workspace ACLs for the dedicated sandbox identity, and
asks an internal worker to prove the restricted token. `run` launches the
internal worker as that dedicated identity and executes the command under a
second `WRITE_RESTRICTED` token and a kill-on-close Job Object. Child stdout and
stderr remain streamed to the corresponding CLI streams; the final
machine-readable report is emitted to stderr with the
`LOBSTER_SANDBOX_REPORT ` prefix. `cleanup` removes only Lobster-owned
capability and identity ACEs for the request.

Installed runtime mode requires request files instead of stdin so the worker
can read the request through an explicitly authorized scratch root. The worker
also verifies that its real Windows parent PID and parent token SID identify
the installed product owner before accepting an internal command. Debug
builds retain an opt-in direct harness for native boundary tests; release
builds ignore that bypass flag.

## Setup lifecycle

`lobster-sandbox-setup.exe` accepts only these operations:

```powershell
lobster-sandbox-setup.exe install
lobster-sandbox-setup.exe verify
lobster-sandbox-setup.exe repair
lobster-sandbox-setup.exe upgrade
lobster-sandbox-setup.exe rollback
lobster-sandbox-setup.exe uninstall
```

`verify` is read-only and never requests elevation. Mutating operations use
Windows `runas` only when needed. The helper installs to
`%ProgramData%\LobsterAI-SandboxRuntime`, provisions the
`LobsterSandboxOffline` ordinary local account, protects runtime and credential
ACLs, installs account-scoped outbound block rules, and retains one previous
runtime for rollback. The managed account is hidden from the Windows sign-in
screen without disabling its batch execution identity. A standard user's SID is carried across an
over-the-shoulder administrator approval so the non-elevated LobsterAI process
can still use the protected installation. Elevated results include a per-call
request identifier, preventing an old result file from being accepted.

Before an installed worker is started with alternate credentials, the broker
grants the dedicated account access to its current Window Station and Desktop,
as required by Windows process creation. This is connection compatibility, not
an extra model capability: the command itself is still placed in the restricted
token and Job UI boundary, and a failure to prepare either object fails closed.

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

- Windows x64 internal-test runtime; protocol v4, policy
  `workspace-write-v4`, runtime 0.4.0.
- Uses a dedicated ordinary local identity plus a `WRITE_RESTRICTED` token and
  path-scoped capability SIDs. Both Windows access checks must succeed.
- Assigns the suspended command to a no-breakaway, kill-on-close Job Object
  before resuming it and applies UI-handle/clipboard/system restrictions.
- Authenticates and supervises the dedicated worker from the signed broker chain, so cancelling
  or terminating the broker closes the command Job and its process tree.
- Rejects UNC/device/drive-root policies and reparse points in policy roots.
- Blocks outbound traffic for the dedicated identity, including TCP/UDP
  loopback, and refuses to run when active Windows Firewall policy or the
  account-scoped rules cannot be verified.
- Verifies manifest schema, protocol, policy, architecture, SHA-256 hashes,
  an exact runtime file set, exact protected install DACLs, and—inside packaged
  builds—Authenticode signatures. Packaged helpers are signed before their
  final manifest hashes are generated.
- Inherits product-selected host profile paths without making the whole profile
  writable; temporary files remain in an authorized disposable scratch root.
- Allows product-selected compatibility roots such as the shared npm cache.
  These grants improve tool compatibility but permit cross-task cache mutation.
- Supports multiple declared roots, but M4 still owns concurrent multi-task
  authorization/ref-count lifecycle and user-queryable enterprise audit.
- Does not claim general read isolation, private-desktop isolation, macOS
  support, or production readiness. Objects that explicitly grant write access
  to `Everyone` remain a documented compatibility-edge case.
- Keeps a non-Windows protocol/core entry that returns `unsupported-platform`,
  so a later macOS executor can implement the same public contract without
  changing the CLI protocol.
