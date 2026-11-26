import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import {
  defaultProcess,
  processSchema,
  READY_FOR_IMPLEMENTATION,
} from '../src/process/defaults.js';
import {
  SEGMENT_IDS,
  SEGMENT_STATES,
  isSchedulableSegment,
  type ProcessConfig,
} from '../src/process/definition.js';
import { parseFollowUps } from '../src/process/follow-ups.js';
import { ProcessStore } from '../src/process/store.js';

function tempFile(name = 'process.json'): string {
  return path.join(tmpDir('process'), name);
}

function segmentBy(config: ProcessConfig, id: string) {
  const segment = config.segments.find((item) => item.id === id);
  if (!segment) throw new Error(`missing segment ${id}`);
  return segment;
}

/** Names of preserved copies for `file`, oldest first. */
function backupNames(file: string): string[] {
  const prefix = `${path.basename(file)}.invalid-`;
  return readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(prefix))
    .sort();
}

function backupFile(file: string, name: string): string {
  return path.join(path.dirname(file), name);
}

describe('process definition', () => {
  it('defaults to the conservative implement-only loop', () => {
    const config = defaultProcess(DEFAULT_SETTINGS.master);
    expect(config.segments.map((segment) => segment.id)).toEqual([...SEGMENT_IDS]);
    expect(config.segments.filter((segment) => segment.enabled).map((segment) => segment.id)).toEqual([
      'implement',
    ]);
    expect(segmentBy(config, 'implement')).toMatchObject({
      idleMinutes: DEFAULT_SETTINGS.master.idleMinutes,
      prompt: DEFAULT_SETTINGS.master.prompt,
      readyMarker: 'READY FOR REVIEW',
      advanceTo: 'review',
    });
    expect(processSchema.parse(config)).toEqual(config);
  });

  it('rejects duplicate ids, illegal advances, and missing markers', () => {
    const duplicate = defaultProcess(DEFAULT_SETTINGS.master);
    duplicate.segments[1] = { ...duplicate.segments[1]!, id: 'intake' };
    expect(processSchema.safeParse(duplicate).success).toBe(false);

    const illegal = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(illegal, 'plan').advanceTo = 'review';
    expect(processSchema.safeParse(illegal).success).toBe(false);

    const unmarked = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(unmarked, 'plan').readyMarker = null;
    expect(processSchema.safeParse(unmarked).success).toBe(false);

    const finalize = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(finalize, 'finalize').advanceTo = 'done';
    expect(processSchema.safeParse(finalize).success).toBe(false);
  });

  it('keeps an enabled finalize segment loadable but treats it as manual', () => {
    const config = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(config, 'finalize').enabled = true;
    expect(processSchema.parse(config)).toEqual(config);
    expect(isSchedulableSegment('finalize')).toBe(false);
    expect(isSchedulableSegment('implement')).toBe(true);

    const file = tempFile();
    writeFileSync(file, JSON.stringify(config));
    const loaded = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master)).get();
    expect(segmentBy(loaded, 'finalize').enabled).toBe(true);
  });

  it('maps every segment to its request state', () => {
    expect(SEGMENT_STATES).toEqual({
      intake: 'clarify',
      plan: 'clarify',
      implement: 'dispatch',
      review: 'review',
      merge: 'merge',
      finalize: 'finalize',
    });
    expect(READY_FOR_IMPLEMENTATION).toBe('READY FOR IMPLEMENTATION');
  });
});

