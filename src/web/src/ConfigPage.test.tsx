import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigPage } from './ConfigPage';
import { jsonResponse, makePrice, makeProcessResponse } from './test/fixtures';
import type {
  BudgetsResponse,
  Cell,
  ChatView,
  DeliveryHistoryItem,
  DeliveryHistoryResponse,
  MasterConfig,
  MasterEvent,
  ModelPrice,
  ModelPriceInput,
  RetentionSettings,
  SegmentConfig,
  SummaryConfig,
  UsageSettings,
} from './types';

const master: MasterConfig = {
  enabled: true,
  intervalMinutes: 5,
  idleMinutes: 10,
  autoReview: true,
  prompt: 'prod prompt',
};

const scorecard: SummaryConfig = {
  enabled: true,
  intervalMinutes: 360,
  windowMinutes: 360,
  prompt: 'summary prompt',
};

const usage: UsageSettings = { retentionDays: 90 };
const retention: RetentionSettings = {
  masterEventsDays: 90,
  cellSummariesDays: 90,
  requestArtifactsDays: 30,
  budgetAlertsDays: 400,
};

const cell: Cell = {
  id: 'c1',
  name: 'Alpha',
  masterEnabled: true,
  masterIntervalMinutes: null,
  maxConcurrent: 3,
  harness: 'opencode',
  model: null,
  effort: null,
  monthlyBudgetUsd: null,
  pauseOnExceeded: false,
  pauseOnUnknownCost: false,
  autocompactPercent: 80,
  createdAt: 1,
};

const budget = {
  monthlyUsd: 100,
  alertAtPercent: 80,
  pauseOnExceeded: false,
  pauseOnUnknownCost: false,
};

const webhook: {
  enabled: boolean;
  url: string | null;
  format: 'json' | 'slack' | 'discord';
  secret: string | null;
  secretSet: boolean;
} = {
  enabled: false,
  url: null,
  format: 'json',
  secret: null,
  secretSet: false,
};

const email: {
  enabled: boolean;
  host: string | null;
  port: number;
  secure: boolean;
  username: string | null;
  password: null;
  passwordSet: boolean;
  from: string | null;
  to: string[];
} = {
  enabled: false,
  host: null,
  port: 587,
  secure: false,
  username: null,
  password: null,
  passwordSet: false,
  from: null,
  to: [],
};

const emptyChat: ChatView = {
  enabled: false,
  botToken: null,
  botTokenSet: false,
  destinations: [],
  defaultChannelId: null,
  routes: [],
};

const eventSettings = {
  failedTurns: { webhook: false, email: false },
  masterErrors: { webhook: false, email: false },
  summaryFailures: { webhook: false, email: false },
};

const notificationStatus = {
  webhook: {
    enabled: false,
    configured: false,
    format: 'json' as const,
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
    pending: 2,
    failed: 1,
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
    lastError: null,
    byKind: {
      'turn.failed': { pending: 1, failed: 1 },
      'master.error': { pending: 1, failed: 0 },
      'summary.failed': { pending: 0, failed: 0 },
    },
  },
};

const budgetView: BudgetsResponse = {
  periodStart: Date.UTC(2026, 10, 1),
  periodEnd: Date.UTC(2026, 11, 1),
  alertAtPercent: 80,
  statuses: [
    {
      scope: 'overall',
      cellId: null,
      cellName: null,
      label: 'Overall',
      periodStart: Date.UTC(2026, 10, 1),
      periodEnd: Date.UTC(2026, 11, 1),
      budgetUsd: 100,
      spendUsd: 85,
      remainingUsd: 15,
      percentUsed: 85,
      pricedTurns: 3,
      unknownCostTurns: 1,
      spendIsLowerBound: true,
      state: 'warning',
      pauseOnExceeded: false,
      pauseOnUnknownCost: false,
      capSpendUsd: 85,
      capSpendIsLowerBound: true,
      unpricedTurns: 0,
      paused: false,
      pauseReason: null,
      overrideId: null,
      overrideExpiresAt: null,
    },
  ],
  alerts: [],
  pauses: [],
  overrides: [],
};

const deliveryRow: DeliveryHistoryItem = {
  id: 'd1',
  source: 'budget',
  alertId: 'a1',
  channel: 'webhook',
  format: 'json',
  status: 'failed',
  attempts: 5,
  nextAttemptAt: Date.UTC(2026, 10, 15, 12),
  lastError: 'HTTP 503',
  createdAt: Date.UTC(2026, 10, 15, 12),
  updatedAt: Date.UTC(2026, 10, 15, 12),
  deliveredAt: null,
  canResend: true,
  alert: {
    scope: 'overall',
    cellId: null,
    cellName: null,
    threshold: 'warning',
    alertAtPercent: 80,
    budgetUsd: 100,
    spendUsd: 85,
    unknownCostTurns: 0,
    periodStart: Date.UTC(2026, 10, 1),
    createdAt: Date.UTC(2026, 10, 15, 12),
    acknowledgedAt: null,
  },
};

