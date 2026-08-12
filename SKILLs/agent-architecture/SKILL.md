---
name: agent-architecture
description: Choose the right agent architecture for a task. Use when designing an AI agent system, deciding workflow vs agent, or selecting an orchestration pattern.
official: true
metadata:
  short-description: Choose the right agent architecture
---

# Agent Architecture

## Goal

Pick the **simplest reliable architecture** for an agentic task: a single LLM call, a scripted workflow, or a true agent loop — and the right orchestration pattern.

## Decision

1. **Workflow or agent?**
   - **Workflow** (fixed code path): predictable, repeatable tasks → prompt chains, routing, parallel fan-out, or a state machine/DAG.
   - **Agent** (model directs its own steps): open-ended tasks needing tool use, mid-task discovery, or self-correction → ReAct or plan-and-execute loop.
   - Default to the simplest that works; only make it an agent when the task genuinely needs autonomy.

2. **Choose a pattern** (Anthropic's "Building Effective Agents" taxonomy):
   - **Prompt chaining** — sequential steps, each validating the last.
   - **Routing** — classify input → dispatch to a specialized path.
   - **Parallelization** — fan-out independent work, fan-in results.
   - **Orchestrator-workers** — a coordinator decomposes work and delegates to sub-agents.
   - **Evaluator-optimizer** — a generator + critic loop that refines.
   - **Human-in-the-loop** — approval/escalation gates for risky actions.
   - **Plan-and-execute** — plan first, then execute with periodic replanning.

3. **Apply constraints before scaling**:
   - Bounded toolset, max steps, explicit stop conditions.
   - Deterministic code for anything the LLM shouldn't do probabilistically (math, DB writes).

## Deliverable

A short architecture note: the pattern, the agent's goal and toolset, the loop and stop conditions, the memory/context strategy, and the failure/fallback plan.

## Rules

- **Start as a workflow**; graduate to an agent only when the task needs it.
- Keep the loop **bounded** and **observable** (logs, step cap).
- Prefer fewer, well-scoped agents over one sprawling prompt or a large agent mesh.
