---
name: writing-plans
description: Create a precise, step-by-step implementation plan for a software task. Use when the user asks for a plan, roadmap, task breakdown, or "how should I implement X" for coding work.
official: true
metadata:
  short-description: Write precise implementation plans
---

# Writing Plans

## Goal

Turn a software task into a **reviewable implementation plan**: requirement breakdown, ordered steps, verification criteria, and risks — before any code is written.

## Workflow

1. **Understand the ask**
   - Identify the goal, the codebase, and the definition of done.
   - If 1–2 blocking unknowns exist, ask; otherwise assume sensibly and note the assumption.

2. **Explore (read-only)**
   - Skim `README.md`, `docs/`, `CONTRIBUTING.md`, and the modules most likely touched.
   - Confirm build/test commands (e.g. `npm test`, `pytest`, `make test`) and CI checks.

3. **Write the plan** using this structure:
   - **Goal** — one paragraph: intent + approach.
   - **Scope** — what's in / not in scope.
   - **Steps** — ordered, verb-first, atomic items (discovery → changes → tests → rollout). 6–12 items.
     - Reference concrete files/commands where helpful.
     - Always include ≥1 **tests/verification** item and ≥1 **edge-cases/risks** item.
   - **Verification** — how to confirm done (specific tests, manual checks, metrics).
   - **Open questions** — max 3, if any.

4. **Output only the plan** (no meta commentary).

## Rules

- Plan for the **smallest change that satisfies the goal**; flag over-engineering.
- Prefer **incremental, verifiable steps** over one big bang.
- If the task is genuinely trivial (< 5 minutes), say so and give a short plan instead of a long one.
