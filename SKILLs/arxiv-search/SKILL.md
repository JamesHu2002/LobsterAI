---
name: arxiv-search
description: Search academic papers via the arXiv and Semantic Scholar APIs. Use when the user asks to find papers, research a topic, or collect citations — especially for CS, AI, and ML papers.
official: true
metadata:
  short-description: Search arXiv & Semantic Scholar
---

# Arxiv Search

## Goal

Find relevant papers on a topic and return a **structured, deduplicated list** of paper metadata for downstream analysis.

## Sources

- **arXiv API** — `https://export.arxiv.org/api/query` (Atom XML, free, no key). Best for CS/AI/ML preprints.
  - Query params: `search_query` (fields `all:`, `ti:`, `au:`, `abs:`, `cat:`), `start`, `max_results`, `sortBy=relevance|lastUpdatedDate|submittedDate`.
  - Use `cat:cs.CL` / `cat:cs.LG` / `cat:cs.AI` etc. to scope by category. Combine with `AND` / `OR`.
  - **Rate limit**: ~1 request per 3 seconds. Batch queries; cache results.
  - PDF URL: `https://arxiv.org/pdf/{id}`.
- **Semantic Scholar API** — `https://api.semanticscholar.org/graph/v1/paper/search?query=...&limit=...&fields=...` (free, no key; ~100 req/5min).
  - Request fields: `title,abstract,year,authors,externalIds,openAccessPdf,citationCount,influentialCitationCount`.
  - Great for citation counts, abstracts, and cross-discipline coverage.
- **Google Scholar** (optional supplement) — no official API; only use via browser automation (`playwright`) when the APIs above are insufficient, and respect rate limits.

## Workflow

1. **Clarify the query**: topic, field/category, year range, and how many results (default 5–10).
2. **Query arXiv first** (primary for CS/ML), then Semantic Scholar; deduplicate by arXiv ID / DOI.
3. **Rank by relevance**: score by keyword match, recency, and citation count; filter out clearly off-topic results.
4. **Return** a structured list, each entry:
   - `id` (arXiv ID or DOI), `title`, `authors`, `year`, `abstract` (if available), `pdfUrl`, `citationCount`, `source`.
   - Mark which are open-access / have full text available.

## Rules

- **Respect rate limits**: add delays between requests; cache results (papers rarely change).
- Prefer **open-access** sources (arXiv) over paywalled ones.
- If the user asked for "recent", sort by submittedDate; if "influential", sort by citationCount.
- Never fabricate papers — only report results actually returned by the APIs.
