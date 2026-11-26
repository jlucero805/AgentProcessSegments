import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './tmp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { SpendCapOverrideRepository } from '../src/usage/spend-cap-overrides.js';
import { BudgetAlertDeliveryRepository } from '../src/usage/budget-deliveries.js';
import { NotificationEventDeliveryRepository } from '../src/notifications/event-deliveries.js';
import { NotificationService, type FetchLike } from '../src/notifications/service.js';
import type { EmailSendLike } from '../src/usage/budget-email.js';
import { BudgetService } from '../src/usage/budgets.js';
import { SpendCapEnforcer } from '../src/usage/spend-cap-enforcer.js';
import { recordUsagePruneState } from '../src/usage/prune-state.js';
import {
  createHarness,
  initLine,
  resultLine,
  settle,
  textLine,
  type ConfigOverrides,
  type Harness,
} from './helpers.js';
import { budgetPeriod, type SpendPause } from '../src/domain/budget.js';
import { masterSessionId, summarySessionId } from '../src/domain/sessions.js';
import type { ErrorSink } from '../src/logging/errors.js';

interface Open {
  h: Harness;
  app: FastifyInstance;
  base: string;
  notifications: NotificationService;
  admission: (cellId: string | null) => SpendPause | null;
}

let open: Open | null = null;

async function makeApp(
  config: ConfigOverrides = {},
  script?: (text: string) => string[],
  send?: FetchLike,
  sendEmail?: EmailSendLike,
  errors?: ErrorSink,
): Promise<Open> {
  let admission: ((cellId: string | null) => SpendPause | null) | null = null;
  let enforcement: SpendCapEnforcer | null = null;
  const h = createHarness(
    script,
    undefined,
    (cellId) => admission?.(cellId) ?? null,
    undefined,
    config,
    () => enforcement?.check(),
  );
  const settings = new SettingsStore(h.config.configPath);
  const process = new ProcessStore(h.config.processPath, () => defaultProcess(settings.get().master));
  const skills = new SkillCatalog({ home: h.config.dataDir, cwd: h.config.dataDir, env: {} });
  const masterEvents = new MasterEventRepository(h.db);
  const master = new MasterScheduler(
    new MasterService({
      repo: h.repo,
      cells: h.cells,
      engine: h.engine,
      settings,
      events: masterEvents,
      process,
      spendCap: (cellId) => admission?.(cellId) ?? null,
    }),
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
    spendCap: (cellId) => admission?.(cellId) ?? null,
  });
  const budgetAlerts = new BudgetAlertRepository(h.db);
  const notifications = new NotificationService({
    deliveries: new BudgetAlertDeliveryRepository(h.db),
    events: new NotificationEventDeliveryRepository(h.db),
    alerts: budgetAlerts,
    cells: h.cells,
    settings,
    send: send ?? (async () => new Response(null, { status: 204 })),
    ...(sendEmail ? { sendEmail } : {}),
  });
  const budgets = new BudgetService({
    usage: h.usage,
    cells: h.cells,
    settings,
    alerts: budgetAlerts,
    onEvaluated: () => enforcement?.check(),
    overrides: new SpendCapOverrideRepository(h.db),
  });
  admission = (cellId) => budgets.admission(cellId);
  enforcement = new SpendCapEnforcer({
    engine: h.engine,
    admission: (cellId) => admission?.(cellId) ?? null,
    ...(errors ? { errors } : {}),
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
    config: h.config,
    ...(errors ? { errorLog: errors } : {}),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  open = {
    h,
    app,
    base: `http://127.0.0.1:${port}`,
    notifications,
    admission: (cellId) => budgets.admission(cellId),
  };
  return open;
}

// Test responses are arbitrary JSON fixtures; each assertion narrows inline.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON is untyped by design
type JsonBody = any;

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: () => JsonBody; text: string }> {
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

function gitRepo(): string {
  const dir = tmpDir('http-git');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  );
  return dir;
}

