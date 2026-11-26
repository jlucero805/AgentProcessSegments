import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptClaim,
  claimHead,
  claimWasDelivered,
  clearQueue,
  enqueueBack,
  enqueueFront,
  inflightKey,
  readClaims,
  readQueue,
  releaseClaim,
  settleClaims,
  type QueueClaim,
} from './queue';
import { installFakeLocks, uninstallFakeLocks } from './test/fakeLocks';

let nextId = 0;

function keys(): { key: string; legacyKey: string } {
  nextId += 1;
  return { key: `aps-queue:req-claim-${nextId}`, legacyKey: `sbox-queue:req-claim-${nextId}` };
}

function stored(key: string): string[] | null {
  const raw = window.localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as string[]);
}

function storedClaims(key: string): QueueClaim[] | null {
  const raw = window.localStorage.getItem(inflightKey(key));
  return raw === null ? null : (JSON.parse(raw) as QueueClaim[]);
}

function seedClaims(key: string, claims: QueueClaim[]): void {
  window.localStorage.setItem(inflightKey(key), JSON.stringify(claims));
}

function claim(id: string, text: string, claimedAt = 100): QueueClaim {
  return { id, text, claimedAt };
}

describe('chat queue claim', () => {
  beforeEach(() => {
    installFakeLocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallFakeLocks();
  });

  it('claims the head, journals it, and removes the key when empty', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['first', 'second']));

    const first = await claimHead(key);
    expect(first).toMatchObject({ text: 'first' });
    expect(first?.id).toEqual(expect.any(String));
    expect(first?.claimedAt).toEqual(expect.any(Number));
    expect(stored(key)).toEqual(['second']);
    expect(storedClaims(key)).toEqual([first]);

    const second = await claimHead(key);
    expect(second).toMatchObject({ text: 'second' });
    expect(stored(key)).toBeNull();
    expect(storedClaims(key)).toEqual([first, second]);
    await expect(claimHead(key)).resolves.toBeNull();
  });

  it('writes the in-flight marker before it removes the queue head', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['first', 'second']));
    const calls: string[] = [];
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      name: string,
      value: string,
    ) {
      calls.push(name);
      original.call(this, name, value);
    });

    await claimHead(key);

    expect(calls).toContain(inflightKey(key));
    expect(calls).toContain(key);
    expect(calls.indexOf(inflightKey(key))).toBeLessThan(calls.indexOf(key));
  });

  it('treats a malformed value as an empty queue and removes it', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, 'not-json');

    await expect(claimHead(key)).resolves.toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('hands two concurrent claims different messages', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['a', 'b']));

    const [one, two] = await Promise.all([claimHead(key), claimHead(key)]);

    expect(new Set([one?.text, two?.text])).toEqual(new Set(['a', 'b']));
    expect(stored(key)).toBeNull();
    expect(storedClaims(key)).toHaveLength(2);
  });

  it('does not lose a concurrent append or resurrect a claimed item', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['first']));

    const [claimed, afterAppend] = await Promise.all([
      claimHead(key),
      enqueueBack(key, 'second'),
    ]);

    expect(claimed?.text).toBe('first');
    expect(afterAppend).toContain('second');
    expect(stored(key)).toEqual(['second']);
  });

  it('keeps a front requeue ahead of the remaining queue', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['first']));

    const [claimed, afterRequeue] = await Promise.all([
      claimHead(key),
      enqueueFront(key, 'again'),
    ]);

    expect(claimed?.text).toBe('first');
    expect(afterRequeue).toEqual(['again']);
    expect(stored(key)).toEqual(['again']);
  });

  it('clears every queued message and in-flight claim', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['a', 'b']));
    seedClaims(key, [claim('c1', 'in flight')]);

    await expect(clearQueue(key)).resolves.toEqual([]);
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem(inflightKey(key))).toBeNull();
  });

  it('serializes inside one tab without Web Locks', async () => {
    uninstallFakeLocks();
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['a', 'b']));

    const [one, two] = await Promise.all([claimHead(key), claimHead(key)]);

    expect(new Set([one?.text, two?.text])).toEqual(new Set(['a', 'b']));
  });

  it('keeps a queue usable when a write fails', async () => {
    const { key } = keys();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    await expect(enqueueBack(key, 'kept')).resolves.toEqual(['kept']);
    const claimed = await claimHead(key);
    expect(claimed?.text).toBe('kept');
  });

  it('keeps a queue usable when a read fails', async () => {
    const { key } = keys();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });

    await expect(enqueueBack(key, 'kept')).resolves.toEqual(['kept']);
    const claimed = await claimHead(key);
    expect(claimed?.text).toBe('kept');
  });
});

