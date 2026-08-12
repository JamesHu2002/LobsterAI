---
name: agent-guardrails
description: Add safety guardrails to agents — prompt-injection defense, permission gates, human-in-the-loop, retry bounds. Use when making an agent safe for real use or risky actions.
official: true
metadata:
  short-description: Safe-guard an agent
---

# Agent Guardrails

## Goal

Keep an agent **safe and bounded** in production: it can do useful work but not exceed its authority or loop destructively.

## Layers

1. **Identity & scope**
   - Give the agent a clear identity, allowed toolset, data scope, and access level.
   - **Allow-list tools** by default; deny by default outside the list.

2. **Prompt-injection defense**
   - Treat retrieved/user content as data, not instructions (delimit it; ignore embedded instructions).
   - Filter untrusted retrieval results before they reach the model.
   - Test with adversarial injection cases (see `agent-evaluation`).

3. **Permission gates & HITL**
   - Require **approval** for high-impact actions: spending money, sending messages, deleting data, external API calls.
   - Design **bounded-autonomy contracts**: the agent may do X/Y freely, but Z requires human sign-off.
   - Provide an escalation ladder: auto → notify → block.

4. **Failure & retry bounds**
   - Classify errors: **retriable** (transient — retry with backoff/jitter), **fatal** (stop), **needs-human** (escalate).
   - Cap retries to avoid retry storms; add fallbacks (degraded mode, smaller model, safe refusal).

5. **Audit**
   - Log every tool call, approval, and denial with context (see `agent-observability`).
   - Keep an audit trail that answers "why did the agent do X?".

## Rules

- **Default deny**: least privilege for tools and data.
- **Human approval** for irreversible/expensive/high-risk actions.
- **Bounded everything**: steps, retries, spend, concurrency.
- Align with OWASP LLM Top 10 (injection, sensitive info disclosure, excessive agency, etc.).
- Run a **go/no-go safety checklist** before production: permissions, HITL triggers, eval gates, observability, rollback.
