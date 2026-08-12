---
name: test-driven-development
description: Drive implementation with a red–green–refactor loop. Use when writing new features or fixing bugs where a failing test can be written first.
official: true
metadata:
  short-description: Red–green–refactor workflow
---

# Test-Driven Development

## Goal

Implement a feature or fix through the TDD loop so the final code is covered by a test that proves the behaviour.

## Workflow (Red → Green → Refactor)

1. **Red — write a failing test first**
   - Add a test that captures the desired behaviour or the bug.
   - Run it and confirm it fails for the right reason (not a harness error).
   - Keep the test small and focused on one behaviour.

2. **Green — make it pass with the minimal change**
   - Implement only what is needed to pass the test.
   - Do not refactor or polish yet.
   - Run the test suite; confirm the new test passes and no existing test regresses.

3. **Refactor — improve without changing behaviour**
   - Rename, extract, deduplicate, remove dead code.
   - Re-run the suite after each refactor step.
   - Confirm behaviour is unchanged (all tests still green).

4. **Repeat** for the next behaviour or edge case.

## Rules

- **One behaviour per test**; assert outcomes, not implementation details.
- Prefer the project's existing test framework and conventions (`npm test`, `pytest`, `vitest`, etc.).
- If the codebase has no test harness, set up a minimal one first and note it in the plan.
- Never weaken a test to make it pass; fix the code instead.
- Cover the **boundary/edge cases** that are cheap to test (empty input, errors, off-by-one).
