import { describe, expect, it } from 'vitest';
import { jsonParseReason } from '../src/util/json.js';

describe('jsonParseReason', () => {
  it('keeps a position with line and column', () => {
    expect(
      jsonParseReason(
        new SyntaxError(
          "Expected ',' or '}' after property value in JSON at position 62 (line 1 column 63)",
        ),
      ),
    ).toBe('invalid JSON at position 62 (line 1 column 63)');
  });

  it('keeps a position without line and column', () => {
    expect(
      jsonParseReason(new SyntaxError('Unexpected token a in JSON at position 3')),
    ).toBe('invalid JSON at position 3');
  });

  it('never quotes the parser snippet', () => {
    const reason = jsonParseReason(
      new SyntaxError('Unexpected token \'S\', "SUPERSECRET" is not valid JSON'),
    );
    expect(reason).toBe('invalid JSON');
    expect(reason).not.toContain('SUPERSECRET');
  });

  it('ignores position-like text inside a quoted snippet', () => {
    expect(
      jsonParseReason(
        new SyntaxError('Unexpected token \'a\', "text at position 42" is not valid JSON'),
      ),
    ).toBe('invalid JSON');
  });

  it('falls back to a generic reason without a position', () => {
    expect(jsonParseReason(new SyntaxError('Unexpected end of JSON input'))).toBe(
      'invalid JSON',
    );
    expect(jsonParseReason(new SyntaxError(''))).toBe('invalid JSON');
    expect(jsonParseReason('at position 5')).toBe('invalid JSON');
  });
});
