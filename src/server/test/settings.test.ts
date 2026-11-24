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
    expect(store.get().budget).toEqual({ monthlyUsd: null, alertAtPercent: 80, pauseOnExceeded: false, pauseOnUnknownCost: false });
  });

  it('loads a legacy file with only master and defaults the budget', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ master: DEFAULT_SETTINGS.master }));
    const store = new SettingsStore(file);
    expect(store.get().budget).toEqual({ monthlyUsd: null, alertAtPercent: 80, pauseOnExceeded: false, pauseOnUnknownCost: false });
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

  it('defaults every retention window and loads a legacy master-only file', () => {
    const file = tempFile();
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 90,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
    });

    writeFileSync(file, JSON.stringify({ master: DEFAULT_SETTINGS.master }));
    const legacy = new SettingsStore(file).get();
    expect(legacy.retention).toEqual({
      masterEventsDays: 90,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
    });
    expect(legacy.usage).toEqual({ retentionDays: 90 });
    expect(legacy.master).toEqual(DEFAULT_SETTINGS.master);
  });

  it('patches activity retention alone and rejects invalid values', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const seen: unknown[] = [];
    store.onChange((settings) => seen.push(settings));

    const saved = store.patch({ retention: { masterEventsDays: 30 } });
    expect(saved.retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
    });
    expect(saved.usage).toEqual({ retentionDays: 90 });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
    });
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
    });

    for (const bad of [-1, 1.5, 3651, 'x']) {
      expect(() =>
        store.patch({ retention: { masterEventsDays: bad as number } }),
      ).toThrow();
    }
    expect(store.get().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
    });

    const forever = store.patch({ retention: { masterEventsDays: 0 } });
    expect(forever.retention).toEqual({
      masterEventsDays: 0,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
    });
  });

  it('loads a legacy retention block without the artifact or scorecard windows', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ retention: { masterEventsDays: 30 } }));
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
    });
  });

  it('patches scorecard retention alone and rejects invalid values', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({ retention: { masterEventsDays: 45, requestArtifactsDays: 7 } });
    const seen: unknown[] = [];
    store.onChange((settings) => seen.push(settings));

    const saved = store.patch({ retention: { cellSummariesDays: 30 } });
    expect(saved.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 30,
      requestArtifactsDays: 7,
    });
    expect(seen).toHaveLength(1);
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 30,
      requestArtifactsDays: 7,
    });

    for (const bad of [-1, 1.5, 3651, 'x']) {
      expect(() =>
        store.patch({ retention: { cellSummariesDays: bad as number } }),
      ).toThrow();
    }
    expect(store.get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 30,
      requestArtifactsDays: 7,
    });

    const forever = store.patch({ retention: { cellSummariesDays: 0 } });
    expect(forever.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 0,
      requestArtifactsDays: 7,
    });
  });

  it('patches artifact retention alone without resetting activity retention', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({ retention: { masterEventsDays: 45 } });
    const seen: unknown[] = [];
    store.onChange((settings) => seen.push(settings));

    const saved = store.patch({ retention: { requestArtifactsDays: 7 } });
    expect(saved.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 90,
      requestArtifactsDays: 7,
    });
    expect(seen).toHaveLength(1);
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 90,
      requestArtifactsDays: 7,
    });

    for (const bad of [-1, 1.5, 3651, 'x']) {
      expect(() =>
        store.patch({ retention: { requestArtifactsDays: bad as number } }),
      ).toThrow();
    }
    expect(store.get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 90,
      requestArtifactsDays: 7,
    });

    const forever = store.patch({ retention: { requestArtifactsDays: 0 } });
    expect(forever.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 90,
      requestArtifactsDays: 0,
    });
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
    const saved = store.patch({ budget: { monthlyUsd: 125.5, alertAtPercent: 90, pauseOnExceeded: false, pauseOnUnknownCost: false } });
    expect(saved.master.enabled).toBe(true);
    expect(saved.budget).toEqual({ monthlyUsd: 125.5, alertAtPercent: 90, pauseOnExceeded: false, pauseOnUnknownCost: false });
    expect(JSON.parse(readFileSync(file, 'utf8')).budget).toEqual({
      monthlyUsd: 125.5,
      alertAtPercent: 90,
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
    });

    const cleared = store.patch({ budget: { monthlyUsd: null } });
    expect(cleared.budget).toEqual({ monthlyUsd: null, alertAtPercent: 90, pauseOnExceeded: false, pauseOnUnknownCost: false });
    expect(cleared.master.intervalMinutes).toBe(DEFAULT_SETTINGS.master.intervalMinutes);
  });

  it('persists the overall budget and pause flag across a reload', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({
      budget: { monthlyUsd: 250, alertAtPercent: 75, pauseOnExceeded: true, pauseOnUnknownCost: true },
    });

    const reloaded = new SettingsStore(file).get();
    expect(reloaded.budget).toEqual({
      monthlyUsd: 250,
      alertAtPercent: 75,
      pauseOnExceeded: true,
      pauseOnUnknownCost: true,
    });

    // A partial patch that omits the flag must not silently turn the cap off.
    store.patch({ budget: { monthlyUsd: 300 } });
    expect(new SettingsStore(file).get().budget).toEqual({
      monthlyUsd: 300,
      alertAtPercent: 75,
      pauseOnExceeded: true,
      pauseOnUnknownCost: true,
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
      pauseOnUnknownCost: false,
    });
  });

  it('merges a partial block over defaults and keeps the saved budget', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        master: {
          enabled: false,
          intervalMinutes: DEFAULT_SETTINGS.master.intervalMinutes,
          idleMinutes: DEFAULT_SETTINGS.master.idleMinutes,
          autoReview: DEFAULT_SETTINGS.master.autoReview,
        },
        budget: { monthlyUsd: 250, alertAtPercent: 75, pauseOnExceeded: true, pauseOnUnknownCost: true },
      }),
    );

    const loaded = new SettingsStore(file).get();
    expect(loaded.master).toEqual({ ...DEFAULT_SETTINGS.master, enabled: false });
    expect(loaded.master.prompt).toBe(DEFAULT_SETTINGS.master.prompt);
    expect(loaded.budget).toEqual({
      monthlyUsd: 250,
      alertAtPercent: 75,
      pauseOnExceeded: true,
      pauseOnUnknownCost: true,
    });
  });

  it('fills an empty block from defaults without discarding the saved budget', () => {
    const blocks = Object.keys(DEFAULT_SETTINGS).filter((block) => {
      if (block === 'budget') return false;
      const value = DEFAULT_SETTINGS[block as keyof typeof DEFAULT_SETTINGS];
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    });
    expect(blocks).toContain('master');

    const savedBudget = { monthlyUsd: 42, alertAtPercent: 85, pauseOnExceeded: true, pauseOnUnknownCost: true };
    for (const block of blocks) {
      const file = tempFile();
      writeFileSync(file, JSON.stringify({ [block]: {}, budget: savedBudget }));

      const loaded = new SettingsStore(file).get();
      expect(loaded[block as keyof typeof loaded]).toEqual(
        DEFAULT_SETTINGS[block as keyof typeof DEFAULT_SETTINGS],
      );
      expect(loaded.budget).toEqual(savedBudget);
    }
  });

  it('preserves explicit nulls and empty arrays while loading', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        budget: { monthlyUsd: 60, alertAtPercent: 70, pauseOnExceeded: false, pauseOnUnknownCost: false },
        notifications: {
          webhook: { secret: null },
          email: { host: null, from: null, to: [] },
        },
      }),
    );

    const loaded = new SettingsStore(file).get();
    expect(loaded.notifications.webhook.secret).toBeNull();
    expect(loaded.notifications.email.host).toBeNull();
    expect(loaded.notifications.email.from).toBeNull();
    expect(loaded.notifications.email.to).toEqual([]);
    expect(loaded.budget).toEqual({
      monthlyUsd: 60,
      alertAtPercent: 70,
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
    });
  });

  it('loads non-object JSON as defaults', () => {
    const file = tempFile();
    for (const raw of ['[]', '"x"', 'null']) {
      writeFileSync(file, raw);
      expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('does not mutate the shared defaults when loading', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({ budget: { monthlyUsd: 99, alertAtPercent: 90, pauseOnExceeded: true, pauseOnUnknownCost: true } }),
    );

    const first = new SettingsStore(file).get();
    const second = new SettingsStore(file).get();
    expect(DEFAULT_SETTINGS.budget.monthlyUsd).toBeNull();
    expect(first.budget.monthlyUsd).toBe(99);
    expect(second.budget.monthlyUsd).toBe(99);
    expect(first.notifications.email.to).not.toBe(second.notifications.email.to);
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
    expect(() =>
      store.patch({ budget: { pauseOnUnknownCost: 'yes' as unknown as boolean } }),
    ).toThrow();
    expect(store.get().budget).toEqual({ monthlyUsd: null, alertAtPercent: 80, pauseOnExceeded: false, pauseOnUnknownCost: false });
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
      pauseOnUnknownCost: false,
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
      pauseOnUnknownCost: false,
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

describe('email notification settings', () => {
  const email = {
    enabled: true,
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    username: 'aps',
    password: 'super-secret',
    from: 'APS Alerts <alerts@example.com>',
    to: ['ops@example.com', 'oncall@example.com'],
  };

  it('defaults email delivery and keeps it across reloads', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(store.get().notifications.email).toEqual({
      enabled: false,
      host: null,
      port: 587,
      secure: false,
      username: null,
      password: null,
      from: null,
      to: [],
    });

    store.patch({ notifications: { email } });
    const reloaded = new SettingsStore(file).get();
    expect(reloaded.notifications.email).toEqual(email);
  });

  it('adds the email block to a webhook-only legacy file', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        notifications: { webhook: { enabled: true, url: 'https://hooks.example.test/b' } },
      }),
    );
    const settings = new SettingsStore(file).get();
    expect(settings.notifications.webhook.url).toBe('https://hooks.example.test/b');
    expect(settings.notifications.email).toEqual({
      enabled: false,
      host: null,
      port: 587,
      secure: false,
      username: null,
      password: null,
      from: null,
      to: [],
    });
  });

  it('merges email patches, replaces recipients, and clears the password explicitly', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({ notifications: { email } });

    const rotated = store.patch({
      notifications: { email: { password: 'rotated-secret', to: ['other@example.com'] } },
    });
    expect(rotated.notifications.email).toMatchObject({
      enabled: true,
      host: 'smtp.example.com',
      username: 'aps',
      password: 'rotated-secret',
      to: ['other@example.com'],
    });

    const kept = store.patch({ notifications: { email: { port: 465, secure: true } } });
    expect(kept.notifications.email.password).toBe('rotated-secret');

    const cleared = store.patch({
      notifications: { email: { username: null, password: null } },
    });
    expect(cleared.notifications.email.password).toBeNull();
    expect(cleared.notifications.email.username).toBeNull();
  });

  it('rejects invalid email settings without writing', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const invalid = [
      { enabled: true, host: null },
      { enabled: true, from: null },
      { enabled: true, to: [] },
      { host: 'smtp example.com' },
      { port: 0 },
      { port: 70000 },
      { port: 587.5 },
      { secure: 'yes' },
      { from: 'not-an-address' },
      { to: ['Ops@example.com', 'ops@example.com'] },
      { to: ['APS <ops@example.com>'] },
      { to: Array.from({ length: 11 }, (_v, index) => `u${index}@example.com`) },
      { username: 'aps' },
      { password: 'secret' },
      { password: '' },
    ];

    for (const patch of invalid) {
      expect(() => store.patch({ notifications: { email: patch } })).toThrow();
    }
    expect(store.get().notifications.email).toEqual({
      enabled: false,
      host: null,
      port: 587,
      secure: false,
      username: null,
      password: null,
      from: null,
      to: [],
    });
    expect(() => readFileSync(file)).toThrow();
  });
});

