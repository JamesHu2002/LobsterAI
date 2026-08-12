---
name: multi-agent-orchestration
description: Design multi-agent systems — supervisor, handoffs, parallel and hierarchical patterns. Use when a task is too big for one agent or benefits from specialised sub-agents.
official: true
metadata:
  short-description: Design multi-agent systems
---

# Multi-Agent Orchestration

## Goal

Decompose complex work across **specialised agents** without adding chaos: clear roles, bounded autonomy, and validated handoffs.

## When to use

- The task spans distinct skill domains (research + code + review).
- A single agent's context/instructions are overloaded.
- Work can run in parallel and be merged.

**Don't** use multi-agent for tasks a single agent or a simple workflow handles fine — more agents = more failure modes and cost.

## Patterns

1. **Supervisor / orchestrator-worker**
   - A coordinator decomposes the goal and routes sub-tasks to specialised workers.
   - Workers are tightly scoped; the supervisor merges results.
   - Good default for heterogeneous tasks.

2. **Handoff**
   - Agents transfer a task to the next specialist with a validated context bundle (what's done, what's needed).
   - Use when a clear sequence of specialists applies (e.g. planner → implementer → reviewer).

3. **Parallel fan-out / fan-in**
   - Run independent workers concurrently, merge outputs.
   - Great for throughput (e.g. parallel code review of multiple files).

4. **Hierarchical / colonies**
   - Nested coordination for very large systems; only when warranted.

## Design rules

- **Tight scope per agent**: one role, one prompt, one toolset — this is what makes sub-agents reliable.
- **Validated handoffs**: pass structured state, not prose; verify the receiving agent has what it needs.
- **Bounded autonomy**: give each agent explicit goals, constraints, and stop conditions (see `agent-loop-design`).
- **Testable composition**: each agent is independently evaluable; the orchestration is a testable workflow (see `agent-evaluation`).

## Deliverable

An orchestration spec: roles, responsibilities, tools, handoff protocol, failure handling (which agent owns a failed step), and the merge logic.
