---
name: tool-calling
description: Design tool interfaces and tool-calling behaviour for agents. Use when defining tools/functions an agent can call, schemas, or tool-error handling.
official: true
metadata:
  short-description: Design agent tool interfaces
---

# Tool Calling

## Goal

Expose capabilities to an agent as **reliable, well-described tools** the model can call with correct arguments.

## Workflow

1. **Define the tool contract**
   - One tool per capability: clear name + purpose.
   - **Strict input schema** (JSON Schema / typed params): names, types, required, enums, formats. Vague descriptions are the #1 cause of wrong tool calls.
   - Declare side effects honestly (e.g. "sends an email") so callers can gate risky actions.

2. **Implement it safely**
   - Validate inputs server-side before executing (never trust the model's args).
   - Return **structured, machine-readable results**: data + success/error, not prose.
   - On error, return a useful error message the model can act on ("file not found: X", "missing required field: Y") so it can retry correctly.

3. **Optimise the call path**
   - Keep tool outputs bounded (truncate/limit) so they fit the context.
   - Run independent calls in parallel where supported.
   - Add retries with backoff for transient failures (network, rate limits).

4. **Expose via a standard**
   - Prefer **MCP (Model Context Protocol)** over bespoke glue for tools/data access (see `mcp-integration`).

## Rules

- **Describe inputs precisely**; the model calls what you describe.
- **Validate before executing**; never trust tool args.
- Make errors **actionable** so the loop can self-correct.
- Keep each tool **single-purpose**; compose complex behaviour from small tools.
- Avoid exposing dangerous tools (shell, write) without approval gates (see `agent-guardrails`).
