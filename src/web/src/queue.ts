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
 * Every outbound message is journaled under `aps-queue-inflight:<requestId>` before
 * its POST starts: a queue drain claims its item and removes it from the queue, while
 * a direct composer send journals a `direct` claim without touching the queue. If the
 * tab dies before the send is accepted, the marker survives and the next mount can
 * prove delivery from the transcript or put the message back at the front of the queue.
 *
 * Storage failures are not fatal. When a read throws, the helper falls back to the
 * copy kept in memory; when a write throws, that copy stays authoritative for this
 * tab until a later write succeeds.
 */

import type { TranscriptMsg } from './types';

const QUEUE_PREFIX = 'aps-queue:';
const INFLIGHT_PREFIX = 'aps-queue-inflight:';
const LOCK_PREFIX = 'aps-queue-lock:';

/** Which send path owns a claim. A legacy record without `kind` is a queue claim. */
export type ClaimKind = 'queue' | 'direct';

/** One outbound message not yet proven accepted by the server. */
export interface QueueClaim {
  id: string;
  text: string;
  claimedAt: number;
  /** Reconciliation path for this claim; missing means `'queue'`. */
  kind?: ClaimKind;
}

const memory = new Map<string, string[]>();
const unsynced = new Set<string>();
const claimsMemory = new Map<string, QueueClaim[]>();
const claimsUnsynced = new Set<string>();
const chains = new Map<string, Promise<unknown>>();
let claimCounter = 0;

function parseQueue(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

function parseClaims(raw: string): QueueClaim[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const claims: QueueClaim[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return null;
      const { id, text, claimedAt, kind } = item as Record<string, unknown>;
      if (typeof id !== 'string' || typeof text !== 'string' || typeof claimedAt !== 'number') {
        return null;
      }
      if (kind !== undefined && kind !== 'queue' && kind !== 'direct') return null;
      const claim: QueueClaim = { id, text, claimedAt };
      if (kind === 'queue' || kind === 'direct') claim.kind = kind;
      claims.push(claim);
    }
    return claims;
  } catch {
    return null;
  }
}

/** Which reconciliation path owns a claim; absent `kind` is a queue claim. */
function claimKind(claim: QueueClaim): ClaimKind {
  return claim.kind === 'direct' ? 'direct' : 'queue';
}

function lockName(key: string): string {
  const id = key.startsWith(QUEUE_PREFIX) ? key.slice(QUEUE_PREFIX.length) : key;
  return `${LOCK_PREFIX}${id}`;
}

