import { describe, expect, it } from 'vitest';
import { TurnParser } from '../src/clarify/stream.js';
import { initLine, line, resultLine, textLine } from './helpers.js';

describe('claude stream-json parser', () => {
  it('maps deltas, tool cards, and tool results into events and an ordered transcript', () => {
    const parser = new TurnParser();

    expect(parser.push(initLine('sess-42'))).toEqual([]);
    expect(parser.sessionId).toBe('sess-42');

    expect(parser.push(textLine('Hello '))).toEqual([{ t: 'text', text: 'Hello ' }]);
    expect(parser.push(textLine('world'))).toEqual([{ t: 'text', text: 'world' }]);

    const toolEvents = parser.push(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } }],
        },
      }),
    );
    expect(toolEvents).toEqual([
      { t: 'tool', id: 't1', name: 'Read', input: JSON.stringify({ file: 'a.ts' }, null, 2) },
    ]);

    const resultEvents = parser.push(
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
        },
      }),
    );
    expect(resultEvents).toEqual([{ t: 'tool_result', id: 't1', text: 'file contents', isError: false }]);

    expect(parser.push(resultLine())).toEqual([]);
    expect(parser.finished).toBe(true);

    const transcript = parser.finalize();
    expect(transcript.map((msg) => [msg.role, msg.kind])).toEqual([
      ['agent', 'text'],
      ['agent', 'tool'],
    ]);
    expect(transcript[0]?.text).toBe('Hello world');
    expect(transcript[1]?.toolName).toBe('Read');
    expect(transcript[1]?.toolResult).toBe('file contents');
  });

  it('does not duplicate assistant text that the deltas already carried', () => {
    const parser = new TurnParser();
    parser.push(textLine('only once'));
    parser.push(
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'only once' }] } }),
    );

    expect(parser.finalize().filter((msg) => msg.kind === 'text')).toHaveLength(1);
  });

  it('falls back to assistant text when the CLI sends no deltas', () => {
    const parser = new TurnParser();
    const events = parser.push(
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole block' }] } }),
    );
    expect(events).toEqual([{ t: 'text', text: 'whole block' }]);
    expect(parser.finalize()[0]?.text).toBe('whole block');
  });

  it('caps oversized tool output in both the event and the transcript', () => {
    const parser = new TurnParser();
    parser.push(
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }),
    );
    const huge = 'x'.repeat(9_000);
    const events = parser.push(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
      }),
    );

    const event = events[0];
    expect(event?.t).toBe('tool_result');
    if (event?.t === 'tool_result') {
      expect(event.text.length).toBeLessThan(huge.length);
      expect(event.text).toContain('truncated');
    }
    expect(parser.finalize().find((msg) => msg.toolId === 't1')?.toolResult).toContain('truncated');
  });

  it('flags errored tool results and errored turns', () => {
    const parser = new TurnParser();
    parser.push(
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }),
    );
    const events = parser.push(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
      }),
    );
    expect(events[0]).toMatchObject({ t: 'tool_result', isError: true });
    expect(parser.finalize().find((msg) => msg.toolId === 't1')?.toolError).toBe(true);

    parser.push(line({ type: 'result', subtype: 'error', is_error: true, result: 'failed' }));
    expect(parser.isError).toBe(true);
    expect(parser.resultText).toBe('failed');
  });

  it('ignores noise without throwing', () => {
    const parser = new TurnParser();
    expect(parser.push('not json')).toEqual([]);
    expect(parser.push('')).toEqual([]);
    expect(parser.push('{}')).toEqual([]);
    expect(parser.push('null')).toEqual([]);
  });

  it('captures usage and reported cost from the result event', () => {
    const parser = new TurnParser();
    parser.push(
      resultLine('done', {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }, 0.0042),
    );

    expect(parser.finished).toBe(true);
    expect(parser.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 0,
      costUsd: 0.0042,
    });
  });

  it('leaves usage null when the result event reports no usage', () => {
    const parser = new TurnParser();
    parser.push(resultLine());
    expect(parser.finished).toBe(true);
    expect(parser.usage).toBeNull();
  });

  it('keeps tokens when a cost is missing and tolerates malformed usage', () => {
    const parser = new TurnParser();
    parser.push(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        usage: { input_tokens: 7, output_tokens: 'bad', cache_read_input_tokens: 3 },
      }),
    );

    expect(parser.usage).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
    });
  });
});