const eventDeliveryRow: DeliveryHistoryItem = {
  id: 'event-1',
  source: 'event',
  channel: 'webhook',
  format: 'json',
  status: 'failed',
  attempts: 5,
  nextAttemptAt: Date.UTC(2026, 10, 15, 13),
  lastError: 'HTTP 503',
  createdAt: Date.UTC(2026, 10, 15, 13),
  updatedAt: Date.UTC(2026, 10, 15, 13),
  deliveredAt: null,
  canResend: true,
  event: {
    kind: 'turn.failed',
    title: 'Turn failed: Fix the parser',
    text: 'Turn failed for "Fix the parser" in implement, Acme: process exited with code 1.',
    source: 'engine.exit',
    reason: 'process exited with code 1',
    cellId: 'c1',
    cellName: 'Acme',
    requestId: 'r1',
    turnId: 't1',
    segment: null,
    occurredAt: Date.UTC(2026, 10, 15, 13),
  },
};

const deliveryHistory: DeliveryHistoryResponse = {
  deliveries: [deliveryRow],
  total: 1,
  limit: 10,
  offset: 0,
};

const event: MasterEvent = {
  id: 'e1',
  cellId: 'c1',
  requestId: 'r1',
  action: 'prod',
  detail: 'Build it',
  createdAt: Date.now() - 30_000,
};

interface Captured {
  config?: {
    master?: Partial<MasterConfig>;
    summary?: Partial<SummaryConfig>;
    usage?: Partial<UsageSettings>;
    retention?: Partial<RetentionSettings>;
    budget?: {
      monthlyUsd?: number | null;
      alertAtPercent?: number;
      pauseOnExceeded?: boolean;
      pauseOnUnknownCost?: boolean;
    };
    notifications?: {
      webhook?: {
        enabled?: boolean;
        url?: string | null;
        format?: string;
        secret?: string | null;
      };
      email?: {
        enabled?: boolean;
        host?: string | null;
        port?: number;
        secure?: boolean;
        username?: string | null;
        password?: string | null;
        from?: string | null;
        to?: string[];
      };
      slack?: {
        enabled?: boolean;
        botToken?: string | null;
        destinations?: Array<{ channelId: string; label: string | null }>;
        defaultChannelId?: string | null;
        routes?: Array<{ cellId: string; channelId: string }>;
      };
      discord?: {
        enabled?: boolean;
        botToken?: string | null;
        destinations?: Array<{ channelId: string; label: string | null }>;
        defaultChannelId?: string | null;
        routes?: Array<{ cellId: string; channelId: string }>;
      };
      events?: {
        failedTurns?: { webhook?: boolean; email?: boolean };
        masterErrors?: { webhook?: boolean; email?: boolean };
        summaryFailures?: { webhook?: boolean; email?: boolean };
      };
    };
  };
  process?: { segments?: SegmentConfig[] };
  cell?: { masterEnabled?: boolean };
  price?: ModelPriceInput;
  deletedPriceId?: string;
  deliveryQuery?: string;
  resendId?: string;
  override?: { scope: string; cellId?: string; minutes: number; note?: string };
  revokedOverrideId?: string;
}