describe('chat notification settings', () => {
  const slack = {
    enabled: true,
    botToken: 'xoxb-0123456789abcdef',
    destinations: [
      { channelId: 'C0123456789', label: 'Ops' },
      { channelId: 'C9876543210', label: null },
    ],
    defaultChannelId: 'C0123456789',
    routes: [{ cellId: 'cell-a', channelId: 'C9876543210' }],
  };
  const discord = {
    enabled: true,
    botToken: 'discord-0123456789abcdef',
    destinations: [{ channelId: '123456789012345678', label: 'Ops' }],
    defaultChannelId: '123456789012345678',
    routes: [],
  };

  it('defaults both providers and keeps saved values across reloads', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(store.get().notifications.slack).toEqual({
      enabled: false,
      botToken: null,
      destinations: [],
      defaultChannelId: null,
      routes: [],
    });
    expect(store.get().notifications.discord).toEqual({
      enabled: false,
      botToken: null,
      destinations: [],
      defaultChannelId: null,
      routes: [],
    });

    store.patch({ notifications: { slack, discord } });
    const reloaded = new SettingsStore(file).get();
    expect(reloaded.notifications.slack).toEqual(slack);
    expect(reloaded.notifications.discord).toEqual(discord);
  });

  it('merges provider patches and replaces arrays wholesale', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({ notifications: { slack } });

    const tokenOnly = store.patch({
      notifications: { slack: { botToken: 'xoxb-rotated-0123456789' } },
    });
    expect(tokenOnly.notifications.slack).toEqual({
      ...slack,
      botToken: 'xoxb-rotated-0123456789',
    });

    const replaced = store.patch({
      notifications: {
        slack: {
          destinations: [{ channelId: 'C1111111111', label: 'New' }],
          defaultChannelId: 'C1111111111',
          routes: [],
        },
      },
    });
    expect(replaced.notifications.slack.destinations).toEqual([
      { channelId: 'C1111111111', label: 'New' },
    ]);
    expect(replaced.notifications.slack.routes).toEqual([]);

    const cleared = store.patch({
      notifications: { slack: { enabled: false, botToken: null } },
    });
    expect(cleared.notifications.slack.botToken).toBeNull();
    expect(cleared.notifications.slack.destinations).toHaveLength(1);
  });

  it('rejects invalid chat settings without writing', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const invalidSlack = [
      { enabled: true, botToken: null },
      { enabled: true, destinations: [], defaultChannelId: null, routes: [] },
      { enabled: true, destinations: [{ channelId: 'C0123456789', label: null }], defaultChannelId: null, routes: [] },
      { botToken: 'short' },
      { botToken: 'has a space 0123456789' },
      { destinations: [{ channelId: 'ops', label: null }] },
      { destinations: [{ channelId: 'C0123456789', label: null }, { channelId: 'C0123456789', label: 'Dup' }] },
      { destinations: [{ channelId: 'C0123456789', label: null }], defaultChannelId: 'C1111111111' },
      { destinations: [{ channelId: 'C0123456789', label: null }], routes: [{ cellId: 'cell-a', channelId: 'C1111111111' }] },
      { destinations: [{ channelId: 'C0123456789', label: null }], routes: [{ cellId: 'cell-a', channelId: 'C0123456789' }, { cellId: 'cell-a', channelId: 'C0123456789' }] },
    ];
    for (const patch of invalidSlack) {
      expect(() => store.patch({ notifications: { slack: patch } })).toThrow();
    }
    expect(() =>
      store.patch({
        notifications: {
          discord: {
            enabled: true,
            botToken: 'discord-0123456789abcdef',
            destinations: [{ channelId: 'C0123456789', label: null }],
            defaultChannelId: 'C0123456789',
            routes: [],
          },
        },
      }),
    ).toThrow();
    expect(() => readFileSync(file)).toThrow();
  });
});
