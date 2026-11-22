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
import { SEGMENT_IDS, SEGMENT_STATES, type ProcessConfig } from '../src/process/definition.js';
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
  });

  it('upgrades an old five-segment process by adding Merge', () => {
    const file = tempFile();
    const old = defaultProcess(DEFAULT_SETTINGS.master);
    old.segments = old.segments.filter((segment) => segment.id !== 'merge');
    writeFileSync(file, JSON.stringify(old));

    const store = new ProcessStore(file, () => defaultProcess(DEFAULT_SETTINGS.master));
    expect(store.get().segments.map((segment) => segment.id)).toEqual([...SEGMENT_IDS]);
    expect(segmentBy(store.get(), 'merge').enabled).toBe(false);
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
