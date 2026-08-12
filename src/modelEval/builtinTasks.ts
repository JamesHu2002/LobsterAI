/**
 * A curated subset of lm-evaluation-harness built-in tasks/groups.
 * These are defined by lm_eval itself (pulled from HuggingFace on first run);
 * the runner passes their group name directly to `--tasks`, no conversion needed.
 *
 * Note: multiple-choice tasks (mmlu, hellaswag, arc, …) are scored via token
 * logprobs — DeepSeek supports them, but if a model/endpoint does not, prefer
 * generation-style tasks (gsm8k, human_eval, drop, …).
 */
export interface LmEvalBuiltinTask {
  group: string;
  label: string;
  desc: string;
  /** Scored via token logprobs (multiple-choice) rather than generated text. */
  needsLogprobs: boolean;
}

export const LM_EVAL_BUILTIN_TASKS: LmEvalBuiltinTask[] = [
  { group: 'gsm8k', label: 'GSM8K', desc: '小学数学推理（生成式，5-shot）', needsLogprobs: false },
  { group: 'human_eval', label: 'HumanEval', desc: 'Python 代码生成 pass@1', needsLogprobs: false },
  { group: 'drop', label: 'DROP', desc: '英文阅读理解（生成式，F1）', needsLogprobs: false },
  { group: 'lambada_openai', label: 'LAMBADA', desc: '词语预测', needsLogprobs: true },
  { group: 'mmlu', label: 'MMLU', desc: '57 学科多选题', needsLogprobs: true },
  { group: 'hellaswag', label: 'HellaSwag', desc: '常识推理多选', needsLogprobs: true },
  { group: 'arc_challenge', label: 'ARC-Challenge', desc: '科学推理多选', needsLogprobs: true },
  { group: 'winogrande', label: 'WinoGrande', desc: '代词消解多选', needsLogprobs: true },
  { group: 'truthfulqa_mc2', label: 'TruthfulQA', desc: '事实性多选题', needsLogprobs: true },
  { group: 'openbookqa', label: 'OpenBookQA', desc: '开放书问答多选', needsLogprobs: true },
  { group: 'cmmlu', label: 'CMMLU', desc: '中文多学科多选题', needsLogprobs: true },
  { group: 'agieval', label: 'AGIEval', desc: '中文 AGI 推理（多项子任务）', needsLogprobs: true },
];
