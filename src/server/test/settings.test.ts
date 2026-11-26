import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings.js';

function tempFile(name = 'config.json'): string {
  return path.join(tmpDir('settings'), name);
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

/** Distinct, valid, non-default values for every settings unit. */
function sentinelSettings(): typeof DEFAULT_SETTINGS {
  const saved = structuredClone(DEFAULT_SETTINGS);
  saved.master = { ...saved.master, intervalMinutes: 17 };
  saved.summary = { ...saved.summary, windowMinutes: 90 };
  saved.usage = { retentionDays: 30 };
  saved.retention = { masterEventsDays: 45, cellSummariesDays: 60, requestArtifactsDays: 7, budgetAlertsDays: 30, notificationEventsDays: 30 };
  saved.budget = { monthlyUsd: 250, alertAtPercent: 75, pauseOnExceeded: true, pauseOnUnknownCost: true };
  saved.notifications.webhook = {
    enabled: true,
    url: 'https://hooks.example.test/sentinel',
    format: 'slack',
    secret: '0123456789abcdef',
  };
  saved.notifications.email = {
    enabled: true,
    host: 'smtp.example.test',
    port: 2525,
    secure: true,
    username: 'aps',
    password: 'smtp-password',
    from: 'APS Alerts <alerts@example.test>',
    to: ['ops@example.test'],
  };
  saved.notifications.slack = {
    enabled: true,
    botToken: 'xoxb-sentinel-0123456789',
    destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
    defaultChannelId: 'C0123456789',
    routes: [],
  };
  saved.notifications.discord = {
    enabled: true,
    botToken: 'discord-sentinel-0123456789',
    destinations: [{ channelId: '123456789012345678', label: 'Ops' }],
    defaultChannelId: '123456789012345678',
    routes: [],
  };
  saved.notifications.events = {
    failedTurns: { webhook: true, email: false },
    masterErrors: { webhook: false, email: true },
    summaryFailures: { webhook: false, email: false },
    spendOverrides: { webhook: false, email: false },
    coalesceMinutes: 60,
    routes: [],
  };
  return saved;
}

/** One realistic invalid value per unit, used by the recovery coverage test. */
const INVALID_UNIT_VALUES: Record<string, unknown> = {
  master: { intervalMinutes: 0 },
  summary: { windowMinutes: 0 },
  usage: { retentionDays: -1 },
  retention: { masterEventsDays: -1 },
  budget: { alertAtPercent: 0 },
  'notifications.webhook': { url: 'not a url' },
  'notifications.email': { port: 0 },
  'notifications.slack': { botToken: 'short' },
  'notifications.discord': { botToken: 'short' },
  'notifications.events': { failedTurns: { webhook: 'yes' } },
};

function asMutable<T extends object>(settings: T): Record<string, unknown> {
  return settings as unknown as Record<string, unknown>;
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

  it('falls back to all defaults for unreadable or malformed files', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();

    writeFileSync(file, '{not json');
    const errors = { error: vi.fn() };
    expect(new SettingsStore(file, errors).get()).toEqual(DEFAULT_SETTINGS);
    expect(errors.error).toHaveBeenCalledWith('settings.unreadable', expect.any(Error), {
      path: file,
    });

    writeFileSync(file, JSON.stringify({ master: { intervalMinutes: 0 } }));
    const invalid = { error: vi.fn() };
    expect(new SettingsStore(file, invalid).get()).toEqual(DEFAULT_SETTINGS);
    expect(invalid.error).toHaveBeenCalledTimes(1);
    expect(invalid.error).toHaveBeenCalledWith('settings.invalid', expect.any(Error), {
      path: file,
      block: 'master',
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loads defaults for a missing file without reporting an error', () => {
    const errors = { error: vi.fn() };
    expect(new SettingsStore(tempFile(), errors).get()).toEqual(DEFAULT_SETTINGS);
    expect(errors.error).not.toHaveBeenCalled();
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
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });

    writeFileSync(file, JSON.stringify({ master: DEFAULT_SETTINGS.master }));
    const legacy = new SettingsStore(file).get();
    expect(legacy.retention).toEqual({
      masterEventsDays: 90,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
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
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });
    expect(saved.usage).toEqual({ retentionDays: 90 });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
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
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });

    const forever = store.patch({ retention: { masterEventsDays: 0 } });
    expect(forever.retention).toEqual({
      masterEventsDays: 0,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });
  });

  it('loads a legacy retention block without the artifact or scorecard windows', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ retention: { masterEventsDays: 30 } }));
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
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
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });
    expect(seen).toHaveLength(1);
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 30,
      requestArtifactsDays: 7,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
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
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });

    const forever = store.patch({ retention: { cellSummariesDays: 0 } });
    expect(forever.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 0,
      requestArtifactsDays: 7,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
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
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });
    expect(seen).toHaveLength(1);
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 90,
      requestArtifactsDays: 7,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
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
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });

    const forever = store.patch({ retention: { requestArtifactsDays: 0 } });
    expect(forever.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 90,
      requestArtifactsDays: 0,
      budgetAlertsDays: 400,
      notificationEventsDays: 400,
    });
  });

  it('patches budget alert retention alone and rejects invalid values', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({
      retention: {
        masterEventsDays: 45,
        cellSummariesDays: 60,
        requestArtifactsDays: 7,
        notificationEventsDays: 30,
      },
    });
    const seen: unknown[] = [];
    store.onChange((settings) => seen.push(settings));

    const saved = store.patch({ retention: { budgetAlertsDays: 30 } });
    expect(saved.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 30,
    });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 30,
    });
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 30,
    });

    for (const bad of [-1, 1.5, 3651, 'x']) {
      expect(() =>
        store.patch({ retention: { budgetAlertsDays: bad as number } }),
      ).toThrow();
    }
    expect(store.get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 30,
    });
  });

  it('patches notification event retention alone and rejects invalid values', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    store.patch({
      retention: {
        masterEventsDays: 45,
        cellSummariesDays: 60,
        requestArtifactsDays: 7,
        budgetAlertsDays: 30,
      },
    });
    const seen: unknown[] = [];
    store.onChange((settings) => seen.push(settings));

    const saved = store.patch({ retention: { notificationEventsDays: 30 } });
    expect(saved.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 30,
    });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 30,
    });
    expect(new SettingsStore(file).get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 30,
    });

    for (const bad of [-1, 1.5, 3651, 'x']) {
      expect(() =>
        store.patch({ retention: { notificationEventsDays: bad as number } }),
      ).toThrow();
    }
    expect(store.get().retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 30,
    });

    const forever = store.patch({ retention: { notificationEventsDays: 0 } });
    expect(forever.retention).toEqual({
      masterEventsDays: 45,
      cellSummariesDays: 60,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
      notificationEventsDays: 0,
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
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      chmodSync(file, 0o644);
      store.patch({ master: { intervalMinutes: 3 } });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, 'utf8')).master.intervalMinutes).toBe(3);
    }
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

  it('loads non-object JSON as defaults and reports it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    for (const raw of ['[]', '"x"', 'null']) {
      writeFileSync(file, raw);
      const errors = { error: vi.fn() };
      expect(new SettingsStore(file, errors).get()).toEqual(DEFAULT_SETTINGS);
      expect(errors.error).toHaveBeenCalledWith('settings.invalid', expect.any(Error), {
        path: file,
        reason: 'not-an-object',
      });
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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

  it('does not mutate the shared defaults when recovering an invalid block', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = INVALID_UNIT_VALUES.budget;
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    const first = new SettingsStore(file).get();
    const second = new SettingsStore(file).get();
    expect(DEFAULT_SETTINGS.budget).toEqual({
      monthlyUsd: null,
      alertAtPercent: 80,
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
    });
    expect(DEFAULT_SETTINGS.notifications.webhook.url).toBeNull();
    expect(first.budget).toEqual(DEFAULT_SETTINGS.budget);
    expect(first.budget).not.toBe(second.budget);
    expect(first.notifications.webhook).toEqual(sentinelSettings().notifications.webhook);
    expect(first.notifications.webhook).not.toBe(second.notifications.webhook);
    warn.mockRestore();
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

  it('defaults event notifications and merges both levels across reloads', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(store.get().notifications.events).toEqual({
      failedTurns: { webhook: false, email: false },
      masterErrors: { webhook: false, email: false },
      summaryFailures: { webhook: false, email: false },
      spendOverrides: { webhook: false, email: false },
      coalesceMinutes: 60,
      routes: [],
    });

    store.patch({
      notifications: {
        webhook: {
          enabled: true,
          url: 'https://hooks.example.test/budget',
          format: 'discord',
          secret: '0123456789abcdef',
        },
        events: {
          failedTurns: { webhook: true },
          summaryFailures: { email: true },
        },
      },
    });
    const first = store.patch({
      notifications: { events: { failedTurns: { email: true } } },
    });
    expect(first.notifications.events).toEqual({
      failedTurns: { webhook: true, email: true },
      masterErrors: { webhook: false, email: false },
      summaryFailures: { webhook: false, email: true },
      spendOverrides: { webhook: false, email: false },
      coalesceMinutes: 60,
      routes: [],
    });
    expect(first.notifications.webhook).toMatchObject({
      enabled: true,
      format: 'discord',
      secret: '0123456789abcdef',
    });

    const reloaded = new SettingsStore(file).get();
    expect(reloaded.notifications.events).toEqual(first.notifications.events);
    expect(reloaded.notifications.webhook.format).toBe('discord');

    expect(() =>
      store.patch({ notifications: { events: { failedTurns: { webhook: 'yes' } } } }),
    ).toThrow();
    expect(() =>
      store.patch({
        notifications: { events: { summaryFailures: { email: 'yes' } } },
      }),
    ).toThrow();
  });

  it('persists the coalescing window and replaces cell routes wholesale', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    const route = {
      kind: 'turn.failed' as const,
      channel: 'webhook' as const,
      cellId: 'cell-a',
    };

    expect(
      store.patch({
        notifications: {
          events: { coalesceMinutes: 15, routes: [route] },
        },
      }).notifications.events,
    ).toMatchObject({ coalesceMinutes: 15, routes: [route] });

    expect(
      store.patch({
        notifications: { events: { failedTurns: { webhook: true } } },
      }).notifications.events,
    ).toMatchObject({ coalesceMinutes: 15, routes: [route] });

    expect(
      store.patch({ notifications: { events: { routes: [] } } }).notifications.events,
    ).toMatchObject({ coalesceMinutes: 15, routes: [] });

    expect(new SettingsStore(file).get().notifications.events).toMatchObject({
      coalesceMinutes: 15,
      routes: [],
    });

    expect(() =>
      store.patch({ notifications: { events: { coalesceMinutes: 0 } } }),
    ).toThrow();
    expect(() =>
      store.patch({ notifications: { events: { coalesceMinutes: 1441 } } }),
    ).toThrow();
    expect(() =>
      store.patch({
        notifications: {
          events: {
            routes: [route, { ...route }],
          },
        },
      }),
    ).toThrow();
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
    expect(settings.notifications.events).toEqual(DEFAULT_SETTINGS.notifications.events);
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

describe('settings recovery', () => {
  const topUnits = Object.keys(DEFAULT_SETTINGS).filter((block) => block !== 'notifications');
  const channelUnits = Object.keys(DEFAULT_SETTINGS.notifications).map(
    (channel) => `notifications.${channel}`,
  );

  it('has an invalid value for every top-level block and notification channel', () => {
    expect(topUnits.length).toBeGreaterThan(0);
    expect(channelUnits.length).toBeGreaterThan(0);
    for (const unit of [...topUnits, ...channelUnits]) {
      expect(INVALID_UNIT_VALUES).toHaveProperty(unit);
    }
  });

  for (const block of topUnits) {
    it(`recovers an invalid \`${block}\` block without disturbing the rest`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const saved = asMutable(sentinelSettings());
      saved[block] = INVALID_UNIT_VALUES[block];
      const file = tempFile();
      writeFileSync(file, JSON.stringify(saved));

      const errors = { error: vi.fn() };
      const loaded = new SettingsStore(file, errors).get();
      const expected = sentinelSettings();
      asMutable(expected)[block] = DEFAULT_SETTINGS[block as keyof typeof DEFAULT_SETTINGS];

      expect(loaded).toEqual(expected);
      expect(errors.error).toHaveBeenCalledTimes(1);
      expect(errors.error).toHaveBeenCalledWith('settings.invalid', expect.any(Error), {
        path: file,
        block,
      });
      warn.mockRestore();
    });
  }

  for (const channel of Object.keys(DEFAULT_SETTINGS.notifications)) {
    const unit = `notifications.${channel}`;
    it(`recovers an invalid \`${unit}\` channel without disturbing the rest`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const saved = sentinelSettings();
      asMutable(saved.notifications)[channel] = INVALID_UNIT_VALUES[unit];
      const file = tempFile();
      writeFileSync(file, JSON.stringify(saved));

      const errors = { error: vi.fn() };
      const loaded = new SettingsStore(file, errors).get();
      const expected = sentinelSettings();
      asMutable(expected.notifications)[channel] =
        DEFAULT_SETTINGS.notifications[channel as keyof typeof DEFAULT_SETTINGS.notifications];

      expect(loaded).toEqual(expected);
      expect(errors.error).toHaveBeenCalledTimes(1);
      expect(errors.error).toHaveBeenCalledWith('settings.invalid', expect.any(Error), {
        path: file,
        block: unit,
      });
      warn.mockRestore();
    });
  }

  it('keeps a saved webhook URL and secret when another block is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = 'not-an-object';
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    const loaded = new SettingsStore(file).get();
    const sentinel = sentinelSettings();
    expect(loaded.budget).toEqual(DEFAULT_SETTINGS.budget);
    expect(loaded.master).toEqual(sentinel.master);
    expect(loaded.summary).toEqual(sentinel.summary);
    expect(loaded.usage).toEqual(sentinel.usage);
    expect(loaded.retention).toEqual(sentinel.retention);
    expect(loaded.notifications).toEqual(sentinel.notifications);

    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).toContain('budget');
    expect(warned).not.toContain(sentinel.notifications.webhook.url);
    expect(warned).not.toContain(sentinel.notifications.webhook.secret);
    expect(warned).not.toContain(sentinel.notifications.email.password);
    expect(warned).not.toContain(sentinel.notifications.slack.botToken);
    warn.mockRestore();
  });

  it('reports every invalid unit when several fail', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = sentinelSettings();
    asMutable(saved).budget = INVALID_UNIT_VALUES.budget;
    asMutable(saved.notifications).webhook = INVALID_UNIT_VALUES['notifications.webhook'];
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    const errors = { error: vi.fn() };
    const loaded = new SettingsStore(file, errors).get();
    const sentinel = sentinelSettings();
    expect(loaded.budget).toEqual(DEFAULT_SETTINGS.budget);
    expect(loaded.notifications.webhook).toEqual(DEFAULT_SETTINGS.notifications.webhook);
    expect(loaded.master).toEqual(sentinel.master);
    expect(loaded.notifications.email).toEqual(sentinel.notifications.email);
    expect(loaded.notifications.slack).toEqual(sentinel.notifications.slack);
    expect(loaded.notifications.discord).toEqual(sentinel.notifications.discord);

    expect(errors.error).toHaveBeenCalledTimes(2);
    expect(errors.error).toHaveBeenCalledWith('settings.invalid', expect.any(Error), {
      path: file,
      block: 'budget',
    });
    expect(errors.error).toHaveBeenCalledWith('settings.invalid', expect.any(Error), {
      path: file,
      block: 'notifications.webhook',
    });
    warn.mockRestore();
  });

  it('leaves a partially invalid file untouched while loading', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = INVALID_UNIT_VALUES.budget;
    const file = tempFile();
    const before = `${JSON.stringify(saved)}\n`;
    writeFileSync(file, before);

    expect(new SettingsStore(file).get().notifications.webhook).toEqual(
      sentinelSettings().notifications.webhook,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
    warn.mockRestore();
  });

  it('keeps surviving blocks when a patch saves after a partial load', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = INVALID_UNIT_VALUES.budget;
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    const store = new SettingsStore(file);
    expect(store.get().budget).toEqual(DEFAULT_SETTINGS.budget);
    store.patch({ master: { intervalMinutes: 2 } });

    const sentinel = sentinelSettings();
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(written.master?.intervalMinutes).toBe(2);
    expect(written.budget).toEqual(DEFAULT_SETTINGS.budget);
    expect(written.notifications).toEqual(sentinel.notifications);

    const reloaded = new SettingsStore(file).get();
    expect(reloaded.master.intervalMinutes).toBe(2);
    expect(reloaded.summary).toEqual(sentinel.summary);
    expect(reloaded.usage).toEqual(sentinel.usage);
    expect(reloaded.retention).toEqual(sentinel.retention);
    expect(reloaded.notifications).toEqual(sentinel.notifications);
    warn.mockRestore();
  });

  it('preserves a malformed file before the first save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    const original = '{not json\n';
    writeFileSync(file, original);

    const errors = { error: vi.fn() };
    const store = new SettingsStore(file, errors);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(store.preservedPath()).toBeNull();
    expect(backupNames(file)).toEqual([]);

    store.patch({ master: { intervalMinutes: 2 } });
    const names = backupNames(file);
    expect(names).toHaveLength(1);
    const backup = backupFile(file, names[0]!);
    expect(readFileSync(backup, 'utf8')).toBe(original);
    expect(store.preservedPath()).toBe(backup);
    if (process.platform !== 'win32') {
      expect(statSync(backup).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(file, 'utf8')).master.intervalMinutes).toBe(2);

    store.patch({ master: { intervalMinutes: 3 } });
    expect(store.preservedPath()).toBe(backup);
    expect(backupNames(file)).toHaveLength(1);

    // The path is per process: a fresh store over the now-valid file has none.
    expect(new SettingsStore(file).preservedPath()).toBeNull();
    warn.mockRestore();
  });

  it('preserves the saved file when a unit recovers to its default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = INVALID_UNIT_VALUES.budget;
    const original = JSON.stringify(saved);
    const file = tempFile();
    writeFileSync(file, original);

    const store = new SettingsStore(file);
    expect(store.get().budget).toEqual(DEFAULT_SETTINGS.budget);
    expect(store.preservedPath()).toBeNull();
    expect(backupNames(file)).toEqual([]);

    store.patch({ master: { intervalMinutes: 2 } });
    const names = backupNames(file);
    expect(names).toHaveLength(1);
    expect(store.preservedPath()).toBe(backupFile(file, names[0]!));
    expect(readFileSync(backupFile(file, names[0]!), 'utf8')).toBe(original);

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(written.budget).toEqual(DEFAULT_SETTINGS.budget);
    expect(written.notifications).toEqual(sentinelSettings().notifications);

    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).not.toContain('0123456789abcdef');
    expect(logged).not.toContain('smtp-password');
    expect(logged).not.toContain('xoxb-sentinel-0123456789');
    expect(logged).not.toContain('discord-sentinel-0123456789');
    warn.mockRestore();
  });

  it('preserves a non-object top level before the first save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const original of ['[]', '"x"', 'null']) {
      const file = tempFile();
      writeFileSync(file, original);
      const store = new SettingsStore(file);
      expect(store.get()).toEqual(DEFAULT_SETTINGS);
      store.patch({ master: { intervalMinutes: 2 } });

      const names = backupNames(file);
      expect(names).toHaveLength(1);
      expect(store.preservedPath()).toBe(backupFile(file, names[0]!));
      expect(readFileSync(backupFile(file, names[0]!), 'utf8')).toBe(original);
    }
    warn.mockRestore();
  });

  it('never preserves a valid or missing file', () => {
    const file = tempFile();
    const store = new SettingsStore(file);
    expect(store.preservedPath()).toBeNull();
    store.patch({ master: { intervalMinutes: 2 } });
    store.patch({ master: { intervalMinutes: 3 } });
    expect(store.preservedPath()).toBeNull();
    expect(backupNames(file)).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8')).master.intervalMinutes).toBe(3);

    const valid = tempFile();
    writeFileSync(valid, JSON.stringify(DEFAULT_SETTINGS));
    const validStore = new SettingsStore(valid);
    validStore.patch({ master: { intervalMinutes: 4 } });
    expect(validStore.preservedPath()).toBeNull();
    expect(backupNames(valid)).toEqual([]);
  });

  it('refuses to overwrite when the unusable file cannot be copied', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = tempFile();
    mkdirSync(file);

    const errors = { error: vi.fn() };
    const store = new SettingsStore(file, errors);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.patch({ master: { intervalMinutes: 2 } })).toThrow();

    expect(errors.error).toHaveBeenCalledWith('settings.backupFailed', expect.any(Error), {
      path: file,
    });
    expect(statSync(file).isDirectory()).toBe(true);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(store.preservedPath()).toBeNull();
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
      const first = new SettingsStore(file);
      first.get();
      first.patch({ master: { intervalMinutes: 2 } });
      const firstNames = backupNames(file);
      expect(firstNames).toHaveLength(1);
      const firstBackup = backupFile(file, firstNames[0]!);

      writeFileSync(file, '{second\n');
      const second = new SettingsStore(file);
      second.get();
      second.patch({ master: { intervalMinutes: 3 } });

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

