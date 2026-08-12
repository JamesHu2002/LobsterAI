---
name: paper-fetch
description: Fetch and extract the full text of an academic paper (PDF or HTML). Use when downloading a paper, extracting its content, or reading beyond the abstract.
official: true
metadata:
  short-description: Fetch and extract paper full text
---

# Paper Fetch

## Goal

Obtain the **full readable text** of a paper from its link or ID, cleaned and ready for analysis.

## Sources (in priority order)

1. **arXiv HTML (ar5iv)** — `https://ar5iv.labs.arxiv.org/html/{id}` — clean HTML rendering of arXiv papers. Prefer this over PDF when available.
2. **arXiv PDF** — `https://arxiv.org/pdf/{id}` — fetch PDF, then extract text with the `pdf` skill.
3. **Open-access PDF** — use the `openAccessPdf` URL from Semantic Scholar if the paper is not on arXiv.
4. **Publisher page** — only if open-access; never bypass paywalls.

## Workflow

1. **Resolve the source** from the paper's ID/URL (arXiv ID → try ar5iv first, then PDF).
2. **Fetch the content**:
   - HTML: fetch and strip tags/scripts; keep headings and body text.
   - PDF: download, extract text (via the `pdf` skill's extraction tooling).
3. **Clean the text**:
   - Remove headers/footers, page numbers, reference lists (keep a short reference list if the analyzer wants citations).
   - Preserve **section structure** (Abstract, Introduction, Method, Experiments, Conclusion).
   - Truncate to a reasonable length (e.g. keep first ~30–50k chars of body) if very long, noting the truncation.
4. **Return** the cleaned text with a small header: title, authors, arXiv ID, source URL, and the section list detected.

## Rules

- **Respect access**: only fetch open-access content; if a paper is paywalled, say so and suggest the open-access alternative.
- **Don't bypass CAPTCHA/paywalls**; prefer open repositories.
- Preserve section headings so the analyzer can parse structure.
- Note any fetch failure clearly (404, rate limit, no open access) instead of silently returning partial content.
