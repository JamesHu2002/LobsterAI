---
name: coverage-gap-analysis
description: Analyse test coverage to find untested, high-risk code and recommend what to test next. Use when asked about coverage, "what's untested", or improving test depth.
official: true
metadata:
  short-description: Find untested high-risk code
---

# Coverage Gap Analysis

## Goal

Turn a coverage report into a **prioritised list of untested, high-risk code** and concrete next tests.

## Workflow

1. **Get coverage data**
   - Run the project's coverage tool (`vitest --coverage`, `pytest --cov`, `nyc`, `lcov`, etc.).
   - If no coverage tool exists, set up a minimal one and note it.

2. **Rank by risk, not just percentage**
   - Focus on **critical, complex, or frequently-changed** modules first, not low-value glue code.
   - Identify:
     - untested **error paths** (exceptions, invalid input),
     - untested **boundaries** (edge conditions, empty/limit cases),
     - untested **branches** in decision-heavy functions,
     - **regression-prone** code (recent changes, bug fixes, core paths).
   - Ignore untested boilerplate/UI glue that adds little value.

3. **Produce the report**
   - List gaps ordered by priority: file:function → why it matters → suggested test (1 line).
   - Give a rough **coverage delta** achievable (e.g. "adding tests for X would lift module coverage from 62% → ~80%").
   - Separate "should test" from "acceptable to skip" (with reason).

## Rules

- **Percentage is a means, not the goal**: 100% coverage of low-value code is waste.
- Prefer testing **behaviour that can regress** over lines that are trivial.
- Tie recommendations to actual risk (public APIs, auth, money/state transitions, error handling).
- Offer to write the top-priority tests after the analysis.
