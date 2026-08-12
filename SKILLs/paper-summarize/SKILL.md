---
name: paper-summarize
description: Write a clear, well-structured article summarizing one or more papers from their structured analysis. Use after papers are fetched and analyzed.
official: true
metadata:
  short-description: Write a paper summary article
---

# Paper Summarize

## Goal

Synthesize a paper's structured analysis (see `paper-analyze`) into a **readable article** that covers its background, the algorithms used, and the model structure & design.

## Article structure (for a single paper)

1. **标题与元信息** — title, authors, year, source link.
2. **背景** — why this work matters, the research context and motivation.
3. **问题** — the problem it solves.
4. **方法** — the overall approach.
5. **所用算法** — the concrete algorithm(s), in plain language.
6. **模型结构与设计** — architecture, components, design choices.
7. **实验与结果** — datasets, metrics, key results.
8. **局限与展望** — limitations and open questions.

## For multiple papers (a mini literature review)

- Add a **对比段落** comparing approaches/models/results across papers.
- Group by theme; each paper gets its own section following the structure above.

## Workflow (Generator-Critic)

1. **Draft** — write the article from the structured analysis (not from scratch; reuse the faithful analysis).
2. **Self-review (critic)** — re-read for: missing key info (background/algorithm/model structure), inaccuracy vs. the analysis, and readability.
3. **Revise** — fix gaps and clarity issues. Iterate at most once or twice (diminishing returns).
4. **Deliver** — output Markdown; if the user wants a document, use the `docx` skill to render it.

## Rules

- **Faithful to the analysis**: don't add technical claims beyond what the paper states.
- **Reader-friendly**: define jargon; keep paragraphs short; use headers/bullets.
- **Balanced depth**: model structure/design deserves real detail (it's a stated priority); avoid burying it.
- If the user asked for a specific length or language, follow it.
