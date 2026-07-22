# M3 Security Boundary

The M3 runtime is an internal-test security implementation, not yet a released
enterprise security boundary. Production readiness remains false until the M4
authorization/audit work, M5 release gates, endpoint validation, and a focused
security review are complete.

The capability mechanism tested by M1 is:

> A command and its descendants run as a dedicated ordinary local identity,
> and can write only when both that identity and one of the request's
> restricting capability SIDs are authorized for the target.

The automated boundary suite covers ordinary existing projects, broad `Users`
and `Authenticated Users` ACLs, child processes, absolute paths, junctions,
timeouts, output limits, and process-tree cleanup. M3 adds an installed broker /
dedicated-worker split, system network rules, protected runtime files, and
runtime integrity checks. Installation and firewall behavior must additionally
be validated on a real endpoint because CI does not approve UAC or mutate the
host firewall.

The implementation fails closed when:

- the request or protocol is incompatible;
- a writable root is a drive root, UNC path, device path, or traverses a
  reparse point;
- `cwd` or a protected path escapes the declared roots;
- ACL preparation or owner verification fails;
- the dedicated identity, its ordinary-user privilege/flags, encrypted
  credentials, or caller identity is invalid;
- the dedicated identity is no longer hidden by the managed Windows account
  visibility policy;
- an active Windows Firewall profile is disabled, local policy is overridden,
  or an account-scoped block rule is missing or changed;
- runtime manifest, version, architecture, hash, Authenticode policy, or the
  exact protected installation DACL validation fails;
- the dedicated worker is elevated, was not directly created by the product
  owner's broker, or cannot establish a watchdog on that broker;
- restricted-token creation fails;
- the broker cannot grant the dedicated identity access to its inherited
  window station and desktop before alternate-credential process creation;
- the child cannot be assigned to the Job Object before it is resumed.

Setup accepts fixed lifecycle verbs only. It rejects calls made by the managed
sandbox account before displaying UAC, carries the initiating user's validated
user SID through administrator approval, and binds elevated results to a unique
request identifier. Installation uses staging/current/previous slots and
attempts rollback before reporting a failed activation. A failed first install
also removes partial firewall rules, account-visibility state, credentials,
the managed account, and staging/install directories.

M3 does not claim strong read isolation. Windows/system-readable files and
explicit product read roots remain visible to the dedicated identity. Network
is instead denied at the dedicated-account boundary and verified before every
worker launch.

Workspace ACL updates add or revoke only deterministic Lobster capability ACEs
and the managed identity ACE. They do not take ownership, replace the existing
DACL, or remove unrelated user permissions. Runtime and credential directories
are different: setup deliberately installs protected DACLs granting full access
only to SYSTEM/Administrators and read/execute access needed by the product and
worker. The sandbox identity is explicitly denied access to its encrypted
credential record.

Windows requires an alternate-credential process to have access to its window
station and desktop even when it has no visible window. Immediately before
launch, the signed broker idempotently grants the dedicated identity access to
the broker's current interactive objects. The model-controlled process still
runs under the restricted token and Job UI restrictions. The desktop ACE is
session-scoped in practice and is not revoked after an individual command,
because revocation would race with concurrent tasks. A private desktop remains
an explicit security-review follow-up.

The broker grants the dedicated identity only synchronization and limited
identity-query access to the broker process object. The worker confirms that
its actual Windows parent PID is the declared broker and that the broker token
belongs to the installed product owner before starting the watchdog. If the
broker is cancelled or killed, the worker exits fail-closed. Closing the
worker's last command Job handle then terminates the model-controlled process
tree. The grant disappears with the broker process object.

## Compatibility limitation

Windows PowerShell needs access to per-logon and machine synchronization objects
while the CLR starts, so the restricted-token compatibility set contains its
logon SID and `Everyone` in addition to Lobster capabilities. The dedicated
identity prevents the signed-in user's normal file grants from carrying into
the command, and broad `Users`/`Authenticated Users` cases remain denied by the
restricted access check. A filesystem object that itself explicitly grants
write access to `Everyone`, however, is not claimed as an absolute boundary.

## Out of scope

M3 does not claim general read isolation, task-to-task isolation, or a private
desktop. The dedicated account narrows many reads naturally, but explicit
read-only roots and Windows/system-readable files remain visible. Named-pipe,
registry, device, and other non-filesystem attack surfaces require dedicated
security review. Shared writable compatibility roots such as npm cache are a
deliberate cache-poisoning tradeoff. The runtime remains Windows x64 only, and
no network-enabled policy exists in this version.
