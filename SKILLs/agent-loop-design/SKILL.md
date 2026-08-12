---
name: agent-loop-design
description: Design the core agent loop (reason → tool → observe → repeat) correctly. Use when implementing an agent's execution loop, stop conditions, or step limits.
official: true
metadata:
  short-description: Design a safe, correct agent loop
---

# Agent Loop Design

## Goal

Design the agent's execution loop so it **converges**: a clear loop body, bounded iteration, and explicit termination.

## The loop

```
while running:
  model produces next action (reason + optional tool call)
  if no tool call → return the answer; stop
  execute tool → capture result/error
  append tool result to context
  step += 1
  if step >= max_steps or time budget exceeded → stop (report partial)
```

## Key design points

1. **Stop conditions (always, not optional)**
   - Max steps (default conservative, e.g. 10–30), wall-clock/timeout budget, token budget, and a "final answer given" condition.
   - Handle **max steps / timeout** gracefully: return the best partial result with a clear status instead of hanging or silently failing.

2. **Tool result handling**
   - Always feed the **tool result (or error) back** into the model's context.
   - Normalise results: truncate large outputs, strip secrets, mark errors (`error: true`).
   - Let the model **recover from tool errors** (retry with corrected args, or switch tool) — see `systematic-debugging`.

3. **Termination classification**
   - Distinguish `final` (answer given), `max_steps`, `timeout`, `tool_error_loop` (repeated failures), `cancelled`. Make these machine-readable so callers can act.

4. **Concurrency & idempotency**
   - Run independent tool calls in parallel where supported; keep each call idempotent (unique request ids) so retries don't double-execute side effects.

## Rules

- **Bound everything**: steps, time, tokens, tool retries.
- **Never let the model loop forever**: a step cap is non-negotiable.
- Log every iteration (reason, tool, args, result) for replay/debugging.
- Design the loop **outside** the framework you'll later wrap it in; the loop is the product.
