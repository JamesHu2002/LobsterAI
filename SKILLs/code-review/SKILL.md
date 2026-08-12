---
name: code-review
description: Review a code change (diff, branch, or PR) and give actionable findings. Use when asked to review code, check a PR, or find bugs/risks in a change.
official: true
metadata:
  short-description: Actionable code review findings
---

# Code Review

## Goal

Review a change and return **prioritised, concrete, actionable findings** — bugs and regressions first, then correctness, security, performance, and readability.

## Workflow

1. **Understand the change**
   - Read the diff and its intent (PR description, commit messages, linked issue).
   - Identify touched modules, data flow, and any public API / contract changes.

2. **Read systematically, in this order**
   - **Correctness & bugs**: logic errors, off-by-one, null/undefined, error handling, races, wrong conditionals, missed cases.
   - **Regressions**: behaviour changes that could break existing callers or tests.
   - **Security**: injection, authn/authz bypass, unsafe deserialisation, secrets in code, path traversal.
   - **Performance**: hot paths, N+1 queries, unbounded loops, blocking I/O in critical paths.
   - **Maintainability**: naming, duplication, dead code, consistency with project conventions, test quality.

3. **Verify the risky findings**
   - For each serious finding, confirm by reading the surrounding code or, if cheap, running a targeted check.
   - Do not report speculative issues as confirmed.

4. **Report findings**
   - Group by severity: **blocker / should-fix / nit**.
   - Each finding: file:line, what's wrong, why it matters, and a concrete suggestion.
   - Note what was checked and verified.

## Rules

- **Respect scope**: review the change, not the whole codebase; flag pre-existing issues separately.
- **Be specific and kind**: reference exact code; propose fixes, don't just criticise.
- **Test coverage**: call out missing tests for new/changed logic.
- If the change has no clear intent, ask before deep review.