describe('ProcessStore', () => {
  it('returns the fallback until a file is saved', () => {
    const file = tempFile();
    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));
    expect(() => readFileSync(file)).toThrow();
  });

  it('writes atomically, reloads, and notifies listeners', () => {
    const file = tempFile();
    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    const seen: ProcessConfig[] = [];
    store.onChange((process) => seen.push(process));

    const next = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(next, 'intake').enabled = true;
    const saved = store.patch({ segments: next.segments });

    expect(segmentBy(saved, 'intake').enabled).toBe(true);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).segments).toHaveLength(6);
    expect(segmentBy(new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master)).get(), 'intake').enabled).toBe(true);
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      chmodSync(file, 0o644);
      const repaired = defaultProcess(DEFAULT_SETTINGS.master);
      segmentBy(repaired, 'intake').enabled = false;
      store.patch({ segments: repaired.segments });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const reread = JSON.parse(readFileSync(file, 'utf8')) as ProcessConfig;
      expect(segmentBy(reread, 'intake').enabled).toBe(false);
    }
  });

  it('upgrades an old five-segment process by adding Merge and concurrency', () => {
    const file = tempFile();
    const old = defaultProcess(DEFAULT_SETTINGS.master);
    old.segments = old.segments.filter((segment) => segment.id !== 'merge');
    for (const segment of old.segments) {
      delete (segment as unknown as Record<string, unknown>)['maxConcurrent'];
    }
    writeFileSync(file, JSON.stringify(old));

    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    const loaded = store.get();
    expect(loaded.segments.map((segment) => segment.id)).toEqual([...SEGMENT_IDS]);
    expect(segmentBy(loaded, 'merge')).toMatchObject({ enabled: false, maxConcurrent: 1 });
    expect(segmentBy(loaded, 'implement')).toMatchObject({ maxConcurrent: null });
    expect(segmentBy(loaded, 'implement').prompt).toContain('cell master');
  });

  it('falls back for an invalid file and rejects invalid patches', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 1, segments: [] }));
    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));

    expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));
    expect(warn).toHaveBeenCalled();
    expect(() => store.patch({ segments: [] })).toThrow();
    warn.mockRestore();
  });

  it('preserves a malformed file before the first save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    const original = '{not json\n';
    writeFileSync(file, original);

    const errors = { error: vi.fn() };
    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master), errors);
    expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));
    expect(backupNames(file)).toEqual([]);

    const next = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(next, 'intake').enabled = true;
    store.patch({ segments: next.segments });

    const names = backupNames(file);
    expect(names).toHaveLength(1);
    const backup = backupFile(file, names[0]!);
    expect(readFileSync(backup, 'utf8')).toBe(original);
    if (process.platform !== 'win32') {
      expect(statSync(backup).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(file, 'utf8')).segments).toHaveLength(6);
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'))).toEqual([]);

    store.patch({ segments: next.segments });
    expect(backupNames(file)).toHaveLength(1);
    warn.mockRestore();
  });

  it('preserves a schema-invalid file before the first save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    const original = JSON.stringify({ version: 1, segments: [] });
    writeFileSync(file, original);

    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));
    store.patch({ segments: defaultProcess(DEFAULT_SETTINGS.master).segments });

    const names = backupNames(file);
    expect(names).toHaveLength(1);
    expect(readFileSync(backupFile(file, names[0]!), 'utf8')).toBe(original);
    warn.mockRestore();
  });

  it('preserves an unusable file when patch is the first operation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    const original = '{bad\n';
    writeFileSync(file, original);

    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    store.patch({ segments: defaultProcess(DEFAULT_SETTINGS.master).segments });

    const names = backupNames(file);
    expect(names).toHaveLength(1);
    expect(readFileSync(backupFile(file, names[0]!), 'utf8')).toBe(original);
    warn.mockRestore();
  });

  it('never preserves a valid or missing file', () => {
    const missing = tempFile('missing.json');
    const store = new ProcessStore(missing, () => defaultProcess(DEFAULT_SETTINGS.master));
    const next = defaultProcess(DEFAULT_SETTINGS.master);
    store.patch({ segments: next.segments });
    store.patch({ segments: next.segments });
    expect(backupNames(missing)).toEqual([]);

    const valid = tempFile('valid.json');
    writeFileSync(valid, JSON.stringify(next));
    const validStore = new ProcessStore(valid, () => defaultProcess(DEFAULT_SETTINGS.master));
    expect(validStore.get()).toEqual(next);
    validStore.patch({ segments: next.segments });
    expect(backupNames(valid)).toEqual([]);
  });

  it('does not preserve a file corrected after an invalid load', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    writeFileSync(file, '{bad\n');

    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));

    const corrected = defaultProcess(DEFAULT_SETTINGS.master);
    writeFileSync(file, JSON.stringify(corrected));
    store.patch({ segments: corrected.segments });

    expect(backupNames(file)).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8')).segments).toHaveLength(6);
    warn.mockRestore();
  });

  it('refuses to overwrite when the unusable file cannot be copied', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    mkdirSync(file);

    const errors = { error: vi.fn() };
    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master), errors);
    expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));
    expect(() =>
      store.patch({ segments: defaultProcess(DEFAULT_SETTINGS.master).segments }),
    ).toThrow();

    expect(errors.error).toHaveBeenCalledWith('process.backupFailed', expect.any(Error), {
      path: file,
    });
    expect(statSync(file).isDirectory()).toBe(true);
    expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));
    expect(readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    warn.mockRestore();
  });

  it('never overwrites an existing preserved copy', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = tempFile();
      writeFileSync(file, '{first\n');
      const first = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
      first.get();
      first.patch({ segments: defaultProcess(DEFAULT_SETTINGS.master).segments });
      const firstNames = backupNames(file);
      expect(firstNames).toHaveLength(1);
      const firstBackup = backupFile(file, firstNames[0]!);

      writeFileSync(file, '{second\n');
      const second = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
      second.get();
      second.patch({ segments: defaultProcess(DEFAULT_SETTINGS.master).segments });

      const names = backupNames(file);
      expect(names).toHaveLength(2);
      expect(readFileSync(firstBackup, 'utf8')).toBe('{first\n');
      const secondBackup = names
        .map((name) => backupFile(file, name))
        .find((name) => name !== firstBackup);
      expect(secondBackup).toBeDefined();
      expect(readFileSync(secondBackup!, 'utf8')).toBe('{second\n');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('parseFollowUps', () => {
  it('extracts unique marker lines and ignores ordinary text', () => {
    const text = [
      'Done. READY FOR REVIEW',
      'FOLLOW-UP: Add metrics',
      '- FOLLOW-UP: Add metrics',
      '1. follow-up: Write the migration',
      'This is not a follow-up.',
    ].join('\n');

    expect(parseFollowUps(text, 'FOLLOW-UP:')).toEqual(['Add metrics', 'Write the migration']);
  });

  it('caps runaway output', () => {
    const text = Array.from({ length: 20 }, (_, index) => `FOLLOW-UP: Task ${index}`).join('\n');
    expect(parseFollowUps(text, 'FOLLOW-UP:', 3)).toHaveLength(3);
  });
});
