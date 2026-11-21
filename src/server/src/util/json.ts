/** Narrow an untrusted JSON value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Same as `isRecord`, but returns an empty object instead of null. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
