import { describe, expect, test } from 'vitest';

import { PRESET_AGENTS } from '../presetAgents';

function preset(id: string) {
  const p = PRESET_AGENTS.find((agent) => agent.id === id);
  if (!p) throw new Error(`preset agent ${id} not found`);
  return p;
}

describe('skill-factory agent prompts', () => {
  test('coordinator enforces delegation, eval file output and NEEDS_INPUT', () => {
    const c = preset('skill-coordinator');
    expect(c.systemPrompt).toContain('sessions_spawn');
    expect(c.systemPrompt).toContain('skill-requirements-analyst');
    expect(c.systemPrompt).toContain('skill-content-maker');
    expect(c.systemPrompt).toContain('skill-evaluator');
    expect(c.systemPrompt).toContain('eval_report.json');
    expect(c.systemPrompt).toContain('final_summary.md');
    expect(c.systemPrompt).toContain('NEEDS_INPUT');
  });

  test('requirements analyst never guesses — returns questions on ambiguity', () => {
    const a = preset('skill-requirements-analyst');
    expect(a.systemPrompt).toContain('不要臆测');
    expect(a.systemPromptEn.toLowerCase()).toContain('do not guess');
    expect(a.systemPrompt + a.systemPromptEn).toContain('questions');
  });

  test('analyst + coordinator support interaction mining mode', () => {
    const a = preset('skill-requirements-analyst');
    const c = preset('skill-coordinator');
    // analyst: mining mode mentions transcripts and source
    expect(a.systemPrompt).toContain('交互挖掘模式');
    expect(a.systemPrompt).toContain('transcript');
    expect(a.systemPromptEn).toContain('Interaction Mining Mode');
    // coordinator: forwards the source type to the analyst
    expect(c.systemPrompt).toContain('输入来源');
    expect(c.systemPromptEn.toLowerCase()).toContain('source');
  });

  test('content-maker must use the skill-creator skill', () => {
    const m = preset('skill-content-maker');
    expect(m.skillIds).toContain('skill-creator');
    expect(m.skillIds).toContain('skill-vetter');
    expect(m.systemPrompt).toContain('quick_validate');
    expect(m.systemPrompt).toContain('SKILL.md');
  });

  test('evaluator emits strict JSON with decision/loopback', () => {
    const e = preset('skill-evaluator');
    expect(e.systemPrompt).toContain('"decision"');
    expect(e.systemPrompt).toContain('loopback');
    expect(e.skillIds).toContain('skill-vetter');
  });
});
