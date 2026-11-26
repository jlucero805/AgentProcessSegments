/** Narrow an untrusted JSON value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Same as `isRecord`, but returns an empty object instead of null. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * A safe description of a `JSON.parse` failure. V8's parser message can quote
 * the input (`Unexpected token 'a', "…" is not valid JSON`), so copy only the
 * position suffix and build the rest from fixed text.
 */
export function jsonParseReason(error: unknown): string {
  if (!(error instanceof Error)) return 'invalid JSON';
  const match = /at position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(
    error.message.trim(),
  );
  if (!match) return 'invalid JSON';
  const position = match[1]!;
  const line = match[2];
  const column = match[3];
  return line && column
    ? `invalid JSON at position ${position} (line ${line} column ${column})`
    : `invalid JSON at position ${position}`;
}
