import { EvalToolset, BenchmarkMatchMethod } from '../../benchmark/constants';
import type {
  BenchmarkMatch,
  BenchmarkTask,
  TaskMetrics,
} from '../../benchmark/types';
import { getModelPrice } from './pricing';

// ─── Raw history message shape (OpenClaw chat.history) ───────────────────────
export interface RawHistoryMessage {
  role?: string;
  type?: string;
  content?: unknown;
  usage?: Record<string, unknown>;
  name?: string;
  arguments?: unknown;
  rawArguments?: unknown;
  error?: unknown;
  toolUseId?: string;
  tool_use_id?: string;
  index?: unknown;
}

interface ToolCallEntry {
  name: string;
  args: unknown;
  rawArgs: unknown;
}

interface ToolResultEntry {
  index: number;
  error: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMsgRole(msg: RawHistoryMessage): string {
  return typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
}

function getMsgType(msg: RawHistoryMessage): string {
  return typeof msg.type === 'string' ? msg.type.toLowerCase() : '';
}

/** Extract tool calls in chronological order (nested blocks or standalone). */
function extractToolCalls(messages: RawHistoryMessage[]): ToolCallEntry[] {
  const calls: ToolCallEntry[] = [];
  for (const msg of messages) {
    const role = getMsgRole(msg);
    const type = getMsgType(msg);
    if (role === 'assistant' || type === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as unknown[]) {
          if (isRecord(block) && block.type === 'toolCall') {
            calls.push({
              name: typeof block.name === 'string' ? block.name : '',
              args: block.arguments ?? null,
              rawArgs: block.arguments ?? null,
            });
          }
        }
      }
    } else if (type === 'tool_use' || role === 'tool_use') {
      calls.push({
        name: typeof msg.name === 'string' ? msg.name : '',
        args: msg.arguments ?? msg.rawArguments ?? null,
        rawArgs: msg.arguments ?? msg.rawArguments ?? null,
      });
    }
  }
  return calls;
}

/** Extract tool results with error flags, in chronological order. */
function extractToolResults(messages: RawHistoryMessage[]): ToolResultEntry[] {
  const results: ToolResultEntry[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const role = getMsgRole(msg);
    const type = getMsgType(msg);
    if (type === 'tool_result' || role === 'tool_result' || role === 'toolresult') {
      const errorFlag = msg.error;
      const error = errorFlag === true
        || (typeof errorFlag === 'string' && errorFlag.length > 0)
        || (isRecord(errorFlag) && Object.keys(errorFlag).length > 0);
      results.push({ index: i, error });
    }
  }
  return results;
}

/** Assistant "steps": rounds that triggered at least one tool call. */
function countSteps(messages: RawHistoryMessage[]): number {
  let steps = 0;
  let previousWasToolUse = false;
  for (const msg of messages) {
    const role = getMsgRole(msg);
    const type = getMsgType(msg);
    const isToolUse = type === 'tool_use' || role === 'tool_use';
    if (isToolUse) {
      if (!previousWasToolUse) {
        steps += 1;
      }
      previousWasToolUse = true;
      continue;
    }
    if (role === 'assistant' || type === 'assistant') {
      if (Array.isArray(msg.content) && msg.content.some((b) => isRecord(b) && b.type === 'toolCall')) {
        steps += 1;
      }
    }
    previousWasToolUse = false;
  }
  return steps;
}

/** Minimal argument schema check: args must parse to a non-empty object or string. */
function argsValid(rawArgs: unknown): boolean {
  if (rawArgs == null) return false;
  if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return Object.keys(rawArgs).length > 0;
  }
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return false;
    // JSON-like strings must parse to a non-empty value; otherwise treat the
    // string as a free-text argument (e.g. python code / bash) and accept it.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isRecord(parsed)) return Object.keys(parsed).length > 0;
        return Boolean(parsed);
      } catch {
        return false;
      }
    }
    return true;
  }
  return true;
}

function sumUsage(messages: RawHistoryMessage[]): {
  input: number; output: number; cacheRead: number; cacheWrite: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const msg of messages) {
    if (!isRecord(msg.usage)) continue;
    const u = msg.usage;
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    input += num(u.input) + num(u.inputTokens);
    output += num(u.output) + num(u.outputTokens);
    cacheRead += num(u.cacheRead) + num(u.cacheReadTokens) + num(u.cache_read_input_tokens);
    cacheWrite += num(u.cacheWrite) + num(u.cacheWriteTokens);
  }
  return { input, output, cacheRead, cacheWrite };
}

/** Extract the final assistant text (concatenated, last non-empty). */
export function extractFinalAssistantText(messages: RawHistoryMessage[]): string {
  let collected: string[] = [];
  for (const msg of messages) {
    const role = getMsgRole(msg);
    const type = getMsgType(msg);
    if (role !== 'assistant' && type !== 'assistant') continue;
    const parts: string[] = [];
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (isRecord(block)) {
          if (typeof block.text === 'string') parts.push(block.text);
          else if (block.type === 'text' && typeof block.content === 'string') parts.push(block.content);
        }
      }
    }
    if (parts.join('').trim()) {
      collected = parts;
    }
  }
  return collected.join('\n').trim();
}

