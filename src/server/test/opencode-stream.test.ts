import { describe, expect, it } from 'vitest';
import { OpencodeTurnParser } from '../src/clarify/harnesses/opencode.js';

const line = (value: unknown) => JSON.stringify(value);

describe('OpenCode stream parser', () => {
  it('maps text parts and captures the session id', () => {
    const parser = new OpencodeTurnParser([]);
    const events = parser.push(
      line({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'hello' } }),
    );

    expect(events).toEqual([{ t: 'text', text: 'hello' }]);
    expect(parser.sessionId).toBe('ses_1');
    expect(parser.transcript).toMatchObject([{ role: 'agent', kind: 'text', text: 'hello' }]);
  });

  it('turns a completed tool event into a tool card plus its result', () => {
    const parser = new OpencodeTurnParser([]);
    const events = parser.push(
      line({
        type: 'tool_use',
        sessionID: 'ses_1',
        part: {
          type: 'tool',
          tool: 'shell',
          callID: 'call-1',
          state: { status: 'completed', input: { command: 'echo x' }, output: 'x\n' },
        },
      }),
    );

    expect(events).toEqual([
      { t: 'tool', id: 'call-1', name: 'shell', input: JSON.stringify({ command: 'echo x' }, null, 2) },
      { t: 'tool_result', id: 'call-1', text: 'x\n', isError: false },
    ]);
    expect(parser.transcript[0]).toMatchObject({
      kind: 'tool',
      toolId: 'call-1',
      toolName: 'shell',
      toolResult: 'x\n',
      toolError: false,
    });
  });

  it('does not repeat tool output when running and completed events both arrive', () => {
    const parser = new OpencodeTurnParser([]);
    const running = parser.push(
      line({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: { status: 'running', input: { command: 'ls' } },
        },
      }),
    );
    expect(running.map((event) => event.t)).toEqual(['tool']);

    const completed = parser.push(
      line({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: { status: 'completed', output: 'a\nb\n' },
        },
      }),
    );
    expect(completed).toEqual([{ t: 'tool_result', id: 'c1', text: 'a\nb\n', isError: false }]);

    const repeated = parser.push(
      line({
        type: 'tool_use',
        part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', output: 'x' } },
      }),
    );
    expect(repeated).toEqual([]);
  });

  it('marks error tool state as an error result', () => {
    const parser = new OpencodeTurnParser([]);
    const events = parser.push(
      line({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'shell',
          callID: 'c2',
          state: { status: 'error', input: {}, error: 'permission denied' },
        },
      }),
    );
    expect(events).toContainEqual({
      t: 'tool_result',
      id: 'c2',
      text: 'permission denied',
      isError: true,
    });
  });

  it('keeps going on tool-calls and finishes on stop', () => {
    const parser = new OpencodeTurnParser([]);
    expect(parser.push(line({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } }))).toEqual([]);
    expect(parser.finished).toBe(false);
    expect(parser.push(line({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }))).toEqual([]);
    expect(parser.finished).toBe(true);
  });

  it('surfaces an error event and finishes', () => {
    const parser = new OpencodeTurnParser([]);
    const events = parser.push(line({ type: 'error', message: 'boom' }));
    expect(events).toEqual([{ t: 'error', message: 'boom' }]);
    expect(parser.finished).toBe(true);
  });

  it('treats an unknown finish reason as an error', () => {
    const parser = new OpencodeTurnParser([]);
    const events = parser.push(line({ type: 'step_finish', part: { reason: 'aborted' } }));
    expect(events).toEqual([{ t: 'error', message: 'agent stopped: aborted' }]);
    expect(parser.finished).toBe(true);
  });

  it('ignores malformed lines and events without a known type', () => {
    const parser = new OpencodeTurnParser([]);
    expect(parser.push('not json')).toEqual([]);
    expect(parser.push(line({ type: 'step_start', part: { type: 'step-start' } }))).toEqual([]);
    expect(parser.finished).toBe(false);
  });

  it('captures usage and cost from a completed step', () => {
    const parser = new OpencodeTurnParser([]);
    parser.push(
      line({
        type: 'step_finish',
        part: {
          type: 'step-finish',
          reason: 'stop',
          cost: 0.0025,
          tokens: {
            input: 40,
            output: 12,
            reasoning: 3,
            cache: { read: 5, write: 2 },
          },
        },
      }),
    );

    expect(parser.finished).toBe(true);
    expect(parser.usage).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
      costUsd: 0.0025,
    });
  });

  it('sums usage across tool and final steps', () => {
    const parser = new OpencodeTurnParser([]);
    parser.push(
      line({
        type: 'step_finish',
        part: {
          reason: 'tool-calls',
          cost: 0.001,
          tokens: { input: 10, output: 5, cache: { read: 1, write: 0 } },
        },
      }),
    );
    expect(parser.finished).toBe(false);

    parser.push(
      line({
        type: 'step_finish',
        part: {
          reason: 'stop',
          cost: 0.002,
          tokens: { input: 20, output: 8, reasoning: 2, cache: { read: 3, write: 4 } },
        },
      }),
    );

    expect(parser.finished).toBe(true);
    expect(parser.usage).toEqual({
      inputTokens: 30,
      outputTokens: 13,
      cacheReadTokens: 4,
      cacheWriteTokens: 4,
      reasoningTokens: 2,
      costUsd: 0.003,
    });
  });

  it('marks cost unknown when any contributing step omits it', () => {
    const parser = new OpencodeTurnParser([]);
    parser.push(
      line({
        type: 'step_finish',
        part: { reason: 'tool-calls', tokens: { input: 10, output: 5 } },
      }),
    );
    parser.push(
      line({
        type: 'step_finish',
        part: { reason: 'stop', cost: 0.002, tokens: { input: 20, output: 8 } },
      }),
    );

    expect(parser.usage).toEqual({
      inputTokens: 30,
      outputTokens: 13,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
    });
  });

  it('ignores usage-less steps and malformed token values', () => {
    const parser = new OpencodeTurnParser([]);
    parser.push(line({ type: 'step_finish', part: { reason: 'tool-calls' } }));
    expect(parser.usage).toBeNull();

    parser.push(
      line({
        type: 'step_finish',
        part: {
          reason: 'stop',
          tokens: { input: 'bad', output: -4, cache: { read: 'bad' } },
        },
      }),
    );
    expect(parser.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
    });
  });
});
