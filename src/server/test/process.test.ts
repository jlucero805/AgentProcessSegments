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

/** Names of preserved copy files for `file`, oldest first. */
function backupNames(file: string): string[] {
  const prefix = `${path.basename(file)}.invalid-`;
  return readdirSync(path.dirname(file), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
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
    expect(errors.error).toHaveBeenCalledWith(
      'process.unreadable',
      expect.objectContaining({ message: expect.stringMatching(/^invalid JSON/) }),
      { path: file, reason: 'invalid-json' },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Unexpected');

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

  it('redacts a parser snippet from the unreadable report', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    const sentinel = 'SUPERSECRET-process-prompt';
    writeFileSync(file, `{"segments":[{"prompt":"${sentinel}"`);

    const errors = { error: vi.fn() };
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError(`Unexpected token 'S', "${sentinel}" is not valid JSON`);
    });

    try {
      const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master), errors);
      expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));

      expect(errors.error).toHaveBeenCalledTimes(1);
      const [source, error, context] = errors.error.mock.calls[0]!;
      expect(source).toBe('process.unreadable');
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(
        /^invalid JSON(?: at position \d+(?: \(line \d+ column \d+\))?)?$/,
      );
      expect(error.message).not.toContain(sentinel);
      expect(error.stack).not.toContain(sentinel);
      expect(context).toEqual({ path: file, reason: 'invalid-json' });
      expect(JSON.stringify(context)).not.toContain(sentinel);
      expect(warn).toHaveBeenCalledWith(
        `ignoring unreadable process config at ${file}: invalid JSON`,
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Unexpected token');
    } finally {
      parse.mockRestore();
      warn.mockRestore();
    }
  });

  it('reports the copy path created by the preserving save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    const original = '{not json\n';
    writeFileSync(file, original);

    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    expect(store.preservedPath()).toBeNull();
    expect(store.get()).toEqual(defaultProcess(DEFAULT_SETTINGS.master));
    expect(store.preservedPath()).toBeNull();

    const next = defaultProcess(DEFAULT_SETTINGS.master);
    store.patch({ segments: next.segments });

    const names = backupNames(file);
    expect(names).toHaveLength(1);
    const preserved = backupFile(file, names[0]!);
    expect(store.preservedPath()).toBe(preserved);
    expect(readFileSync(store.preservedPath()!, 'utf8')).toBe(original);

    store.patch({ segments: next.segments });
    expect(store.preservedPath()).toBe(preserved);
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
    expect(store.preservedPath()).toBeNull();

    const valid = tempFile('valid.json');
    writeFileSync(valid, JSON.stringify(next));
    const validStore = new ProcessStore(valid, () => defaultProcess(DEFAULT_SETTINGS.master));
    expect(validStore.get()).toEqual(next);
    validStore.patch({ segments: next.segments });
    expect(backupNames(valid)).toEqual([]);
    expect(validStore.preservedPath()).toBeNull();
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
    const preserved = `${file}.invalid-2026-01-01T00-00-00-000Z`;
    writeFileSync(preserved, 'keep\n');

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
    expect(store.preservedPath()).toBeNull();
    expect(readdirSync(path.dirname(file)).sort()).toEqual(
      [path.basename(file), path.basename(preserved)].sort(),
    );
    expect(readFileSync(preserved, 'utf8')).toBe('keep\n');
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

  it('keeps only the five newest preserved copies', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = tempFile();
      const next = defaultProcess(DEFAULT_SETTINGS.master);
      const originals: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
        const original = `{bad-${index}\n`;
        writeFileSync(file, original);
        new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master)).patch({
          segments: next.segments,
        });
        originals.push(original);
      }

      const names = backupNames(file);
      expect(names).toHaveLength(5);
      expect(names.map((name) => readFileSync(backupFile(file, name), 'utf8'))).toEqual(
        originals.slice(1),
      );
      expect(JSON.parse(readFileSync(file, 'utf8')).segments).toHaveLength(6);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('orders same-timestamp preserved copies by numeric suffix', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = tempFile();
      const next = defaultProcess(DEFAULT_SETTINGS.master);
      const prefix = `${file}.invalid-2026-01-02T00-00-00-000Z`;
      for (let suffix = 0; suffix <= 12; suffix += 1) {
        writeFileSync(suffix === 0 ? prefix : `${prefix}-${suffix}`, `old-${suffix}\n`);
      }
      writeFileSync(file, '{bad\n');
      new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master)).patch({
        segments: next.segments,
      });

      const names = backupNames(file);
      expect(names).toHaveLength(5);
      for (const suffix of [9, 10, 11, 12, 13]) {
        expect(names).toContain(`${path.basename(prefix)}-${suffix}`);
      }
      for (const suffix of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        expect(names).not.toContain(
          suffix === 0 ? path.basename(prefix) : `${path.basename(prefix)}-${suffix}`,
        );
      }
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('never prunes the copy it just created', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = tempFile();
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(`${file}.invalid-2026-01-01T00-00-0${index}-000Z`, `future-${index}\n`);
      }
      writeFileSync(file, '{bad\n');
      const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
      store.patch({
        segments: defaultProcess(DEFAULT_SETTINGS.master).segments,
      });

      const names = backupNames(file);
      expect(names).toHaveLength(5);
      const preserved = `${path.basename(file)}.invalid-2025-01-01T00-00-00-000Z`;
      expect(names).toContain(preserved);
      expect(store.preservedPath()).toBe(backupFile(file, preserved));
      expect(names).not.toContain(`${path.basename(file)}.invalid-2026-01-01T00-00-00-000Z`);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('prunes only matching preserved copy files', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = tempFile();
      const dir = path.dirname(file);
      const configCopy = path.join(dir, 'config.json.invalid-2026-01-01T00-00-00-000Z');
      const otherCopy = path.join(dir, 'other.json.invalid-2026-01-01T00-00-00-000Z');
      const temp = path.join(dir, 'process.json.tmp-keep');
      writeFileSync(configCopy, 'config bytes\n');
      writeFileSync(otherCopy, 'other bytes\n');
      writeFileSync(temp, 'temp bytes\n');
      for (let index = 0; index < 6; index += 1) {
        writeFileSync(`${file}.invalid-2026-01-01T00-00-0${index}-000Z`, `old-${index}\n`);
      }

      writeFileSync(file, '{bad\n');
      new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master)).patch({
        segments: defaultProcess(DEFAULT_SETTINGS.master).segments,
      });

      const names = backupNames(file);
      expect(names).toHaveLength(5);
      expect(names).not.toContain(`${path.basename(file)}.invalid-2026-01-01T00-00-00-000Z`);
      expect(names).not.toContain(`${path.basename(file)}.invalid-2026-01-01T00-00-01-000Z`);
      expect(names).toContain(`${path.basename(file)}.invalid-2026-01-03T00-00-00-000Z`);
      expect(readFileSync(configCopy, 'utf8')).toBe('config bytes\n');
      expect(readFileSync(otherCopy, 'utf8')).toBe('other bytes\n');
      expect(readFileSync(temp, 'utf8')).toBe('temp bytes\n');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('ignores non-file entries with a preserved name', () => {
    const file = tempFile();
    const dir = path.dirname(file);
    const next = defaultProcess(DEFAULT_SETTINGS.master);
    writeFileSync(file, JSON.stringify(next));
    const preservedDir = path.join(
      dir,
      `${path.basename(file)}.invalid-2026-01-01T00-00-00-000Z`,
    );
    mkdirSync(preservedDir);
    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(`${file}.invalid-2026-01-01T00-00-0${index}-000Z`, `old-${index}\n`);
    }

    const errors = { error: vi.fn() };
    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master), errors);
    store.patch({ segments: next.segments });

    expect(backupNames(file)).toHaveLength(5);
    expect(statSync(preservedDir).isDirectory()).toBe(true);
    expect(errors.error).not.toHaveBeenCalled();
  });

  it('bounds an existing backlog on a successful save', () => {
    const file = tempFile();
    const next = defaultProcess(DEFAULT_SETTINGS.master);
    writeFileSync(file, JSON.stringify(next));
    const backups = Array.from(
      { length: 8 },
      (_, index) => `${file}.invalid-2026-01-01T00-00-0${index}-000Z`,
    );
    for (const [index, backup] of backups.entries()) {
      writeFileSync(backup, `old-${index}\n`);
    }

    const errors = { error: vi.fn() };
    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master), errors);
    store.patch({ segments: next.segments });

    expect(backupNames(file)).toEqual(
      backups.slice(3).map((backup) => path.basename(backup)),
    );
    expect(errors.error).not.toHaveBeenCalled();
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