// ─── Main metrics computation ────────────────────────────────────────────────
export function computeTaskMetrics(
  historyMessages: RawHistoryMessage[],
  modelRef: string,
  executionTimeMs: number,
): TaskMetrics {
  const toolCalls = extractToolCalls(historyMessages);
  const toolResults = extractToolResults(historyMessages);
  const usage = sumUsage(historyMessages);

  const toolCallCount = toolCalls.length;
  const toolCallNames: Record<string, number> = {};
  for (const c of toolCalls) {
    toolCallNames[c.name] = (toolCallNames[c.name] ?? 0) + 1;
  }

  const invalidToolCalls = toolResults.filter((r) => r.error).length;
  const invalidCallRate = toolCallCount > 0 ? invalidToolCalls / toolCallCount : 0;

  const toolset = new Set<string>(EvalToolset);
  let inToolset = 0;
  let paramValid = 0;
  for (const c of toolCalls) {
    if (toolset.has(c.name)) inToolset += 1;
    if (argsValid(c.rawArgs)) paramValid += 1;
  }
  const toolSelectionAccuracy = toolCallCount > 0 ? inToolset / toolCallCount : null;
  const paramAccuracy = toolCallCount > 0 ? paramValid / toolCallCount : null;

  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const price = getModelPrice(modelRef);
  const estimatedCostUsd = (
    usage.input * price.in
    + usage.output * price.out
    + usage.cacheRead * price.read
    + usage.cacheWrite * price.write
  ) / 1_000_000;

  // Recoverability: after an errored tool_result, does the model keep going?
  const errorResultIdx = toolResults.filter((r) => r.error).map((r) => r.index);
  let recovered = 0;
  if (errorResultIdx.length > 0) {
    for (const errIdx of errorResultIdx) {
      let stepRecovered = false;
      for (let i = errIdx + 1; i < historyMessages.length; i += 1) {
        const role = getMsgRole(historyMessages[i]);
        const type = getMsgType(historyMessages[i]);
        const isToolUse = type === 'tool_use' || role === 'tool_use';
        if (isToolUse) {
          stepRecovered = true;
          break;
        }
        const msgContent = historyMessages[i].content;
        if ((role === 'assistant' || type === 'assistant') && Array.isArray(msgContent)) {
          const hasText = msgContent.some((b) => isRecord(b) && (typeof b.text === 'string' ? b.text.trim() : false));
          if (hasText) {
            stepRecovered = true;
            break;
          }
        }
      }
      if (stepRecovered) recovered += 1;
    }
  }
  const recoverability = errorResultIdx.length === 0 ? 1 : recovered / errorResultIdx.length;

  return {
    steps: countSteps(historyMessages),
    toolCallCount,
    toolCallNames,
    invalidToolCalls,
    invalidCallRate,
    toolSelectionAccuracy,
    paramAccuracy,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens,
    estimatedCostUsd,
    executionTimeMs,
    recoverability,
  };
}

// ─── GAIA answer normalisation & matching ────────────────────────────────────
export function normalizeGaiaAnswer(input: string): string {
  let s = input.toLowerCase().trim();
  // strip $ and thousands separators for numeric answers
  s = s.replace(/[,，]/g, '').replace(/\$/g, ' ');
  // strip leading articles
  s = s.replace(/^(a|an|the)\s+/g, '');
  // remove punctuation but keep alphanumerics, %, ., and internal space
  s = s.replace(/[^\w\s%.,]/g, ' ');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // strip trailing period
  s = s.replace(/\.$/, '');
  return s;
}

export function matchAnswer(task: BenchmarkTask, finalText: string): BenchmarkMatch {
  const expectedRaw = task.referenceAnswer ?? '';
  const actualRaw = finalText.trim();
  if (!expectedRaw.trim()) {
    return { method: BenchmarkMatchMethod.None, expected: expectedRaw, actual: actualRaw, passed: false };
  }
  const expected = normalizeGaiaAnswer(expectedRaw);
  const actual = normalizeGaiaAnswer(actualRaw);
  if (!expected || !actual) {
    return { method: BenchmarkMatchMethod.None, expected: expectedRaw, actual: actualRaw, passed: false };
  }
  if (expected === actual) {
    return { method: BenchmarkMatchMethod.GaiaNormalized, expected: expectedRaw, actual: actualRaw, passed: true };
  }
  if (actual.includes(expected) || expected.includes(actual)) {
    return { method: BenchmarkMatchMethod.NormalizedContainment, expected: expectedRaw, actual: actualRaw, passed: true };
  }
  return { method: BenchmarkMatchMethod.NormalizedContainment, expected: expectedRaw, actual: actualRaw, passed: false };
}
