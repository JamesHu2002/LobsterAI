---
name: refactoring
description: Improve code structure without changing behaviour. Use when asked to refactor, clean up, simplify, or improve a codebase's design.
official: true
metadata:
  short-description: Safe, behaviour-preserving refactoring
---

# Refactoring

## Goal

Improve structure, readability, and maintainability of code **without changing its observable behaviour**.

## Workflow

1. **Establish the baseline**
   - Run the existing test suite and record the result (all green? known failures?).
   - Identify the seams / entry points of the refactor.

2. **Choose small, reversible steps**
   - Extract functions/classes, rename, simplify conditionals, remove duplication.
   - One structural change at a time; keep the code compiling and tests green after each step.
   - Prefer mechanical, behaviour-preserving transforms over rewrites.

3. **Keep behaviour identical**
   - Do not bundle feature changes or bug fixes into a refactor unless the user asks.
   - If a bug is discovered, flag it separately.

4. **Verify**
   - Run the full relevant suite after each step.
   - For critical paths, add/adjust tests if the refactor makes intent clearer.

## Rules

- **Small commits/steps** make regressions easy to bisect.
- Preserve public APIs and external contracts unless asked otherwise.
- Update documentation/comments that the refactor makes stale.
- If a "refactor" turns into a rewrite (large behavioural risk), stop and propose a plan first.
- Do not refactor just to change style; refactor for a concrete benefit (clarity, extensibility, performance).
