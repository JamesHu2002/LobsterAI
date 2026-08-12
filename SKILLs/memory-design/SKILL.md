---
name: memory-design
description: Design an agent's memory layers — short-term, episodic, long-term — with governance. Use when building agent state/persistence or "does the agent remember across sessions".
official: true
metadata:
  short-description: Design agent memory layers
---

# Memory Design

## Goal

Give an agent the right memory for the task — **intentional, auditable, and safe** — without over-persisting sensitive data.

## Memory tiers

1. **Short-term (session)** — cheap, ephemeral.
   - Conversational continuity within a session; lives in the context window.
   - No persistence guarantees; cleared on session end.

2. **Episodic (task/ticket)** — scoped to one case.
   - Steps taken, decisions, artifacts for a specific task; supports audit and replay.
   - Store as structured run logs, not free text.

3. **Long-term (profile/knowledge)** — highest risk.
   - Persistent user preferences, learned facts, project context.
   - Requires **consent, retention limits, provenance**, and review.
   - Store in an external store (DB, vector index), not the prompt.

## Design decisions

- **What to remember** vs. what to forget (decay/expiry, merge, redaction).
- **Where it lives**: context, session store, DB, vector index.
- **Who can read/write**: scoped access; don't leak one user's memory to another.
- **Provenance**: record source and time for every persisted fact.

## Rules

- **Intentional**: persist only what serves the task; don't hoard data.
- **Auditable**: every write is traceable (who/what/when).
- **Safe**: redact secrets/PII; enforce retention; support deletion.
- **Testable**: verify memory is correctly written, retrieved, and expires.
- Prefer **explicit memory primitives** (structured notes) over "the model just remembers" — see the host framework's memory tooling.
