---
name: flaky-test-repair
description: Find and fix flaky (intermittently failing) tests. Use when a test passes sometimes and fails other times, or when investigating CI flakiness.
official: true
metadata:
  short-description: Diagnose and fix flaky tests
---

# Flaky Test Repair

## Goal

Turn an intermittent test failure into a **deterministic, reliably-passing test** (or a correctly-marked environment issue).

## Workflow

1. **Reproduce the flake**
   - Run the test repeatedly (e.g. `--repeat 50` or a loop) and collect the failure signature.
   - Note whether it fails consistently in a pattern (always 2nd run, only on CI, only on Windows, only under load).

2. **Diagnose the root cause — the common culprits, in order:**
   - **Shared state**: leftover DB records, globals, cache, files, env — not cleaned between tests.
   - **Timing/races**: missing wait, fixed sleep, async not awaited, background tasks racing.
   - **Order dependence**: test passes alone but fails in a suite (or vice versa).
   - **Environment drift**: locale, timezone, random data, network, resource limits, versions.
   - **Brittle selectors/assertions**: ambiguous locators, exact-string matching on volatile text.

3. **Fix at the root**
   - Isolate state (fixtures/cleanup, unique test data, transactions).
   - Replace sleeps with explicit waits/conditions; await all async work.
   - Remove order dependence; make each test self-contained.
   - Pin or mock non-deterministic inputs (time, random, network).

4. **Verify durability**
   - Run the test many times (50–100) and the full suite a few times to confirm.
   - Add a comment documenting *why* it was flaky and how it's now deterministic.

## Rules

- **Never fix a flake by retrying the test** (unless it's a genuine transient external dependency, and then mock it instead).
- Do not skip/disable a flaky test without a tracked reason and a plan.
- If the flake is caused by a **real bug** (nondeterministic app behaviour), fix the app, not the test.
- Report the pattern you found so reviewers trust the fix.
