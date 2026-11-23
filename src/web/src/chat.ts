import type { ClarifyEvent, TranscriptMsg } from './types';

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatToolPart {
  type: 'tool';
  id: string;
  name: string;
  input: string;
  result?: string;
  error?: boolean;
}

export type ChatPart = ChatTextPart | ChatToolPart;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: ChatPart[];
  createdAt: Date;
}

let counter = 0;

const LEGACY_MCP_PREFIX = 'mcp__harness__';
const MCP_PREFIX = 'mcp__aps__';
const LEGACY_OPENCODE_PREFIX = 'harness_';
const OPENCODE_PREFIX = 'aps_';

/** Rewrites a tool name captured before the MCP identity rename to its canonical `aps` form. */
export function normalizeToolName(name: string): string {
  if (name.startsWith(LEGACY_MCP_PREFIX)) {
    return `${MCP_PREFIX}${name.slice(LEGACY_MCP_PREFIX.length)}`;
  }
  if (name.startsWith(LEGACY_OPENCODE_PREFIX)) {
    return `${OPENCODE_PREFIX}${name.slice(LEGACY_OPENCODE_PREFIX.length)}`;
  }
  return name;
}

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/** Rebuilds chat messages from the persisted transcript, grouping agent output. */
export function fromTranscript(transcript: TranscriptMsg[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of transcript) {
    const createdAt = new Date(entry.ts);
    if (entry.role === 'you') {
      messages.push({
        id: nextId('user'),
        role: 'user',
        parts: [{ type: 'text', text: entry.text }],
        createdAt,
      });
      continue;
    }

    const part: ChatPart =
      entry.kind === 'tool'
        ? {
            type: 'tool',
            id: entry.toolId ?? nextId('tool'),
            name: normalizeToolName(entry.toolName ?? 'tool'),
            input: entry.toolInput ?? '',
            result: entry.toolResult,
            error: entry.toolError,
          }
        : { type: 'text', text: entry.text };

    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') last.parts.push(part);
    else messages.push({ id: nextId('agent'), role: 'assistant', parts: [part], createdAt });
  }
  return messages;
}

export function appendUser(messages: ChatMessage[], text: string): ChatMessage[] {
  return [
    ...messages,
    { id: nextId('user'), role: 'user', parts: [{ type: 'text', text }], createdAt: new Date() },
  ];
}

function appendAgentPart(messages: ChatMessage[], part: ChatPart): ChatMessage[] {
  const next = messages.slice();
  const last = next[next.length - 1];
  if (last && last.role === 'assistant') {
    next[next.length - 1] = { ...last, parts: [...last.parts, part] };
  } else {
    next.push({ id: nextId('agent'), role: 'assistant', parts: [part], createdAt: new Date() });
  }
  return next;
}

function attachToolResult(
  messages: ChatMessage[],
  toolId: string,
  result: string,
  error: boolean,
): ChatMessage[] {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== 'assistant') continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part.type !== 'tool' || part.id !== toolId) continue;
      const parts = message.parts.slice();
      parts[partIndex] = { ...part, result, error };
      const next = messages.slice();
      next[messageIndex] = { ...message, parts };
      return next;
    }
  }
  return messages;
}

/** Folds one NDJSON event into the message list. */
export function applyEvent(messages: ChatMessage[], event: ClarifyEvent): ChatMessage[] {
  switch (event.t) {
    case 'text':
      return appendAgentPart(messages, { type: 'text', text: event.text });
    case 'tool':
      return appendAgentPart(messages, {
        type: 'tool',
        id: event.id,
        name: normalizeToolName(event.name),
        input: event.input,
      });
    case 'tool_result':
      return attachToolResult(messages, event.id, event.text, event.isError);
    case 'error':
      return appendAgentPart(messages, { type: 'text', text: `⚠ ${event.message}` });
    default:
      return messages;
  }
}

/** Extracts plain text from an assistant-ui append message. */
export function textOfParts(parts: readonly { type: string; text?: string }[]): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}
