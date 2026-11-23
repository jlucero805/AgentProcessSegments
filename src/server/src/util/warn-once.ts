const warned = new Set<string>();

/**
 * Emit a console warning once per key for the life of the process.
 *
 * Harness preparation runs on every turn, so warnings about a user config are
 * keyed by the config file: a persistent problem is reported once, not once a
 * turn.
 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}
