import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings.js';

function tempFile(name = 'config.json'): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'sbox-settings-')), name);
}

describe('SettingsStore', () => {
  it('returns defaults when the file is missing', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to defaults for invalid or unreadable files', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    writeFileSync(file, '{not json');
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);

    writeFileSync(file, JSON.stringify({ master: { intervalMinutes: 0 } }));
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalled();
  });

  it('defaults usage retention and loads a legacy master-only file', () => {
    const file = tempFile();
    expect(new SettingsStore(file).get().usage).toEqual({ retentionDays: 90 });

    writeFileSync(file, JSON.stringify({ master: DEFAULT_SETTINGS.master }));
    const legacy = new SettingsStore(file).get();
    expect(legacy.usage).toEqual({ retentionDays: 90 });
    expect(legacy.master).toEqual(DEFAULT_SETTINGS.master);
  });

  it('patches usage retention and rejects invalid values', () => {
    const file = tempFile();
    const store = new SettingsStore(file);

    const saved = store.patch({ usage: { retentionDays: 30 } });
    expect(saved.usage).toEqual({ retentionDays: 30 });
    expect(JSON.parse(readFileSync(file, 'utf8')).usage).toEqual({ retentionDays: 30 });
    expect(new SettingsStore(file).get().usage).toEqual({ retentionDays: 30 });

    for (const bad of [-1, 1.5, 3651, 'x']) {
      expect(() => store.patch({ usage: { retentionDays: bad as number } })).toThrow();
    }
    expect(store.get().usage).toEqual({ retentionDays: 30 });
  });

  it('merges a patch, writes atomically, and notifies listeners', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const seen: unknown[] = [];
    store.onChange((settings) => seen.push(settings));

    const saved = store.patch({ master: { enabled: false, intervalMinutes: 2 } });

    expect(saved.master).toMatchObject({ enabled: false, intervalMinutes: 2, idleMinutes: 10 });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).master.intervalMinutes).toBe(2);
    expect(new SettingsStore(file).get().master.enabled).toBe(false);
  });

  it('rejects invalid patches without writing', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(() => store.patch({ master: { intervalMinutes: 0 } })).toThrow();
    expect(store.get().master.intervalMinutes).toBe(5);
    expect(() => readFileSync(file)).toThrow();
  });

  it('strips unknown keys and accepts a fresh file path', () => {
    const file = tempFile('nested/config.json');
    const store = new SettingsStore(file);
    const saved = store.patch({ master: { intervalMinutes: 3, surprise: true } });
    expect(saved.master.intervalMinutes).toBe(3);
    expect(saved.master).not.toHaveProperty('surprise');
  });
});
