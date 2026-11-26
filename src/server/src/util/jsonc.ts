/**
 * Parse JSON with comments and trailing commas (JSONC), as OpenCode allows for
 * both `opencode.json` and `opencode.jsonc`.
 *
 * This is JSONC, not JSON5: only comments, trailing commas, and a leading BOM
 * are relaxed. The cleaned text still goes through `JSON.parse`, so every other
 * syntax error is rejected.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(removeComments(text)));
}

const BOM = '\uFEFF';

function removeComments(text: string): string {
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  let out = '';
  let index = 0;

  while (index < source.length) {
    const char = source.charAt(index);
    if (char === '"') {
      const end = stringEnd(source, index);
      out += source.slice(index, end);
      index = end;
      continue;
    }
    if (char === '/' && source.charAt(index + 1) === '/') {
      index += 2;
      while (
        index < source.length &&
        source.charAt(index) !== '\n' &&
        source.charAt(index) !== '\r'
      ) {
        index++;
      }
      out += ' ';
      continue;
    }
    if (char === '/' && source.charAt(index + 1) === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) throw new SyntaxError('unterminated block comment');
      index = end + 2;
      out += ' ';
      continue;
    }
    out += char;
    index++;
  }

  return out;
}

function removeTrailingCommas(text: string): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (next < text.length && isJsonWhitespace(text.charAt(next))) next++;
      const closer = text.charAt(next);
      if ((closer === '}' || closer === ']') && followsValue(out)) {
        index++;
        continue;
      }
    }
    out += char;
    index++;
  }

  return out;
}

/** Index just past the closing quote; an unterminated string returns the end. */
function stringEnd(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index++;
  }
  return source.length;
}

/** A trailing comma is only removable when it follows a value, not `{,}` or `[,]`. */
function followsValue(out: string): boolean {
  let index = out.length - 1;
  while (index >= 0 && isJsonWhitespace(out.charAt(index))) index--;
  if (index < 0) return false;
  const previous = out.charAt(index);
  return previous !== '{' && previous !== '[' && previous !== ',' && previous !== ':';
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}
