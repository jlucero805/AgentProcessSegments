const warned = new Set<string>();

/**
 * Emit a console warning once per key for the life of the process.
 *
 * Harness preparation runs on every turn, so warnings about a user config are
 * keyed by the config file: a persistent problem is reported once, not once a
 * turn. Returns true only when it emitted, so a caller can gate another
 * one-time side effect (such as an error-log record) on the same key.
 */
export function warnOnce(key: string, message: string): boolean {
  if (warned.has(key)) return false;
  warned.add(key);
  console.warn(message);
  return true;
}