function branchTip(repo: string, branch: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function seedDelivery(
  status: 'pending' | 'delivered' | 'failed',
  alertAtPercent = 80,
) {
  if (!open) throw new Error('no server');
  const now = Date.now();
  const alerts = new BudgetAlertRepository(open.h.db);
  const deliveries = new BudgetAlertDeliveryRepository(open.h.db);
  const alert = alerts.upsert(
    {
      scope: 'overall',
      scopeId: '',
      periodStart: budgetPeriod(now).start,
      threshold: 'warning',
      alertAtPercent,
      budgetUsd: 100,
      spendUsd: 85,
      unknownCostTurns: 0,
    },
    now,
  );
  const row = deliveries.enqueue({
    alertId: alert.id,
    channel: 'webhook',
    format: 'json',
    destinationHash: 'hash-fixture-a',
    now,
  });
  if (status === 'failed') {
    deliveries.markDelivering(row.id, now);
    deliveries.markFailed(row.id, now, 'HTTP 503');
  } else if (status === 'delivered') {
    deliveries.markDelivered(row.id, now);
  }
  return { alert, row, alerts, deliveries };
}

let eventSeed = 0;

function seedEvent(status: 'pending' | 'delivered' | 'failed' = 'failed') {
  if (!open) throw new Error('no server');
  const now = Date.now();
  const events = new NotificationEventDeliveryRepository(open.h.db);
  const requestId = `req-event-${++eventSeed}`;
  const row = events.enqueue({
    dedupeKey: `turn:${requestId}:engine.exit:process_exited_with_code_1:1`,
    kind: 'turn.failed',
    channel: 'webhook',
    format: 'json',
    destinationHash: 'event-hash-fixture',
    payloadJson: JSON.stringify({
      turnId: `turn-${requestId}`,
      requestId,
      requestTitle: 'Fix the parser',
      state: 'implement',
      cellId: null,
      harness: 'opencode',
      model: null,
      source: 'engine.exit',
      reason: 'process exited with code 1',
      occurredAt: now,
    }),
    now,
  });
  if (status === 'failed') {
    events.markDelivering(row.id, now);
    events.markFailed(row.id, now, 'HTTP 503');
  } else if (status === 'delivered') {
    events.markDelivered(row.id, now);
  }
  return { row, events };
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
      retention: { masterEventsDays: 90, cellSummariesDays: 90, requestArtifactsDays: 30, budgetAlertsDays: 400 },
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

    const retentionPatch = await call('PATCH', '/api/config', {
      retention: { masterEventsDays: 30 },
    });
    expect(retentionPatch.status).toBe(200);
    expect(retentionPatch.json().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 90,
      requestArtifactsDays: 30,
      budgetAlertsDays: 400,
    });

    const afterRetention = await call('GET', '/api/config');
    expect(afterRetention.json()).toMatchObject({
      master: { intervalMinutes: 7 },
      usage: { retentionDays: 30 },
      retention: { masterEventsDays: 30, cellSummariesDays: 90, requestArtifactsDays: 30, budgetAlertsDays: 400 },
    });

    const summaryRetentionPatch = await call('PATCH', '/api/config', {
      retention: { cellSummariesDays: 30 },
    });
    expect(summaryRetentionPatch.status).toBe(200);
    expect(summaryRetentionPatch.json().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 30,
      requestArtifactsDays: 30,
      budgetAlertsDays: 400,
    });

    const artifactPatch = await call('PATCH', '/api/config', {
      retention: { requestArtifactsDays: 7 },
    });
    expect(artifactPatch.status).toBe(200);
    expect(artifactPatch.json().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 30,
      requestArtifactsDays: 7,
      budgetAlertsDays: 400,
    });

    const afterArtifact = await call('GET', '/api/config');
    expect(afterArtifact.json().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 30,
      requestArtifactsDays: 7,
      budgetAlertsDays: 400,
    });

    const budgetAlertsPatch = await call('PATCH', '/api/config', {
      retention: { budgetAlertsDays: 30 },
    });
    expect(budgetAlertsPatch.status).toBe(200);
    expect(budgetAlertsPatch.json().retention).toEqual({
      masterEventsDays: 30,
      cellSummariesDays: 30,
      requestArtifactsDays: 7,
      budgetAlertsDays: 30,
    });

    const badRetention = await call('PATCH', '/api/config', {
      retention: { masterEventsDays: 1.5 },
    });
    expect(badRetention.status).toBe(400);

    const badCellSummaries = await call('PATCH', '/api/config', {
      retention: { cellSummariesDays: -1 },
    });
    expect(badCellSummaries.status).toBe(400);

    const badArtifacts = await call('PATCH', '/api/config', {
      retention: { requestArtifactsDays: 3651 },
    });
    expect(badArtifacts.status).toBe(400);

    const badBudgetAlerts = await call('PATCH', '/api/config', {
      retention: { budgetAlertsDays: -1 },
    });
    expect(badBudgetAlerts.status).toBe(400);
  });

  it('reads and patches budget settings and exposes budget status', async () => {
    await makeApp();
    const before = await call('GET', '/api/config');
    expect(before.json().budget).toEqual({
      monthlyUsd: null,
      alertAtPercent: 80,
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
    });

    const patched = await call('PATCH', '/api/config', {
      budget: { monthlyUsd: 250.5, alertAtPercent: 90 },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().budget).toEqual({
      monthlyUsd: 250.5,
      alertAtPercent: 90,
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
    });

    const budgets = await call('GET', '/api/budgets');
    expect(budgets.status).toBe(200);
    expect(budgets.json()).not.toHaveProperty('usageAvailable');
    expect(budgets.json()).toMatchObject({
      alertAtPercent: 90,
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

  it('returns 409 before a turn when a cell hard cap is exceeded', async () => {
    await makeApp();
    const cell = await call('POST', '/api/cells', {
      name: 'Capped',
      monthlyBudgetUsd: 1,
      pauseOnExceeded: true,
    });
    expect(cell.status).toBe(201);
    const cellId = (cell.json() as { id: string }).id;
    const request = await call('POST', '/api/requests', { title: 'Blocked', cellId });
    const requestId = (request.json() as { id: string }).id;
    open?.h.usage.record({
      turnId: 'cap-turn',
      sessionId: 'cap-session',
      scope: 'request',
      cellId,
      requestId,
      model: null,
      effort: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 2,
      createdAt: Date.now(),
    });

    const budgets = await call('GET', '/api/budgets');
    expect((budgets.json() as { pauses: unknown[] }).pauses).toHaveLength(1);

    const refused = await call('POST', `/api/requests/${requestId}/clarify/start`);
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'spend_cap',
      scope: 'cell',
      cellId,
      budgetUsd: 1,
      spendUsd: 2,
    });
    const after = open!.h.repo.require(requestId);
    expect(after.clarifyStarted).toBe(false);
    expect(after.agentStatus).toBe('none');
    expect(after.state).toBe('clarify');
  });


  it('stops a live sibling when a completed turn crosses the overall cap', async () => {
    await makeApp(
      {},
      (text) =>
        text.includes('slow work')
          ? []
          : [initLine('fast-session'), resultLine('ok', { input_tokens: 10, output_tokens: 5 }, 1)],
    );
    const patched = await call('PATCH', '/api/config', {
      budget: { monthlyUsd: 1, alertAtPercent: 80, pauseOnExceeded: true },
    });
    expect(patched.status).toBe(200);
    const h = open!.h;
    const first = await call('POST', '/api/requests', { title: 'Slow' });
    const second = await call('POST', '/api/requests', { title: 'Fast' });
    const firstId = (first.json() as { id: string }).id;
    const secondId = (second.json() as { id: string }).id;

    const slow = await h.engine.send(firstId, 'slow work');
    await settle();
    const slowProcess = h.harness.process;
    const fast = await h.engine.send(secondId, 'fast work');
    await fast.promise;
    await settle();

    expect(fast.stoppedBy).toBeNull();
    expect(slow.stoppedBy).toMatchObject({ scope: 'overall' });
    expect(slow.events.some((event) => event.t === 'paused')).toBe(true);
    expect(slowProcess?.killed).toBe(true);
    expect(h.repo.require(firstId).agentStatus).toBe('idle');

    const refused = await call('POST', `/api/requests/${firstId}/clarify/send`, {
      text: 'continue',
    });
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'spend_cap', scope: 'overall' });
  });

  it('stops a live turn when a cell patch enables its cap', async () => {
    await makeApp({}, () => []);
    const cell = await call('POST', '/api/cells', {
      name: 'Capped',
      monthlyBudgetUsd: 1,
    });
    const cellId = (cell.json() as { id: string }).id;
    const request = await call('POST', '/api/requests', { title: 'Live', cellId });
    const requestId = (request.json() as { id: string }).id;
    open?.h.usage.record({
      turnId: 'cell-spend',
      sessionId: 'cell-session',
      scope: 'request',
      cellId,
      requestId,
      model: null,
      effort: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 2,
      createdAt: Date.now(),
    });

    const turn = await open!.h.engine.send(requestId, 'work');
    await settle();
    const proc = open!.h.harness.process;

    const patched = await call('PATCH', `/api/cells/${cellId}`, { pauseOnExceeded: true });
    expect(patched.status).toBe(200);
    await turn.promise;
    await settle();

    expect(turn.stoppedBy).toMatchObject({ scope: 'cell', cellId });
    expect(proc?.killed).toBe(true);
    expect(open!.h.repo.require(requestId).agentStatus).toBe('idle');
    expect(open!.h.engine.transcript(requestId).some((message) => message.text.startsWith('⏸'))).toBe(
      true,
    );
  });

  it('stops a live turn when its spend-cap override is revoked', async () => {
    await makeApp({}, () => []);
    const cell = await call('POST', '/api/cells', {
      name: 'Snoozed',
      monthlyBudgetUsd: 1,
      pauseOnExceeded: true,
    });
    const cellId = (cell.json() as { id: string }).id;
    const request = await call('POST', '/api/requests', { title: 'Live', cellId });
    const requestId = (request.json() as { id: string }).id;
    open?.h.usage.record({
      turnId: 'snooze-spend',
      sessionId: 'snooze-session',
      scope: 'request',
      cellId,
      requestId,
      model: null,
      effort: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 2,
      createdAt: Date.now(),
    });

    const granted = await call('POST', '/api/budgets/overrides', {
      scope: 'cell',
      cellId,
      minutes: 60,
    });
    expect(granted.status).toBe(201);
    const overrideId = (granted.json() as { override: { id: string } }).override.id;

    const turn = await open!.h.engine.send(requestId, 'work');
    await settle();
    const proc = open!.h.harness.process;

    const revoked = await call('DELETE', `/api/budgets/overrides/${overrideId}`);
    expect(revoked.status).toBe(200);
    await turn.promise;
    await settle();

    expect(turn.stoppedBy).toMatchObject({ scope: 'cell', cellId });
    expect(proc?.killed).toBe(true);
    expect(open!.h.repo.require(requestId).agentStatus).toBe('idle');
    expect(open!.h.engine.transcript(requestId).some((message) => message.text.startsWith('⏸'))).toBe(
      true,
    );
  });

  it('refuses a new turn with an unknown-cost reason when the cap is strict', async () => {
    await makeApp();
    const cell = await call('POST', '/api/cells', {
      name: 'Strict',
      monthlyBudgetUsd: 100,
      pauseOnExceeded: true,
      pauseOnUnknownCost: true,
    });
    const cellId = (cell.json() as { id: string }).id;
    const request = await call('POST', '/api/requests', { title: 'Blocked', cellId });
    const requestId = (request.json() as { id: string }).id;
    open?.h.usage.record({
      turnId: 'unknown-turn',
      sessionId: 'unknown-session',
      scope: 'request',
      cellId,
      requestId,
      model: 'unknown-model',
      effort: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      createdAt: Date.now(),
    });

    const budgets = await call('GET', '/api/budgets');
    const body = budgets.json() as {
      pauses: Array<{ reason: string; unpricedTurns: number }>;
    };
    expect(body.pauses).toMatchObject([
      { reason: 'unknown_cost', unpricedTurns: 1 },
    ]);

    const refused = await call('POST', `/api/requests/${requestId}/clarify/start`);
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'spend_cap',
      reason: 'unknown_cost',
      scope: 'cell',
      cellId,
      budgetUsd: 100,
      spendUsd: 0,
      unpricedTurns: 1,
    });
    const after = open!.h.repo.require(requestId);
    expect(after.clarifyStarted).toBe(false);
    expect(after.agentStatus).toBe('none');
    expect(after.state).toBe('clarify');
  });

  it('refuses manual master and summary runs when the overall cap is exceeded', async () => {
    await makeApp();
    const cell = await call('POST', '/api/cells', { name: 'Capped' });
    const cellId = (cell.json() as { id: string }).id;
    const patched = await call('PATCH', '/api/config', {
      budget: { monthlyUsd: 1, alertAtPercent: 80, pauseOnExceeded: true },
    });
    expect(patched.json()).toMatchObject({
      budget: { monthlyUsd: 1, pauseOnExceeded: true },
    });
    open?.h.usage.record({
      turnId: 'cap-overall',
      sessionId: 'cap-session',
      scope: 'master',
      cellId,
      requestId: null,
      model: null,
      effort: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 2,
      createdAt: Date.now(),
    });

    const master = await call('POST', `/api/master/run?cellId=${cellId}`);
    expect(master.status).toBe(409);
    expect(master.json()).toMatchObject({ error: 'spend_cap', scope: 'overall' });

    const summary = await call('POST', `/api/summaries/run?cellId=${cellId}`);
    expect(summary.status).toBe(409);
    expect(summary.json()).toMatchObject({ error: 'spend_cap', scope: 'overall' });
  });

  it('persists the cell pause and strict flags through create and patch', async () => {
    await makeApp();
    const created = await call('POST', '/api/cells', {
      name: 'Capped',
      monthlyBudgetUsd: 10,
      pauseOnExceeded: true,
      pauseOnUnknownCost: true,
    });
    expect(created.json()).toMatchObject({
      monthlyBudgetUsd: 10,
      pauseOnExceeded: true,
      pauseOnUnknownCost: true,
    });
    const id = (created.json() as { id: string }).id;

    const off = await call('PATCH', `/api/cells/${id}`, {
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
    });
    expect(off.json()).toMatchObject({
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
    });
    const on = await call('PATCH', `/api/cells/${id}`, {
      pauseOnExceeded: true,
      pauseOnUnknownCost: true,
    });
    expect(on.json()).toMatchObject({
      pauseOnExceeded: true,
      pauseOnUnknownCost: true,
    });

    const patched = await call('PATCH', '/api/config', {
      budget: {
        monthlyUsd: 100,
        alertAtPercent: 80,
        pauseOnExceeded: true,
        pauseOnUnknownCost: true,
      },
    });
    expect(patched.json()).toMatchObject({
      budget: { pauseOnUnknownCost: true },
    });
    const config = await call('GET', '/api/config');
    expect(config.json()).toMatchObject({
      budget: { pauseOnUnknownCost: true },
    });
  });

  it('grants, extends, and revokes a spend cap override through HTTP', async () => {
    const { h } = (await makeApp())!;
    const cell = await call('POST', '/api/cells', {
      name: 'Capped',
      monthlyBudgetUsd: 1,
      pauseOnExceeded: true,
    });
    const cellId = (cell.json() as { id: string }).id;
    const request = await call('POST', '/api/requests', { title: 'Capped work', cellId });
    const requestId = (request.json() as { id: string }).id;
    h.usage.record({
      turnId: 'cap-override-turn',
      sessionId: 'cap-override-session',
      scope: 'request',
      cellId,
      requestId,
      model: null,
      effort: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 2,
      createdAt: Date.now(),
    });

    const refused = await call('POST', `/api/requests/${requestId}/clarify/start`);
    expect(refused.status).toBe(409);
    expect(open!.admission(cellId)).toMatchObject({ scope: 'cell' });

    for (const body of [
      { scope: 'cell', cellId, minutes: 0 },
      { scope: 'overall', cellId, minutes: 60 },
      { scope: 'cell', minutes: 60 },
      { scope: 'cell', cellId, minutes: 60, note: 'x'.repeat(281) },
    ]) {
      const bad = await call('POST', '/api/budgets/overrides', body);
      expect(bad.status).toBe(400);
    }

    const unconfigured = await call('POST', '/api/budgets/overrides', {
      scope: 'overall',
      minutes: 60,
    });
    expect(unconfigured.status).toBe(409);
    expect(unconfigured.json()).toMatchObject({ error: 'cap_not_configured' });

    const granted = await call('POST', '/api/budgets/overrides', {
      scope: 'cell',
      cellId,
      minutes: 60,
      note: 'release review',
    });
    expect(granted.status).toBe(201);
    const override = granted.json().override as {
      id: string;
      expiresAt: number;
    };
    expect(granted.json()).toMatchObject({
      created: true,
      override: {
        scope: 'cell',
        cellId,
        cellName: 'Capped',
        note: 'release review',
      },
    });
    expect(open!.admission(cellId)).toBeNull();

    const extended = await call('POST', '/api/budgets/overrides', {
      scope: 'cell',
      cellId,
      minutes: 120,
    });
    expect(extended.status).toBe(200);
    expect(extended.json()).toMatchObject({
      created: false,
      override: { id: override.id },
    });
    expect(extended.json().override.expiresAt as number).toBeGreaterThan(
      override.expiresAt,
    );

    const budgets = await call('GET', '/api/budgets');
    expect(budgets.json()).toMatchObject({
      overrides: [expect.objectContaining({ id: override.id })],
    });
    expect(budgets.json().statuses[0]).toMatchObject({
      scope: 'cell',
      cellId,
      paused: true,
      overrideId: override.id,
    });

    const revoked = await call('DELETE', `/api/budgets/overrides/${override.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.json().override.revokedAt).toEqual(expect.any(Number));
    expect(open!.admission(cellId)).toMatchObject({ scope: 'cell' });

    expect((await call('DELETE', `/api/budgets/overrides/${override.id}`)).status).toBe(200);
    expect((await call('DELETE', '/api/budgets/overrides/ghost')).status).toBe(404);

    const after = await call('POST', `/api/requests/${requestId}/clarify/start`);
    expect(after.status).toBe(409);
    const state = h.repo.require(requestId);
    expect(state.clarifyStarted).toBe(false);
    expect(state.agentStatus).toBe('none');
  });

  it('returns spend cap override history with states, filters, and validation', async () => {
    const { h } = await makeApp();
    const empty = await call('GET', '/api/budgets/overrides/history');
    expect(empty.status).toBe(200);
    expect(empty.json()).toEqual({ overrides: [], total: 0, limit: 20, offset: 0 });

    const cell = await call('POST', '/api/cells', {
      name: 'History Alpha',
      monthlyBudgetUsd: 1,
      pauseOnExceeded: true,
    });
    const cellId = (cell.json() as { id: string }).id;
    const other = await call('POST', '/api/cells', {
      name: 'History Beta',
      monthlyBudgetUsd: 1,
      pauseOnExceeded: true,
    });
    const otherId = (other.json() as { id: string }).id;

    const granted = await call('POST', '/api/budgets/overrides', {
      scope: 'cell',
      cellId,
      minutes: 60,
      note: 'active window',
    });
    const activeId = (granted.json() as { override: { id: string } }).override.id;
    const extended = await call('POST', '/api/budgets/overrides', {
      scope: 'cell',
      cellId,
      minutes: 120,
    });
    expect(extended.status).toBe(200);

    const revokedGrant = await call('POST', '/api/budgets/overrides', {
      scope: 'cell',
      cellId: otherId,
      minutes: 60,
      note: 'ended early',
    });
    const revokedId = (revokedGrant.json() as { override: { id: string } }).override.id;
    expect((await call('DELETE', `/api/budgets/overrides/${revokedId}`)).status).toBe(200);

    const now = Date.now();
    const period = budgetPeriod(now);
    const periodDate = new Date(period.start);
    const priorStart = Date.UTC(
      periodDate.getUTCFullYear(),
      periodDate.getUTCMonth() - 1,
      1,
    );
    const repo = new SpendCapOverrideRepository(h.db);
    const expired = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: priorStart,
        expiresAt: priorStart + 1000,
        note: 'prior month',
      },
      now - 1000,
    );

    const history = await call('GET', '/api/budgets/overrides/history');
    expect(history.status).toBe(200);
    const body = history.json() as {
      overrides: Array<{
        id: string;
        state: string;
        cellName: string | null;
        extensionCount: number;
        lastExtendedAt: number | null;
      }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body).toMatchObject({ total: 3, limit: 20, offset: 0 });
    expect(body.overrides.find((item) => item.id === activeId)).toMatchObject({
      state: 'active',
      cellName: 'History Alpha',
      extensionCount: 1,
      lastExtendedAt: expect.any(Number),
    });
    expect(body.overrides.find((item) => item.id === revokedId)).toMatchObject({
      state: 'revoked',
      cellName: 'History Beta',
      extensionCount: 0,
      lastExtendedAt: null,
    });
    expect(body.overrides.find((item) => item.id === expired.record.id)).toMatchObject({
      state: 'expired',
      cellName: null,
      extensionCount: 0,
      lastExtendedAt: null,
    });

    const revokedHistory = await call(
      'GET',
      '/api/budgets/overrides/history?state=revoked',
    );
    expect(revokedHistory.json()).toMatchObject({
      total: 1,
      overrides: [expect.objectContaining({ id: revokedId })],
    });
    const cellHistory = await call(
      'GET',
      `/api/budgets/overrides/history?scope=cell&cellId=${encodeURIComponent(otherId)}`,
    );
    expect(cellHistory.json()).toMatchObject({
      total: 1,
      overrides: [expect.objectContaining({ id: revokedId })],
    });
    const currentHistory = await call(
      'GET',
      `/api/budgets/overrides/history?from=${period.start}`,
    );
    expect(currentHistory.json().total).toBe(2);
    const page = await call('GET', '/api/budgets/overrides/history?limit=1&offset=2');
    expect(page.json()).toMatchObject({ total: 3, limit: 1, offset: 2 });
    expect(page.json().overrides).toHaveLength(1);

    for (const query of [
      'scope=team',
      'state=gone',
      'scope=overall&cellId=abc',
      'from=20&to=10',
      'limit=0',
      'limit=101',
      'offset=-1',
    ]) {
      const bad = await call('GET', `/api/budgets/overrides/history?${query}`);
      expect(bad.status).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'invalid' });
    }

    const budgets = await call('GET', '/api/budgets');
    expect(budgets.json()).toMatchObject({
      overrides: [expect.objectContaining({ id: activeId })],
    });
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
    expect(reloaded.budget).toEqual({
      monthlyUsd: null,
      alertAtPercent: 80,
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
    });
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

  it('reports webhook and email delivery status', async () => {
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
      email: {
        enabled: false,
        configured: false,
        pending: 0,
        failed: 0,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        lastError: null,
      },
      slack: {
        enabled: false,
        configured: false,
        pending: 0,
        failed: 0,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        lastError: null,
        destinations: [],
      },
      discord: {
        enabled: false,
        configured: false,
        pending: 0,
        failed: 0,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        lastError: null,
        destinations: [],
      },
      events: {
        pending: 0,
        failed: 0,
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        lastError: null,
        byKind: {
          'turn.failed': { pending: 0, failed: 0 },
          'master.error': { pending: 0, failed: 0 },
          'summary.failed': { pending: 0, failed: 0 },
        },
      },
    });
  });

  it('patches and reloads event notification routes', async () => {
    const { h } = await makeApp();

    const before = await call('GET', '/api/config');
    expect(before.json().notifications.events).toEqual({
      failedTurns: { webhook: false, email: false },
      masterErrors: { webhook: false, email: false },
      summaryFailures: { webhook: false, email: false },
      coalesceMinutes: 60,
      routes: [],
    });

    const patched = await call('PATCH', '/api/config', {
      notifications: {
        events: {
          failedTurns: { webhook: true },
          summaryFailures: { email: true },
          coalesceMinutes: 30,
          routes: [{ kind: 'turn.failed', channel: 'webhook', cellId: 'cell-a' }],
        },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().notifications.events).toEqual({
      failedTurns: { webhook: true, email: false },
      masterErrors: { webhook: false, email: false },
      summaryFailures: { webhook: false, email: true },
      coalesceMinutes: 30,
      routes: [{ kind: 'turn.failed', channel: 'webhook', cellId: 'cell-a' }],
    });

    const further = await call('PATCH', '/api/config', {
      notifications: { events: { masterErrors: { email: true } } },
    });
    expect(further.json().notifications.events).toEqual({
      failedTurns: { webhook: true, email: false },
      masterErrors: { webhook: false, email: true },
      summaryFailures: { webhook: false, email: true },
      coalesceMinutes: 30,
      routes: [{ kind: 'turn.failed', channel: 'webhook', cellId: 'cell-a' }],
    });
    expect(new SettingsStore(h.config.configPath).get().notifications.events).toEqual(
      further.json().notifications.events,
    );

    const bad = await call('PATCH', '/api/config', {
      notifications: { events: { failedTurns: { webhook: 'yes' } } },
    });
    expect(bad.status).toBe(400);
    expect(
      (await call('GET', '/api/config')).json().notifications.events.failedTurns.webhook,
    ).toBe(true);

    const badWindow = await call('PATCH', '/api/config', {
      notifications: { events: { coalesceMinutes: 0 } },
    });
    expect(badWindow.status).toBe(400);

    const duplicate = await call('PATCH', '/api/config', {
      notifications: {
        events: {
          routes: [
            { kind: 'turn.failed', channel: 'webhook', cellId: 'cell-a' },
            { kind: 'turn.failed', channel: 'webhook', cellId: 'cell-a' },
          ],
        },
      },
    });
    expect(duplicate.status).toBe(400);
  });

  it('patches, redacts, and reloads email settings', async () => {
    const { h } = await makeApp();

    const before = await call('GET', '/api/config');
    expect(before.json().notifications.email).toEqual({
      enabled: false,
      host: null,
      port: 587,
      secure: false,
      username: null,
      password: null,
      passwordSet: false,
      from: null,
      to: [],
    });

    const patched = await call('PATCH', '/api/config', {
      notifications: {
        email: {
          enabled: true,
          host: 'smtp.example.test',
          port: 587,
          secure: false,
          username: 'aps',
          password: 'super-secret',
          from: 'APS <alerts@example.test>',
          to: ['ops@example.test'],
        },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().notifications.email).toEqual({
      enabled: true,
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      username: 'aps',
      password: null,
      passwordSet: true,
      from: 'APS <alerts@example.test>',
      to: ['ops@example.test'],
    });
    expect(patched.text).not.toContain('super-secret');

    const reloaded = new SettingsStore(h.config.configPath).get();
    expect(reloaded.notifications.email.password).toBe('super-secret');
    expect(readFileSync(h.config.configPath, 'utf8')).toContain('super-secret');

    for (const email of [
      { enabled: true, host: null },
      { port: 0 },
      { from: 'nope' },
      { to: ['Ops@example.test', 'ops@example.test'] },
      { password: null },
    ]) {
      const bad = await call('PATCH', '/api/config', { notifications: { email } });
      expect(bad.status).toBe(400);
    }
    const after = await call('GET', '/api/config');
    expect(after.json().notifications.email.host).toBe('smtp.example.test');
    expect(after.json().notifications.email.passwordSet).toBe(true);
  });

  it('sends an email test event with the configured sender', async () => {
    let calls = 0;
    const sent: Array<{ subject: string; to: string[] }> = [];
    await makeApp({}, undefined, undefined, async (_email, message) => {
      calls += 1;
      sent.push({ subject: message.subject, to: message.to });
    });
    await call('PATCH', '/api/config', {
      notifications: {
        email: {
          host: 'smtp.example.test',
          from: 'alerts@example.test',
          to: ['ops@example.test'],
        },
      },
    });

    const result = await call('POST', '/api/notifications/email/test');
    expect(result.status).toBe(200);
    expect(result.json()).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    expect(sent[0]).toEqual({
      subject: '[APS] Test budget alert',
      to: ['ops@example.test'],
    });
  });

  it('returns 502 when the email test is rejected and 400 without settings', async () => {
    await makeApp({}, undefined, undefined, async () => {
      throw new Error('smtp down');
    });
    const missing = await call('POST', '/api/notifications/email/test');
    expect(missing.status).toBe(400);

    await call('PATCH', '/api/config', {
      notifications: {
        email: {
          host: 'smtp.example.test',
          from: 'alerts@example.test',
          to: ['ops@example.test'],
        },
      },
    });
    const result = await call('POST', '/api/notifications/email/test');
    expect(result.status).toBe(502);
    expect(result.json()).toMatchObject({ ok: false, error: 'smtp error' });
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

  it('lists delivery history with snapshotted alerts and no secrets', async () => {
    await makeApp();
    const { row } = seedDelivery('failed');

    const response = await call('GET', '/api/notifications/deliveries');

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      limit: 25,
      offset: 0,
      deliveries: [
        {
          id: row.id,
          channel: 'webhook',
          format: 'json',
          status: 'failed',
          attempts: 1,
          lastError: 'HTTP 503',
          canResend: false,
          alert: {
            scope: 'overall',
            cellId: null,
            cellName: null,
            threshold: 'warning',
            alertAtPercent: 80,
            budgetUsd: 100,
            spendUsd: 85,
            unknownCostTurns: 0,
          },
        },
      ],
    });
    expect(response.text).not.toContain('hash-fixture-a');
    expect(response.text).not.toContain('hooks.example.test');
  });

  it('keeps delivery history after the alert is deleted and blocks resend', async () => {
    await makeApp();
    const { alert, row } = seedDelivery('failed');

    open!.h.db.prepare('DELETE FROM budget_alerts WHERE id = ?').run(alert.id);

    const history = await call('GET', '/api/notifications/deliveries');
    expect(history.status).toBe(200);
    expect(history.json()).toMatchObject({
      total: 1,
      deliveries: [
        {
          id: row.id,
          status: 'failed',
          canResend: false,
          alert: {
            scope: 'overall',
            cellId: null,
            cellName: null,
            threshold: 'warning',
            alertAtPercent: 80,
            budgetUsd: 100,
            spendUsd: 85,
          },
        },
      ],
    });

    const resend = await call(
      'POST',
      `/api/notifications/deliveries/${row.id}/resend`,
    );
    expect(resend.status).toBe(409);
    expect(resend.json()).toMatchObject({ error: 'alert_deleted' });
  });

  it('filters delivery history and rejects invalid queries', async () => {
    await makeApp();
    seedDelivery('failed');

    const filtered = await call(
      'GET',
      '/api/notifications/deliveries?channel=webhook&status=failed&limit=1&offset=0',
    );
    expect(filtered.status).toBe(200);
    expect(filtered.json().deliveries).toHaveLength(1);

    for (const query of [
      'channel=teams',
      'status=nope',
      'limit=0',
      'offset=-1',
      'from=5&to=5',
    ]) {
      const bad = await call('GET', `/api/notifications/deliveries?${query}`);
      expect(bad.status).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'invalid' });
    }
  });

  it('lists operational event history with safe fields and filters', async () => {
    await makeApp();
    const { row } = seedEvent('failed');
    seedDelivery('failed');

    const events = await call('GET', '/api/notifications/deliveries?source=event');
    expect(events.status).toBe(200);
    expect(events.json()).toMatchObject({
      total: 1,
      deliveries: [
        {
          id: row.id,
          source: 'event',
          channel: 'webhook',
          status: 'failed',
          lastError: 'HTTP 503',
          canResend: false,
          event: {
            kind: 'turn.failed',
            title: 'Turn failed: Fix the parser',
            text: 'Turn failed for "Fix the parser" in implement: process exited with code 1.',
            source: 'engine.exit',
            reason: 'process exited with code 1',
            cellId: null,
            cellName: null,
            turnId: expect.stringMatching(/^turn-req-event-/),
            segment: null,
          },
        },
      ],
    });
    expect(events.text).not.toContain('event-hash-fixture');
    expect(events.text).not.toContain('hooks.example.test');
    expect(events.text).not.toContain('payload_json');

    const byKind = await call('GET', '/api/notifications/deliveries?kind=turn.failed');
    expect(byKind.status).toBe(200);
    expect(byKind.json()).toMatchObject({ total: 1 });
    const summaryKind = await call('GET', '/api/notifications/deliveries?kind=summary.failed');
    expect(summaryKind.status).toBe(200);
    expect(summaryKind.json()).toMatchObject({ total: 0 });
    const budget = await call('GET', '/api/notifications/deliveries?source=budget');
    expect(budget.status).toBe(200);
    expect(budget.json().deliveries[0]).toMatchObject({ source: 'budget' });

    for (const query of [
      'source=event&kind=turn.failed',
      'alertId=a1&kind=turn.failed',
      'alertId=a1&source=event',
    ]) {
      const bad = await call('GET', `/api/notifications/deliveries?${query}`);
      expect(bad.status).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'invalid' });
    }
  });

  it('guards and resends operational event rows', async () => {
    await makeApp();
    const { row } = seedEvent('failed');
    const delivered = seedEvent('delivered');

    const blocked = await call('POST', `/api/notifications/deliveries/${row.id}/resend`);
    expect(blocked.status).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'event_disabled' });

    await call('PATCH', '/api/config', {
      notifications: {
        webhook: { enabled: true, url: 'https://hooks.example.test/events' },
        events: { failedTurns: { webhook: true } },
      },
    });
    const resent = await call('POST', `/api/notifications/deliveries/${row.id}/resend`);
    expect(resent.status).toBe(200);
    expect(resent.json()).toMatchObject({
      id: row.id,
      source: 'event',
      status: 'pending',
      attempts: 0,
      canResend: false,
    });

    const refused = await call(
      'POST',
      `/api/notifications/deliveries/${delivered.row.id}/resend`,
    );
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'already_delivered' });
  });

  it('resends a failed delivery, refuses a delivered one, and 404s unknown ids', async () => {
    await makeApp();
    await call('PATCH', '/api/config', {
      notifications: { webhook: { enabled: true, url: 'https://hooks.example.test/budget' } },
    });
    const failed = seedDelivery('failed');

    const resent = await call(
      'POST',
      `/api/notifications/deliveries/${failed.row.id}/resend`,
    );
    expect(resent.status).toBe(200);
    expect(resent.json()).toMatchObject({
      id: failed.row.id,
      status: 'pending',
      attempts: 0,
      canResend: false,
    });
    await open?.notifications.flush();

    const delivered = seedDelivery('delivered', 70);
    const refused = await call(
      'POST',
      `/api/notifications/deliveries/${delivered.row.id}/resend`,
    );
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'already_delivered' });

    const missing = await call('POST', '/api/notifications/deliveries/missing/resend');
    expect(missing.status).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not_found' });
  });

  it('returns a sanitized 500 when a resend fails internally', async () => {
    await makeApp();
    const failed = seedDelivery('failed');
    vi.spyOn(open!.notifications, 'resend').mockReturnValue({
      ok: false,
      reason: 'internal',
    });

    const response = await call(
      'POST',
      `/api/notifications/deliveries/${failed.row.id}/resend`,
    );

    expect(response.status).toBe(500);
    expect(response.json()).toEqual({ error: 'internal', message: 'resend failed' });
  });

  it('patches, redacts, and reloads chat bot settings', async () => {
    const { h } = await makeApp();
    const token = 'xoxb-0123456789abcdef';
    const before = await call('GET', '/api/config');
    expect(before.json().notifications.slack).toEqual({
      enabled: false,
      botToken: null,
      botTokenSet: false,
      destinations: [],
      defaultChannelId: null,
      routes: [],
    });

    const patched = await call('PATCH', '/api/config', {
      notifications: {
        slack: {
          enabled: true,
          botToken: token,
          destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
          defaultChannelId: 'C0123456789',
          routes: [],
        },
      },
    });
    expect(patched.status).toBe(200);
    expect(patched.json().notifications.slack).toEqual({
      enabled: true,
      botToken: null,
      botTokenSet: true,
      destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
      defaultChannelId: 'C0123456789',
      routes: [],
    });
    expect(patched.text).not.toContain(token);
    expect(new SettingsStore(h.config.configPath).get().notifications.slack.botToken).toBe(
      token,
    );

    const partial = await call('PATCH', '/api/config', {
      notifications: { slack: { routes: [{ cellId: 'cell-a', channelId: 'C0123456789' }] } },
    });
    expect(partial.status).toBe(200);
    expect(partial.json().notifications.slack.botTokenSet).toBe(true);
    expect(partial.json().notifications.slack.routes).toHaveLength(1);

    for (const slack of [
      { botToken: 'short' },
      { destinations: [{ channelId: 'ops', label: null }] },
      {
        destinations: [
          { channelId: 'C0123456789', label: null },
          { channelId: 'C0123456789', label: 'Dup' },
        ],
      },
      { defaultChannelId: 'C1111111111' },
      { routes: [{ cellId: 'cell-a', channelId: 'C1111111111' }] },
    ]) {
      const bad = await call('PATCH', '/api/config', { notifications: { slack } });
      expect(bad.status).toBe(400);
    }

    const discordBad = await call('PATCH', '/api/config', {
      notifications: {
        discord: {
          enabled: true,
          botToken: 'discord-0123456789abcdef',
          destinations: [{ channelId: 'C0123456789', label: null }],
          defaultChannelId: 'C0123456789',
          routes: [],
        },
      },
    });
    expect(discordBad.status).toBe(400);

    const after = await call('GET', '/api/config');
    expect(after.json().notifications.slack.botTokenSet).toBe(true);
    expect(after.json().notifications.slack.destinations).toEqual([
      { channelId: 'C0123456789', label: 'Ops' },
    ]);
  });

  it('rejects enabling a chat provider without its required settings', async () => {
    await makeApp();
    const noToken = await call('PATCH', '/api/config', {
      notifications: {
        slack: {
          enabled: true,
          destinations: [{ channelId: 'C0123456789', label: null }],
          defaultChannelId: 'C0123456789',
          routes: [],
        },
      },
    });
    expect(noToken.status).toBe(400);

    const noRoute = await call('PATCH', '/api/config', {
      notifications: {
        slack: {
          enabled: true,
          botToken: 'xoxb-0123456789abcdef',
          destinations: [{ channelId: 'C0123456789', label: null }],
          defaultChannelId: null,
          routes: [],
        },
      },
    });
    expect(noRoute.status).toBe(400);
  });

  it('sends Slack and Discord test messages only to configured destinations', async () => {
    const sent: string[] = [];
    await makeApp({}, undefined, async (url) => {
      sent.push(url);
      return url.includes('slack.com')
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(null, { status: 204 });
    });
    await call('PATCH', '/api/config', {
      notifications: {
        slack: {
          enabled: false,
          botToken: 'xoxb-0123456789abcdef',
          destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
          defaultChannelId: 'C0123456789',
          routes: [],
        },
        discord: {
          enabled: false,
          botToken: 'discord-0123456789abcdef',
          destinations: [{ channelId: '123456789012345678', label: 'Ops' }],
          defaultChannelId: '123456789012345678',
          routes: [],
        },
      },
    });

    const slack = await call('POST', '/api/notifications/slack/test');
    expect(slack.status).toBe(200);
    expect(slack.json()).toMatchObject({ ok: true, status: 200 });
    const discord = await call('POST', '/api/notifications/discord/test', {
      channelId: '123456789012345678',
    });
    expect(discord.status).toBe(200);
    expect(discord.json()).toMatchObject({ ok: true, status: 204 });
    expect(sent.some((url) => url.includes('slack.com'))).toBe(true);
    expect(sent.some((url) => url.includes('discord.com'))).toBe(true);

    const unknown = await call('POST', '/api/notifications/slack/test', {
      channelId: 'C1111111111',
    });
    expect(unknown.status).toBe(400);
  });

  it('returns 502 when a chat test is rejected and 400 without a token', async () => {
    await makeApp({}, undefined, async () => new Response(null, { status: 500 }));
    await call('PATCH', '/api/config', {
      notifications: {
        slack: {
          enabled: false,
          botToken: 'xoxb-0123456789abcdef',
          destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
          defaultChannelId: 'C0123456789',
          routes: [],
        },
      },
    });
    const rejected = await call('POST', '/api/notifications/slack/test');
    expect(rejected.status).toBe(502);
    expect(rejected.json()).toMatchObject({ ok: false, status: 500, error: 'HTTP 500' });

    const missing = await makeApp();
    const noToken = await call('POST', '/api/notifications/discord/test');
    expect(noToken.status).toBe(400);
    void missing;
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
    const finalize = segments.find((segment) => segment.id === 'finalize');
    expect(finalize).toBeDefined();
    finalize!.enabled = true;

    const patched = await call('PATCH', '/api/process', { segments });
    expect(patched.status).toBe(200);
    expect(patched.json().segments.find((segment: { id: string }) => segment.id === 'intake').enabled).toBe(
      true,
    );
    expect(
      patched.json().segments.find((segment: { id: string }) => segment.id === 'finalize').enabled,
    ).toBe(true);

    const after = await call('GET', '/api/process');
    expect(after.json().segments.find((segment: { id: string }) => segment.id === 'intake').enabled).toBe(
      true,
    );
    expect(
      after.json().segments.find((segment: { id: string }) => segment.id === 'finalize').enabled,
    ).toBe(true);

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
      coverage: { rolledThrough: null, retentionDays: 90, lastPrune: null },
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

    // The retention window rides on the usage payload, read per request.
    recordUsagePruneState(h.db, { ranAt: base, deletedRows: 1234 });
    expect((await call('GET', '/api/usage')).json().coverage.lastPrune).toEqual({
      ranAt: base,
      deletedRows: 1234,
    });

    await call('PATCH', '/api/config', { usage: { retentionDays: 30 } });
    expect((await call('GET', '/api/usage')).json().coverage).toEqual({
      rolledThrough: null,
      retentionDays: 30,
      lastPrune: { ranAt: base, deletedRows: 1234 },
    });
    await call('PATCH', '/api/config', { usage: { retentionDays: 0 } });
    const disabled = (await call('GET', '/api/usage')).json().coverage;
    expect(disabled.retentionDays).toBe(0);
    expect(disabled.lastPrune).toEqual({ ranAt: base, deletedRows: 1234 });
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

  it('refuses a clarify send while a turn is live', async () => {
    const { h } = await makeApp({}, () => []);
    const request = h.repo.create({ title: 'Busy' });

    const turn = await h.engine.start(request.id);
    const refused = await call('POST', `/api/requests/${request.id}/clarify/send`, {
      text: 'discarded text',
    });
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'turn_active' });

    h.harness.process?.emit(resultLine());
    await turn.promise;
    await settle();

    expect(h.harness.sessions).toHaveLength(1);
    expect(
      h.engine.transcript(request.id).some((message) => message.text === 'discarded text'),
    ).toBe(false);

    const accepted = call('POST', `/api/requests/${request.id}/clarify/send`, {
      text: 'retry now',
    });
    await settle();
    h.harness.process?.emit(resultLine());
    const response = await accepted;
    expect(response.status).toBe(200);
    expect(response.text).toContain('"t":"done"');
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

  it('removes cell activity and reserved session directories on delete', async () => {
    const { h } = await makeApp();
    const cell = h.cells.create('Doomed');
    const other = h.cells.create('Other');
    const request = h.repo.create({ title: 'In a cell', cellId: cell.id });
    const events = new MasterEventRepository(h.db);
    events.record({
      cellId: cell.id,
      requestId: request.id,
      action: 'start',
      detail: request.title,
    });
    events.record({
      cellId: cell.id,
      requestId: request.id,
      action: 'followup',
      detail: 'Add metrics',
    });
    events.record({ cellId: other.id, requestId: null, action: 'cycle', detail: '{}' });

    const requests = path.join(h.config.dataDir, 'requests');
    const masterDir = path.join(requests, masterSessionId(cell.id));
    const summaryDir = path.join(requests, summarySessionId(cell.id));
    const otherDir = path.join(requests, masterSessionId(other.id));
    for (const dir of [masterDir, summaryDir, otherDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'session.json'), '{}');
      writeFileSync(path.join(dir, 'transcript.json'), '[]');
    }

    const removed = await call('DELETE', `/api/cells/${cell.id}`);
    expect(removed.status).toBe(204);

    expect(existsSync(masterDir)).toBe(false);
    expect(existsSync(summaryDir)).toBe(false);
    expect(existsSync(otherDir)).toBe(true);
    expect(events.list({ cellId: cell.id }).map((event) => event.action)).toEqual(['followup']);
    expect(events.hasEvent(request.id, 'followup', 'Add metrics')).toBe(true);
    expect(events.list({ cellId: other.id })).toHaveLength(1);
    expect(h.repo.require(request.id).cellId).toBeNull();
  });

  it('reports session cleanup failures without failing the cell delete', async () => {
    const records: Array<{ source: string; context?: Record<string, unknown> }> = [];
    const errors: ErrorSink = {
      error(source, _error, context) {
        records.push({ source, ...(context ? { context } : {}) });
      },
    };
    const { h } = await makeApp({}, undefined, undefined, undefined, errors);
    const cell = h.cells.create('Broken cleanup');
    vi.spyOn(h.engine, 'discardSession').mockRejectedValue(new Error('cannot remove'));

    const removed = await call('DELETE', `/api/cells/${cell.id}`);
    expect(removed.status).toBe(204);
    expect(records).toEqual([
      {
        source: 'cells.cleanup',
        context: { cellId: cell.id, session: masterSessionId(cell.id) },
      },
      {
        source: 'cells.cleanup',
        context: { cellId: cell.id, session: summarySessionId(cell.id) },
      },
    ]);
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

  it('retires a legacy branch when indexing closes a request', async () => {
    const { h } = await makeApp();
    const repo = gitRepo();
    const request = h.repo.create({ title: 'Index legacy work', targetRepo: repo });
    execFileSync('git', ['-C', repo, 'branch', `sbox/${request.id}`]);
    h.repo.setBranch(request.id, `sbox/${request.id}`);
    h.repo.transition(request.id, 'dispatch');
    h.repo.transition(request.id, 'review');
    h.repo.transition(request.id, 'finalize');

    const indexed = await call('POST', `/api/requests/${request.id}/index`, {
      digest: 'Keep the legacy work',
    });

    expect(indexed.status).toBe(200);
    expect(indexed.json().state).toBe('done');
    expect(branchTip(repo, `sbox/${request.id}`)).toBeNull();
    expect(branchTip(repo, `aps/${request.id}`)).not.toBeNull();
    expect(h.repo.require(request.id).branch).toBe(`aps/${request.id}`);
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

  it('retires a legacy branch when a request is dropped', async () => {
    const { h } = await makeApp();
    const repo = gitRepo();
    const request = h.repo.create({ title: 'Drop legacy work', targetRepo: repo });
    execFileSync('git', ['-C', repo, 'branch', `sbox/${request.id}`]);
    h.repo.setBranch(request.id, `sbox/${request.id}`);

    const dropped = await call('POST', `/api/requests/${request.id}/drop`);

    expect(dropped.status).toBe(200);
    expect(dropped.json().state).toBe('dropped');
    expect(branchTip(repo, `sbox/${request.id}`)).toBeNull();
    expect(branchTip(repo, `aps/${request.id}`)).not.toBeNull();
    expect(h.repo.require(request.id).branch).toBe(`aps/${request.id}`);
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

  it('applies a makeApp defaultModel override to the reported models', async () => {
    await makeApp({
      harness: 'opencode',
      defaultModel: 'test/opencode-override',
    });

    const active = await call('GET', '/api/models');
    expect(active.json()).toMatchObject({
      harness: 'opencode',
      defaultModel: 'test/opencode-override',
    });

    const claude = await call('GET', '/api/models?harness=claude');
    expect(claude.json()).toMatchObject({ harness: 'claude', defaultModel: null });
  });

  it('uses a makeApp defaultModel override for real turns', async () => {
    const { h } = await makeApp({
      harness: 'opencode',
      defaultModel: 'test/opencode-override',
    });
    const request = h.repo.create({ title: 'Overridden default model' });

    await (await h.engine.start(request.id)).promise;
    await settle();

    expect(h.opencode.sessions[0]).toMatchObject({ model: 'test/opencode-override' });
    expect(h.harness.sessions).toHaveLength(0);
  });

  it('honors explicit per-harness defaultModels overrides from makeApp', async () => {
    await makeApp({
      defaultModels: { claude: 'test/claude-model', opencode: 'test/opencode-model' },
    });

    const claude = await call('GET', '/api/models?harness=claude');
    expect(claude.json()).toMatchObject({
      harness: 'claude',
      defaultModel: 'test/claude-model',
    });

    const opencode = await call('GET', '/api/models?harness=opencode');
    expect(opencode.json()).toMatchObject({
      harness: 'opencode',
      defaultModel: 'test/opencode-model',
    });
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
    const dir = tmpDir('web');
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

  it('does not escape webDir via encoded traversal paths', async () => {
    const dir = tmpDir('web');
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><body>spa-index</body>');
    writeFileSync(path.join(dir, '..', 'outside-web-dir.txt'), 'outside-web-dir-sentinel');
    await makeApp({ webDir: dir });

    for (const url of [
      '/../outside-web-dir.txt',
      '/%2e%2e/outside-web-dir.txt',
      '/assets/..%2f..%2foutside-web-dir.txt',
      '/assets/%2e%2e/%2e%2e/outside-web-dir.txt',
      '/assets/..%5c..%5coutside-web-dir.txt',
    ]) {
      const response = await call('GET', url);
      // The only safe outcome is that the sentinel never leaves webDir; a rejected
      // static path may surface as 403/404, the SPA fallback, or the app's generic 500.
      expect(response.text).not.toContain('outside-web-dir-sentinel');
    }
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