/** The in-flight marker key for a queue key. */
export function inflightKey(key: string): string {
  const id = key.startsWith(QUEUE_PREFIX) ? key.slice(QUEUE_PREFIX.length) : key;
  return `${INFLIGHT_PREFIX}${id}`;
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

function discardClaims(key: string): void {
  claimsMemory.delete(key);
  claimsUnsynced.delete(key);
  try {
    window.localStorage.removeItem(inflightKey(key));
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

function readStoredClaims(key: string): QueueClaim[] {
  const markerKey = inflightKey(key);
  if (!claimsUnsynced.has(key)) {
    try {
      const raw = window.localStorage.getItem(markerKey);
      if (raw === null) {
        claimsMemory.delete(key);
        return [];
      }
      const parsed = parseClaims(raw);
      if (parsed !== null) {
        claimsMemory.set(key, parsed);
        return parsed;
      }
      discardClaims(key);
      return [];
    } catch {
      // Fall through to this tab's copy.
    }
  }
  return claimsMemory.get(key) ?? [];
}

function writeClaims(key: string, claims: QueueClaim[]): void {
  claimsMemory.set(key, claims);
  try {
    if (claims.length > 0) {
      window.localStorage.setItem(inflightKey(key), JSON.stringify(claims));
    } else {
      window.localStorage.removeItem(inflightKey(key));
    }
    claimsUnsynced.delete(key);
  } catch {
    // Private mode or a full quota: the claims stay in memory for this tab.
    claimsUnsynced.add(key);
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

/** The claims still in flight for this queue, oldest first. */
export function readClaims(key: string): QueueClaim[] {
  return readStoredClaims(key);
}

/**
 * Remove and return the first queued message, or null when the queue is empty.
 * The read, marker write, shift, and queue write all happen under the per-request
 * lock, so exactly one tab can claim a given message and the marker lands before
 * the message leaves the queue.
 */
export function claimHead(key: string): Promise<QueueClaim | null> {
  return withLock(key, () => {
    const current = readStored(key);
    const [head, ...rest] = current;
    if (head === undefined) return null;
    claimCounter += 1;
    const claimedAt = Date.now();
    const claim: QueueClaim = {
      id: `${claimedAt}-${claimCounter}`,
      text: head,
      claimedAt,
      kind: 'queue',
    };
    writeClaims(key, [...readStoredClaims(key), claim]);
    writeQueue(key, rest);
    return claim;
  });
}

/**
 * Journal a direct composer send before its POST starts and return the claim. The
 * queue is left alone; `settleDirectClaims` reconciles the marker on a later mount.
 */
export function journalDirectClaim(key: string, text: string): Promise<QueueClaim> {
  return withLock(key, () => {
    claimCounter += 1;
    const claimedAt = Date.now();
    const claim: QueueClaim = {
      id: `${claimedAt}-${claimCounter}`,
      text,
      claimedAt,
      kind: 'direct',
    };
    writeClaims(key, [...readStoredClaims(key), claim]);
    return claim;
  });
}

/** Drop one claim after its send was accepted or definitively rejected. */
export function acceptClaim(key: string, claimId: string): Promise<void> {
  return withLock(key, () => {
    const claims = readStoredClaims(key);
    const next = claims.filter((claim) => claim.id !== claimId);
    if (next.length !== claims.length) writeClaims(key, next);
  });
}

/**
 * Move a claim back to the front of the queue in one critical section. The queue
 * write happens first, so a crash between the writes leaves the text in both the
 * queue and the marker; reconciliation drops the marker while the text is at the head.
 */
export function releaseClaim(key: string, claimId: string): Promise<string[]> {
  return withLock(key, () => {
    const claims = readStoredClaims(key);
    const claim = claims.find((entry) => entry.id === claimId);
    const next = claims.filter((entry) => entry.id !== claimId);
    if (!claim) return readStored(key);
    writeQueue(key, [claim.text, ...readStored(key)]);
    writeClaims(key, next);
    return readStored(key);
  });
}

/**
 * Reconcile every queue claim after a snapshot. Claims the transcript already proves
 * delivered are dropped; the rest are prepended in claim order so the normal drain
 * sends them. A claim whose text is still at the queue head never completed its
 * removal, so it is dropped rather than queued twice. Direct-send claims are left in
 * the marker for `settleDirectClaims`. The transcript decision happens under the same
 * lock as the queue write, so a concurrent claim cannot be requeued from a stale read.
 */
export function settleClaims(
  key: string,
  transcript: readonly TranscriptMsg[],
): Promise<string[]> {
  return withLock(key, () => {
    const claims = readStoredClaims(key);
    const queue = readStored(key);
    const queued = claims.filter((claim) => claimKind(claim) === 'queue');
    if (queued.length === 0) return queue;
    const restored: string[] = [];
    for (const claim of queued) {
      if (claimWasDelivered(claim, transcript)) continue;
      if (queue[0] === claim.text) continue;
      restored.push(claim.text);
    }
    const next = restored.length > 0 ? [...restored, ...queue] : queue;
    if (restored.length > 0) writeQueue(key, next);
    writeClaims(key, claims.filter((claim) => claimKind(claim) === 'direct'));
    return next;
  });
}

/**
 * Reconcile direct-send claims after a snapshot, without touching queue claims or the
 * ids in `activeIds` (sends this tab is still POSTing). Proven claims are dropped and
 * the rest are prepended in claim order, except a claim whose text is already at the
 * queue head. Runs under the same lock as the queue write.
 */
export function settleDirectClaims(
  key: string,
  transcript: readonly TranscriptMsg[],
  activeIds: ReadonlySet<string> = new Set<string>(),
): Promise<string[]> {
  return withLock(key, () => {
    const claims = readStoredClaims(key);
    const queue = readStored(key);
    const direct = claims.filter(
      (claim) => claimKind(claim) === 'direct' && !activeIds.has(claim.id),
    );
    if (direct.length === 0) return queue;
    const restored: string[] = [];
    for (const claim of direct) {
      if (claimWasDelivered(claim, transcript)) continue;
      if (queue[0] === claim.text) continue;
      restored.push(claim.text);
    }
    const next = restored.length > 0 ? [...restored, ...queue] : queue;
    if (restored.length > 0) writeQueue(key, next);
    writeClaims(
      key,
      claims.filter((claim) => claimKind(claim) !== 'direct' || activeIds.has(claim.id)),
    );
    return next;
  });
}

/** Whether a persisted transcript entry proves the claim reached the server. */
export function claimWasDelivered(claim: QueueClaim, transcript: readonly TranscriptMsg[]): boolean {
  return transcript.some(
    (entry) =>
      entry.role === 'you' &&
      entry.kind === 'text' &&
      entry.text === claim.text &&
      entry.ts >= claim.claimedAt,
  );
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
    writeClaims(key, []);
    writeQueue(key, []);
    return [];
  });
}
