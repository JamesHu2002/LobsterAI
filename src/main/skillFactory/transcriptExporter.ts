/**
 * Transcript exporter for the skill-factory "interaction mining" mode.
 *
 * Converts selected real interactions (Cowork sessions / subagent workflow
 * runs / IM conversations) into compact, analyst-friendly transcript files
 * under the run's docs dir, applying hard size caps so the analyst prompt
 * never blows its context window.
 */
import fs from 'fs';
import path from 'path';

import { SkillFactoryDefaults } from '../../skillFactory/constants';
import type { SkillFactorySource, SkillFactoryStartInput } from '../../skillFactory/types';
import type { CoworkStore } from '../coworkStore';
import type { IMStore } from '../im/imStore';
import type { SubagentMessageStore } from '../subagentMessageStore';
import type { SubagentRunStore } from '../subagentRunStore';

interface TranscriptMessageLike {
  type?: string;
  role?: string;
  content?: unknown;
  metadata?: {
    toolName?: string;
    toolInput?: unknown;
    toolResult?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TranscriptExporterDeps {
  getCoworkStore?: () => CoworkStore;
  getSubagentRunStore?: () => SubagentRunStore;
  getSubagentMessageStore?: () => SubagentMessageStore;
  getIMStore?: () => IMStore | null | undefined;
  getOpenClawRuntimeAdapter?: () => {
    fetchSessionByKey: (key: string, opts?: unknown) => Promise<unknown>;
  } | null | undefined;
}

export interface TranscriptExportResult {
  files: string[];
  warnings: string[];
}

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…[truncated]` : text;

function stringifyArgs(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return truncate(input, 300);
  try {
    return truncate(JSON.stringify(input), 300);
  } catch {
    return String(input);
  }
}

/** Normalize heterogeneous message rows (CoworkMessage / SubagentMessage / raw gateway) into a common shape. */
function normalizeMessage(msg: Record<string, unknown>): TranscriptMessageLike {
  const type = (msg.type ?? msg.role ?? '').toString();
  let metadata: TranscriptMessageLike['metadata'];
  const rawMeta = msg.metadata;
  if (typeof rawMeta === 'string' && rawMeta) {
    try {
      metadata = JSON.parse(rawMeta) as TranscriptMessageLike['metadata'];
    } catch {
      metadata = undefined;
    }
  } else if (rawMeta && typeof rawMeta === 'object') {
    metadata = rawMeta as TranscriptMessageLike['metadata'];
  }
  return {
    type,
    content: typeof msg.content === 'string' ? msg.content : undefined,
    ...(metadata ? { metadata } : {}),
  };
}

function formatMessageLine(msg: TranscriptMessageLike): string {
  const type = (msg.type ?? msg.role ?? '').toString();
  const text = typeof msg.content === 'string' ? msg.content : '';
  const meta = msg.metadata ?? {};
  switch (type) {
    case 'user':
      return `USER: ${truncate(text, SkillFactoryDefaults.transcriptMaxCharsPerMessage)}`;
    case 'assistant':
      return `ASSISTANT: ${truncate(text, SkillFactoryDefaults.transcriptMaxCharsPerMessage)}`;
    case 'system':
      return `[SYSTEM] ${truncate(text, SkillFactoryDefaults.transcriptMaxCharsPerMessage)}`;
    case 'tool_use':
      return `[TOOL] ${meta.toolName ?? 'tool'}(${stringifyArgs(meta.toolInput)})`;
    case 'tool_result':
      return `[RESULT] ${truncate(
        typeof meta.toolResult === 'string' ? meta.toolResult : text,
        SkillFactoryDefaults.transcriptMaxCharsPerMessage,
      )}`;
    default:
      return truncate(text, SkillFactoryDefaults.transcriptMaxCharsPerMessage);
  }
}

function formatTranscript(messages: TranscriptMessageLike[]): string {
  const tail = messages.slice(-SkillFactoryDefaults.transcriptMaxMessagesPerSource);
  return tail.map(formatMessageLine).join('\n');
}

/**
 * Export transcripts for the run's selected sources into docsDir.
 * Returns the written transcript file names + non-fatal warnings.
 */
export async function exportTranscripts(
  deps: TranscriptExporterDeps,
  input: SkillFactoryStartInput,
  docsDir: string,
): Promise<TranscriptExportResult> {
  const source: SkillFactorySource = input.source ?? 'manual';
  const refs = Array.isArray(input.sourceRefs) ? input.sourceRefs : [];
  const warnings: string[] = [];
  const files: string[] = [];
  let totalChars = 0;

  if (source === 'manual') {
    return { files, warnings };
  }

  const sourceLabels: Record<SkillFactorySource, string> = {
    manual: '手写需求',
    sessions: 'Cowork 会话',
    runs: 'Agent 工作流',
    im: 'IM 对话',
  };

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    if (totalChars >= SkillFactoryDefaults.transcriptMaxCharsPerRun) {
      warnings.push(`已达转录总字数上限，跳过剩余 ${refs.length - i} 个样本`);
      break;
    }

    let messages: TranscriptMessageLike[] = [];
    let title = '';
    try {
      ({ messages, title } = await fetchSourceMessages(deps, source, ref));
    } catch (error) {
      warnings.push(`样本 ${ref} 读取失败：${error instanceof Error ? error.message : String(error)}`);
      messages = [];
    }

    const header = [
      `# 交互样本 ${i + 1} — ${sourceLabels[source]}`,
      `来源: ${source} | ref: ${ref}${title ? ` | title: ${title}` : ''}`,
      '---',
    ].join('\n');

