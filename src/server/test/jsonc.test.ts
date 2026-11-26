import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../src/util/jsonc.js';

describe('parseJsonc', () => {
  it('parses line and block comments', () => {
    const parsed = parseJsonc(`{
      // Local tools the user wants in every request.
      "mcp": { /* inline */ "user": { "type": "local" } },
    }`);

    expect(parsed).toEqual({ mcp: { user: { type: 'local' } } });
  });

  it('parses trailing commas in objects and arrays', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": true,},}')).toEqual({
      a: [1, 2],
      b: { c: true },
    });
  });

  it('preserves comment markers and escapes inside strings', () => {
    const parsed = parseJsonc(
      '{"url":"https://example.test/a//b","glob":"/* not a comment */",' +
        '"quote":"a\\"//b","slash":"c:\\\\d"}',
    );

    expect(parsed).toEqual({
      url: 'https://example.test/a//b',
      glob: '/* not a comment */',
      quote: 'a"//b',
      slash: 'c:\\d',
    });
  });

  it('parses CRLF line comments and a comment at end of file', () => {
    expect(parseJsonc('{\r\n // comment\r\n "a": 1 // tail\r\n}')).toEqual({ a: 1 });
    expect(parseJsonc('{"a":1} // done')).toEqual({ a: 1 });
  });

  it('accepts a trailing comma separated from its closer by a comment', () => {
    expect(parseJsonc('[1, /* keep */ ]')).toEqual([1]);
  });

  it('tolerates a leading byte order mark', () => {
    expect(parseJsonc('\uFEFF{"a":1}')).toEqual({ a: 1 });
  });

  it('still parses plain JSON', () => {
    expect(parseJsonc('{"a":[1,2],"b":null}')).toEqual({ a: [1, 2], b: null });
  });

  it('rejects malformed JSONC', () => {
    const cases = [
      '',
      '   ',
      '// only a comment',
      '/* only a comment */',
      '{,}',
      '[,]',
      '[1,,]',
      '{"a":1',
      '"unterminated',
      '/* unterminated',
    ];

    for (const text of cases) {
      expect(() => parseJsonc(text)).toThrow(SyntaxError);
    }
  });

  it('does not accept JSON5', () => {
    for (const text of ['{a: 1}', "{'a': 1}", '[NaN]', '[Infinity]', '[0x10]']) {
      expect(() => parseJsonc(text)).toThrow(SyntaxError);
    }
  });
});
