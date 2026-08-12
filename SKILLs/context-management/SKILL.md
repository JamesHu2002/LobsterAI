---
name: context-management
description: Manage an agent's context window — what to keep, compress, and retrieve. Use when building agent memory/context pipelines or fighting hallucinations from missing/overflowing context.
official: true
metadata:
  short-description: Manage agent context windows
---

# Context Management

## Goal

Give the agent the **right information at the right time** within its context budget, and avoid the drift/hallucination caused by overloaded or missing context.

## Workflow

1. **Audit the context budget**
   - Know the model's context window and what's consumed: system prompt, conversation history, tool outputs, retrieved content.
   - Reserve headroom for the next model response.

2. **Prioritise and order**
   - Put the **most relevant information first** (recency + relevance), then supporting context.
   - Separate distinct concerns with clear delimiters so the model can tell data from instructions.

3. **Compress progressively**
   - Summarise old turns / tool results; keep verbatim only what's likely needed.
   - Use **progressive disclosure**: surface summaries first, expand detail on demand.
   - Drop what's stale or redundant.

4. **Time retrieval correctly**
   - Retrieve only when the task needs external knowledge (don't stuff the prompt with irrelevant docs).
   - For RAG: retrieve → answer → cite; filter untrusted or off-topic chunks.
   - Detect **missing context**: if the agent can't answer responsibly, prefer asking for clarification over guessing.

5. **Make it testable**
   - Log context composition per turn (what was kept/compressed/dropped) for debugging.
   - Verify the agent behaves well under long sessions (compaction paths) and short ones (no irrelevant history).

## Rules

- **Context is a pipeline, not a blob**: curate it actively each turn.
- **Compress, don't truncate silently** — record what was summarised.
- Poor context management is a top cause of **hallucination**; if answers drift, fix the context, not the prompt alone.
- Keep **durable knowledge in memory** (see `memory-design`), not in the prompt.
