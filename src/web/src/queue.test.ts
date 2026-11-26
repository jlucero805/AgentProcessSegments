import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimHead, clearQueue, enqueueBack, enqueueFront, readQueue } from './queue';
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

describe('chat queue claim', () => {
  beforeEach(() => {
    installFakeLocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallFakeLocks();
  });

  it('claims the head, leaves the rest, and removes the key when empty', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['first', 'second']));

    await expect(claimHead(key)).resolves.toBe('first');
    expect(stored(key)).toEqual(['second']);
    await expect(claimHead(key)).resolves.toBe('second');
    expect(window.localStorage.getItem(key)).toBeNull();
    await expect(claimHead(key)).resolves.toBeNull();
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

    expect(new Set([one, two])).toEqual(new Set(['a', 'b']));
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('does not lose a concurrent append or resurrect a claimed item', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['first']));

    const [claimed, afterAppend] = await Promise.all([
      claimHead(key),
      enqueueBack(key, 'second'),
    ]);

    expect(claimed).toBe('first');
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

    expect(claimed).toBe('first');
    expect(afterRequeue).toEqual(['again']);
    expect(stored(key)).toEqual(['again']);
  });

  it('clears every queued message', async () => {
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['a', 'b']));

    await expect(clearQueue(key)).resolves.toEqual([]);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('serializes inside one tab without Web Locks', async () => {
    uninstallFakeLocks();
    const { key } = keys();
    window.localStorage.setItem(key, JSON.stringify(['a', 'b']));

    const [one, two] = await Promise.all([claimHead(key), claimHead(key)]);

    expect(new Set([one, two])).toEqual(new Set(['a', 'b']));
  });

  it('keeps a queue usable when a write fails', async () => {
    const { key } = keys();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    await expect(enqueueBack(key, 'kept')).resolves.toEqual(['kept']);
    await expect(claimHead(key)).resolves.toBe('kept');
  });

  it('keeps a queue usable when a read fails', async () => {
    const { key } = keys();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });

    await expect(enqueueBack(key, 'kept')).resolves.toEqual(['kept']);
    await expect(claimHead(key)).resolves.toBe('kept');
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
