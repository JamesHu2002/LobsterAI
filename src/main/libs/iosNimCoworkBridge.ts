import crypto from 'crypto';

import type { CoworkMessage, CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from './agentEngine/types';
import type { NimMessage } from './ydNimClient';

type SendExtMessage = (text: string, ext: object) => Promise<void>;
type SaveConversationMessages = (taskId: string, messages: NimMessage[]) => Promise<void>;

export interface IosNimCoworkBridgeOptions {
  runtime: CoworkRuntime;
  getCoworkStore: () => CoworkStore;
  getTaskIdForElectronSession: (sessionId: string) => string | undefined;
  sendExtMessage: SendExtMessage;
  saveConversationMessages: SaveConversationMessages;
}

const boundRuntimes = new WeakSet<object>();
const TOOL_PREFIX = '\u25cf';
const MAX_SENT_KEYS = 2000;
const CoworkMessageType = {
  Assistant: 'assistant',
  ToolUse: 'tool_use',
  User: 'user',
} as const;
const IosNimAction = {
  Normal: 'normal',
  NormalFinish: 'normal_finish',
  NormalRight: 'normal_right',
  NormalToolUse: 'normal_tool_use',
} as const;
const NimRole = {
  Assistant: 'assistant',
} as const;

const sentKeys: string[] = [];
const sentKeySet = new Set<string>();

type BridgeTurnState = {
  taskId: string;
  lastUserMessageId?: string;
  turnStartedAt?: number;
  sentAssistantContents: Set<string>;
};

const turnStateBySession = new Map<string, BridgeTurnState>();

const rememberSentKey = (key: string): boolean => {
  if (sentKeySet.has(key)) {
    return false;
  }
  sentKeySet.add(key);
  sentKeys.push(key);
  while (sentKeys.length > MAX_SENT_KEYS) {
    const expired = sentKeys.shift();
    if (expired) {
      sentKeySet.delete(expired);
    }
  }
  return true;
};

const getMessageIdKey = (prefix: string, taskId: string, message: CoworkMessage): string =>
  `${prefix}:${taskId}:${message.id}`;

const getContentHash = (content: string): string =>
  crypto.createHash('sha1').update(content).digest('hex');

const getAssistantSendKey = (
  taskId: string,
  state: BridgeTurnState,
  message: CoworkMessage,
): string =>
  `assistant_send:${taskId}:${state.lastUserMessageId ?? 'no-user'}:${message.id}:${getContentHash(message.content)}`;

const getToolUseKey = (taskId: string, message: CoworkMessage): string => {
  const toolUseId = message.metadata?.toolUseId;
  return `tool_use:${taskId}:${typeof toolUseId === 'string' && toolUseId.trim() ? toolUseId : message.id}`;
};

const findLatestUserMessage = (messages: CoworkMessage[]): CoworkMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === CoworkMessageType.User) {
      return messages[index];
    }
  }
  return undefined;
};

const createTurnState = (taskId: string, userMessage?: CoworkMessage): BridgeTurnState => ({
  taskId,
  lastUserMessageId: userMessage?.id,
  turnStartedAt: userMessage?.timestamp,
  sentAssistantContents: new Set<string>(),
});

const syncCurrentTurnState = (
  store: CoworkStore,
  sessionId: string,
  taskId: string,
): BridgeTurnState => {
  const latestUserMessage = findLatestUserMessage(store.getSession(sessionId)?.messages ?? []);
  const existing = turnStateBySession.get(sessionId);
  if (
    existing
    && existing.taskId === taskId
    && existing.lastUserMessageId === latestUserMessage?.id
  ) {
    return existing;
  }

  const state = createTurnState(taskId, latestUserMessage);
  turnStateBySession.set(sessionId, state);
  return state;
};

const startTurnFromUserMessage = (
  sessionId: string,
  taskId: string,
  message: CoworkMessage,
): BridgeTurnState => {
  const state = createTurnState(taskId, message);
  turnStateBySession.set(sessionId, state);
  return state;
};

const getCurrentTurnMessages = (
  messages: CoworkMessage[],
  state: BridgeTurnState,
): CoworkMessage[] => {
  if (state.lastUserMessageId) {
    const userIndex = messages.findIndex(message => message.id === state.lastUserMessageId);
    if (userIndex >= 0) {
      return messages.slice(userIndex + 1);
    }
  }

  if (typeof state.turnStartedAt === 'number') {
    return messages.filter(message => message.timestamp > state.turnStartedAt!);
  }

  return messages;
};

const getSimpleToolDetail = (toolInput: unknown): string => {
  if (!toolInput || typeof toolInput !== 'object') {
    return '';
  }

  const input = toolInput as Record<string, unknown>;
  const simpleValue = typeof input.command === 'string' ? input.command.trim()
    : typeof input.file_path === 'string' ? input.file_path.trim()
    : typeof input.path === 'string' ? input.path.trim()
    : typeof input.url === 'string' ? input.url.trim()
    : null;

  if (simpleValue) {
    return ` ${simpleValue.length > 120 ? `${simpleValue.slice(0, 120)}...` : simpleValue}`;
  }

  const json = JSON.stringify(toolInput);
  return ` ${json.length > 120 ? `${json.slice(0, 120)}...` : json}`;
};

