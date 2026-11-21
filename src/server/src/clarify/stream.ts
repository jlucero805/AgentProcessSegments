import type { ClarifyEvent, TranscriptMsg } from '../domain/request.js';

const TOOL_RESULT_CAP = 8_000;

function truncate(text: string, cap = TOOL_RESULT_CAP): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n… (${text.length - cap} chars truncated)`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  const content = asRecord(message)['content'];
  if (!Array.isArray(content)) return [];
  return content.map(asRecord);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return typeof record['text'] === 'string' ? record['text'] : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Turns one line of `claude --output-format stream-json` into our NDJSON events
 * while accumulating the ordered transcript. Pure: no process, no disk, so the
 * whole wire contract is testable against fixtures.
 */
export class TurnParser {
  readonly transcript: TranscriptMsg[];
  sessionId: string | null = null;
  finished = false;
  resultText = '';
  isError = false;

  private pendingText = '';
  private sawTextDelta = false;
  private readonly toolIndex = new Map<string, number>();

  constructor(seed: TranscriptMsg[] = []) {
    this.transcript = [...seed];
  }

  push(line: string): ClarifyEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return [];
    }

    const event = asRecord(raw);
    const type = event['type'];

    if (type === 'system') {
      const sessionId = event['session_id'];
      if (typeof sessionId === 'string') this.sessionId = sessionId;
      return [];
    }

    if (type === 'stream_event') {
      const inner = asRecord(event['event']);
      if (inner['type'] !== 'content_block_delta') return [];
      const delta = asRecord(inner['delta']);
      if (delta['type'] !== 'text_delta' || typeof delta['text'] !== 'string') return [];
      this.sawTextDelta = true;
      this.pendingText += delta['text'];
      return [{ t: 'text', text: delta['text'] }];
    }

    if (type === 'assistant') {
      return this.onAssistant(event['message']);
    }

    if (type === 'user') {
      return this.onToolResult(event['message']);
    }

    if (type === 'result') {
      this.finished = true;
      this.isError = event['is_error'] === true || event['subtype'] === 'error';
      this.resultText = typeof event['result'] === 'string' ? event['result'] : '';
      this.flushText();
      return [];
    }

    return [];
  }

  private onAssistant(message: unknown): ClarifyEvent[] {
    const events: ClarifyEvent[] = [];

    for (const block of contentBlocks(message)) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        // With --include-partial-messages the deltas already carried this text.
        if (this.sawTextDelta) continue;
        if (block['text'].trim() === '') continue;
        this.pendingText += block['text'];
        events.push({ t: 'text', text: block['text'] });
        continue;
      }

      if (block['type'] !== 'tool_use') continue;
      const id = typeof block['id'] === 'string' ? block['id'] : `tool_${this.transcript.length}`;
      const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
      const input = JSON.stringify(block['input'] ?? {}, null, 2);

      this.flushText();
      this.toolIndex.set(id, this.transcript.length);
      this.transcript.push({
        role: 'agent',
        kind: 'tool',
        text: name,
        toolId: id,
        toolName: name,
        toolInput: input,
        ts: Date.now(),
      });
      events.push({ t: 'tool', id, name, input });
    }

    return events;
  }

  private onToolResult(message: unknown): ClarifyEvent[] {
    const events: ClarifyEvent[] = [];

    for (const block of contentBlocks(message)) {
      if (block['type'] !== 'tool_result') continue;
      const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '';
      const text = truncate(resultText(block['content']));
      const isError = block['is_error'] === true;

      const index = this.toolIndex.get(id);
      if (index !== undefined) {
        const entry = this.transcript[index];
        if (entry) {
          entry.toolResult = text;
          entry.toolError = isError;
        }
      } else {
        this.transcript.push({
          role: 'agent',
          kind: 'tool',
          text: 'tool_result',
          toolId: id,
          toolResult: text,
          toolError: isError,
          ts: Date.now(),
        });
      }

      events.push({ t: 'tool_result', id, text, isError });
    }

    return events;
  }

  /** Close the open text block so transcript order matches what the user saw. */
  flushText(): void {
    const text = this.pendingText;
    this.pendingText = '';
    if (text.trim() === '') return;
    this.transcript.push({ role: 'agent', kind: 'text', text, ts: Date.now() });
  }

  finalize(): TranscriptMsg[] {
    this.flushText();
    return this.transcript;
  }
}
