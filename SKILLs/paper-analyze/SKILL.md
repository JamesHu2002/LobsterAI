---
name: paper-analyze
description: Structurally analyze a paper's full text — background, problem, method, algorithm, model architecture, experiments, results, limitations. Use after fetching a paper, before summarizing it.
official: true
metadata:
  short-description: Structurally analyze a paper
---

# Paper Analyze

## Goal

Turn a paper's full text into a **structured analysis** that captures what matters: the background, the problem, the method, the **algorithm**, the **model structure & design**, and the evidence.

## Output structure

Produce a structured analysis (JSON) with these fields:

- `title` — paper title
- `background` — research context, motivation, prior work it builds on
- `problem` — the problem the paper solves, in one or two sentences
- `method` — high-level approach (e.g. "a transformer trained with contrastive loss")
- `algorithm` — the concrete algorithm(s): steps, data flow, loss functions, key equations (in plain language)
- `model_architecture` — model structure and design: layers, components, dimensions, attention mechanism, training setup (optimizer, schedule, data), any design choices and why
- `experiments` — datasets, baselines, evaluation metrics
- `results` — key quantitative/qualitative findings
- `limitations` — stated limitations and open questions
- `key_terms` — jargon/terms worth defining for a reader

## Workflow

1. **Read the abstract + intro** first to frame the whole paper.
2. **Skim section headings** to locate method/model/algorithm sections.
3. **Extract precisely**: for algorithms and model architecture, read the actual method section (not just the abstract) and paraphrase the mechanism accurately — do not invent details.
4. **Be faithful**: if a design detail is unclear or absent, note it as "not stated" rather than guessing.
5. **Return the structured analysis** in JSON so the summarizer can consume it directly.

## Rules

- **Accuracy over brevity**: the analysis feeds a downstream article, so correctness matters more than compactness.
- **Separate fact from inference**: label anything you inferred as "(inferred)".
- Keep technical detail (layer names, dimensions, losses) that a reader would want — don't over-simplify the model structure.
- Preserve the paper's own terminology; add clarifications in `key_terms`.
