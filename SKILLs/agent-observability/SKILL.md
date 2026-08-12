---
name: agent-observability
description: Instrument an agent for production — tracing, logging, cost/latency attribution. Use when deploying an agent, debugging a bad turn, or monitoring agent behaviour.
official: true
metadata:
  short-description: Observe agents in production
---

# Agent Observability

## Goal

Make every agent turn **replayable and attributable**: you can answer "which step caused this bad output?", and track cost/latency by component.

## Workflow

1. **Instrument the loop**
   - Log each iteration: reason, tool called, arguments, result/error, tokens, latency.
   - Emit **spans** for the agent turn, each model call, and each tool call (OpenTelemetry GenAI conventions where available).
   - Tag spans with session/run/user IDs for correlation.

2. **Define a span taxonomy**
   - Consistent naming: `agent.run`, `agent.model_call`, `agent.tool.<name>`, `agent.retrieval`.
   - Record outcomes (success/failure, stop reason: final/max_steps/timeout/error).

3. **Track cost & latency**
   - Attribute tokens and wall time to components (prompt build, model, each tool).
   - Alert on anomalies: cost spikes, latency regressions, error-rate jumps, loop-prone sessions.

4. **Support debugging**
   - Store **replayable traces** (inputs, outputs, tool results) so you can re-run a failing turn.
   - Correlate traces with eval failures and user reports.

5. **Make it a gate**
   - Alert thresholds + circuit breakers for degraded components.
   - Use traces to identify the root cause of bad outputs (which span, which context).

## Rules

- **Trace by default**: don't wait for production incidents to add telemetry.
- **Never log secrets** (API keys, tokens, PII) — redact tool args/results.
- Keep trace volume bounded (sampling) without losing the ability to replay a specific failure.
- Tie observability to **eval gates and rollback**: if a change degrades the traced metrics, roll it back.
