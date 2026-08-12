---
name: systematic-debugging
description: Debug issues methodically instead of guessing. Use when investigating a bug, failing test, crash, or unexpected behaviour.
official: true
metadata:
  short-description: Methodical root-cause debugging
---

# Systematic Debugging

## Goal

Find the **root cause** of a problem and fix it with confidence, using evidence instead of guessing.

## Workflow

1. **Reproduce**
   - Get a minimal, reliable reproduction (command, input, steps).
   - Note the exact error, stack trace, and the versions involved.

2. **Read the evidence**
   - Read the failing code path and logs **before** theorising.
   - Confirm the failure is in the code, not the environment or the test.

3. **Form one hypothesis at a time**
   - State a specific, falsifiable hypothesis (e.g. "the null check returns early when `id` is empty").
   - Use binary search / bisecting to narrow it: comment out code, toggle flags, add targeted logging, or `git bisect` for regressions.
   - Prefer the cheapest discriminating experiment.

4. **Confirm the root cause**
   - Modify the code to prove the hypothesis (e.g. add an assertion or log that confirms the assumed state).
   - Remove any temporary instrumentation.

5. **Fix + regression test**
   - Apply the minimal fix.
   - Add a regression test that fails on the old code and passes on the fix.
   - Run the related suite and confirm no regressions.

## Rules

- **No shotgun debugging**: change one thing at a time and verify.
- Suspect the **recent changes** first (blame/git log) for regressions.
- Distinguish *symptom* from *cause* — keep digging until the root cause is identified.
- If a fix is non-obvious, note *why* it works (mechanism) for the reviewer.