    let body = formatTranscript(messages);
    if (body.trim().length === 0) {
      body = '[EMPTY] 该样本没有可用的交互消息';
      warnings.push(`样本 ${ref} 无可用消息（可能未持久化）`);
    }

    // Cap per-file + per-run.
    body = truncate(body, SkillFactoryDefaults.transcriptMaxCharsPerFile - header.length - 2);
    totalChars += header.length + body.length;

    const fileName = `transcript-${i + 1}.md`;
    fs.writeFileSync(path.join(docsDir, fileName), `${header}\n\n${body}\n`, 'utf8');
    files.push(fileName);
  }

  // Write the SOURCE.md marker for the coordinator / detail view.
  const sourceMeta = [
    '# 输入来源',
    `source: ${source}`,
    `refs: ${refs.join(', ') || '(none)'}`,
    `transcript files: ${files.join(', ') || '(none)'}`,
    warnings.length > 0 ? `warnings:\n${warnings.map((w) => `- ${w}`).join('\n')}` : 'warnings: none',
  ].join('\n');
  fs.writeFileSync(path.join(docsDir, 'SOURCE.md'), `${sourceMeta}\n`, 'utf8');

  return { files, warnings };
}

async function fetchSourceMessages(
  deps: TranscriptExporterDeps,
  source: SkillFactorySource,
  ref: string,
): Promise<{ messages: TranscriptMessageLike[]; title: string }> {
  if (source === 'sessions') {
    const store = deps.getCoworkStore?.();
    if (!store) return { messages: [], title: '' };
    const session = store.getSession(ref, 0);
    const title = session?.title ?? '';
    const count = store.countSessionMessages(ref);
    const rows = store.getPagedSessionMessages(ref, Math.max(count, 1), 0);
    return { messages: rows.map((m) => normalizeMessage(m as unknown as Record<string, unknown>)), title };
  }

  if (source === 'runs') {
    const store = deps.getSubagentMessageStore?.();
    if (!store) return { messages: [], title: '' };
    const runStore = deps.getSubagentRunStore?.();
    let title = '';
    if (runStore) {
      const run = runStore.getSubagentRun(ref);
      title = run?.label ?? run?.task ?? '';
    }
    const rows = store.getMessages(ref);
    return { messages: rows.map((m) => normalizeMessage(m as unknown as Record<string, unknown>)), title };
  }

  // source === 'im'
  const imStore = deps.getIMStore?.();
  if (!imStore) return { messages: [], title: '' };
  const [conversationId, platform = ''] = ref.includes(':') ? ref.split(':') : [ref, ''];
  const mapping = platform ? imStore.getSessionMapping(conversationId, platform as never) : null;
  if (!mapping) return { messages: [], title: conversationId };

  // Prefer the locally-synced cowork transcript (no gateway needed).
  if (mapping.coworkSessionId) {
    const store = deps.getCoworkStore?.();
    if (store) {
      const session = store.getSession(mapping.coworkSessionId, 0);
      const count = store.countSessionMessages(mapping.coworkSessionId);
      const rows = store.getPagedSessionMessages(mapping.coworkSessionId, Math.max(count, 1), 0);
      return {
        messages: rows.map((m) => normalizeMessage(m as unknown as Record<string, unknown>)),
        title: session?.title ?? mapping.imConversationId,
      };
    }
  }

  // Fallback: fetch via the gateway session key.
  if (mapping.openClawSessionKey) {
    const adapter = deps.getOpenClawRuntimeAdapter?.();
    if (adapter) {
      const result = (await adapter.fetchSessionByKey(mapping.openClawSessionKey)) as
        | { messages?: unknown[]; title?: string }
        | null
        | undefined;
      const messages = Array.isArray(result?.messages)
        ? result.messages.map((m) => normalizeMessage(m as Record<string, unknown>))
        : [];
      return { messages, title: result?.title ?? mapping.imConversationId };
    }
  }

  return { messages: [], title: mapping.imConversationId };
}
