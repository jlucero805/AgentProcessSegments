import { describe, expect, it } from 'vitest';
import { appendUser, applyEvent, fromTranscript, textOfParts } from './chat';
import type { TranscriptMsg } from './types';

const ts = 1_700_000_000_000;

const transcript: TranscriptMsg[] = [
  { role: 'you', kind: 'text', text: 'Groom it', ts },
  { role: 'agent', kind: 'text', text: 'What about X?', ts: ts + 1 },
  {
    role: 'agent',
    kind: 'tool',
    text: 'Read',
    toolId: 't1',
    toolName: 'Read',
    toolInput: '{"path":"x"}',
    toolResult: 'contents',
    ts: ts + 2,
  },
];

describe('chat transcript helpers', () => {
  it('groups consecutive agent output into one message', () => {
    const messages = fromTranscript(transcript);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Groom it' }] });
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].parts).toEqual([
      { type: 'text', text: 'What about X?' },
      {
        type: 'tool',
        id: 't1',
        name: 'Read',
        input: '{"path":"x"}',
        result: 'contents',
        error: undefined,
      },
    ]);
  });

  it('falls back to a generic tool name for result-only entries', () => {
    const messages = fromTranscript([
      { role: 'agent', kind: 'tool', text: 'tool_result', toolId: 't9', toolResult: 'x', ts },
    ]);
    expect(messages[0].parts[0]).toMatchObject({ type: 'tool', name: 'tool', result: 'x' });
  });

  it('appends a user message without mutating the input', () => {
    const messages = fromTranscript(transcript);
    const next = appendUser(messages, 'Next question');
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Next question' }] });
    expect(messages).toHaveLength(2);
  });

  it('folds text, tool, and tool_result events in order', () => {
    let messages = appendUser([], 'hello');
    messages = applyEvent(messages, { t: 'text', text: 'thinking' });
    messages = applyEvent(messages, { t: 'tool', id: 't1', name: 'Grep', input: '{"q":"x"}' });
    messages = applyEvent(messages, { t: 'tool_result', id: 't1', text: 'found', isError: false });

    expect(messages).toHaveLength(2);
    expect(messages[1].parts).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool', id: 't1', name: 'Grep', input: '{"q":"x"}', result: 'found', error: false },
    ]);
  });

  it('creates a fresh assistant message when the last one is a user message', () => {
    const messages = applyEvent(appendUser([], 'hi'), { t: 'text', text: 'hello' });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] });
  });

  it('renders errors as agent text', () => {
    const messages = applyEvent([], { t: 'error', message: 'boom' });
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', text: '⚠ boom' }],
    });
  });

  it('ignores events it does not render', () => {
    const before = appendUser([], 'hi');
    expect(applyEvent(before, { t: 'done', request: null, transcript: [] })).toBe(before);
  });

  it('extracts text parts from an assistant-ui append message', () => {
    expect(
      textOfParts([
        { type: 'text', text: 'one' },
        { type: 'tool-call' },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\ntwo');
  });
});
