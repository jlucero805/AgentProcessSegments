import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import {
  defaultProcess,
  processSchema,
  READY_FOR_IMPLEMENTATION,
} from '../src/process/defaults.js';
import {
  AUTOMATED_SEGMENT_IDS,
  SEGMENT_IDS,
  SEGMENT_STATES,
  type ProcessConfig,
} from '../src/process/definition.js';
import { parseFollowUps } from '../src/process/follow-ups.js';
import { ProcessStore } from '../src/process/store.js';

function tempFile(name = 'process.json'): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'sbox-process-')), name);
}

function segmentBy(config: ProcessConfig, id: string) {
  const segment = config.segments.find((item) => item.id === id);
  if (!segment) throw new Error(`missing segment ${id}`);
  return segment;
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

  it('maps every segment to its request state', () => {
    expect(SEGMENT_STATES).toEqual({
      intake: 'clarify',
      plan: 'clarify',
      implement: 'dispatch',
      review: 'review',
      merge: 'merge',
      finalize: 'finalize',
    });
    expect(AUTOMATED_SEGMENT_IDS).toEqual(['intake', 'plan', 'implement', 'review', 'merge']);
    expect(READY_FOR_IMPLEMENTATION).toBe('READY FOR IMPLEMENTATION');
  });

  it('normalizes finalize automation off without dropping the segment', () => {
    const config = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(config, 'finalize').enabled = true;

    const parsed = processSchema.parse(config);

    expect(parsed.segments.map((segment) => segment.id)).toEqual([...SEGMENT_IDS]);
    expect(segmentBy(parsed, 'finalize').enabled).toBe(false);
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
  });

  it('forces finalize off when saving and reloading a process', () => {
    const file = tempFile();
    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    const next = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(next, 'finalize').enabled = true;

    const saved = store.patch({ segments: next.segments });
    expect(segmentBy(saved, 'finalize').enabled).toBe(false);

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as ProcessConfig;
    expect(segmentBy(onDisk, 'finalize').enabled).toBe(false);

    const reloaded = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    expect(segmentBy(reloaded.get(), 'finalize').enabled).toBe(false);
  });

  it('loads a legacy file with finalize enabled and normalizes it off', () => {
    const file = tempFile();
    const legacy = defaultProcess(DEFAULT_SETTINGS.master);
    segmentBy(legacy, 'finalize').enabled = true;
    writeFileSync(file, JSON.stringify(legacy));

    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));

    expect(segmentBy(store.get(), 'finalize').enabled).toBe(false);
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
