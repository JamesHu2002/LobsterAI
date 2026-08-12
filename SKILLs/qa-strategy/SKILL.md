---
name: qa-strategy
description: Design a testing/QA strategy for a project or feature — test levels, scope, risks, and quality gates. Use when asked for a test plan, QA approach, or how to test a change thoroughly.
official: true
metadata:
  short-description: Design a testing strategy and quality gates
---

# QA Strategy

## Goal

Produce a **pragmatic testing strategy** for a feature or project: what to test at each level, what to skip, and how to gate quality.

## Workflow

1. **Understand the change**
   - Feature scope, tech stack, existing test setup, and CI pipeline.
   - The highest-risk areas (auth, data, money, external integrations, concurrency).

2. **Design the test pyramid for this feature**
   - **Unit** (many, fast): core logic, edge cases, error paths.
   - **Integration** (fewer): module/API/DB seams, contracts.
   - **E2E** (few, critical): the 2–5 user journeys that must not break.
   - **Manual/exploratory** (if relevant): UX, visual, cross-browser.
   - Justify what's at each level and what is explicitly **out of scope** (with reason).

3. **Define quality gates**
   - Required before merge/rollout: build passes, unit+integration green, lint, no new critical issues, E2E critical paths green.
   - Optional gates: coverage threshold (only if meaningful), performance check, a11y scan.
   - Make gates **automated** where possible so they run in CI.

4. **Deliver the strategy**
   - A short written plan: test matrix, tools/commands, CI hooks, risks, and the acceptance criteria ("definition of done").
   - Include concrete examples of the tests to write.

## Rules

- **Align depth with risk**: don't gold-plate a tiny change, but harden money/security/concurrency paths.
- Prefer **automation over manual checklists** for repeatable checks.
- Name the **owner/trigger** for each gate (CI on PR, nightly, on-demand).
- If the project lacks infrastructure for a gate (e.g. no E2E harness), say so and propose the minimal setup.
