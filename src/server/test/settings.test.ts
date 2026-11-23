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
    expect(store.get().budget).toEqual({ monthlyUsd: null, alertAtPercent: 80, pauseOnExceeded: false });
  });

  it('loads a legacy file with only master and defaults the budget', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ master: DEFAULT_SETTINGS.master }));
    const store = new SettingsStore(file);
    expect(store.get().budget).toEqual({ monthlyUsd: null, alertAtPercent: 80, pauseOnExceeded: false });
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

  it('defaults master activity retention and loads a legacy master-only file', () => {
    const file = tempFile();
    expect(new SettingsStore(file).get().retention).toEqual({ masterEventsDays: 90 });

    writeFileSync(file, JSON.stringify({ master: DEFAULT_SETTINGS.master }));
    const legacy = new SettingsStore(file).get();
    expect(legacy.retention).toEqual({ masterEventsDays: 90 });
    expect(legacy.usage).toEqual({ retentionDays: 90 });
    expect(legacy.master).toEqual(DEFAULT_SETTINGS.master);
  });

  it('patches activity retention alone and rejects invalid values', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const seen: unknown[] = [];
    store.onChange((settings) => seen.push(settings));

    const saved = store.patch({ retention: { masterEventsDays: 30 } });
    expect(saved.retention).toEqual({ masterEventsDays: 30 });
    expect(saved.usage).toEqual({ retentionDays: 90 });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).retention).toEqual({
      masterEventsDays: 30,
    });
    expect(new SettingsStore(file).get().retention).toEqual({ masterEventsDays: 30 });

    for (const bad of [-1, 1.5, 3651, 'x']) {
      expect(() =>
        store.patch({ retention: { masterEventsDays: bad as number } }),
      ).toThrow();
    }
    expect(store.get().retention).toEqual({ masterEventsDays: 30 });

    const forever = store.patch({ retention: { masterEventsDays: 0 } });
    expect(forever.retention).toEqual({ masterEventsDays: 0 });
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

  it('merges budget patches without disturbing master', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const saved = store.patch({ budget: { monthlyUsd: 125.5, alertAtPercent: 90, pauseOnExceeded: false } });
    expect(saved.master.enabled).toBe(true);
    expect(saved.budget).toEqual({ monthlyUsd: 125.5, alertAtPercent: 90, pauseOnExceeded: false });
    expect(JSON.parse(readFileSync(file, 'utf8')).budget).toEqual({
      monthlyUsd: 125.5,
      alertAtPercent: 90,
      pauseOnExceeded: false,
    });

    const cleared = store.patch({ budget: { monthlyUsd: null } });
    expect(cleared.budget).toEqual({ monthlyUsd: null, alertAtPercent: 90, pauseOnExceeded: false });
    expect(cleared.master.intervalMinutes).toBe(DEFAULT_SETTINGS.master.intervalMinutes);
  });

  it('persists the overall budget and pause flag across a reload', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({
      budget: { monthlyUsd: 250, alertAtPercent: 75, pauseOnExceeded: true },
    });

    const reloaded = new SettingsStore(file).get();
    expect(reloaded.budget).toEqual({
      monthlyUsd: 250,
      alertAtPercent: 75,
      pauseOnExceeded: true,
    });

    // A partial patch that omits the flag must not silently turn the cap off.
    store.patch({ budget: { monthlyUsd: 300 } });
    expect(new SettingsStore(file).get().budget).toEqual({
      monthlyUsd: 300,
      alertAtPercent: 75,
      pauseOnExceeded: true,
    });
  });

  it('loads a legacy budget block without the pause flag', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ budget: { monthlyUsd: 100, alertAtPercent: 80 } }));
    const budget = new SettingsStore(file).get().budget;
    expect(budget).toEqual({
      monthlyUsd: 100,
      alertAtPercent: 80,
      pauseOnExceeded: false,
    });
  });

  it('rejects invalid budget patches without writing', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(() => store.patch({ budget: { monthlyUsd: 0 } })).toThrow();
    expect(() => store.patch({ budget: { monthlyUsd: -1 } })).toThrow();
    expect(() => store.patch({ budget: { monthlyUsd: 1_000_001 } })).toThrow();
    expect(() => store.patch({ budget: { alertAtPercent: 0 } })).toThrow();
    expect(() => store.patch({ budget: { alertAtPercent: 101 } })).toThrow();
    expect(() => store.patch({ budget: { alertAtPercent: 80.5 } })).toThrow();
    expect(store.get().budget).toEqual({ monthlyUsd: null, alertAtPercent: 80, pauseOnExceeded: false });
    expect(() => readFileSync(file)).toThrow();
  });

  it('rejects invalid patches without writing', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(() => store.patch({ master: { intervalMinutes: 0 } })).toThrow();
    expect(store.get().master.intervalMinutes).toBe(5);
    expect(() => readFileSync(file)).toThrow();
  });

  it('ignores a legacy unassigned-work flag', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        master: { ...DEFAULT_SETTINGS.master, intervalMinutes: 7, includeUnassigned: true },
      }),
    );

    const store = new SettingsStore(file);
    expect(store.get().master).toMatchObject({ intervalMinutes: 7 });
    expect(store.get().master).not.toHaveProperty('includeUnassigned');

    const saved = store.patch({ master: { intervalMinutes: 3, includeUnassigned: false } });
    expect(saved.master.intervalMinutes).toBe(3);
    expect(saved.master).not.toHaveProperty('includeUnassigned');
    expect(JSON.parse(readFileSync(file, 'utf8')).master).not.toHaveProperty('includeUnassigned');
  });

  it('strips unknown keys and accepts a fresh file path', () => {
    const file = tempFile('nested/config.json');
    const store = new SettingsStore(file);
    const saved = store.patch({ master: { intervalMinutes: 3, surprise: true } });
    expect(saved.master.intervalMinutes).toBe(3);
    expect(saved.master).not.toHaveProperty('surprise');
  });

  it('keeps a legacy master block and adds the default summary policy', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        master: {
          enabled: false,
          intervalMinutes: 17,
          idleMinutes: 30,
          autoReview: false,
          includeUnassigned: false,
          prompt: 'legacy master prompt',
        },
      }),
    );

    const settings = new SettingsStore(file).get();

    expect(settings.master).toMatchObject({ enabled: false, intervalMinutes: 17 });
    expect(settings.summary).toEqual(DEFAULT_SETTINGS.summary);
  });

  it('patches summary independently of master', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const saved = store.patch({
      summary: { intervalMinutes: 720, windowMinutes: 180, enabled: false },
    });

    expect(saved.summary).toMatchObject({
      enabled: false,
      intervalMinutes: 720,
      windowMinutes: 180,
      prompt: DEFAULT_SETTINGS.summary.prompt,
    });
    expect(saved.master).toEqual(DEFAULT_SETTINGS.master);
    expect(JSON.parse(readFileSync(file, 'utf8')).summary.windowMinutes).toBe(180);
    expect(new SettingsStore(file).get().summary.windowMinutes).toBe(180);
  });

  it('defaults webhook delivery and preserves saved settings across reloads', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(store.get().notifications.webhook).toEqual({
      enabled: false,
      url: null,
      format: 'json',
      secret: null,
    });

    store.patch({
      budget: { monthlyUsd: 120, alertAtPercent: 75 },
      notifications: {
        webhook: {
          enabled: true,
          url: 'https://hooks.example.test/budget',
          format: 'slack',
          secret: '0123456789abcdef',
        },
      },
    });

    const reloaded = new SettingsStore(file).get();
    expect(reloaded.budget).toEqual({
      monthlyUsd: 120,
      alertAtPercent: 75,
      pauseOnExceeded: false,
    });
    expect(reloaded.notifications.webhook).toEqual({
      enabled: true,
      url: 'https://hooks.example.test/budget',
      format: 'slack',
      secret: '0123456789abcdef',
    });
  });

  it('fills missing webhook fields from defaults on load', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        budget: { monthlyUsd: 50, alertAtPercent: 70 },
        notifications: { webhook: { enabled: true, url: 'https://hooks.example.test/b' } },
      }),
    );
    const settings = new SettingsStore(file).get();
    expect(settings.budget).toEqual({
      monthlyUsd: 50,
      alertAtPercent: 70,
      pauseOnExceeded: false,
    });
    expect(settings.notifications.webhook).toEqual({
      enabled: true,
      url: 'https://hooks.example.test/b',
      format: 'json',
      secret: null,
    });
  });

  it('merges a webhook patch field by field', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({
      notifications: {
        webhook: {
          enabled: true,
          url: 'https://hooks.example.test/budget',
          format: 'discord',
          secret: '0123456789abcdef',
        },
      },
    });

    const urlOnly = store.patch({
      notifications: { webhook: { url: 'https://hooks.example.test/other' } },
    });
    expect(urlOnly.notifications.webhook).toEqual({
      enabled: true,
      url: 'https://hooks.example.test/other',
      format: 'discord',
      secret: '0123456789abcdef',
    });

    const cleared = store.patch({ notifications: { webhook: { secret: null } } });
    expect(cleared.notifications.webhook.secret).toBeNull();
    expect(cleared.notifications.webhook.format).toBe('discord');
  });

  it('rejects invalid webhook settings without writing', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const invalid = [
      { enabled: true, url: null },
      { url: 'http://example.com/hook' },
      { url: 'https://user:pass@example.com/hook' },
      { url: 'https://example.com/hook#fragment' },
      { url: 'not a url' },
      { url: `https://example.com/${'x'.repeat(2048)}` },
      { format: 'teams' },
      { secret: 'short' },
      { secret: 'x'.repeat(257) },
    ];

    for (const webhook of invalid) {
      expect(() => store.patch({ notifications: { webhook } })).toThrow();
    }
    expect(store.get().notifications.webhook).toEqual({
      enabled: false,
      url: null,
      format: 'json',
      secret: null,
    });
    expect(() => readFileSync(file)).toThrow();
  });
});
