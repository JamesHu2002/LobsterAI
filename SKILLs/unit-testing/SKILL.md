---
name: unit-testing
description: Write focused unit tests for functions, classes, and modules. Use when asked to add tests, improve coverage, or validate isolated logic.
official: true
metadata:
  short-description: Focused unit test authoring
---

# Unit Testing

## Goal

Write **fast, focused, reliable** unit tests that validate a module's behaviour in isolation.

## Workflow

1. **Scope the unit**
   - Identify the function/class under test and its contract (inputs → outputs, errors).
   - Map dependencies that should be mocked/faked vs. exercised (prefer real, fast dependencies; mock I/O, network, time, randomness).

2. **Write tests that assert behaviour**
   - Use the project's test framework (`vitest`, `jest`, `pytest`, `unittest`, etc.).
   - Structure with arrange → act → assert; one behaviour per test.
   - Cover:
     - **Happy path** (normal input → expected output)
     - **Boundaries** (empty, min/max, off-by-one, zero, null/undefined)
     - **Errors** (invalid input → expected error/exception)
     - **Edge states** (caching, ordering, idempotency when relevant)

3. **Run and verify**
   - Run the targeted test and the module's suite; confirm green.
   - Do not leave skipped/disabled tests without a reason.

## Rules

- Test **behaviour**, not implementation; avoid asserting internals that make tests brittle.
- Keep tests **deterministic**: no dependence on wall-clock, locale, or shared global state unless isolated.
- Keep tests **fast** (no real network, no real browser unless the unit needs it).
- Name tests to describe the behaviour (`should_return_empty_when_input_is_null`).
- If a bug is found while testing, write a failing test first, then fix (see `test-driven-development`).
