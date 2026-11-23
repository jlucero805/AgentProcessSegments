import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CellDraftStore } from '../src/cells/drafts.js';
import { HarnessModelCatalog, HARDCODED_MODELS } from '../src/clarify/models.js';
import { MASTER_SESSION_ID } from '../src/clarify/engine.js';
import { buildServer } from '../src/http/server.js';
import { MasterEventRepository } from '../src/master/events.js';
import { MasterScheduler } from '../src/master/scheduler.js';
import { MasterService } from '../src/master/service.js';
import { defaultProcess } from '../src/process/defaults.js';
import { ProcessStore } from '../src/process/store.js';
import { SettingsStore } from '../src/settings.js';
import { SkillCatalog } from '../src/skills/catalog.js';
import { SummaryRepository } from '../src/summary/repository.js';
import { SummaryScheduler } from '../src/summary/scheduler.js';
import { SummaryService } from '../src/summary/service.js';
import { BudgetAlertRepository } from '../src/usage/budget-alerts.js';
import { BudgetAlertDeliveryRepository } from '../src/usage/budget-deliveries.js';
import { BudgetNotifier, type FetchLike } from '../src/usage/budget-notifier.js';
import { createBudgetUsageReader } from '../src/usage/budget-usage.js';
import { BudgetService } from '../src/usage/budgets.js';
import { createHarness, initLine, resultLine, settle, textLine, type Harness } from './helpers.js';

interface Open {
  h: Harness;
  app: FastifyInstance;
  base: string;
}

let open: Open | null = null;

