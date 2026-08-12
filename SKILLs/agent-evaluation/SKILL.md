---
name: agent-evaluation
description: Evaluate an AI agent's quality — build eval sets, graders, and regression gates. Use when asked to measure an agent, improve its reliability, or guard against regressions.
official: true
metadata:
  short-description: Measure agent quality with evals
---

# Agent Evaluation

## Goal

Turn "does the agent work?" into **measurable, regression-guarded** evidence.

## Workflow

1. **Define what "good" means**
   - Success criteria per task: correct final answer, correct tool usage, no disallowed side effects, latency/cost bounds.
   - Distinguish **capability** (can it do X?) from **preference/fidelity** (does it follow the process?).

2. **Build an eval set**
   - 10–20 cases while iterating; 50–200+ before release.
   - Cover happy paths, edge cases, adversarial inputs (prompt injection, tool misuse).
   - Use **golden traces** for stable, reproducible scenarios.

3. **Choose graders**
   - **Deterministic checks**: output schema, tool-call accuracy, exact/containment matching (cheap, reliable).
   - **Semantic / LLM-as-judge**: rubric-based scoring of answers and reasoning (with a clear rubric and an independent judge prompt).
   - Report both; don't rely on "vibe checks".

4. **Gate regressions**
   - Run the eval suite on every prompt/agent change; block merges that regress.
   - Track metrics over time: pass rate, cost, latency, tool-error rate.
   - Add **online monitoring** for real-world failures that offline evals miss (see `agent-observability`).

5. **Act on the results**
   - Fix the top failure modes (prompt, tools, loop, context).
   - Re-run to confirm improvement; keep the failing cases as regression tests.

## Rules

- **Evals early**: add them before the agent gets complex; they anchor every later change.
- **Combine deterministic + semantic grading**; deterministic first.
- **Adversarial cases** are mandatory (injection, dangerous tool requests).
- Record **cost/latency** alongside correctness — a correct but expensive agent has a budget problem.