const getLatestVisibleAssistantMessage = (
  store: CoworkStore,
  sessionId: string,
  state: BridgeTurnState,
): CoworkMessage | undefined =>
  getCurrentTurnMessages(store.getSession(sessionId)?.messages ?? [], state)
    .filter(message => message.type === CoworkMessageType.Assistant && !message.metadata?.isThinking && message.content)
    .at(-1);

const sendUserMessageToIos = (
  options: IosNimCoworkBridgeOptions,
  taskId: string,
  message: CoworkMessage,
): void => {
  if (!rememberSentKey(getMessageIdKey('user', taskId, message))) {
    return;
  }
  options.sendExtMessage(message.content, { action: IosNimAction.NormalRight, taskId })
    .catch(error => console.error('[IosNimBridge] failed to forward the user message to iOS:', error));
};

const flushLatestAssistantText = (
  options: IosNimCoworkBridgeOptions,
  sessionId: string,
  taskId: string,
  state: BridgeTurnState,
): CoworkMessage | undefined => {
  const assistant = getLatestVisibleAssistantMessage(options.getCoworkStore(), sessionId, state);
  if (!assistant?.content) {
    return assistant;
  }

  if (state.sentAssistantContents.has(assistant.content)) {
    return assistant;
  }

  if (!rememberSentKey(getAssistantSendKey(taskId, state, assistant))) {
    state.sentAssistantContents.add(assistant.content);
    return assistant;
  }

  options.sendExtMessage(assistant.content, { action: IosNimAction.Normal, taskId })
    .catch(error => console.error('[IosNimBridge] failed to forward the assistant message to iOS:', error));
  state.sentAssistantContents.add(assistant.content);
  return assistant;
};

const sendToolUseToIos = (
  options: IosNimCoworkBridgeOptions,
  taskId: string,
  message: CoworkMessage,
): void => {
  if (!rememberSentKey(getToolUseKey(taskId, message))) {
    return;
  }

  const toolName = String(message.metadata?.toolName ?? 'unknown');
  const toolDetail = getSimpleToolDetail(message.metadata?.toolInput);
  options.sendExtMessage(`${TOOL_PREFIX} ${toolName}${toolDetail}`, {
    action: IosNimAction.NormalToolUse,
    taskId,
    toolName,
  }).catch(error => console.error('[IosNimBridge] failed to forward the tool message to iOS:', error));
};

const saveAssistantMessageToServer = (
  options: IosNimCoworkBridgeOptions,
  taskId: string,
  assistant: CoworkMessage | undefined,
): void => {
  if (!assistant?.content) {
    return;
  }

  const key = getMessageIdKey('assistant_save', taskId, assistant);
  if (!rememberSentKey(key)) {
    return;
  }

  options.saveConversationMessages(taskId, [{
    messageId: assistant.id,
    role: NimRole.Assistant,
    content: assistant.content,
    timestamp: assistant.timestamp,
  }]).catch(error => console.error('[IosNimBridge] failed to save the assistant message:', error));
};

const sendFinishToIos = (
  options: IosNimCoworkBridgeOptions,
  taskId: string,
  sessionId: string,
  state: BridgeTurnState,
  assistant: CoworkMessage | undefined,
): void => {
  const key = `finish:${taskId}:${state.lastUserMessageId ?? assistant?.id ?? sessionId}`;
  if (!rememberSentKey(key)) {
    return;
  }

  options.sendExtMessage(' ', { action: IosNimAction.NormalFinish, taskId })
    .catch(error => console.error('[IosNimBridge] failed to forward the finish marker to iOS:', error));
};

export const bindIosNimCoworkBridge = (options: IosNimCoworkBridgeOptions): void => {
  if (boundRuntimes.has(options.runtime as object)) {
    return;
  }
  boundRuntimes.add(options.runtime as object);

  options.runtime.on('message', (sessionId, message) => {
    const taskId = options.getTaskIdForElectronSession(sessionId);
    if (!taskId) {
      return;
    }

    if (message.type === CoworkMessageType.User) {
      startTurnFromUserMessage(sessionId, taskId, message);
      sendUserMessageToIos(options, taskId, message);
      return;
    }

    if (message.type === CoworkMessageType.ToolUse) {
      const state = syncCurrentTurnState(options.getCoworkStore(), sessionId, taskId);
      flushLatestAssistantText(options, sessionId, taskId, state);
      sendToolUseToIos(options, taskId, message);
    }
  });

  options.runtime.on('complete', (sessionId) => {
    const taskId = options.getTaskIdForElectronSession(sessionId);
    console.log(`[IosNimBridge] observed cowork completion for session ${sessionId} with ${taskId ? 'an iOS task mapping' : 'no iOS task mapping'}`);
    if (!taskId) {
      return;
    }

    const state = syncCurrentTurnState(options.getCoworkStore(), sessionId, taskId);
    const assistant = flushLatestAssistantText(options, sessionId, taskId, state)
      ?? getLatestVisibleAssistantMessage(options.getCoworkStore(), sessionId, state);

    if (!assistant?.content) {
      console.error(`[IosNimBridge] could not find assistant content after cowork completion for session ${sessionId}`);
    }

    saveAssistantMessageToServer(options, taskId, assistant);
    sendFinishToIos(options, taskId, sessionId, state, assistant);
    turnStateBySession.delete(sessionId);
  });

  options.runtime.on('error', (sessionId) => {
    turnStateBySession.delete(sessionId);
  });

  options.runtime.on('sessionStopped', (sessionId) => {
    turnStateBySession.delete(sessionId);
  });
};