async function makeApp(
  config: Partial<Harness['config']> = {},
  script?: (text: string) => string[],
  send?: FetchLike,
): Promise<Open> {
  const h = createHarness(script);
  const merged = { ...h.config, ...config };
  if (config.defaultModel !== undefined) {
    merged.defaultModels = { ...merged.defaultModels, [merged.harness]: config.defaultModel };
  }
  const settings = new SettingsStore(h.config.configPath);
  const process = new ProcessStore(h.config.processPath, () => defaultProcess(settings.get().master));
  const skills = new SkillCatalog({ home: h.config.dataDir, cwd: h.config.dataDir, env: {} });
  const masterEvents = new MasterEventRepository(h.db);
  const master = new MasterScheduler(
    new MasterService({ repo: h.repo, cells: h.cells, engine: h.engine, settings, events: masterEvents, process }),
    settings,
    h.cells,
  );
  const summaries = new SummaryRepository(h.db);
  const summary = new SummaryScheduler({
    service: new SummaryService({
      repo: h.repo,
      cells: h.cells,
      engine: h.engine,
      settings,
      events: masterEvents,
      summaries,
    }),
    settings,
    cells: h.cells,
    summaries,
  });
  const budgetAlerts = new BudgetAlertRepository(h.db);
  const notifications = new BudgetNotifier({
    deliveries: new BudgetAlertDeliveryRepository(h.db),
    alerts: budgetAlerts,
    cells: h.cells,
    settings,
    send: send ?? (async () => new Response(null, { status: 204 })),
  });
  const budgets = new BudgetService({
    usage: createBudgetUsageReader(h.usage),
    cells: h.cells,
    settings,
    alerts: budgetAlerts,
  });
  const app = await buildServer({
    repo: h.repo,
    cells: h.cells,
    drafts: new CellDraftStore(),
    kb: h.kb,
    engine: h.engine,
    models: new HarnessModelCatalog({
      claude: { probeModels: async () => null, fallbackModels: HARDCODED_MODELS },
      opencode: { probeModels: async () => null, fallbackModels: HARDCODED_MODELS },
    }),
    usage: h.usage,
    pricing: h.pricing,
    plugins: h.plugins,
    settings,
    budgets,
    notifications,
    master,
    masterEvents,
    summary,
    summaries,
    process,
    skills,
    config: { ...h.config, ...config },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  open = { h, app, base: `http://127.0.0.1:${port}` };
  return open;
}

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: () => any; text: string }> {
  if (!open) throw new Error('no server');
  const response = await fetch(`${open.base}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: () => (text === '' ? null : JSON.parse(text)),
  };
}

afterEach(async () => {
  if (open) {
    await open.app.close();
    open.h.db.close();
    open = null;
  }
});

describe('http api', () => {
  it('reports health', async () => {
    await makeApp();
    const response = await call('GET', '/health');
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('serves the help manifest, an article, and screenshot assets', async () => {
    const docsDir = path.resolve(fileURLToPath(new URL('../../../docs', import.meta.url)));
    const server = await makeApp({ docsDir });

    const manifest = await call('GET', '/api/docs');
    expect(manifest.status).toBe(200);
    const pages = manifest.json().pages as Array<{ slug: string; title: string; group: string }>;
    expect(pages[0]).toMatchObject({ slug: 'getting-started', group: 'Getting started' });
    expect(pages.map((page) => page.slug)).toContain('07-process-segments');

    const article = await call('GET', '/api/docs/07-process-segments');
    expect(article.status).toBe(200);
    expect(article.json()).toMatchObject({
      slug: '07-process-segments',
      title: 'Process segments',
      group: 'Guides',
    });
    expect(article.json().markdown).toContain('# Process segments');
    expect(article.json().updatedAt).toBeGreaterThan(0);

    const image = await fetch(`${server.base}/api/docs/assets/board.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);

    expect((await call('GET', '/api/docs/nope')).status).toBe(404);
    expect((await call('GET', '/api/docs/assets/nope.png')).status).toBe(404);
  });

  it('rejects docs asset traversal and absolute paths', async () => {
    const docsDir = path.resolve(fileURLToPath(new URL('../../../docs', import.meta.url)));
    const server = await makeApp({ docsDir });

    for (const pathname of [
      '/api/docs/assets/%2e%2e%2fREADME.md',
      '/api/docs/assets/..%2f..%2fREADME.md',
      '/api/docs/assets/%2Fetc%2Fpasswd',
      '/api/docs/assets/%2e%2e/%2e%2e/src/server/src/config.ts',
    ]) {
      const response = await fetch(`${server.base}${pathname}`);
      expect({ pathname, status: response.status }).toEqual({ pathname, status: 404 });
    }

    expect((await call('GET', '/api/docs/..%2fREADME.md')).status).toBe(404);
  });

  it('returns an empty manifest when the docs directory is missing', async () => {
    await makeApp();
    const manifest = await call('GET', '/api/docs');
    expect(manifest.status).toBe(200);
    expect(manifest.json()).toEqual({ pages: [] });
  });

  it('reports terminal availability and manages visible sessions', async () => {
    const { h } = await makeApp();
    const status = await call('GET', '/api/terminal');
    expect(status.status).toBe(200);
    expect(status.json()).toMatchObject({ available: true, cwd: h.config.terminalCwd });

    const created = await call('POST', '/api/terminals', { cols: 80, rows: 24 });
    expect(created.status).toBe(201);
    expect(created.json().alive).toBe(true);
    const list = await call('GET', '/api/terminals');
    expect(list.json()).toHaveLength(1);

    const closed = await call('DELETE', `/api/terminals/${created.json().id}`);
    expect(closed.status).toBe(204);
    expect((await call('GET', '/api/terminals')).json()).toEqual([]);
    expect((await call('DELETE', '/api/terminals/ghost')).status).toBe(404);
  });

  it('creates, reads, and lists requests', async () => {
    await makeApp();

    const created = await call('POST', '/api/requests', { title: 'First', body: 'body text' });
    expect(created.status).toBe(201);
    const request = created.json() as { id: string; state: string };
    expect(request.state).toBe('clarify');

    const fetched = await call('GET', `/api/requests/${request.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json().title).toBe('First');

    const listed = await call('GET', '/api/requests?view=intake');
    expect(listed.json()).toHaveLength(1);
  });

  it('rejects a request pointed at a missing cell', async () => {
    const { h } = await makeApp();
    const cell = h.cells.create('Alpha');

    const missing = await call('POST', '/api/requests', { title: 'x', cellId: 'ghost' });
    expect(missing.status).toBe(404);
    expect(missing.json().error).toBe('not_found');

    const created = await call('POST', '/api/requests', { title: 'x', cellId: cell.id });
    expect(created.status).toBe(201);
    expect(created.json().cellId).toBe(cell.id);

    const badPatch = await call('PATCH', `/api/requests/${created.json().id}`, {
      cellId: 'ghost',
    });
    expect(badPatch.status).toBe(404);
  });

  it('starts workflow turns without holding the response open when detach=1', async () => {
    const { h } = await makeApp({}, () => []);
    const startRequest = h.repo.create({ title: 'Detached start' });
    const dispatchRequest = h.repo.create({ title: 'Detached dispatch' });

    const started = await call(
      'POST',
      `/api/requests/${startRequest.id}/clarify/start?detach=1`,
    );
    expect(started.status).toBe(200);
    expect(started.json()).toEqual({ started: true });
    expect(h.engine.hasLive(startRequest.id)).toBe(true);

    const dispatched = await call(
      'POST',
      `/api/requests/${dispatchRequest.id}/dispatch?detach=1`,
    );
    expect(dispatched.status).toBe(200);
    expect(dispatched.json()).toEqual({ started: true });
    expect(h.repo.require(dispatchRequest.id).state).toBe('dispatch');

    await call('POST', `/api/requests/${startRequest.id}/drop`);
    await call('POST', `/api/requests/${dispatchRequest.id}/drop`);
  });

  it('maps validation, missing, and illegal transitions to the documented codes', async () => {
    await makeApp();

    const invalid = await call('POST', '/api/requests', { title: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.json().error).toBe('invalid');

    const missing = await call('GET', '/api/requests/nope');
    expect(missing.status).toBe(404);
    expect(missing.json().error).toBe('not_found');

    const created = await call('POST', '/api/requests', { title: 'x' });
    const { id } = created.json() as { id: string };

    const illegal = await call('POST', `/api/requests/${id}/transition`, { to: 'done' });
    expect(illegal.status).toBe(409);
    expect(illegal.json().error).toBe('illegal_transition');
  });

  it('patches fields and clears unchecked on seen', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Patch me' });
    h.repo.setUnchecked(request.id, true);

    const patched = await call('PATCH', `/api/requests/${request.id}`, {
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      skills: ['tdd'],
      kbDigest: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.json()).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', kbDigest: false });
    expect(patched.json().skills).toEqual(['tdd']);

    const seen = await call('POST', `/api/requests/${request.id}/seen`);
    expect(seen.json().unchecked).toBe(false);
  });

  it('reads and patches master settings through the API', async () => {
    const { h } = await makeApp();
    const before = await call('GET', '/api/config');
    expect(before.status).toBe(200);
    expect(before.json()).toMatchObject({
      path: h.config.configPath,
      master: { intervalMinutes: 5, idleMinutes: 10, enabled: true },
      usage: { retentionDays: 90 },
    });

    const patched = await call('PATCH', '/api/config', {
      master: { intervalMinutes: 7, enabled: false },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().master).toMatchObject({
      intervalMinutes: 7,
      enabled: false,
      idleMinutes: 10,
    });

    const after = await call('GET', '/api/config');
    expect(after.json().master.intervalMinutes).toBe(7);

    const bad = await call('PATCH', '/api/config', { master: { intervalMinutes: 0 } });
    expect(bad.status).toBe(400);

    const usagePatch = await call('PATCH', '/api/config', {
      usage: { retentionDays: 30 },
    });
    expect(usagePatch.status).toBe(200);
    expect(usagePatch.json().usage).toEqual({ retentionDays: 30 });

    const afterUsage = await call('GET', '/api/config');
    expect(afterUsage.json()).toMatchObject({
      master: { intervalMinutes: 7 },
      usage: { retentionDays: 30 },
    });

    const badUsage = await call('PATCH', '/api/config', {
      usage: { retentionDays: -1 },
    });
    expect(badUsage.status).toBe(400);
  });

  it('reads and patches budget settings and exposes budget status', async () => {
    await makeApp();
    const before = await call('GET', '/api/config');
    expect(before.json().budget).toEqual({ monthlyUsd: null, alertAtPercent: 80 });

    const patched = await call('PATCH', '/api/config', {
      budget: { monthlyUsd: 250.5, alertAtPercent: 90 },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().budget).toEqual({ monthlyUsd: 250.5, alertAtPercent: 90 });

    const budgets = await call('GET', '/api/budgets');
    expect(budgets.status).toBe(200);
    expect(budgets.json()).toMatchObject({
      alertAtPercent: 90,
      usageAvailable: true,
      alerts: [],
    });
    expect(budgets.json().statuses).toHaveLength(1);
    expect(budgets.json().statuses[0]).toMatchObject({
      scope: 'overall',
      budgetUsd: 250.5,
      spendUsd: 0,
      state: 'ok',
    });

    for (const budget of [
      { monthlyUsd: 0 },
      { monthlyUsd: -1 },
      { monthlyUsd: 1_000_001 },
      { alertAtPercent: 0 },
      { alertAtPercent: 101 },
      { alertAtPercent: 80.5 },
    ]) {
      const bad = await call('PATCH', '/api/config', { budget });
      expect(bad.status).toBe(400);
    }

    const missing = await call('POST', '/api/budgets/alerts/ghost/ack');
    expect(missing.status).toBe(404);
  });

  it('patches, redacts, and reloads webhook settings', async () => {
    const { h } = await makeApp();

    const before = await call('GET', '/api/config');
    expect(before.json().notifications.webhook).toEqual({
      enabled: false,
      url: null,
      format: 'json',
      secret: null,
      secretSet: false,
    });

    const patched = await call('PATCH', '/api/config', {
      notifications: {
        webhook: {
          enabled: true,
          url: 'https://hooks.example.test/budget',
          format: 'slack',
          secret: '0123456789abcdef',
        },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().notifications.webhook).toEqual({
      enabled: true,
      url: 'https://hooks.example.test/budget',
      format: 'slack',
      secret: null,
      secretSet: true,
    });
    expect(patched.text).not.toContain('0123456789abcdef');

    const reloaded = new SettingsStore(h.config.configPath).get();
    expect(reloaded.notifications.webhook).toEqual({
      enabled: true,
      url: 'https://hooks.example.test/budget',
      format: 'slack',
      secret: '0123456789abcdef',
    });
    expect(reloaded.budget).toEqual({ monthlyUsd: null, alertAtPercent: 80 });
    expect(readFileSync(h.config.configPath, 'utf8')).toContain('0123456789abcdef');

    for (const webhook of [
      { enabled: true, url: null },
      { url: 'http://example.com/hook' },
      { url: 'https://example.com/hook#frag' },
      { format: 'teams' },
      { secret: 'short' },
    ]) {
      const bad = await call('PATCH', '/api/config', { notifications: { webhook } });
      expect(bad.status).toBe(400);
    }
    const after = await call('GET', '/api/config');
    expect(after.json().notifications.webhook.url).toBe('https://hooks.example.test/budget');
    expect(after.json().notifications.webhook.secretSet).toBe(true);
  });

  it('reports webhook delivery status', async () => {
    await makeApp();
    const status = await call('GET', '/api/notifications/status');
    expect(status.status).toBe(200);
    expect(status.json()).toEqual({
      webhook: {
        enabled: false,
        configured: false,
        format: 'json',
        pending: 0,
        failed: 0,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        lastError: null,
      },
    });
  });

  it('sends a webhook test event with the configured sender', async () => {
    let calls = 0;
    await makeApp({}, undefined, async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    });
    await call('PATCH', '/api/config', {
      notifications: {
        webhook: { enabled: false, url: 'https://hooks.example.test/budget' },
      },
    });

    const result = await call('POST', '/api/notifications/webhook/test');
    expect(result.status).toBe(200);
    expect(result.json()).toMatchObject({ ok: true, status: 204 });
    expect(calls).toBe(1);
  });

  it('returns 502 when the webhook test is rejected', async () => {
    await makeApp({}, undefined, async () => new Response(null, { status: 500 }));
    await call('PATCH', '/api/config', {
      notifications: { webhook: { url: 'https://hooks.example.test/budget' } },
    });

    const result = await call('POST', '/api/notifications/webhook/test');
    expect(result.status).toBe(502);
    expect(result.json()).toMatchObject({ ok: false, status: 500, error: 'HTTP 500' });
  });

  it('rejects a webhook test without a URL', async () => {
    await makeApp();
    const result = await call('POST', '/api/notifications/webhook/test');
    expect(result.status).toBe(400);
  });

  it('acknowledges a budget alert over HTTP', async () => {
    const { h } = await makeApp();
    h.usage.record({
      turnId: 'turn-budget',
      sessionId: 'session-budget',
      scope: 'request',
      cellId: null,
      requestId: null,
      model: null,
      effort: null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 90,
      createdAt: Date.now(),
    });
    await call('PATCH', '/api/config', {
      budget: { monthlyUsd: 100, alertAtPercent: 80 },
    });
    await call('POST', '/api/cells', { name: 'Budgeted', monthlyBudgetUsd: 100 });

    const budgets = await call('GET', '/api/budgets');
    expect(budgets.json().alerts).toHaveLength(1);
    const alert = budgets.json().alerts[0] as { id: string; threshold: string };
    expect(alert.threshold).toBe('warning');

    const acknowledged = await call('POST', `/api/budgets/alerts/${alert.id}/ack`);
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.json().acknowledgedAt).toEqual(expect.any(Number));

    const again = await call('POST', `/api/budgets/alerts/${alert.id}/ack`);
    expect(again.status).toBe(200);
    expect(again.json().acknowledgedAt).toBe(acknowledged.json().acknowledgedAt);
    expect((await call('GET', '/api/budgets')).json().alerts).toEqual([]);
  });

  it('reads and patches process segments through the API', async () => {
    await makeApp();

    const before = await call('GET', '/api/process');
    expect(before.status).toBe(200);
    expect(before.json().segments).toHaveLength(6);
    expect(before.json().path).toContain('process.json');
    const segments = before.json().segments as Array<{ id: string; enabled: boolean }>;
    const intake = segments.find((segment) => segment.id === 'intake');
    expect(intake).toBeDefined();
    intake!.enabled = true;

    const patched = await call('PATCH', '/api/process', { segments });
    expect(patched.status).toBe(200);
    expect(patched.json().segments.find((segment: { id: string }) => segment.id === 'intake').enabled).toBe(
      true,
    );

    const after = await call('GET', '/api/process');
    expect(after.json().segments.find((segment: { id: string }) => segment.id === 'intake').enabled).toBe(
      true,
    );

    const bad = await call('PATCH', '/api/process', {
      segments: [{ id: 'intake' }, { id: 'intake' }],
    });
    expect(bad.status).toBe(400);
  });

  it('reports master status, runs a cell cycle, and lists events', async () => {
    const { h } = await makeApp();
    const cell = h.cells.create('Alpha');
    const status = await call('GET', '/api/master/status');
    expect(status.status).toBe(200);
    expect(status.json()).toMatchObject({ enabled: true, running: false, intervalMinutes: 5 });

    const missing = await call('POST', '/api/master/run');
    expect(missing.status).toBe(400);

    const run = await call('POST', `/api/master/run?cellId=${cell.id}`);
    expect(run.status).toBe(200);
    expect(run.json()).toMatchObject({ prodded: 0, reviewed: 0, dispatch: 0 });

    const events = await call('GET', '/api/master/events?limit=10');
    expect(events.status).toBe(200);
    expect(Array.isArray(events.json())).toBe(true);
  });

  it('serves scorecard settings, runs a report, and lists history', async () => {
    const { h } = await makeApp({}, () => [
      initLine('scorecard-session'),
      textLine('# Scorecard\n\nQuiet window.'),
      resultLine(),
    ]);

    const config = await call('GET', '/api/config');
    expect(config.status).toBe(200);
    expect(config.json().summary).toMatchObject({
      enabled: true,
      intervalMinutes: 360,
      windowMinutes: 360,
    });

    const patched = await call('PATCH', '/api/config', {
      summary: { intervalMinutes: 120, windowMinutes: 60 },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().summary).toMatchObject({ intervalMinutes: 120, windowMinutes: 60 });
    expect(patched.json().master.intervalMinutes).toBe(5);

    const empty = await call('PATCH', '/api/config', {});
    expect(empty.status).toBe(400);

    const cell = h.cells.create('Alpha');
    const status = await call('GET', `/api/summaries/status?cellId=${cell.id}`);
    expect(status.status).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: true,
      intervalMinutes: 120,
      windowMinutes: 60,
      running: false,
      lastRunAt: null,
    });

    const run = await call('POST', `/api/summaries/run?cellId=${cell.id}`);
    expect(run.status).toBe(200);
    expect(run.json().cellId).toBe(cell.id);
    expect(run.json().content).toContain('Quiet window');
    expect(run.json().stats.cell.name).toBe('Alpha');

    const latest = await call('GET', `/api/summaries/latest?cellId=${cell.id}`);
    expect(latest.status).toBe(200);
    expect(latest.json().id).toBe(run.json().id);

    const list = await call('GET', `/api/summaries?cellId=${cell.id}&limit=5`);
    expect(list.status).toBe(200);
    expect(list.json()).toHaveLength(1);

    const all = await call('GET', '/api/summaries');
    expect(all.status).toBe(200);
    expect(all.json()).toHaveLength(1);

    expect((await call('GET', '/api/summaries/latest')).status).toBe(400);
    expect((await call('GET', '/api/summaries/latest?cellId=missing')).status).toBe(404);
    expect((await call('GET', '/api/summaries?limit=0')).status).toBe(400);
  });

  it('returns usage totals, filters, buckets, and validation errors', async () => {
    const { h } = await makeApp();
    const empty = await call('GET', '/api/usage');
    expect(empty.status).toBe(200);
    expect(empty.json()).toMatchObject({
      range: { from: null, to: null },
      totals: { turns: 0, totalTokens: 0, costUsd: null, unknownCostTurns: 0 },
      series: [],
      byModel: [],
      byCell: [],
      byRequest: [],
      coverage: { rolledThrough: null },
    });

    const base = Date.UTC(2026, 0, 1, 10);
    const cell = h.cells.create('Metered cell');
    const request = h.repo.create({ title: 'Metered request', cellId: cell.id });
    h.usage.record({
      turnId: 'turn-1',
      sessionId: request.id,
      scope: 'request',
      cellId: cell.id,
      requestId: request.id,
      model: 'model-a',
      effort: 'high',
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 5,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      costUsd: 0.01,
      createdAt: base,
    });
    h.usage.record({
      turnId: 'turn-2',
      sessionId: request.id,
      scope: 'request',
      cellId: cell.id,
      requestId: request.id,
      model: 'model-b',
      effort: null,
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
      costUsd: null,
      createdAt: base + 2 * 60 * 60 * 1000,
    });

    const filtered = await call(
      'GET',
      `/api/usage?cellId=${cell.id}&from=${base}&to=${base + 24 * 60 * 60 * 1000}&bucket=hour`,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.json()).toMatchObject({
      totals: { turns: 2, totalTokens: 197, unknownCostTurns: 1 },
      byModel: [{ key: 'model-a' }, { key: 'model-b' }],
      byCell: [{ key: cell.id, label: 'Metered cell' }],
      byRequest: [
        { key: request.id, label: 'Metered request', cellId: cell.id, cellLabel: 'Metered cell' },
      ],
    });
    expect(filtered.json().totals.costUsd).toBeCloseTo(0.01);
    expect(filtered.json().series).toHaveLength(24);

    const unknown = await call('GET', '/api/usage?cellId=missing&requestId=missing');
    expect(unknown.status).toBe(200);
    expect(unknown.json().totals.turns).toBe(0);
    expect(unknown.json().series).toEqual([]);

    expect((await call('GET', '/api/usage?bucket=week')).status).toBe(400);
    expect((await call('GET', '/api/usage?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/usage?from=10&to=5')).status).toBe(400);
    expect(
      (await call('GET', `/api/usage?from=0&to=${10_001 * 60 * 60 * 1000}&bucket=hour`)).status,
    ).toBe(400);
  });

  it('manages effective-dated model pricing and estimates unreported usage', async () => {
    const { h } = await makeApp();
    const empty = await call('GET', '/api/pricing');
    expect(empty.status).toBe(200);
    expect(empty.json()).toEqual({ prices: [] });

    const base = Date.UTC(2026, 0, 1, 10);
    const input = {
      model: 'model-a',
      effectiveFrom: base,
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 2,
      cacheReadUsdPerMtok: 0.5,
      cacheWriteUsdPerMtok: 3,
      reasoningUsdPerMtok: 4,
      source: 'https://example.com/pricing',
      note: 'list price',
    };

    expect((await call('POST', '/api/pricing', { ...input, inputUsdPerMtok: -1 })).status).toBe(400);
    expect((await call('POST', '/api/pricing', { ...input, source: '' })).status).toBe(400);
    expect((await call('POST', '/api/pricing', { ...input, effectiveFrom: 1.5 })).status).toBe(400);

    const created = await call('POST', '/api/pricing', input);
    expect(created.status).toBe(201);
    expect(created.json()).toMatchObject({
      model: 'model-a',
      effectiveFrom: base,
      inputUsdPerMtok: 1,
      source: 'https://example.com/pricing',
    });
    expect((await call('POST', '/api/pricing', input)).status).toBe(409);
    expect((await call('GET', '/api/pricing')).json().prices).toHaveLength(1);

    h.usage.record({
      turnId: 'turn-reported',
      sessionId: 'request-1',
      scope: 'request',
      cellId: null,
      requestId: null,
      model: 'model-a',
      effort: null,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.25,
      createdAt: base,
    });
    h.usage.record({
      turnId: 'turn-estimated',
      sessionId: 'request-1',
      scope: 'request',
      cellId: null,
      requestId: null,
      model: 'model-a',
      effort: null,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      createdAt: base + 1,
    });

    const usage = await call('GET', '/api/usage');
    expect(usage.status).toBe(200);
    expect(usage.json().totals).toMatchObject({
      turns: 2,
      reportedCostTurns: 1,
      estimatedCostTurns: 1,
      unpricedTurns: 0,
      unknownCostTurns: 1,
    });
    expect(usage.json().totals.costUsd).toBeCloseTo(0.25);
    expect(usage.json().totals.estimatedCostUsd).toBeCloseTo(1);
    expect(usage.json().totals.totalCostUsd).toBeCloseTo(1.25);

    const id = created.json().id as string;
    expect((await call('DELETE', `/api/pricing/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/pricing/${id}`)).status).toBe(404);
    expect((await call('GET', '/api/usage')).json().totals.estimatedCostUsd).toBeNull();
  });

  it('creates a cell with its own process and can replace it', async () => {
    await makeApp();
    const configured = (await call('GET', '/api/process')).json().segments as Array<{
      id: string;
      enabled: boolean;
    }>;
    const intake = configured.find((segment) => segment.id === 'intake');
    if (!intake) throw new Error('missing intake');
    intake.enabled = true;

    const created = await call('POST', '/api/cells', {
      name: 'Strict repo',
      process: { version: 1, segments: configured },
      masterIntervalMinutes: 3,
      maxConcurrent: 2,
      model: 'cell-model',
      effort: 'high',
      monthlyBudgetUsd: 75.5,
      autocompactPercent: 60,
    });
    expect(created.status).toBe(201);
    expect(created.json().masterIntervalMinutes).toBe(3);
    expect(created.json().maxConcurrent).toBe(2);
    expect(created.json().model).toBe('cell-model');
    expect(created.json().effort).toBe('high');
    expect(created.json().monthlyBudgetUsd).toBe(75.5);
    expect(created.json().autocompactPercent).toBe(60);
    expect(
      created
        .json()
        .process.segments.find((segment: { id: string }) => segment.id === 'intake').enabled,
    ).toBe(true);

    const detail = await call('GET', `/api/cells/${created.json().id}`);
    expect(detail.json().process.segments).toHaveLength(6);

    const compacted = await call('PATCH', `/api/cells/${created.json().id}`, {
      autocompactPercent: 75,
    });
    expect(compacted.json().autocompactPercent).toBe(75);

    const invalid = await call('PATCH', `/api/cells/${created.json().id}`, {
      autocompactPercent: 100,
    });
    expect(invalid.status).toBe(400);

    const invalidCreate = await call('POST', '/api/cells', {
      name: 'Bad threshold',
      autocompactPercent: 0,
    });
    expect(invalidCreate.status).toBe(400);

    const cleared = await call('PATCH', `/api/cells/${created.json().id}`, { process: null });
    expect(cleared.json().process).toBeNull();
  });

  it('round-trips and validates a cell monthly budget', async () => {
    await makeApp();
    const created = await call('POST', '/api/cells', {
      name: 'Budgeted',
      monthlyBudgetUsd: 75.5,
    });
    expect(created.status).toBe(201);
    expect(created.json().monthlyBudgetUsd).toBe(75.5);

    const patched = await call('PATCH', `/api/cells/${created.json().id}`, {
      monthlyBudgetUsd: 50,
    });
    expect(patched.status).toBe(200);
    expect(patched.json().monthlyBudgetUsd).toBe(50);

    const cleared = await call('PATCH', `/api/cells/${created.json().id}`, {
      monthlyBudgetUsd: null,
    });
    expect(cleared.json().monthlyBudgetUsd).toBeNull();

    for (const monthlyBudgetUsd of [0, -1, 1_000_001, 'lots']) {
      const bad = await call('PATCH', `/api/cells/${created.json().id}`, { monthlyBudgetUsd });
      expect(bad.status).toBe(400);
    }
  });

  it('toggles a cell master through the cells patch', async () => {
    await makeApp();
    const created = await call('POST', '/api/cells', { name: 'Mastered' });
    expect(created.json().masterEnabled).toBe(true);
    expect(created.json().autocompactPercent).toBe(80);

    const patched = await call('PATCH', `/api/cells/${created.json().id}`, {
      masterEnabled: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.json().masterEnabled).toBe(false);

    const listed = await call('GET', '/api/cells');
    expect(listed.json()[0].masterEnabled).toBe(false);
  });

  it('serves the clarify snapshot and reports an idle stream', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Snapshot' });

    const snapshot = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.json()).toEqual({ started: false, transcript: [], active: false });

    const idle = await call('GET', `/api/requests/${request.id}/clarify/stream`);
    expect(idle.json()).toEqual({ active: false });
  });

  it('creates cells, renames them, and detaches requests on delete', async () => {
    const { h } = await makeApp();

    const created = await call('POST', '/api/cells', { name: 'Floor 1' });
    expect(created.status).toBe(201);
    const cell = created.json() as { id: string; name: string };

    const request = h.repo.create({ title: 'In a cell', cellId: cell.id });

    const renamed = await call('PATCH', `/api/cells/${cell.id}`, { name: 'Floor One' });
    expect(renamed.json().name).toBe('Floor One');

    const removed = await call('DELETE', `/api/cells/${cell.id}`);
    expect(removed.status).toBe(204);
    expect(h.repo.require(request.id).cellId).toBeNull();

    const list = await call('GET', '/api/cells');
    expect(list.json()).toEqual([]);
  });

  it('stores knowledge-base entries', async () => {
    await makeApp();
    const created = await call('POST', '/api/kb', {
      requestId: 'r1',
      title: 'Digest',
      content: 'what we learned',
    });
    expect(created.status).toBe(201);

    const list = await call('GET', '/api/kb');
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].content).toBe('what we learned');

    const search = await call('GET', '/api/kb?q=learned');
    expect(search.json()).toHaveLength(1);
    expect(search.json()[0].requestId).toBe('r1');

    const miss = await call('GET', '/api/kb?q=absent');
    expect(miss.json()).toEqual([]);
  });

  it('indexes a digest and finishes the request', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Ship it' });
    h.repo.transition(request.id, 'dispatch');
    h.repo.transition(request.id, 'review');
    h.repo.transition(request.id, 'finalize');

    const indexed = await call('POST', `/api/requests/${request.id}/index`, {
      digest: 'The decision we keep',
      index: true,
    });

    expect(indexed.status).toBe(200);
    expect(indexed.json().state).toBe('done');
    expect(indexed.json().digest).toBe('The decision we keep');
    expect(h.kb.getByRequest(request.id)?.content).toBe('The decision we keep');
  });

  it('indexes and closes the eligible Finalize requests in a cell', async () => {
    const { h } = await makeApp();
    const alpha = h.cells.create('Alpha');
    const beta = h.cells.create('Beta');

    const finalize = (
      title: string,
      cellId: string,
      fields: { digest?: string | null; kbDigest?: boolean } = {},
    ) => {
      const request = h.repo.create({ title, cellId });
      h.repo.transition(request.id, 'dispatch');
      h.repo.transition(request.id, 'review');
      h.repo.transition(request.id, 'finalize');
      h.repo.edit(request.id, fields);
      return request;
    };

    const ready = finalize('Ready', alpha.id, { digest: 'Keep this' });
    const optedOut = finalize('Opted out', alpha.id, { digest: 'Do not store', kbDigest: false });
    const missing = finalize('Missing digest', alpha.id);
    const working = finalize('Still working', alpha.id, { digest: 'In flight' });
    h.repo.setAgentStatus(working.id, 'working');
    const otherCell = finalize('Other cell', beta.id, { digest: 'Other digest' });

    const review = h.repo.create({ title: 'Still in review', cellId: alpha.id });
    h.repo.transition(review.id, 'dispatch');
    h.repo.transition(review.id, 'review');

    const response = await call('POST', '/api/requests/index-all', { cellId: alpha.id });

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ indexed: 1, closed: 2, failed: [] });
    expect(response.json().skipped).toEqual(
      expect.arrayContaining([
        { id: missing.id, title: 'Missing digest', reason: 'no_digest' },
        { id: working.id, title: 'Still working', reason: 'working' },
      ]),
    );
    expect(h.repo.require(ready.id).state).toBe('done');
    expect(h.repo.require(optedOut.id).state).toBe('done');
    expect(h.repo.require(missing.id).state).toBe('finalize');
    expect(h.repo.require(working.id).state).toBe('finalize');
    expect(h.repo.require(review.id).state).toBe('review');
    expect(h.repo.require(otherCell.id).state).toBe('finalize');
    expect(h.kb.getByRequest(ready.id)?.content).toBe('Keep this');
    expect(h.kb.getByRequest(optedOut.id)).toBeNull();
    expect(h.kb.getByRequest(missing.id)).toBeNull();
    expect(h.kb.getByRequest(working.id)).toBeNull();
    expect(h.kb.getByRequest(otherCell.id)).toBeNull();
  });

  it('index-all scopes to all cells when cellId is omitted and rejects unknown cells', async () => {
    const { h } = await makeApp();
    const alpha = h.cells.create('Alpha');
    const beta = h.cells.create('Beta');

    const finalize = (title: string, cellId: string) => {
      const request = h.repo.create({ title, cellId });
      h.repo.transition(request.id, 'dispatch');
      h.repo.transition(request.id, 'review');
      h.repo.transition(request.id, 'finalize');
      h.repo.edit(request.id, { digest: `${title} digest` });
      return request;
    };

    const first = finalize('Alpha request', alpha.id);
    const second = finalize('Beta request', beta.id);

    const all = await call('POST', '/api/requests/index-all');
    expect(all.status).toBe(200);
    expect(all.json()).toMatchObject({ indexed: 2, closed: 2, skipped: [], failed: [] });
    expect(h.repo.require(first.id).state).toBe('done');
    expect(h.repo.require(second.id).state).toBe('done');

    const again = await call('POST', '/api/requests/index-all');
    expect(again.json()).toMatchObject({ indexed: 0, closed: 0, skipped: [], failed: [] });

    const unknown = await call('POST', '/api/requests/index-all', { cellId: 'not-a-cell' });
    expect(unknown.status).toBe(404);
  });

  it('drops a request and disposes its session', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Abandon' });

    const dropped = await call('POST', `/api/requests/${request.id}/drop`);
    expect(dropped.status).toBe(200);
    expect(dropped.json().state).toBe('dropped');
  });

  it('lists plugins and commands and maps plugin errors', async () => {
    await makeApp();

    expect((await call('GET', '/api/plugins')).json()).toEqual([]);
    expect((await call('GET', '/api/commands')).json()).toEqual([]);
    expect((await call('GET', '/api/skills')).json()).toEqual([]);

    const bad = await call('POST', '/api/plugins', { url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    expect(bad.json().error).toBe('bad_source');

    const missing = await call('DELETE', '/api/plugins/ghost');
    expect(missing.status).toBe(404);
    expect(missing.json().error).toBe('not_found');
  });

  it('falls back to the hardcoded model list when the CLI is absent', async () => {    await makeApp();
    const response = await call('GET', '/api/models');

    expect(response.status).toBe(200);
    const body = response.json() as {
      source: string;
      effortLevels: string[];
      models: unknown[];
      harness: string;
      supportsEffort: boolean;
    };
    expect(body.source).toBe('fallback');
    expect(body.effortLevels).toContain('xhigh');
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.harness).toBe('claude');
    expect(body.supportsEffort).toBe(true);
  });

  it('reports an OpenCode harness without effort support', async () => {
    await makeApp({
      harness: 'opencode',
      harnessBin: 'opencode',
      defaultModel: 'opencode-go/deepseek-v4.1-flash',
    });
    const response = await call('GET', '/api/models');

    expect(response.status).toBe(200);
    const body = response.json() as {
      harness: string;
      supportsEffort: boolean;
      defaultModel: string | null;
    };
    expect(body.harness).toBe('opencode');
    expect(body.supportsEffort).toBe(false);
    expect(body.defaultModel).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('reports models for an explicit harness or a cell', async () => {
    await makeApp();
    const claude = await call('GET', '/api/models?harness=claude');
    expect(claude.json()).toMatchObject({
      harness: 'claude',
      supportsEffort: true,
      defaultModel: null,
    });

    const open = await call('GET', '/api/models?harness=opencode');
    expect(open.json()).toMatchObject({
      harness: 'opencode',
      supportsEffort: false,
      defaultModel: 'opencode-go/deepseek-v4.1-flash',
    });

    const created = await call('POST', '/api/cells', { name: 'Open cell', harness: 'opencode' });
    const byCell = await call('GET', `/api/models?cellId=${created.json().id}`);
    expect(byCell.json()).toMatchObject({ harness: 'opencode', supportsEffort: false });

    const inherited = await call('POST', '/api/cells', { name: 'Inherited cell' });
    const byInherited = await call('GET', `/api/models?cellId=${inherited.json().id}`);
    expect(byInherited.json()).toMatchObject({ harness: 'claude', supportsEffort: true });

    expect((await call('GET', '/api/models?harness=claude&cellId=x')).status).toBe(400);
    expect((await call('GET', '/api/models?harness=gemini')).status).toBe(400);
    expect((await call('GET', '/api/models?cellId=missing')).status).toBe(404);
  });

  it('stores a request harness override and resolves models from it', async () => {
    const { h } = await makeApp();
    const cell = await call('POST', '/api/cells', { name: 'Claude cell', harness: 'claude' });
    const created = await call('POST', '/api/requests', {
      title: 'Override harness',
      cellId: cell.json().id,
      harness: 'opencode',
    });

    expect(created.status).toBe(201);
    expect(created.json().harness).toBe('opencode');

    const byRequest = await call('GET', `/api/models?requestId=${created.json().id}`);
    expect(byRequest.status).toBe(200);
    expect(byRequest.json()).toMatchObject({
      harness: 'opencode',
      supportsEffort: false,
      defaultModel: 'opencode-go/deepseek-v4.1-flash',
    });

    h.repo.edit(created.json().id, { harness: null });
    const inherited = await call('GET', `/api/models?requestId=${created.json().id}`);
    expect(inherited.json()).toMatchObject({ harness: 'claude', supportsEffort: true });

    expect((await call('GET', '/api/models?requestId=missing')).status).toBe(404);
    expect(
      (await call('GET', `/api/models?requestId=${created.json().id}&harness=claude`)).status,
    ).toBe(400);
    expect(
      (await call('PATCH', `/api/requests/${created.json().id}`, { harness: 'gemini' })).status,
    ).toBe(400);
  });

  it('clears a request model when an edit changes the effective harness', async () => {
    const { h } = await makeApp();
    const claudeCell = await call('POST', '/api/cells', {
      name: 'Claude cell',
      harness: 'claude',
    });
    const openCell = await call('POST', '/api/cells', {
      name: 'Open cell',
      harness: 'opencode',
    });
    const created = await call('POST', '/api/requests', {
      title: 'Model reset',
      cellId: claudeCell.json().id,
    });
    h.repo.edit(created.json().id, { model: 'claude-opus-5-5' });

    const switched = await call('PATCH', `/api/requests/${created.json().id}`, {
      harness: 'opencode',
    });
    expect(switched.json()).toMatchObject({ harness: 'opencode', model: null });

    h.repo.edit(created.json().id, { model: 'claude-opus-5-5' });
    const replaced = await call('PATCH', `/api/requests/${created.json().id}`, {
      harness: 'claude',
      model: 'claude-sonnet-5-5',
    });
    expect(replaced.json()).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5' });

    h.repo.edit(created.json().id, { model: 'claude-opus-5-5', harness: null });
    const moved = await call('PATCH', `/api/requests/${created.json().id}`, {
      cellId: openCell.json().id,
    });
    expect(moved.json()).toMatchObject({ cellId: openCell.json().id, model: null });
  });

  it('validates a cell harness and clears incompatible model defaults', async () => {
    await makeApp();
    const created = await call('POST', '/api/cells', {
      name: 'Claude cell',
      harness: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    expect(created.json()).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5' });

    const switched = await call('PATCH', `/api/cells/${created.json().id}`, { harness: 'opencode' });
    expect(switched.json()).toMatchObject({ harness: 'opencode', model: null, effort: null });

    const explicit = await call('PATCH', `/api/cells/${created.json().id}`, {
      harness: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      effort: 'low',
    });
    expect(explicit.json()).toMatchObject({
      model: 'opencode-go/deepseek-v4.1-flash',
      effort: 'low',
    });

    expect((await call('POST', '/api/cells', { name: 'Bad', harness: 'gemini' })).status).toBe(400);
  });

  it('reports a live clarify turn and clears it when the turn finishes', async () => {
    const { h } = await makeApp({}, () => []);
    const request = h.repo.create({ title: 'Live snapshot' });

    const turn = await h.engine.start(request.id);
    const live = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(live.status).toBe(200);
    expect(live.json()).toMatchObject({ started: true, active: true });

    h.harness.process?.emit(resultLine());
    await turn.promise;
    await settle();

    const after = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(after.json().active).toBe(false);
  });

  it('does not serve a global master chat', async () => {
    const { h } = await makeApp();
    h.engine.note(MASTER_SESSION_ID, 'Master cycle: 1 queued, 1 prodded');

    const snapshot = await call('GET', `/api/requests/${MASTER_SESSION_ID}/clarify`);
    expect(snapshot.status).toBe(404);

    const sent = await call('POST', `/api/requests/${MASTER_SESSION_ID}/clarify/send`, {
      text: 'what are you doing?',
    });
    expect(sent.status).toBe(404);
    expect(h.harness.sessions).toHaveLength(0);
  });

  it('serves a separate master chat and status per cell', async () => {
    const { h } = await makeApp();
    const cell = h.cells.create('Alpha', null, 3);
    const session = `__master__:${cell.id}`;
    h.engine.note(session, 'Cell cycle: 1 prodded');

    const snapshot = await call('GET', `/api/requests/${session}/clarify`);
    expect(snapshot.status).toBe(200);
    expect(
      snapshot.json().transcript.some((message: { text: string }) =>
        message.text.includes('Cell cycle'),
      ),
    ).toBe(true);

    const sent = await call('POST', `/api/requests/${session}/clarify/send`, {
      text: 'what is this cell doing?',
    });
    expect(sent.status).toBe(200);
    expect(sent.text).toContain('"t":"done"');
    expect(h.harness.sessions[0]).toMatchObject({ scope: 'master', requestId: '' });

    const status = await call('GET', `/api/master/status?cellId=${cell.id}`);
    expect(status.json()).toMatchObject({ enabled: true, intervalMinutes: 3 });
  });

  it('stores and patches transient cell drafts', async () => {
    await makeApp();
    const process = (await call('GET', '/api/process')).json();
    const id = 'draft-test';
    const created = await call('PUT', `/api/cell-drafts/${id}`, {
      name: 'Draft cell',
      process: { version: 1, segments: process.segments },
      masterIntervalMinutes: 5,
      maxConcurrent: 3,
      model: null,
      effort: null,
      autocompactPercent: 70,
    });
    expect(created.status).toBe(200);
    expect(created.json().name).toBe('Draft cell');
    expect(created.json().harness).toBeNull();
    expect(created.json().autocompactPercent).toBe(70);

    const segments = created.json().process.segments as Array<{ id: string; enabled: boolean }>;
    const intake = segments.find((segment) => segment.id === 'intake');
    if (!intake) throw new Error('missing intake');
    intake.enabled = true;
    const patched = await call('PATCH', `/api/cell-drafts/${id}`, { segments });
    expect(patched.status).toBe(200);
    expect(
      patched.json().process.segments.find((segment: { id: string }) => segment.id === 'intake')
        .enabled,
    ).toBe(true);

    const targeted = await call('PATCH', `/api/cell-drafts/${id}`, {
      segmentUpdates: [
        { id: 'plan', prompt: 'Work in the AgentProcessSegments repository.' },
        { id: 'implement', followUps: { enabled: true } },
      ],
    });
    expect(targeted.status).toBe(200);
    const updatedSegments = targeted.json().process.segments as Array<{
      id: string;
      enabled: boolean;
      prompt: string;
      followUps: { enabled: boolean };
    }>;
    expect(updatedSegments.find((segment) => segment.id === 'plan')).toMatchObject({
      prompt: 'Work in the AgentProcessSegments repository.',
    });
    expect(updatedSegments.find((segment) => segment.id === 'implement')).toMatchObject({
      followUps: { enabled: true, marker: 'FOLLOW-UP:' },
    });
    expect(updatedSegments.find((segment) => segment.id === 'intake')?.enabled).toBe(true);

    const withHarness = await call('PATCH', `/api/cell-drafts/${id}`, { harness: 'opencode' });
    expect(withHarness.json().harness).toBe('opencode');

    const illegal = await call('PATCH', `/api/cell-drafts/${id}`, {
      segmentUpdates: [{ id: 'intake', advanceTo: 'dispatch' }],
    });
    expect(illegal.status).toBe(400);
    expect(illegal.json().issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'intake moves to plan by starting clarification' }),
      ]),
    );

    expect((await call('GET', `/api/cell-drafts/${id}`)).json().maxConcurrent).toBe(3);
    const compactedDraft = await call('PATCH', `/api/cell-drafts/${id}`, {
      autocompactPercent: 65,
    });
    expect(compactedDraft.json().autocompactPercent).toBe(65);
    expect((await call('DELETE', `/api/cell-drafts/${id}`)).status).toBe(204);
    expect((await call('GET', `/api/cell-drafts/${id}`)).status).toBe(404);
  });

  it('serves a transient cell-setup chat', async () => {
    const { h } = await makeApp();
    const session = '__setup__:draft-1';
    const sent = await call('POST', `/api/requests/${session}/clarify/send`, {
      text: 'suggest defaults',
    });
    expect(sent.status).toBe(200);
    expect(sent.text).toContain('"t":"done"');
    expect(h.harness.sessions[0]).toMatchObject({
      scope: 'setup',
      requestId: '',
      draftId: 'draft-1',
    });
    const snapshot = await call('GET', `/api/requests/${session}/clarify`);
    expect(snapshot.json().started).toBe(true);
  });

  it('stops a live turn over HTTP', async () => {
    const { h } = await makeApp({}, () => []);
    const request = h.repo.create({ title: 'Stop HTTP' });
    const turn = await h.engine.start(request.id);

    const stopped = await call('POST', `/api/requests/${request.id}/clarify/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.json()).toEqual({ stopped: true });

    await turn.promise;
    await settle();
    const snapshot = await call('GET', `/api/requests/${request.id}/clarify`);
    expect(snapshot.json().active).toBe(false);

    const again = await call('POST', `/api/requests/${request.id}/clarify/stop`);
    expect(again.json()).toEqual({ stopped: false });
  });

  it('vends SPA assets added after boot and keeps missing assets as 404s', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sbox-web-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><body>spa-index</body>');
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("asset")');
    await makeApp({ webDir: dir });

    const index = await call('GET', '/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('spa-index');

    const asset = await call('GET', '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.text).toContain('console.log');

    const deep = await call('GET', '/boards/abc');
    expect(deep.status).toBe(200);
    expect(deep.text).toContain('spa-index');

    const missing = await call('GET', '/assets/missing.js');
    expect(missing.status).toBe(404);
  });

  it('streams a clarify turn as NDJSON over a real socket', async () => {
    const { h } = await makeApp();
    const request = h.repo.create({ title: 'Stream me' });

    const response = await fetch(`${open?.base}/api/requests/${request.id}/clarify/start`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');

    const body = await response.text();
    const events = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { t: string; text?: string });

    expect(events.map((event) => event.t)).toContain('text');
    expect(events.at(-1)?.t).toBe('done');
    expect(h.repo.require(request.id).agentStatus).toBe('idle');
  });
});
