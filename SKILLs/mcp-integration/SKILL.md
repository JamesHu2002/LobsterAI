---
name: mcp-integration
description: Build and integrate agents with Model Context Protocol (MCP) — servers, tools, resources, prompts. Use when connecting an agent to external tools/data via MCP.
official: true
metadata:
  short-description: Build MCP servers and integrations
---

# MCP Integration

## Goal

Expose tools and data to an agent through the **Model Context Protocol** (an open standard) instead of brittle per-app glue code.

## Concepts

- **Server** — provides capabilities (tools, resources, prompts) over the protocol.
- **Tool** — an executable function the model can call (schema + handler).
- **Resource** — data the model can read (files, DB rows, documents).
- **Prompt** — a reusable prompt template the model/client can invoke.
- **Client** — connects the agent (host) to servers.

## Workflow

1. **Decide what to expose**
   - Tools for actions, resources for data, prompts for recurring interactions.
   - Keep the surface minimal: expose only what the agent needs.

2. **Build the server**
   - Use the MCP SDK for your runtime (e.g. `@modelcontextprotocol/sdk`).
   - Define tool schemas precisely (name, description, input/output schema) — see `tool-calling`.
   - Validate inputs; return structured results and actionable errors.

3. **Handle capabilities & lifecycle**
   - Declare supported features (tools/resources/prompts) via capability negotiation.
   - Implement clean init/shutdown, auth (if any), and transport (stdio or HTTP/SSE).
   - Add retries/timeouts for reliability.

4. **Test against a real client**
   - Connect the server to the host agent and exercise each tool/resource.
   - Verify tool outputs round-trip correctly and errors surface properly.

## Rules

- **MCP is the integration layer**: use it for tool/data access; use A2A-style delegation only when coordinating agents.
- **Security**: apply per-tool permissions, validate all inputs, and never expose sensitive tools without gates (see `agent-guardrails`).
- Prefer a small, well-tested server over many ad-hoc tools.
- Keep schemas versioned; changing a tool contract breaks callers.