function installFetch(
  view: BudgetsResponse = budgetView,
  events: MasterEvent[] = [event],
  prices: ModelPrice[] = [],
  postError?: { status: number; message: string },
  webhookTest: { ok: boolean; status?: number; durationMs?: number; error?: string } = {
    ok: true,
    status: 204,
    durationMs: 12,
  },
  webhookView: typeof webhook = webhook,
  emailView: typeof email = email,
  emailTest: { ok: boolean; durationMs?: number; error?: string } = {
    ok: true,
    durationMs: 15,
  },
  deliveriesView: DeliveryHistoryResponse = deliveryHistory,
  resendStatus = 200,
  slackView: typeof emptyChat = emptyChat,
  discordView: typeof emptyChat = emptyChat,
  slackTest: { ok: boolean; status?: number; durationMs?: number; error?: string } = {
    ok: true,
    status: 200,
    durationMs: 10,
  },
  discordTest: { ok: boolean; status?: number; durationMs?: number; error?: string } = {
    ok: true,
    status: 204,
    durationMs: 11,
  },
): Captured {
  const captured: Captured = {};
  const processResponse = makeProcessResponse();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/pricing' && init?.method === 'POST') {
      if (postError) return jsonResponse({ message: postError.message }, postError.status);
      captured.price = JSON.parse(String(init.body)) as ModelPriceInput;
      return jsonResponse(makePrice({ ...captured.price, id: 'price-new' }), 201);
    }
    if (url.startsWith('/api/pricing/') && init?.method === 'DELETE') {
      captured.deletedPriceId = decodeURIComponent(url.slice('/api/pricing/'.length));
      return jsonResponse(null, 204);
    }
    if (url === '/api/pricing') return jsonResponse({ prices });
    if (url === '/api/config' && init?.method === 'PATCH') {
      captured.config = JSON.parse(String(init.body)) as Captured['config'];
      const patchedWebhook = {
        ...webhookView,
        ...(captured.config?.notifications?.webhook ?? {}),
      };
      const emailPatch = captured.config?.notifications?.email;
      const patchedEmail = { ...emailView, ...(emailPatch ?? {}) };
      const passwordSet =
        emailPatch?.password === null
          ? false
          : emailPatch?.password !== undefined
            ? true
            : emailView.passwordSet;
      const slackPatch = captured.config?.notifications?.slack;
      const discordPatch = captured.config?.notifications?.discord;
      const patchedSlack = {
        ...slackView,
        ...(slackPatch ?? {}),
        botToken: null,
        botTokenSet:
          slackPatch?.botToken === null
            ? false
            : slackPatch?.botToken !== undefined
              ? true
              : slackView.botTokenSet,
        destinations: slackPatch?.destinations ?? slackView.destinations,
        routes: slackPatch?.routes ?? slackView.routes,
        defaultChannelId:
          slackPatch?.defaultChannelId !== undefined
            ? slackPatch.defaultChannelId
            : slackView.defaultChannelId,
      };
      const patchedDiscord = {
        ...discordView,
        ...(discordPatch ?? {}),
        botToken: null,
        botTokenSet:
          discordPatch?.botToken === null
            ? false
            : discordPatch?.botToken !== undefined
              ? true
              : discordView.botTokenSet,
        destinations: discordPatch?.destinations ?? discordView.destinations,
        routes: discordPatch?.routes ?? discordView.routes,
        defaultChannelId:
          discordPatch?.defaultChannelId !== undefined
            ? discordPatch.defaultChannelId
            : discordView.defaultChannelId,
      };
      const eventsPatch = captured.config?.notifications?.events;
      const patchedEvents = {
        failedTurns: { ...eventSettings.failedTurns, ...(eventsPatch?.failedTurns ?? {}) },
        masterErrors: { ...eventSettings.masterErrors, ...(eventsPatch?.masterErrors ?? {}) },
        summaryFailures: {
          ...eventSettings.summaryFailures,
          ...(eventsPatch?.summaryFailures ?? {}),
        },
      };
      return jsonResponse({
        master: { ...master, ...captured.config?.master },
        summary: { ...scorecard, ...captured.config?.summary },
        usage: { ...usage, ...captured.config?.usage },
        retention: { ...retention, ...captured.config?.retention },
        budget: { ...budget, ...captured.config?.budget },
        notifications: {
          webhook: {
            ...patchedWebhook,
            secret: null,
            secretSet: patchedWebhook.secret !== null,
          },
          email: { ...patchedEmail, password: null, passwordSet },
          slack: patchedSlack,
          discord: patchedDiscord,
          events: patchedEvents,
        },
        path: '/tmp/agent-process-segments/config.json',
      });
    }
    if (url === '/api/config') {
      return jsonResponse({
        master,
        summary: scorecard,
        usage,
        retention,
        budget,
        notifications: {
          webhook: webhookView,
          email: emailView,
          slack: slackView,
          discord: discordView,
          events: eventSettings,
        },
        path: '/tmp/agent-process-segments/config.json',
      });
    }
    if (url === '/api/notifications/status') return jsonResponse(notificationStatus);
    if (url.startsWith('/api/notifications/deliveries/') && init?.method === 'POST') {
      const suffix = '/resend';
      const rest = url.slice('/api/notifications/deliveries/'.length);
      captured.resendId = decodeURIComponent(rest.endsWith(suffix) ? rest.slice(0, -suffix.length) : rest);
      if (resendStatus >= 400) {
        return jsonResponse(
          { error: 'already_delivered', message: 'already delivered' },
          resendStatus,
        );
      }
      const row = deliveriesView.deliveries.find((item) => item.id === captured.resendId);
      return jsonResponse({
        ...(row ?? deliveryRow),
        status: 'pending',
        attempts: 0,
        canResend: false,
      });
    }
    if (url.startsWith('/api/notifications/deliveries')) {
      captured.deliveryQuery = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      return jsonResponse(deliveriesView);
    }
    if (url === '/api/notifications/webhook/test' && init?.method === 'POST') {
      return jsonResponse(webhookTest, webhookTest.ok ? 200 : 502);
    }
    if (url === '/api/notifications/email/test' && init?.method === 'POST') {
      return jsonResponse(emailTest, emailTest.ok ? 200 : 502);
    }
    if (url === '/api/notifications/slack/test' && init?.method === 'POST') {
      return jsonResponse(slackTest, slackTest.ok ? 200 : 502);
    }
    if (url === '/api/notifications/discord/test' && init?.method === 'POST') {
      return jsonResponse(discordTest, discordTest.ok ? 200 : 502);
    }
    if (url === '/api/budgets/overrides' && init?.method === 'POST') {
      captured.override = JSON.parse(String(init.body)) as Captured['override'];
      return jsonResponse(
        {
          override: {
            id: 'o1',
            scope: captured.override?.scope,
            cellId: captured.override?.cellId ?? null,
            cellName: null,
            periodStart: view.periodStart,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            note: captured.override?.note ?? null,
            revokedAt: null,
          },
          created: true,
        },
        201,
      );
    }
    if (url.startsWith('/api/budgets/overrides/') && init?.method === 'DELETE') {
      captured.revokedOverrideId = decodeURIComponent(
        url.slice('/api/budgets/overrides/'.length),
      );
      return jsonResponse({ override: { id: captured.revokedOverrideId } });
    }
    if (url === '/api/budgets') return jsonResponse(view);
    if (url === '/api/process' && init?.method === 'PATCH') {
      captured.process = JSON.parse(String(init.body)) as Captured['process'];
      return jsonResponse({ ...processResponse, segments: captured.process?.segments });
    }
    if (url === '/api/process') return jsonResponse(processResponse);
    if (url.startsWith('/api/master/events')) return jsonResponse(events);
    if (url === '/api/cells/c1' && init?.method === 'PATCH') {
      captured.cell = JSON.parse(String(init.body)) as Captured['cell'];
      return jsonResponse({ ...cell, ...captured.cell });
    }
    if (url === '/api/cells') return jsonResponse([cell]);
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return captured;
}

