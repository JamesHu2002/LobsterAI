# M1 Security Boundary

The M1 runner is a feasibility prototype, not a released security boundary.

The capability mechanism tested by M1 is:

> A command and descendants started by the runner can write only to explicitly
> prepared roots carrying one of the request's restricting SIDs.

The automated boundary suite proves this for ordinary existing projects,
including roots and non-roots that grant broad access to `Users` and
`Authenticated Users`. It also proves that a child process, absolute path, and
junction do not bypass that check.

The implementation fails closed when:

- the request or protocol is incompatible;
- a writable root is a drive root, UNC path, device path, or traverses a
  reparse point;
- `cwd` or a protected path escapes the declared roots;
- ACL preparation or owner verification fails;
- restricted-token creation fails;
- the child cannot be assigned to the Job Object before it is resumed.

M1 does not claim strong read isolation or network isolation. The calling
user's normal read permissions remain visible to the restricted process.

ACL updates add or revoke only deterministic Lobster capability ACEs. They do
not take ownership, replace the existing DACL, or remove user permissions.

## Prototype identity limitation

M1 runs from the signed-in user's token. Windows PowerShell needs access to
per-logon and machine synchronization objects while the CLR starts, so the
restricted-token compatibility set contains the logon SID and `Everyone` in
addition to the Lobster capabilities. This does not make normal user-owned
directories writable, and broad `Users`/`Authenticated Users` cases remain
denied by the second access check. It does mean that a filesystem object which
itself explicitly grants write access to `Everyone` is not a production-grade
boundary under this prototype.

Before the Sandbox can be presented as a strict enterprise boundary, the
setup/runtime milestone must launch the runner from a provisioned low-privilege
sandbox identity. Then the normal access check denies the signed-in user's
other files, while the Capability check grants only active workspace roots.
M1 must not be connected to the product toggle as-is.

## Out of scope

`networkMode=disabled` records the policy expected by later integration, but
M1 does not yet install or enforce a Windows Filtering Platform rule. M1 also
does not claim strong read isolation: the caller's normal read permissions
remain visible to the restricted process.
