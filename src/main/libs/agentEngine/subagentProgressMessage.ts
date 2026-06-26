import type { CoworkMessage, CoworkMessageMetadata } from '../../coworkStore';
import type { SubagentProgressSnapshot } from './subagentTracker';

export const SubagentProgressMessageKind = {
  Progress: 'subagent_progress',
} as const;

export const isSubagentProgressText = (content: string): boolean => {
  const text = content.trim();
  if (!text) return false;
  return /\d+\s*\/\s*\d+\s*(?:完成|已完成|已结束)/.test(text)
    || /继续等待.*子\s*agent/.test(text);
};

export const isSubagentProgressMessage = (
  message: CoworkMessage,
  allowTextMatch: boolean,
): boolean => {
  if (message.type !== 'assistant') return false;
  if (message.metadata?.kind === SubagentProgressMessageKind.Progress
      || message.metadata?.subagentProgress === true) {
    return true;
  }
  if (!allowTextMatch || message.metadata?.isStreaming === true) return false;
  return isSubagentProgressText(message.content);
};

export const findSubagentProgressMessage = (
  messages: CoworkMessage[],
  preferLatestTextMatch: boolean,
): CoworkMessage | null => {
  const reversed = [...messages].reverse();
  if (preferLatestTextMatch) {
    return reversed.find((message) => isSubagentProgressMessage(message, true)) ?? null;
  }
  return reversed.find((message) => isSubagentProgressMessage(message, false)) ?? null;
};

export const buildSubagentProgressMetadata = (
  snapshot: SubagentProgressSnapshot,
  existingMetadata?: CoworkMessageMetadata,
): CoworkMessageMetadata => ({
  ...(existingMetadata ?? {}),
  kind: SubagentProgressMessageKind.Progress,
  isStreaming: false,
  isFinal: true,
  subagentProgress: true,
  subagentProgressTotal: snapshot.total,
  subagentProgressDone: snapshot.done,
  subagentProgressError: snapshot.error,
  subagentProgressRunning: snapshot.running,
  subagentProgressUpdatedAt: Date.now(),
});

export const buildSubagentProgressContent = (snapshot: SubagentProgressSnapshot): string => {
  const doneLabels = snapshot.runs
    .filter((run) => run.status === 'done')
    .map(formatSubagentProgressRunLabel);
  const errorLabels = snapshot.runs
    .filter((run) => run.status === 'error')
    .map(formatSubagentProgressRunLabel);
  const formattedDoneLabels = formatSubagentProgressLabels(doneLabels);
  const formattedErrorLabels = formatSubagentProgressLabels(errorLabels);

  if (snapshot.allTerminal && snapshot.error === 0) {
    return `${snapshot.total}/${snapshot.total} 完成 - ${formattedDoneLabels} ✓`;
  }

  if (snapshot.allTerminal) {
    const donePart = snapshot.done > 0 ? `${snapshot.done} 个完成` : '';
    const errorPart = `${snapshot.error} 个出错`;
    const summary = [donePart, errorPart].filter(Boolean).join('，');
    const details = [
      formattedDoneLabels ? `完成：${formattedDoneLabels}` : '',
      formattedErrorLabels ? `出错：${formattedErrorLabels}` : '',
    ].filter(Boolean).join('\n');
    return `${snapshot.terminal}/${snapshot.total} 已结束（${summary}）${details ? `\n\n${details}` : ''}`;
  }

  if (snapshot.error === 0) {
    const doneLine = snapshot.done > 0
      ? `${snapshot.done}/${snapshot.total} 完成 - ${formattedDoneLabels} ✓`
      : `0/${snapshot.total} 完成`;
    return `${doneLine}\n\n继续等待剩余 ${snapshot.running} 个子 agent 完成...`;
  }

  const summary = `${snapshot.terminal}/${snapshot.total} 已结束（${snapshot.done} 个完成，${snapshot.error} 个出错）`;
  const details = [
    formattedDoneLabels ? `完成：${formattedDoneLabels}` : '',
    formattedErrorLabels ? `出错：${formattedErrorLabels}` : '',
  ].filter(Boolean).join('\n');
  return `${summary}${details ? `\n\n${details}` : ''}\n\n继续等待剩余 ${snapshot.running} 个子 agent 完成...`;
};

const formatSubagentProgressRunLabel = (run: SubagentProgressSnapshot['runs'][number]): string => {
  const label = run.label?.trim() || run.agentId?.trim() || run.id.trim();
  return label || run.id.slice(0, 8);
};

const formatSubagentProgressLabels = (labels: string[]): string => {
  if (labels.length <= 5) return labels.join('、');
  return `${labels.slice(0, 5).join('、')} 等 ${labels.length} 个`;
};