describe('settings recovery warnings', () => {
  it('is empty for a valid file and a missing file', () => {
    const valid = tempFile();
    writeFileSync(valid, JSON.stringify(sentinelSettings()));
    expect(new SettingsStore(valid).warnings()).toEqual([]);
    expect(new SettingsStore(tempFile()).warnings()).toEqual([]);
  });

  it('names a recovered block and never repeats its saved values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = INVALID_UNIT_VALUES.budget;
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    const store = new SettingsStore(file);
    const warnings = store.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.block).toBe('budget');
    expect(warnings[0]?.message).toEqual(expect.any(String));

    const text = JSON.stringify(warnings);
    expect(text).not.toContain(sentinelSettings().notifications.webhook.url);
    expect(text).not.toContain(sentinelSettings().notifications.webhook.secret);
    expect(text).not.toContain(sentinelSettings().notifications.email.password);
    expect(text).not.toContain(sentinelSettings().notifications.slack.botToken);
    warn.mockRestore();
  });

  it('lists every recovered unit in settings order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = sentinelSettings();
    asMutable(saved).master = INVALID_UNIT_VALUES.master;
    asMutable(saved).budget = INVALID_UNIT_VALUES.budget;
    asMutable(saved.notifications).webhook = INVALID_UNIT_VALUES['notifications.webhook'];
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    expect(new SettingsStore(file).warnings().map((warning) => warning.block)).toEqual([
      'master',
      'budget',
      'notifications.webhook',
    ]);
    warn.mockRestore();
  });

  it('reports one whole-file warning for malformed, non-object, or unreadable files', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const malformed = tempFile();
    writeFileSync(malformed, '{not json');
    expect(new SettingsStore(malformed).warnings()).toEqual([
      { block: null, message: expect.stringContaining('JSON') },
    ]);

    const nonObject = tempFile();
    writeFileSync(nonObject, '[]');
    expect(new SettingsStore(nonObject).warnings()).toEqual([
      { block: null, message: expect.stringContaining('JSON object') },
    ]);

    const unreadable = tempFile();
    mkdirSync(unreadable);
    expect(new SettingsStore(unreadable).warnings()).toEqual([
      { block: null, message: expect.stringContaining('could not be read') },
    ]);
    warn.mockRestore();
  });

  it('returns a copy callers cannot mutate', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = INVALID_UNIT_VALUES.budget;
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    const store = new SettingsStore(file);
    const first = store.warnings();
    first[0]!.block = 'mutated';
    first.push({ block: 'master', message: 'injected' });
    expect(store.warnings()).toEqual([
      { block: 'budget', message: expect.any(String) },
    ]);
    warn.mockRestore();
  });

  it('clears after a successful save and keeps the original aside', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = INVALID_UNIT_VALUES.budget;
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    const store = new SettingsStore(file);
    expect(store.warnings()).toHaveLength(1);
    expect(backupNames(file)).toEqual([]);

    store.patch({ master: { intervalMinutes: 2 } });
    expect(store.warnings()).toEqual([]);
    expect(backupNames(file)).toHaveLength(1);
    warn.mockRestore();
  });

  it('keeps the warnings when a patch is rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = asMutable(sentinelSettings());
    saved.budget = INVALID_UNIT_VALUES.budget;
    const file = tempFile();
    writeFileSync(file, JSON.stringify(saved));

    const store = new SettingsStore(file);
    expect(store.warnings()).toHaveLength(1);
    expect(() => store.patch({ master: { intervalMinutes: 0 } })).toThrow();
    expect(store.warnings()).toEqual([
      { block: 'budget', message: expect.any(String) },
    ]);
    warn.mockRestore();
  });
});