describe('chat queue in-flight markers', () => {
  beforeEach(() => {
    installFakeLocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallFakeLocks();
  });

  it('drops exactly one accepted claim and leaves the others', async () => {
    const { key } = keys();
    const one = claim('one', 'first');
    const two = claim('two', 'second');
    seedClaims(key, [one, two]);

    await acceptClaim(key, 'one');

    expect(readClaims(key)).toEqual([two]);
  });

  it('releases a claim back to the front in one step', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['rest']));
    seedClaims(key, [claim('one', 'again')]);

    await expect(releaseClaim(key, 'one')).resolves.toEqual(['again', 'rest']);
    expect(stored(key)).toEqual(['again', 'rest']);
    expect(readClaims(key)).toEqual([]);
  });

  it('settles delivered claims and restores the rest in claim order', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['tail']));
    const one = claim('one', 'first');
    const two = claim('two', 'second');
    const three = claim('three', 'third');
    seedClaims(key, [one, two, three]);

    await expect(
      settleClaims(key, [{ role: 'you', kind: 'text', text: 'second', ts: 200 }]),
    ).resolves.toEqual(['first', 'third', 'tail']);
    expect(stored(key)).toEqual(['first', 'third', 'tail']);
    expect(readClaims(key)).toEqual([]);
  });

  it('drops a claim whose queue removal never happened', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['head', 'tail']));
    seedClaims(key, [claim('one', 'head')]);

    await expect(settleClaims(key, [])).resolves.toEqual(['head', 'tail']);
    expect(stored(key)).toEqual(['head', 'tail']);
    expect(readClaims(key)).toEqual([]);
  });

  it('treats a malformed marker as empty and removes it', async () => {
    const { key } = keys();
    window.localStorage.setItem(inflightKey(key), 'not-json');

    expect(readClaims(key)).toEqual([]);
    expect(window.localStorage.getItem(inflightKey(key))).toBeNull();
  });

  it('matches only a later user transcript entry with the same text', () => {
    const delivered = claim('one', 'hello', 200);
    const transcript = [
      { role: 'you' as const, kind: 'text' as const, text: 'hello', ts: 199 },
      { role: 'you' as const, kind: 'text' as const, text: 'hello', ts: 200 },
    ];

    expect(claimWasDelivered(delivered, transcript)).toBe(true);
    expect(claimWasDelivered(delivered, transcript.slice(0, 1))).toBe(false);
    expect(
      claimWasDelivered(delivered, [
        { role: 'agent', kind: 'text', text: 'hello', ts: 300 },
      ]),
    ).toBe(false);
    expect(
      claimWasDelivered(delivered, [{ role: 'you', kind: 'tool', text: 'hello', ts: 300 }]),
    ).toBe(false);
  });

  it('keeps claims usable when marker storage throws', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['kept']));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const claimed = await claimHead(key);
    expect(claimed?.text).toBe('kept');
    await expect(acceptClaim(key, claimed!.id)).resolves.toBeUndefined();
    expect(readClaims(key)).toEqual([]);
  });
});

describe('chat queue hydration', () => {
  it('adopts the legacy key, then drops it', () => {
    const { key, legacyKey } = keys();
    window.localStorage.setItem(legacyKey, JSON.stringify(['carry me']));

    expect(readQueue(key, legacyKey)).toEqual(['carry me']);
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(['carry me']));
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });

  it('removes a malformed new key instead of falling back to legacy', () => {
    const { key, legacyKey } = keys();
    window.localStorage.setItem(key, 'not-json');
    window.localStorage.setItem(legacyKey, JSON.stringify(['stale']));

    expect(readQueue(key, legacyKey)).toEqual([]);
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });
});
