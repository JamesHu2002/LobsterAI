import fs from 'fs';
import path from 'path';

import type { BenchmarkTask } from '../../benchmark/types';

const GAIA_UTILS_PY = `import re
from lm_eval.metrics import exact_match, f1_score

def _normalize(s):
    s = (s or "").lower().strip()
    s = s.replace(",", "").replace("，", "").replace("$", " ")
    s = re.sub(r"^(a|an|the)\\s+", "", s)
    s = re.sub(r"[^\\w\\s%.,]", " ", s)
    s = re.sub(r"\\s+", " ", s).strip()
    s = re.sub(r"\\.$", "", s)
    return s

def gaia_score(doc, results):
    cont = results.get("continuation") or []
    cont = cont[0] if isinstance(cont, list) and cont else (cont or "")
    ref = (doc.get("answer") or "")
    refs = [ref]
    preds = [str(cont)]
    em = float(exact_match(preds, refs) or 0.0)
    f1 = float(f1_score(preds, refs) or 0.0)
    exp = _normalize(ref)
    act = _normalize(cont)
    gex = 1.0 if exp and act and exp == act else 0.0
    gc = 1.0 if exp and act and (exp in act or act in exp) else 0.0
    return {"exact_match": em, "f1": f1, "gaia_exact": gex, "gaia_containment": gc}
`;

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Convert parsed benchmark tasks into an lm-evaluation-harness generation task:
 * writes <datasetId>.jsonl + <datasetId>.yaml + utils.py into tasksRoot, and
 * returns the task name (datasetId). Skips tasks without a reference answer.
 */
export function convertTasksToLmEval(
  tasksRoot: string,
  datasetId: string,
  tasks: BenchmarkTask[],
  maxGenToks = 512,
): string {
  const taskDir = path.join(tasksRoot, datasetId);
  fs.mkdirSync(taskDir, { recursive: true });

  const scorable = tasks.filter((t) => t.referenceAnswer && t.referenceAnswer.trim());
  const jsonlPath = path.join(taskDir, `${datasetId}.jsonl`);
  const lines = scorable.map((t) => JSON.stringify({ prompt: t.prompt, answer: t.referenceAnswer }));
  fs.writeFileSync(jsonlPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');

  const yaml = [
    `task: ${datasetId}`,
    'dataset_path: json',
    'dataset_kwargs:',
    `  data_files: "${toPosix(jsonlPath)}"`,
    '  split: train',
    'doc_to_text: "{{prompt}}"',
    'doc_to_target: "{{answer}}"',
    'generation_kwargs:',
    '  until: ["\\n\\n"]',
    `  max_gen_toks: ${maxGenToks}`,
    'metric_list:',
    '  - metric: exact_match',
    '    aggregation: mean',
    '    higher_is_better: true',
    '  - metric: f1',
    '    aggregation: mean',
    '    higher_is_better: true',
    '  - metric: gaia_exact',
    '    aggregation: mean',
    '    higher_is_better: true',
    '  - metric: gaia_containment',
    '    aggregation: mean',
    '    higher_is_better: true',
    'process_results: !function utils.gaia_score',
    'metadata:',
    '  version: 1.0',
  ].join('\n');
  fs.writeFileSync(path.join(taskDir, `${datasetId}.yaml`), `${yaml}\n`, 'utf8');

  const utilsPath = path.join(taskDir, 'utils.py');
  if (!fs.existsSync(utilsPath)) {
    fs.writeFileSync(utilsPath, GAIA_UTILS_PY, 'utf8');
  }

  return datasetId;
}