describe('ConfigPage', () => {
  it('loads settings, saves a patch, and shows the path', async () => {
    const captured = installFetch();

    render(<ConfigPage onError={() => {}} />);

    const interval = await screen.findByRole('spinbutton', { name: /interval/i });
    expect(interval).toHaveValue(5);
    expect(screen.getByRole('spinbutton', { name: /every/i })).toHaveValue(360);
    expect(screen.getByText('/tmp/agent-process-segments/config.json')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /without a cell/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Global master chat')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run master now/i })).not.toBeInTheDocument();

    fireEvent.change(interval, { target: { value: '8' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: /window/i }), {
      target: { value: '180' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await waitFor(() => expect(captured.config).toBeDefined());
    expect(captured.config?.master).toMatchObject({ intervalMinutes: 8, idleMinutes: 10 });
    expect(captured.config?.summary).toMatchObject({ intervalMinutes: 360, windowMinutes: 180 });
    expect(captured.config?.master).not.toHaveProperty('includeUnassigned');
  });

  it('loads and saves usage retention', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const retention = await screen.findByRole('spinbutton', {
      name: 'Usage retention (days)',
    });
    expect(retention).toHaveValue(90);
    expect(screen.getByText('0 keeps raw turns forever')).toBeInTheDocument();
    expect(screen.getByText(/summarized into daily totals/)).toBeInTheDocument();

    fireEvent.change(retention, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save usage retention' }));

    await waitFor(() =>
      expect(captured.config?.usage).toEqual({ retentionDays: 30 }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(retention).toHaveValue(30);
  });

  it('loads and saves master activity retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const activity = await screen.findByRole('spinbutton', {
      name: 'Activity retention (days)',
    });
    expect(activity).toHaveValue(90);
    expect(screen.getByText('0 keeps all master activity forever')).toBeInTheDocument();
    expect(screen.getByText(/activity is not rolled up/)).toBeInTheDocument();
    expect(screen.getByText(/Follow-up markers are kept/)).toBeInTheDocument();

    fireEvent.change(activity, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save activity retention' }));

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ masterEventsDays: 30 }),
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(activity).toHaveValue(30);
  });

  it('loads and saves scorecard retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const summaries = await screen.findByRole('spinbutton', {
      name: 'Scorecard retention (days)',
    });
    expect(summaries).toHaveValue(90);
    expect(
      screen.getByText('0 keeps all scorecard history forever'),
    ).toBeInTheDocument();
    expect(screen.getByText(/newest report per cell is always kept/)).toBeInTheDocument();
    expect(screen.getByText(/Scorecard history is not rolled up/)).toBeInTheDocument();

    fireEvent.change(summaries, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scorecard retention' }));

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ cellSummariesDays: 30 }),
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(summaries).toHaveValue(30);
  });

  it('loads and saves budget alert retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const alerts = await screen.findByRole('spinbutton', {
      name: 'Budget alert retention (days)',
    });
    expect(alerts).toHaveValue(400);
    expect(
      screen.getByText('0 keeps alert and delivery history forever'),
    ).toBeInTheDocument();
    expect(screen.getByText(/current UTC month is always kept/)).toBeInTheDocument();
    expect(screen.getByText(/pending and in-flight deliveries/)).toBeInTheDocument();

    fireEvent.change(alerts, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget alert retention' }));

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ budgetAlertsDays: 30 }),
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(alerts).toHaveValue(30);
  });

  it('loads and saves request artifact retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const artifacts = await screen.findByRole('spinbutton', {
      name: 'Request artifacts retention (days)',
    });
    expect(artifacts).toHaveValue(30);
    expect(
      screen.getByText('0 keeps request folders and worktrees forever'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Only done or dropped requests/)).toBeInTheDocument();
    expect(screen.getByText(/Git branches are kept/)).toBeInTheDocument();

    fireEvent.change(artifacts, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save artifact retention' }));

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ requestArtifactsDays: 7 }),
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(artifacts).toHaveValue(7);
  });

  it('toggles the master switch', async () => {
    const captured = installFetch();

    render(<ConfigPage onError={() => {}} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Master enabled' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(captured.config).toBeDefined());
    expect(captured.config?.master).toMatchObject({ enabled: false });
  });

  it('toggles a cell master', async () => {
    const captured = installFetch();

    render(<ConfigPage onError={() => {}} />);

    const cellToggle = await screen.findByRole('checkbox', { name: 'Alpha master' });
    expect(cellToggle).toBeChecked();
    fireEvent.click(cellToggle);
    await waitFor(() => expect(captured.cell).toEqual({ masterEnabled: false }));
  });

  it('shows recent activity', async () => {
    installFetch();
    render(<ConfigPage onError={() => {}} />);
    expect(await screen.findByText('Build it')).toBeInTheDocument();
    expect(screen.getByText('prod')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
  });

  it('edits the overall budget, shows status, and saves independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const monthly = await screen.findByRole('spinbutton', { name: /overall monthly budget/i });
    expect(monthly).toHaveValue(100);
    expect(screen.getByText('Overall')).toBeInTheDocument();
    expect(screen.getByText(/At least \$85\.00 of \$100\.00 \(85%\)/)).toBeInTheDocument();

    const threshold = screen.getByRole('spinbutton', { name: /alert threshold/i });
    expect(threshold).toHaveValue(80);

    const strict = screen.getByRole('checkbox', {
      name: /also pause when a turn's cost is unknown/i,
    });
    expect(strict).toBeDisabled();

    fireEvent.change(monthly, { target: { value: '250.5' } });
    fireEvent.change(threshold, { target: { value: '90' } });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /pause new work when the overall budget is exceeded/i,
      }),
    );
    expect(strict).not.toBeDisabled();
    fireEvent.click(strict);
    fireEvent.click(screen.getByRole('button', { name: 'Save budgets' }));

    await waitFor(() =>
      expect(captured.config?.budget).toEqual({
        monthlyUsd: 250.5,
        alertAtPercent: 90,
        pauseOnExceeded: true,
        pauseOnUnknownCost: true,
      }),
    );
    expect(captured.config?.master).toBeUndefined();
  });

  it('explains a strict unknown-cost pause even when spend is unknown', async () => {
    installFetch({
      ...budgetView,
      statuses: [
        {
          ...budgetView.statuses[0]!,
          state: 'unknown',
          paused: true,
          pauseReason: 'unknown_cost',
          unknownCostTurns: 2,
          unpricedTurns: 2,
          capSpendIsLowerBound: true,
        },
      ],
    });
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText(/Spend unknown/)).toBeInTheDocument();
    expect(
      screen.getByText(/Paused: 2 unpriced turns, so cost cannot be verified/i),
    ).toBeInTheDocument();
  });

  it('snoozes a paused budget and ends an active override', async () => {
    const pausedView: BudgetsResponse = {
      ...budgetView,
      statuses: [
        {
          ...budgetView.statuses[0]!,
          spendUsd: 100,
          remainingUsd: 0,
          percentUsed: 100,
          state: 'exceeded',
          capSpendUsd: 100,
          paused: true,
        },
      ],
    };
    const captured = installFetch(pausedView);
    const { unmount } = render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('paused')).toBeInTheDocument();
    expect(
      screen.getByText(/New work is paused and in-flight turns were stopped at/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Snooze overall spend' }));
    await waitFor(() =>
      expect(captured.override).toEqual({ scope: 'overall', minutes: 60 }),
    );
    unmount();

    const overrideView: BudgetsResponse = {
      ...pausedView,
      statuses: [
        {
          ...pausedView.statuses[0]!,
          overrideId: 'o1',
          overrideExpiresAt: Date.UTC(2026, 10, 15, 13),
        },
      ],
      overrides: [
        {
          id: 'o1',
          scope: 'overall',
          cellId: null,
          cellName: null,
          periodStart: Date.UTC(2026, 10, 1),
          createdAt: Date.UTC(2026, 10, 15, 12),
          updatedAt: Date.UTC(2026, 10, 15, 12),
          expiresAt: Date.UTC(2026, 10, 15, 13),
          note: null,
          revokedAt: null,
        },
      ],
    };
    const second = installFetch(overrideView);
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText(/Override active until/)).toBeInTheDocument();
    expect(screen.getByText('snoozed')).toBeInTheDocument();
    expect(
      screen.getByText(/an override is admitting new work until/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/New work is paused and in-flight turns were stopped/),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'End override for overall spend' }),
    );
    await waitFor(() => expect(second.revokedOverrideId).toBe('o1'));
  });

  it('explains a strict unknown-cost pause that an override is admitting', async () => {
    const view: BudgetsResponse = {
      ...budgetView,
      statuses: [
        {
          ...budgetView.statuses[0]!,
          state: 'unknown',
          spendUsd: 40,
          remainingUsd: 60,
          percentUsed: 40,
          capSpendUsd: 40,
          unknownCostTurns: 2,
          unpricedTurns: 2,
          paused: true,
          pauseReason: 'unknown_cost',
          overrideId: 'o1',
          overrideExpiresAt: Date.UTC(2026, 10, 15, 13),
        },
      ],
      overrides: [
        {
          id: 'o1',
          scope: 'overall',
          cellId: null,
          cellName: null,
          periodStart: Date.UTC(2026, 10, 1),
          createdAt: Date.UTC(2026, 10, 15, 12),
          updatedAt: Date.UTC(2026, 10, 15, 12),
          expiresAt: Date.UTC(2026, 10, 15, 13),
          note: null,
          revokedAt: null,
        },
      ],
    };
    installFetch(view);
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('snoozed')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Cost is unknown: 2 unpriced turns, so cost cannot be verified; an override is admitting new work until/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/New work is paused and in-flight turns were stopped/),
    ).not.toBeInTheDocument();
  });

  it('configures and saves webhook delivery', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const toggle = await screen.findByRole('checkbox', {
      name: /deliver budget alerts to a webhook/i,
    });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(/webhook url/i), {
      target: { value: 'https://hooks.example.test/budget' },
    });
    fireEvent.change(screen.getByLabelText(/payload format/i), {
      target: { value: 'slack' },
    });
    fireEvent.change(screen.getByLabelText(/signing secret/i), {
      target: { value: '0123456789abcdef' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save delivery' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.webhook).toEqual({
        enabled: true,
        url: 'https://hooks.example.test/budget',
        format: 'slack',
        secret: '0123456789abcdef',
      }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('0123456789abcdef')).not.toBeInTheDocument();
  });

  it('saves event notification routes independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const failedWebhook = await screen.findByRole('checkbox', {
      name: /failed turns by webhook/i,
    });
    const masterEmail = screen.getByRole('checkbox', {
      name: /master errors by email/i,
    });
    const summaryWebhook = screen.getByRole('checkbox', {
      name: /scorecard failures by webhook/i,
    });
    expect(failedWebhook).not.toBeChecked();
    fireEvent.click(failedWebhook);
    fireEvent.click(masterEmail);
    fireEvent.click(summaryWebhook);
    fireEvent.click(screen.getByRole('button', { name: 'Save event notifications' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.events).toEqual({
        failedTurns: { webhook: true, email: false },
        masterErrors: { webhook: false, email: true },
        summaryFailures: { webhook: true, email: false },
      }),
    );
    expect(captured.config?.notifications?.webhook).toBeUndefined();
    expect(screen.getByText(/2 pending · 1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/turns 1 pending \/ 1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/scorecard 0 pending \/ 0 failed/)).toBeInTheDocument();
  });

  it('clears a saved webhook secret only on request', async () => {
    const captured = installFetch(budgetView, [event], [], undefined, undefined, {
      ...webhook,
      enabled: true,
      url: 'https://hooks.example.test/budget',
      secretSet: true,
    });
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('A signing secret is saved.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear secret' }));
    expect(screen.getByText(/will be cleared on save/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save delivery' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.webhook).toMatchObject({
        enabled: true,
        url: 'https://hooks.example.test/budget',
        secret: null,
      }),
    );
  });

  it('shows webhook test success and failure', async () => {
    installFetch();
    const view = render(<ConfigPage onError={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test' }));
    expect(await screen.findByText(/Test delivered \(HTTP 204\)/)).toBeInTheDocument();
    view.unmount();

    installFetch(budgetView, [event], [], undefined, {
      ok: false,
      status: 500,
      error: 'HTTP 500',
    });
    render(<ConfigPage onError={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
  });

  it('configures, routes, saves, and tests a Slack bot', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const toggle = await screen.findByRole('checkbox', {
      name: /deliver budget alerts to a Slack bot/i,
    });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(/Slack bot token/i), {
      target: { value: 'xoxb-0123456789abcdef' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add destination' })[0]!);
    fireEvent.change(screen.getByLabelText(/Slack destination 1 channel ID/i), {
      target: { value: 'C0123456789' },
    });
    fireEvent.change(screen.getByLabelText(/Slack destination 1 label/i), {
      target: { value: 'Ops' },
    });
    fireEvent.change(screen.getByLabelText(/Slack default destination/i), {
      target: { value: 'C0123456789' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add route' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: 'Save Slack delivery' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.slack).toEqual({
        enabled: true,
        botToken: 'xoxb-0123456789abcdef',
        destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
        defaultChannelId: 'C0123456789',
        routes: [{ cellId: 'c1', channelId: 'C0123456789' }],
      }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('xoxb-0123456789abcdef')).not.toBeInTheDocument();

    const sendTest = screen.getAllByRole('button', { name: 'Send test' });
    fireEvent.click(sendTest[sendTest.length - 1]!);
    expect(await screen.findByText(/Test delivered \(HTTP 200\)/)).toBeInTheDocument();
  });

  it('validates a Slack channel before saving and clears a saved token', async () => {
    const errors: string[] = [];
    const captured = installFetch();
    const first = render(<ConfigPage onError={(message) => errors.push(message)} />);

    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: /deliver budget alerts to a Slack bot/i,
      }),
    );
    fireEvent.change(screen.getByLabelText(/Slack bot token/i), {
      target: { value: 'xoxb-0123456789abcdef' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add destination' })[0]!);
    fireEvent.change(screen.getByLabelText(/Slack destination 1 channel ID/i), {
      target: { value: 'not-a-channel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Slack delivery' }));
    await waitFor(() => expect(errors.join(' ')).toMatch(/Slack channel ID/));
    expect(captured.config?.notifications?.slack).toBeUndefined();
    first.unmount();

    const cleared = installFetch(
      budgetView,
      [event],
      [],
      undefined,
      undefined,
      webhook,
      email,
      undefined,
      deliveryHistory,
      200,
      {
        ...emptyChat,
        enabled: true,
        botTokenSet: true,
        destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
        defaultChannelId: 'C0123456789',
      },
    );
    render(<ConfigPage onError={() => {}} />);
    expect(await screen.findByText('A bot token is saved.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear token' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Slack delivery' }));
    await waitFor(() =>
      expect(cleared.config?.notifications?.slack).toMatchObject({ botToken: null }),
    );
  });

  it('does not render an all-unpriced budget as measured zero', async () => {
    installFetch({
      ...budgetView,
      statuses: [
        {
          ...budgetView.statuses[0]!,
          spendUsd: 0,
          remainingUsd: 100,
          percentUsed: 0,
          pricedTurns: 0,
          unknownCostTurns: 2,
          spendIsLowerBound: true,
          state: 'unknown',
        },
      ],
    });
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText(/Spend unknown · 2 unpriced turns/)).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\(0%\)/)).not.toBeInTheDocument();
  });

  it('caps recent activity so the config page stays short', async () => {
    const events: MasterEvent[] = Array.from({ length: 30 }, (_, index) => ({
      id: `e${index}`,
      cellId: null,
      requestId: null,
      action: 'prod',
      detail: `Prod ${index}`,
      createdAt: Date.now() - index * 1_000,
    }));
    installFetch(budgetView, events);
    render(<ConfigPage onError={() => {}} />);

    const list = await screen.findByRole('list', { name: 'Recent activity' });
    expect(list).toHaveClass('max-h-80', 'overflow-y-auto');
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
  });

  it('saves a per-segment process change', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const intake = await screen.findByRole('checkbox', { name: 'Automate Requests' });
    expect(intake).not.toBeChecked();
    fireEvent.click(intake);
    fireEvent.click(screen.getByRole('button', { name: 'Save process' }));

    await waitFor(() => expect(captured.process).toBeDefined());
    expect(
      captured.process?.segments?.find((segment) => segment.id === 'intake')?.enabled,
    ).toBe(true);
  });

  it('shows finalize as a manual-only segment', async () => {
    installFetch();
    render(<ConfigPage onError={() => {}} />);

    const finalize = await screen.findByRole(
      'checkbox',
      { name: 'Automate Finalize', hidden: true },
    );
    expect(finalize).toBeDisabled();
    expect(finalize).not.toBeChecked();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('never scheduled')).toBeInTheDocument();
    expect(screen.getByText(/Finalize is manual/)).toBeInTheDocument();
  });

  it('lists configured model prices with their source', async () => {
    const price = makePrice();
    installFetch(budgetView, [event], [price]);
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('model-a')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/pricing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.com/pricing' })).toHaveAttribute(
      'href',
      'https://example.com/pricing',
    );
  });

  it('adds a price with a UTC effective date and every rate', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    fireEvent.change(await screen.findByLabelText(/Model id/), {
      target: { value: 'provider/model-a' },
    });
    fireEvent.change(screen.getByLabelText(/Effective date/), {
      target: { value: '2026-02-03' },
    });
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Cache read $/1M'), { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('Cache write $/1M'), { target: { value: '3.75' } });
    fireEvent.change(screen.getByLabelText('Reasoning $/1M'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText(/Source/), {
      target: { value: 'https://example.com/pricing' },
    });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'list price' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add price' }));

    await waitFor(() => expect(captured.price).toBeDefined());
    expect(captured.price).toEqual({
      model: 'provider/model-a',
      effectiveFrom: Date.UTC(2026, 1, 3),
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
      cacheReadUsdPerMtok: 0.3,
      cacheWriteUsdPerMtok: 3.75,
      reasoningUsdPerMtok: 15,
      source: 'https://example.com/pricing',
      note: 'list price',
    });
  });

  it('blocks a price without a model, source, or complete rates', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    await screen.findByLabelText(/Model id/);
    fireEvent.click(screen.getByRole('button', { name: 'Add price' }));

    expect(
      await screen.findByText('Model, effective date, and source are required.'),
    ).toBeInTheDocument();
    expect(captured.price).toBeUndefined();
  });

  it('shows a duplicate price error from the server', async () => {
    installFetch(budgetView, [event], [], { status: 409, message: 'a price already exists for model-a' });
    render(<ConfigPage onError={() => {}} />);

    fireEvent.change(await screen.findByLabelText(/Model id/), {
      target: { value: 'model-a' },
    });
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Cache read $/1M'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Cache write $/1M'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Reasoning $/1M'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Source/), {
      target: { value: 'https://example.com/pricing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add price' }));

    expect(
      await screen.findByText('a price already exists for model-a'),
    ).toBeInTheDocument();
  });

  it('configures and saves email delivery independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const toggle = await screen.findByRole('checkbox', {
      name: /deliver budget alerts by email/i,
    });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(/smtp host/i), {
      target: { value: 'smtp.example.test' },
    });
    fireEvent.change(screen.getByLabelText(/smtp port/i), { target: { value: '465' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /implicit tls/i }));
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'aps' } });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: 'super-secret' },
    });
    fireEvent.change(screen.getByLabelText(/from address/i), {
      target: { value: 'APS <alerts@example.test>' },
    });
    fireEvent.change(screen.getByLabelText(/recipients/i), {
      target: { value: 'ops@example.test, oncall@example.test\nOPS@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save email delivery' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.email).toEqual({
        enabled: true,
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        username: 'aps',
        password: 'super-secret',
        from: 'APS <alerts@example.test>',
        to: ['ops@example.test', 'oncall@example.test'],
      }),
    );
    expect(captured.config?.notifications?.webhook).toBeUndefined();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('super-secret')).not.toBeInTheDocument();
  });

  it('keeps a saved email password unless cleared with the username', async () => {
    const captured = installFetch(
      budgetView,
      [event],
      [],
      undefined,
      undefined,
      webhook,
      {
        ...email,
        enabled: true,
        host: 'smtp.example.test',
        username: 'aps',
        passwordSet: true,
        from: 'alerts@example.test',
        to: ['ops@example.test'],
      },
    );
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('A password is saved.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save email delivery' }));
    await waitFor(() => expect(captured.config).toBeDefined());
    expect(captured.config?.notifications?.email).not.toHaveProperty('password');
    expect(captured.config?.notifications?.email).toMatchObject({ username: 'aps' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear password' }));
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email delivery' }));
    await waitFor(() =>
      expect(captured.config?.notifications?.email).toMatchObject({
        username: null,
        password: null,
      }),
    );
  });

  it('validates email delivery and reports a test result', async () => {
    const onError = vi.fn();
    const captured = installFetch();
    const view = render(<ConfigPage onError={onError} />);

    fireEvent.click(await screen.findByRole('checkbox', { name: /deliver budget alerts by email/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save email delivery' }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Host, From address, and at least one recipient are required.',
      ),
    );
    expect(captured.config).toBeUndefined();

    fireEvent.change(screen.getByLabelText(/smtp host/i), {
      target: { value: 'smtp.example.test' },
    });
    fireEvent.change(screen.getByLabelText(/from address/i), {
      target: { value: 'alerts@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/recipients/i), {
      target: { value: 'ops@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText(/Test email sent in 15 ms/)).toBeInTheDocument();
    view.unmount();
  });

  it('shows email test failures', async () => {
    installFetch(budgetView, [event], [], undefined, undefined, webhook, email, {
      ok: false,
      error: 'eauth',
    });
    render(<ConfigPage onError={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText('eauth')).toBeInTheDocument();
  });

  it('deletes a price after an inline confirmation', async () => {
    const price = makePrice();
    const captured = installFetch(budgetView, [event], [price]);
    render(<ConfigPage onError={() => {}} />);

    const remove = await screen.findByRole('button', { name: 'Delete price for model-a' });
    fireEvent.click(remove);
    expect(captured.deletedPriceId).toBeUndefined();
    expect(remove).toHaveTextContent('Confirm?');

    fireEvent.click(remove);
    await waitFor(() => expect(captured.deletedPriceId).toBe(price.id));
  });

  it('renders delivery history and filters by channel and status', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText(/Overall · warning 80%/)).toBeInTheDocument();
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Resend webhook delivery/i }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Channel/), { target: { value: 'email' } });
    await waitFor(() => expect(captured.deliveryQuery).toContain('channel=email'));

    fireEvent.change(screen.getByLabelText(/^Status/), { target: { value: 'failed' } });
    await waitFor(() => expect(captured.deliveryQuery).toContain('status=failed'));
  });

  it('renders operational event rows and filters by type', async () => {
    const captured = installFetch(
      budgetView,
      [event],
      [],
      undefined,
      undefined,
      webhook,
      email,
      undefined,
      {
        deliveries: [deliveryRow, eventDeliveryRow],
        total: 2,
        limit: 10,
        offset: 0,
      },
    );
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('Turn failed: Fix the parser')).toBeInTheDocument();
    expect(screen.getByText('Turn failed')).toBeInTheDocument();
    expect(screen.getByText('Budget')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /Resend webhook delivery for Turn failed: Fix the parser/i,
      }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Type/), {
      target: { value: 'turn.failed' },
    });
    await waitFor(() => expect(captured.deliveryQuery).toContain('kind=turn.failed'));
    expect(captured.deliveryQuery).toContain('offset=0');

    fireEvent.change(screen.getByLabelText(/^Type/), {
      target: { value: 'master.error' },
    });
    await waitFor(() => expect(captured.deliveryQuery).toContain('kind=master.error'));

    fireEvent.change(screen.getByLabelText(/^Type/), { target: { value: 'budget' } });
    await waitFor(() => expect(captured.deliveryQuery).toContain('source=budget'));
  });

  it('shows an empty delivery history', async () => {
    installFetch(
      budgetView,
      [event],
      [],
      undefined,
      undefined,
      webhook,
      email,
      undefined,
      { deliveries: [], total: 0, limit: 10, offset: 0 },
    );
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('No deliveries yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resend/i })).not.toBeInTheDocument();
  });

  it('pages through delivery history', async () => {
    const captured = installFetch(
      budgetView,
      [event],
      [],
      undefined,
      undefined,
      webhook,
      email,
      undefined,
      { deliveries: [deliveryRow], total: 25, limit: 10, offset: 0 },
    );
    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByText('Showing 1–1 of 25')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(captured.deliveryQuery).toContain('offset=10'));
  });

  it('resends a failed delivery and refreshes the list', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: /Resend webhook delivery/i }));
    await waitFor(() => expect(captured.resendId).toBe('d1'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Resend queued; delivery will retry on the next flush.',
    );
  });

  it('reports a resend failure through onError', async () => {
    const onError = vi.fn();
    installFetch(
      budgetView,
      [event],
      [],
      undefined,
      undefined,
      webhook,
      email,
      undefined,
      deliveryHistory,
      409,
    );
    render(<ConfigPage onError={onError} />);

    fireEvent.click(await screen.findByRole('button', { name: /Resend webhook delivery/i }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('already delivered'),
    );
  });
});
