/**
 * Per-request chat queue storage.
 *
 * The queue lives in `localStorage` so it survives a reload, which also means two
 * tabs can see the same queue. Reading and writing it through these helpers keeps
 * one tab from claiming the same message twice: every mutation runs inside an
 * exclusive Web Lock named `aps-queue-lock:<requestId>`. Browsers without Web Locks
 * (and jsdom) still serialize inside one tab through a promise chain, but lose the
 * cross-tab guarantee; the queue itself is best-effort either way.
 *
 * Storage failures are not fatal. When a read throws, the helper falls back to the
 * copy kept in memory; when a write throws, that copy stays authoritative for this
 * tab until a later write succeeds.
 */

const QUEUE_PREFIX = 'aps-queue:';
const LOCK_PREFIX = 'aps-queue-lock:';

const memory = new Map<string, string[]>();
const unsynced = new Set<string>();
const chains = new Map<string, Promise<unknown>>();

function parseQueue(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

function lockName(key: string): string {
  const id = key.startsWith(QUEUE_PREFIX) ? key.slice(QUEUE_PREFIX.length) : key;
  return `${LOCK_PREFIX}${id}`;
}

/** Serialize queue mutations inside this tab, with or without Web Locks. */
function withInTabLock<T>(key: string, task: () => T | Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = (async () => {
    await previous;
    return await task();
  })();
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return result;
}

function withLock<T>(key: string, task: () => T | Promise<T>): Promise<T> {
  return withInTabLock<T>(key, async () => {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) return await task();
    return await locks.request(lockName(key), { mode: 'exclusive' }, async () => await task());
  });
}

function discardQueue(key: string): void {
  memory.delete(key);
  unsynced.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Private mode: nothing to clean up.
  }
}

function readStored(key: string): string[] {
  if (!unsynced.has(key)) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) {
        memory.delete(key);
        return [];
      }
      const parsed = parseQueue(raw);
      if (parsed !== null) {
        memory.set(key, parsed);
        return parsed;
      }
      discardQueue(key);
      return [];
    } catch {
      // Fall through to this tab's copy.
    }
  }
  return memory.get(key) ?? [];
}

function writeQueue(key: string, queue: string[]): void {
  memory.set(key, queue);
  try {
    if (queue.length > 0) window.localStorage.setItem(key, JSON.stringify(queue));
    else window.localStorage.removeItem(key);
    unsynced.delete(key);
  } catch {
    // Private mode or a full quota: the queue stays in memory for this tab.
    unsynced.add(key);
  }
}

/**
 * The `aps-queue` key is authoritative; the legacy `sbox-queue` key is read once
 * so a queue composed before the rename is not dropped. Adoption copies the raw
 * value into the new key before deleting the legacy one, keeping a re-run of the
 * state initializer (StrictMode, tests) correct. A malformed new key is removed
 * without falling back to the legacy text.
 */
export function readQueue(key: string, legacyKey: string): string[] {
  let raw: string | null | undefined;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    raw = undefined;
  }
  if (raw === undefined) return memory.get(key) ?? [];

  if (raw !== null) {
    discardQueue(legacyKey);
    const parsed = parseQueue(raw);
    if (parsed !== null) {
      memory.set(key, parsed);
      unsynced.delete(key);
      return parsed;
    }
    discardQueue(key);
    return [];
  }

  // A failed write keeps this tab's copy authoritative even when storage reads
  // as empty; otherwise the item would vanish before it could be sent.
  if (unsynced.has(key)) return memory.get(key) ?? [];

  let legacy: string | null;
  try {
    legacy = window.localStorage.getItem(legacyKey);
  } catch {
    return memory.get(key) ?? [];
  }
  if (legacy === null) return [];
  const parsed = parseQueue(legacy) ?? [];
  memory.set(key, parsed);
  try {
    window.localStorage.setItem(key, legacy);
  } catch {
    unsynced.add(key);
    return parsed;
  }
  discardQueue(legacyKey);
  unsynced.delete(key);
  return parsed;
}

/**
 * Remove and return the first queued message, or null when the queue is empty.
 * The read, shift, and write all happen under the per-request lock, so exactly
 * one tab can claim a given message.
 */
export function claimHead(key: string): Promise<string | null> {
  return withLock(key, () => {
    const current = readStored(key);
    const [head, ...rest] = current;
    if (head === undefined) return null;
    writeQueue(key, rest);
    return head;
  });
}

export function enqueueBack(key: string, text: string): Promise<string[]> {
  return withLock(key, () => {
    const next = [...readStored(key), text];
    writeQueue(key, next);
    return next;
  });
}

export function enqueueFront(key: string, text: string): Promise<string[]> {
  return withLock(key, () => {
    const next = [text, ...readStored(key)];
    writeQueue(key, next);
    return next;
  });
}

export function clearQueue(key: string): Promise<string[]> {
  return withLock(key, () => {
    writeQueue(key, []);
    return [];
  });
}
