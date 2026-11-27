import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigPage as ConfigPageComponent } from './ConfigPage';
import { jsonResponse, makePrice, makeProcessResponse } from './test/fixtures';
import type { BudgetFeed } from './useBudgets';
import type {
  BudgetsResponse,
  Cell,
  CellDetail,
  ChatView,
  DeliveryHistoryItem,
  DeliveryHistoryResponse,
  MasterConfig,
  MasterEvent,
  ModelPrice,
  ModelPriceInput,
  RetentionSettings,
  SegmentConfig,
  SettingsWarning,
  SpendCapOverrideHistoryResponse,
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
  notificationEventsDays: 400,
  spendCapOverridesDays: 400,
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

const cellDetail: CellDetail = { ...cell, process: null };

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
  spendOverrides: { webhook: false, email: false },
  coalesceMinutes: 60,
  routes: [] as Array<{
    kind:
      | 'turn.failed'
      | 'master.error'
      | 'summary.failed'
      | 'spend.override';
    channel: 'webhook' | 'email';
    cellId: string;
  }>,
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
      'spend.override': { pending: 0, failed: 0 },
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

function pausedBudgetView(): BudgetsResponse {
  return {
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
}

function overriddenBudgetView(): BudgetsResponse {
  const paused = pausedBudgetView();
  return {
    ...paused,
    statuses: [
      {
        ...paused.statuses[0]!,
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
}

function makeBudgetFeed(overrides: Partial<BudgetFeed> = {}): BudgetFeed {
  return {
    budgets: budgetView,
    error: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    reload: vi.fn(async () => budgetView),
    acknowledge: vi.fn(async () => {}),
    snooze: vi.fn(async () => {}),
    revokeOverride: vi.fn(async () => {}),
    ...overrides,
  };
}

type TestConfigPageProps = Omit<
  ComponentProps<typeof ConfigPageComponent>,
  'budgetFeed' | 'cells' | 'onCellChanged'
> & {
  budgetFeed?: BudgetFeed;
  cells?: CellDetail[];
  onCellChanged?: (cell: CellDetail) => void;
};

/** Render ConfigPage with a deterministic shared feed unless a test supplies one. */
function ConfigPage({
  budgetFeed,
  cells = [cellDetail],
  onCellChanged = () => {},
  ...props
}: TestConfigPageProps) {
  return (
    <ConfigPageComponent
      {...props}
      cells={cells}
      onCellChanged={onCellChanged}
      budgetFeed={budgetFeed ?? makeBudgetFeed()}
    />
  );
}

const overrideHistory: SpendCapOverrideHistoryResponse = {
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
      note: 'release review',
      revokedAt: null,
      state: 'active',
      extensionCount: 1,
      lastExtendedAt: Date.UTC(2026, 10, 15, 12, 30),
    },
  ],
  total: 1,
  limit: 10,
  offset: 0,
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
    change: null,
  },
};

const summaryDeliveryRow: DeliveryHistoryItem = {
  id: 'event-2',
  source: 'event',
  channel: 'webhook',
  format: 'json',
  status: 'failed',
  attempts: 2,
  nextAttemptAt: Date.UTC(2026, 10, 15, 14),
  lastError: 'HTTP 503',
  createdAt: Date.UTC(2026, 10, 15, 14),
  updatedAt: Date.UTC(2026, 10, 15, 14),
  deliveredAt: null,
  canResend: true,
  event: {
    kind: 'summary.failed',
    title: 'Scorecard failed: Acme',
    text: 'Scorecard generation failed for cell "Acme": process exited with code 1.',
    source: 'summary.exit',
    reason: 'process exited with code 1',
    cellId: 'c1',
    cellName: 'Acme',
    requestId: null,
    turnId: null,
    segment: null,
    occurredAt: Date.UTC(2026, 10, 15, 14),
    change: null,
  },
};

const overrideDeliveryRow: DeliveryHistoryItem = {
  id: 'event-3',
  source: 'event',
  channel: 'webhook',
  format: 'json',
  status: 'delivered',
  attempts: 1,
  nextAttemptAt: Date.UTC(2026, 10, 15, 15),
  lastError: null,
  createdAt: Date.UTC(2026, 10, 15, 15),
  updatedAt: Date.UTC(2026, 10, 15, 15),
  deliveredAt: Date.UTC(2026, 10, 15, 15),
  canResend: false,
  event: {
    kind: 'spend.override',
    title: 'Spend cap override expired: Overall',
    text: 'Spend cap override for overall spend expired at 2026-11-15T14:00:00.000Z.',
    source: null,
    reason: 'cap_reached',
    cellId: null,
    cellName: null,
    requestId: null,
    turnId: null,
    segment: null,
    occurredAt: Date.UTC(2026, 10, 15, 14),
    change: 'expired',
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
        spendOverrides?: { webhook?: boolean; email?: boolean };
        coalesceMinutes?: number;
        routes?: Array<{
          kind:
            | 'turn.failed'
            | 'master.error'
            | 'summary.failed'
            | 'spend.override';
          channel: 'webhook' | 'email';
          cellId: string;
        }>;
      };
    };
  };
  process?: { segments?: SegmentConfig[] };
  cell?: { masterEnabled?: boolean };
  cellGets?: number;
  price?: ModelPriceInput;
  deletedPriceId?: string;
  deliveryQuery?: string;
  resendId?: string;
  override?: { scope: string; cellId?: string; minutes: number; note?: string };
  revokedOverrideId?: string;
  historyQuery?: string;
  historyQueries?: string[];
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
  historyView: SpendCapOverrideHistoryResponse = overrideHistory,
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
        spendOverrides: {
          ...eventSettings.spendOverrides,
          ...(eventsPatch?.spendOverrides ?? {}),
        },
        coalesceMinutes: eventsPatch?.coalesceMinutes ?? eventSettings.coalesceMinutes,
        routes: eventsPatch?.routes ?? eventSettings.routes,
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
        warnings: [],
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
        warnings: [],
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
    if (url.startsWith('/api/budgets/overrides/history')) {
      captured.historyQuery = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      captured.historyQueries = [...(captured.historyQueries ?? []), captured.historyQuery];
      return jsonResponse(historyView);
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
    if (url === '/api/cells') {
      captured.cellGets = (captured.cellGets ?? 0) + 1;
      return jsonResponse([cell]);
    }
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return captured;
}

/**
 * Wrap the installed mock so `/api/config` reports recovered-settings warnings
 * and the preserved settings copy. `warnings: null` omits the field, matching a
 * brain that predates it. A successful save clears the warnings, as the server
 * does. `before`/`after` set `preservedPath` on the load and save response:
 * `undefined` omits the field, `null` sends an explicit null. The matching
 * `beforeCopies`/`afterCopies` set `preservedCopies`; `undefined` omits it.
 */
function stubConfigWarnings(
  warnings: SettingsWarning[] | null,
  preserved: {
    before?: string | null;
    after?: string | null;
    beforeCopies?: string[];
    afterCopies?: string[];
    secret?: string;
  } = {},
): void {
  const base = globalThis.fetch as typeof fetch;
  const configBody = {
    master,
    summary: scorecard,
    usage,
    retention,
    budget,
    notifications: {
      webhook: preserved.secret
        ? { ...webhook, secret: preserved.secret, secretSet: true }
        : webhook,
      email,
      slack: emptyChat,
      discord: emptyChat,
      events: eventSettings,
    },
    path: '/tmp/agent-process-segments/config.json',
  };
  const beforeMeta = {
    ...(preserved.before === undefined ? {} : { preservedPath: preserved.before }),
    ...(preserved.beforeCopies === undefined
      ? {}
      : { preservedCopies: preserved.beforeCopies }),
  };
  const afterMeta = {
    ...(preserved.after === undefined ? {} : { preservedPath: preserved.after }),
    ...(preserved.afterCopies === undefined
      ? {}
      : { preservedCopies: preserved.afterCopies }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/config' && init?.method === 'PATCH') {
        return jsonResponse({ ...configBody, warnings: [], ...afterMeta });
      }
      if (url === '/api/config') {
        return jsonResponse({
          ...configBody,
          ...(warnings === null ? {} : { warnings }),
          ...beforeMeta,
        });
      }
      return base(input, init);
    }),
  );
}

/**
 * Wrap the installed mock so `/api/process` reports a preserved copy path on load
 * and after a save. `after` defaults to `before`; pass explicit nulls to omit it.
 * Pass `copies.before`/`copies.after` to include `preservedCopies`; leaving one
 * undefined omits the field, matching an older brain.
 */
function stubProcessPreservedPath(
  before: string | null,
  after: string | null = before,
  copies: { before?: string[]; after?: string[] } = {},
): void {
  const base = globalThis.fetch as typeof fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await base(input, init);
      if (String(input) !== '/api/process') return response;
      const body = (await response.json()) as Record<string, unknown>;
      const preservedCopies = init?.method === 'PATCH' ? copies.after : copies.before;
      const next: Record<string, unknown> = {
        ...body,
        preservedPath: init?.method === 'PATCH' ? after : before,
      };
      if (preservedCopies === undefined) delete next.preservedCopies;
      else next.preservedCopies = preservedCopies;
      return jsonResponse(next);
    }),
  );
}

// The Config page fetches several resources before it renders its cards. Give the
// slow async cases, including the Slack flow, room under full-suite load while
// keeping them bounded.
const ASYNC_TIMEOUT_MS = 10_000;
const CONFIG_PAGE_TEST_TIMEOUT_MS = 30_000;
const SLACK_TEST_TIMEOUT_MS = 30_000;

describe('ConfigPage', () => {
  it('loads settings, saves a patch, and shows the path', async () => {
    const captured = installFetch();

    render(<ConfigPage onError={() => {}} />);

    const interval = await screen.findByRole('spinbutton', { name: /interval/i }, { timeout: ASYNC_TIMEOUT_MS });
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

    expect(await screen.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(() => expect(captured.config).toBeDefined(), { timeout: ASYNC_TIMEOUT_MS });
    expect(captured.config?.master).toMatchObject({ intervalMinutes: 8, idleMinutes: 10 });
    expect(captured.config?.summary).toMatchObject({ intervalMinutes: 360, windowMinutes: 180 });
    expect(captured.config?.master).not.toHaveProperty('includeUnassigned');
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('names the settings blocks recovered at load', async () => {
    installFetch();
    stubConfigWarnings([
      { block: 'budget', message: 'alert threshold is invalid' },
      { block: 'notifications.email', message: 'port is invalid' },
    ]);

    render(<ConfigPage onError={() => {}} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Some saved settings were reset to defaults');
    expect(alert).toHaveTextContent('Budgets: alert threshold is invalid');
    expect(alert).toHaveTextContent('Email: port is invalid');
    expect(alert).toHaveTextContent('copies the original aside');
  });

  it('labels a whole-file warning', async () => {
    installFetch();
    stubConfigWarnings([
      { block: null, message: 'is not valid JSON; all settings loaded as defaults' },
    ]);

    render(<ConfigPage onError={() => {}} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Settings file: is not valid JSON');
  });

  it('clears the recovered settings banner after a successful save', async () => {
    installFetch();
    stubConfigWarnings([{ block: 'budget', message: 'alert threshold is invalid' }]);

    render(<ConfigPage onError={() => {}} />);
    expect(await screen.findByRole('alert', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS });
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('renders no banner when the brain omits warnings', async () => {
    installFetch();
    stubConfigWarnings(null);

    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByRole('spinbutton', { name: /interval/i }, { timeout: ASYNC_TIMEOUT_MS })).toHaveValue(5);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: 'Preserved settings files' }),
    ).not.toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('shows the preserved settings path when the server reports one', async () => {
    const preserved = '/tmp/agent-process-segments/config.json.invalid-2026-01-01T00-00-00-000Z';
    installFetch();
    stubConfigWarnings([], { before: preserved, secret: 'webhook-secret-sentinel' });

    render(<ConfigPage onError={() => {}} />);

    const status = await screen.findByRole('status', { name: 'Preserved settings files' });
    expect(status).toHaveTextContent(preserved);
    expect(status).toHaveTextContent('may contain credentials');
    expect(status).toHaveTextContent('Delete it once you have reviewed it');
    expect(document.body.textContent).not.toContain('webhook-secret-sentinel');
  });

  it('lists older preserved settings copies after a restart', async () => {
    const newest = '/tmp/agent-process-segments/config.json.invalid-2026-01-01T00-00-01-000Z';
    const older = '/tmp/agent-process-segments/config.json.invalid-2026-01-01T00-00-00-000Z';
    installFetch();
    stubConfigWarnings([], { before: null, beforeCopies: [newest, older] });

    render(<ConfigPage onError={() => {}} />);

    const status = await screen.findByRole('status', { name: 'Preserved settings files' });
    const items = within(status).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([newest, older]);
    expect(status).toHaveTextContent('They may contain credentials');
    expect(status).toHaveTextContent('Delete them once you have reviewed them');
  });

  it('shows the preserved settings path after the save that copies the file', async () => {
    const preserved = '/tmp/agent-process-segments/config.json.invalid-2026-01-01T00-00-01-000Z';
    installFetch();
    stubConfigWarnings([{ block: 'budget', message: 'alert threshold is invalid' }], {
      before: null,
      beforeCopies: [],
      after: preserved,
      afterCopies: [preserved],
    });

    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByRole('alert', undefined, { timeout: ASYNC_TIMEOUT_MS })).toHaveTextContent(
      'Some saved settings were reset to defaults',
    );
    expect(
      screen.queryByRole('status', { name: 'Preserved settings files' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS });
    const status = await screen.findByRole('status', { name: 'Preserved settings files' }, { timeout: ASYNC_TIMEOUT_MS });
    expect(status).toHaveTextContent(preserved);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('renders no preserved settings notice for an explicit null and empty list', async () => {
    installFetch();
    stubConfigWarnings(null, { before: null, beforeCopies: [] });

    render(<ConfigPage onError={() => {}} />);

    expect(await screen.findByRole('spinbutton', { name: /interval/i }, { timeout: ASYNC_TIMEOUT_MS })).toHaveValue(5);
    expect(
      screen.queryByRole('status', { name: 'Preserved settings files' }),
    ).not.toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('loads and saves usage retention', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const retention = await screen.findByRole('spinbutton', {
      name: 'Usage retention (days)',
    }, { timeout: ASYNC_TIMEOUT_MS });
    expect(retention).toHaveValue(90);
    expect(screen.getByText('0 keeps raw turns forever')).toBeInTheDocument();
    expect(screen.getByText(/summarized into daily totals/)).toBeInTheDocument();

    fireEvent.change(retention, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save usage retention' }));

    await waitFor(() =>
      expect(captured.config?.usage).toEqual({ retentionDays: 30 }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(await screen.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(retention).toHaveValue(30);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('loads and saves master activity retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const activity = await screen.findByRole('spinbutton', {
      name: 'Activity retention (days)',
    }, { timeout: ASYNC_TIMEOUT_MS });
    expect(activity).toHaveValue(90);
    expect(screen.getByText('0 keeps all master activity forever')).toBeInTheDocument();
    expect(screen.getByText(/activity is not rolled up/)).toBeInTheDocument();
    expect(screen.getByText(/Follow-up markers are kept/)).toBeInTheDocument();

    fireEvent.change(activity, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save activity retention' }));

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ masterEventsDays: 30 }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(activity).toHaveValue(30);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('loads and saves scorecard retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const summaries = await screen.findByRole('spinbutton', {
      name: 'Scorecard retention (days)',
    }, { timeout: ASYNC_TIMEOUT_MS });
    expect(summaries).toHaveValue(90);
    expect(
      screen.getByText('0 keeps all scorecard history forever'),
    ).toBeInTheDocument();
    expect(screen.getByText(/newest report per cell is always kept/)).toBeInTheDocument();
    expect(screen.getByText(/Scorecard history is not rolled up/)).toBeInTheDocument();

    fireEvent.change(summaries, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scorecard retention' }));

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ cellSummariesDays: 30 }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(summaries).toHaveValue(30);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('loads and saves budget alert retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const alerts = await screen.findByRole('spinbutton', {
      name: 'Budget alert retention (days)',
    }, { timeout: ASYNC_TIMEOUT_MS });
    expect(alerts).toHaveValue(400);
    expect(
      screen.getByText('0 keeps alert and delivery history forever'),
    ).toBeInTheDocument();
    expect(screen.getByText(/current UTC month is always kept/)).toBeInTheDocument();
    expect(screen.getByText(/pending and in-flight deliveries/)).toBeInTheDocument();

    fireEvent.change(alerts, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget alert retention' }));

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ budgetAlertsDays: 30 }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(alerts).toHaveValue(30);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('loads and saves notification event retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const events = await screen.findByRole('spinbutton', {
      name: 'Notification event retention (days)',
    }, { timeout: ASYNC_TIMEOUT_MS });
    expect(events).toHaveValue(400);
    expect(events).toHaveAttribute('min', '0');
    expect(events).toHaveAttribute('max', '3650');
    expect(events).toHaveAttribute('step', '1');
    expect(
      screen.getByText('0 keeps event delivery history forever'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Pending and in-flight deliveries/)).toBeInTheDocument();

    fireEvent.change(events, { target: { value: '30' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save notification event retention' }),
    );

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ notificationEventsDays: 30 }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(events).toHaveValue(30);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('loads and saves spend cap override retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const overrides = await screen.findByRole('spinbutton', {
      name: 'Spend cap override retention (days)',
    }, { timeout: ASYNC_TIMEOUT_MS });
    expect(overrides).toHaveValue(400);
    expect(overrides).toHaveAttribute('min', '0');
    expect(overrides).toHaveAttribute('max', '3650');
    expect(overrides).toHaveAttribute('step', '1');
    expect(
      screen.getByText('0 keeps override history forever'),
    ).toBeInTheDocument();
    expect(screen.getByText(/current UTC budget month is kept whole/)).toBeInTheDocument();

    fireEvent.change(overrides, { target: { value: '60' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save spend cap override retention' }),
    );

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ spendCapOverridesDays: 60 }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(overrides).toHaveValue(60);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('loads and saves request artifact retention independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const artifacts = await screen.findByRole('spinbutton', {
      name: 'Request artifacts retention (days)',
    }, { timeout: ASYNC_TIMEOUT_MS });
    expect(artifacts).toHaveValue(30);
    expect(
      screen.getByText('0 keeps request folders and worktrees forever'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Only done or dropped requests/)).toBeInTheDocument();
    expect(screen.getByText(/Git branches are kept/)).toBeInTheDocument();

    fireEvent.change(artifacts, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save artifact retention' }));

    await waitFor(() =>
      expect(captured.config?.retention).toEqual({ requestArtifactsDays: 7 }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.usage).toBeUndefined();
    expect(await screen.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(artifacts).toHaveValue(7);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('toggles the master switch', async () => {
    const captured = installFetch();

    render(<ConfigPage onError={() => {}} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Master enabled' }, { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(captured.config).toBeDefined(), { timeout: ASYNC_TIMEOUT_MS });
    expect(captured.config?.master).toMatchObject({ enabled: false });
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('toggles a cell master', async () => {
    const captured = installFetch();
    const onCellChanged = vi.fn();

    render(<ConfigPage onCellChanged={onCellChanged} onError={() => {}} />);

    const cellToggle = await screen.findByRole('checkbox', { name: 'Alpha master' });
    expect(cellToggle).toBeChecked();
    fireEvent.click(cellToggle);
    await waitFor(() => expect(captured.cell).toEqual({ masterEnabled: false }));
    await waitFor(() =>
      expect(onCellChanged).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1', masterEnabled: false }),
      ),
    );
    expect(captured.cellGets ?? 0).toBe(0);
  });

  it('renders cells from the shared list and drops a deleted one', async () => {
    const captured = installFetch();

    const { rerender } = render(
      <ConfigPage cells={[cellDetail]} onError={() => {}} />,
    );
    expect(await screen.findByRole('checkbox', { name: 'Alpha master' })).toBeInTheDocument();
    expect(
      await screen.findByRole('checkbox', { name: 'Master enabled' }),
    ).toBeInTheDocument();
    expect(captured.cellGets ?? 0).toBe(0);

    rerender(<ConfigPage cells={[]} onError={() => {}} />);

    expect(
      screen.queryByRole('checkbox', { name: 'Alpha master' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('No cells yet. Create one in the left menu.'),
    ).toBeInTheDocument();
  });

  it('keeps the shared list unchanged when a cell toggle fails', async () => {
    installFetch();
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/cells/c1' && init?.method === 'PATCH') {
          return jsonResponse({ error: 'cell_unavailable', message: 'cell unavailable' }, 500);
        }
        return baseFetch(input, init);
      }),
    );
    const onCellChanged = vi.fn();
    const onError = vi.fn();

    render(<ConfigPage onCellChanged={onCellChanged} onError={onError} />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Alpha master' }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onCellChanged).not.toHaveBeenCalled();
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

    const card = within(
      await screen.findByTestId('spend-budgets-card', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    );
    const monthly = card.getByRole('spinbutton', { name: /overall monthly budget/i });
    expect(monthly).toHaveValue(100);
    expect(card.getByText('Overall')).toBeInTheDocument();
    expect(card.getByText(/At least \$85\.00 of \$100\.00 \(85%\)/)).toBeInTheDocument();

    const threshold = card.getByRole('spinbutton', { name: /alert threshold/i });
    expect(threshold).toHaveValue(80);

    const strict = card.getByRole('checkbox', {
      name: /also pause when a turn's cost is unknown/i,
    });
    expect(strict).toBeDisabled();

    fireEvent.change(monthly, { target: { value: '250.5' } });
    fireEvent.change(threshold, { target: { value: '90' } });
    fireEvent.click(
      card.getByRole('checkbox', {
        name: /pause new work when the overall budget is exceeded/i,
      }),
    );
    expect(strict).not.toBeDisabled();
    fireEvent.click(strict);
    fireEvent.click(card.getByRole('button', { name: 'Save budgets' }));

    await waitFor(() =>
      expect(captured.config?.budget).toEqual({
        monthlyUsd: 250.5,
        alertAtPercent: 90,
        pauseOnExceeded: true,
        pauseOnUnknownCost: true,
      }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.master).toBeUndefined();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('explains a strict unknown-cost pause even when spend is unknown', async () => {
    const view: BudgetsResponse = {
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
    };
    installFetch(view);
    render(
      <ConfigPage onError={() => {}} budgetFeed={makeBudgetFeed({ budgets: view })} />,
    );

    const card = within(await screen.findByTestId('spend-budgets-card'));
    expect(await card.findByText(/Spend unknown/)).toBeInTheDocument();
    expect(
      card.getByText(/Paused: 2 unpriced turns, so cost cannot be verified/i),
    ).toBeInTheDocument();
  });

  it('renders recent spend cap override history', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    expect(
      await screen.findByRole('table', { name: 'Spend cap override history' }, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(screen.getByText('Overall spend')).toBeInTheDocument();
    expect(screen.getByText('release review')).toBeInTheDocument();
    expect(screen.getByText(/×1/)).toBeInTheDocument();
    await waitFor(() => expect(captured.historyQueries).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('snoozes a paused budget through the shared feed and ends an active override', async () => {
    const pausedView = pausedBudgetView();
    const snooze = vi.fn(async () => {});
    const captured = installFetch(pausedView);
    const { unmount } = render(
      <ConfigPage
        onError={() => {}}
        budgetFeed={makeBudgetFeed({ budgets: pausedView, snooze })}
      />,
    );

    const firstCard = within(
      await screen.findByTestId('spend-budgets-card', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    );
    expect(
      await firstCard.findByText('paused', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(
      firstCard.getByText(/New work is paused and in-flight turns were stopped at/),
    ).toBeInTheDocument();
    await waitFor(
      () => expect(captured.historyQueries).toHaveLength(1),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    fireEvent.click(firstCard.getByRole('button', { name: 'Snooze overall spend' }));
    await waitFor(() =>
      expect(snooze).toHaveBeenCalledWith({ scope: 'overall', minutes: 60 }), { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(() => expect(captured.historyQueries!.length).toBeGreaterThan(1), { timeout: ASYNC_TIMEOUT_MS });
    unmount();

    const overrideView = overriddenBudgetView();
    const revokeOverride = vi.fn(async () => {});
    const second = installFetch(overrideView);
    render(
      <ConfigPage
        onError={() => {}}
        budgetFeed={makeBudgetFeed({ budgets: overrideView, revokeOverride })}
      />,
    );

    const secondCard = within(
      await screen.findByTestId('spend-budgets-card', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    );
    expect(
      await secondCard.findByText(/Override active until/, undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    expect(secondCard.getByText('snoozed')).toBeInTheDocument();
    expect(
      secondCard.getByText(/an override is admitting new work until/),
    ).toBeInTheDocument();
    expect(
      secondCard.queryByText(/New work is paused and in-flight turns were stopped/),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(second.historyQueries).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.click(
      secondCard.getByRole('button', { name: 'End override for overall spend' }),
    );
    await waitFor(() => expect(revokeOverride).toHaveBeenCalledWith('o1'), { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() => expect(second.historyQueries!.length).toBeGreaterThan(1), { timeout: ASYNC_TIMEOUT_MS });
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('force-reloads the shared feed after saving a budget', async () => {
    installFetch();
    const reload = vi.fn(async () => budgetView);
    render(<ConfigPage onError={() => {}} budgetFeed={makeBudgetFeed({ reload })} />);

    const card = within(await screen.findByTestId('spend-budgets-card'));
    const save = card.getByRole('button', { name: 'Save budgets' });
    fireEvent.click(save);

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(await card.findByText('Saved')).toBeInTheDocument();
  });

  it('shows loading instead of an empty budget message before the feed resolves', async () => {
    installFetch();
    render(
      <ConfigPage
        onError={() => {}}
        budgetFeed={makeBudgetFeed({ budgets: null, loading: true })}
      />,
    );

    const card = within(await screen.findByTestId('spend-budgets-card'));
    expect(await card.findByText('Loading budgets…')).toBeInTheDocument();
    expect(card.queryByText(/No budgets configured/)).not.toBeInTheDocument();
  });

  it('shows a retryable error when the feed has no budget snapshot', async () => {
    installFetch();
    const reload = vi.fn(async () => null);
    render(
      <ConfigPage
        onError={() => {}}
        budgetFeed={makeBudgetFeed({
          budgets: null,
          loading: false,
          error: 'offline',
          reload,
        })}
      />,
    );

    const card = within(await screen.findByTestId('spend-budgets-card'));
    expect(await card.findByText("Couldn't load budget status.")).toBeInTheDocument();
    expect(card.getByText('offline')).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('warns and retries when a refresh fails but a snapshot is shown', async () => {
    installFetch();
    const reload = vi.fn(async () => budgetView);
    render(
      <ConfigPage
        onError={() => {}}
        budgetFeed={makeBudgetFeed({ error: 'offline', reload })}
      />,
    );

    const card = within(await screen.findByTestId('spend-budgets-card'));
    expect(
      await card.findByText(/showing the last successful snapshot/),
    ).toBeInTheDocument();
    expect(card.getByText('Overall')).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
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
    render(
      <ConfigPage onError={() => {}} budgetFeed={makeBudgetFeed({ budgets: view })} />,
    );
    const card = within(await screen.findByTestId('spend-budgets-card'));
    expect(await card.findByText('snoozed')).toBeInTheDocument();
    expect(
      card.getByText(
        /Cost is unknown: 2 unpriced turns, so cost cannot be verified; an override is admitting new work until/,
      ),
    ).toBeInTheDocument();
    expect(
      card.queryByText(/New work is paused and in-flight turns were stopped/),
    ).not.toBeInTheDocument();
  });

  it('links the Alert delivery card to the webhook signature Help section', async () => {
    installFetch();
    const onOpenHelp = vi.fn();

    render(<ConfigPage onError={() => {}} onOpenHelp={onOpenHelp} />);

    const card = within(await screen.findByTestId('webhook-delivery-card'));
    const link = card.getByRole('link', { name: 'Verify webhook signatures' });
    expect(link).toHaveAttribute('href', '?help=08-user-workflows#verify-webhook-signatures');

    fireEvent.click(link);
    expect(onOpenHelp).toHaveBeenCalledWith(
      '08-user-workflows',
      'verify-webhook-signatures',
    );
  });

  it('configures and saves webhook delivery', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const card = within(
      await screen.findByTestId('webhook-delivery-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    const toggle = card.getByRole('checkbox', {
      name: /deliver budget alerts to a webhook/i,
    });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.change(card.getByLabelText(/webhook url/i), {
      target: { value: 'https://hooks.example.test/budget' },
    });
    fireEvent.change(card.getByLabelText(/payload format/i), {
      target: { value: 'slack' },
    });
    fireEvent.change(card.getByLabelText(/signing secret/i), {
      target: { value: '0123456789abcdef' },
    });
    fireEvent.click(card.getByRole('button', { name: 'Save delivery' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.webhook).toEqual({
        enabled: true,
        url: 'https://hooks.example.test/budget',
        format: 'slack',
        secret: '0123456789abcdef',
      }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(await card.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(card.queryByDisplayValue('0123456789abcdef')).not.toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('saves event notification routes independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const card = within(
      await screen.findByTestId('event-notifications-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    const failedWebhook = card.getByRole('checkbox', {
      name: /failed turns by webhook/i,
    });
    const masterEmail = card.getByRole('checkbox', {
      name: /master errors by email/i,
    });
    const summaryWebhook = card.getByRole('checkbox', {
      name: /scorecard failures by webhook/i,
    });
    const overrideEmail = card.getByRole('checkbox', {
      name: /spend cap overrides by email/i,
    });
    expect(failedWebhook).not.toBeChecked();
    fireEvent.click(failedWebhook);
    fireEvent.click(masterEmail);
    fireEvent.click(summaryWebhook);
    fireEvent.click(overrideEmail);
    fireEvent.click(card.getByRole('button', { name: 'Save event notifications' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.events).toEqual({
        failedTurns: { webhook: true, email: false },
        masterErrors: { webhook: false, email: true },
        summaryFailures: { webhook: true, email: false },
        spendOverrides: { webhook: false, email: true },
        coalesceMinutes: 60,
        routes: [],
      }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.notifications?.webhook).toBeUndefined();
    expect(card.getByText(/2 pending · 1 failed/)).toBeInTheDocument();
    expect(card.getByText(/turns 1 pending \/ 1 failed/)).toBeInTheDocument();
    expect(card.getByText(/scorecard 0 pending \/ 0 failed/)).toBeInTheDocument();
    expect(card.getByText(/overrides 0 pending \/ 0 failed/)).toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('saves the coalescing window and a cell route', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const card = within(
      await screen.findByTestId('event-notifications-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    const minutes = card.getByLabelText(/coalesce repeats within/i);
    fireEvent.change(minutes, { target: { value: '30' } });
    fireEvent.click(card.getByRole('button', { name: 'Add event route' }));

    expect(card.getByLabelText('Route 1 event kind')).toHaveValue('turn.failed');
    expect(card.getByLabelText('Route 1 channel')).toHaveValue('webhook');
    expect(card.getByLabelText('Route 1 cell')).toHaveValue('c1');
    fireEvent.change(card.getByLabelText('Route 1 channel'), {
      target: { value: 'email' },
    });
    fireEvent.click(card.getByRole('button', { name: 'Save event notifications' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.events).toEqual({
        failedTurns: { webhook: false, email: false },
        masterErrors: { webhook: false, email: false },
        summaryFailures: { webhook: false, email: false },
        spendOverrides: { webhook: false, email: false },
        coalesceMinutes: 30,
        routes: [{ kind: 'turn.failed', channel: 'email', cellId: 'c1' }],
      }), { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('rejects an invalid event coalescing window before saving', async () => {
    const captured = installFetch();
    const onError = vi.fn();
    render(<ConfigPage onError={onError} />);

    const card = within(
      await screen.findByTestId('event-notifications-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    const minutes = card.getByLabelText(/coalesce repeats within/i);
    fireEvent.change(minutes, { target: { value: '0' } });
    fireEvent.click(card.getByRole('button', { name: 'Save event notifications' }));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Coalesce minutes'));
    expect(captured.config).toBeUndefined();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('clears a saved webhook secret only on request', async () => {
    const captured = installFetch(budgetView, [event], [], undefined, undefined, {
      ...webhook,
      enabled: true,
      url: 'https://hooks.example.test/budget',
      secretSet: true,
    });
    render(<ConfigPage onError={() => {}} />);

    const card = within(
      await screen.findByTestId('webhook-delivery-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    expect(
      await card.findByText('A signing secret is saved.', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'Clear secret' }));
    expect(card.getByText(/will be cleared on save/)).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'Save delivery' }));

    await waitFor(() =>
      expect(captured.config?.notifications?.webhook).toMatchObject({
        enabled: true,
        url: 'https://hooks.example.test/budget',
        secret: null,
      }), { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('shows webhook test success and failure', async () => {
    // A saved Slack destination renders a second "Send test" button, so the
    // webhook case must resolve its own button from the webhook card.
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
      200,
      {
        ...emptyChat,
        enabled: true,
        botTokenSet: true,
        destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
      },
    );
    const view = render(<ConfigPage onError={() => {}} />);
    const first = within(
      await screen.findByTestId('webhook-delivery-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    fireEvent.click(first.getByRole('button', { name: 'Send test' }));
    expect(
      await first.findByText(/Test delivered \(HTTP 204\)/, undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    view.unmount();

    installFetch(budgetView, [event], [], undefined, {
      ok: false,
      status: 500,
      error: 'HTTP 500',
    });
    render(<ConfigPage onError={() => {}} />);
    const second = within(
      await screen.findByTestId('webhook-delivery-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    fireEvent.click(second.getByRole('button', { name: 'Send test' }));
    expect(await second.findByText('HTTP 500', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it(
    'configures, routes, saves, and tests a Slack bot',
    async () => {
      const captured = installFetch();
      render(<ConfigPage onError={() => {}} />);

      const card = await screen.findByTestId('slack-delivery-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      });
      const slack = within(card);
      const toggle = slack.getByRole('checkbox', {
        name: /deliver budget alerts to a Slack bot/i,
      });
      expect(toggle).not.toBeChecked();
      fireEvent.click(toggle);
      expect(toggle).toBeChecked();
      fireEvent.change(slack.getByLabelText(/Slack bot token/i), {
        target: { value: 'xoxb-0123456789abcdef' },
      });
      fireEvent.click(slack.getByRole('button', { name: 'Add destination' }));
      fireEvent.change(slack.getByLabelText(/Slack destination 1 channel ID/i), {
        target: { value: 'C0123456789' },
      });
      fireEvent.change(slack.getByLabelText(/Slack destination 1 label/i), {
        target: { value: 'Ops' },
      });
      fireEvent.change(slack.getByLabelText(/Slack default destination/i), {
        target: { value: 'C0123456789' },
      });
      fireEvent.click(slack.getByRole('button', { name: 'Add route' }));

      fireEvent.click(slack.getByRole('button', { name: 'Save Slack delivery' }));

      await waitFor(
        () =>
          expect(captured.config?.notifications?.slack).toEqual({
            enabled: true,
            botToken: 'xoxb-0123456789abcdef',
            destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
            defaultChannelId: 'C0123456789',
            routes: [{ cellId: 'c1', channelId: 'C0123456789' }],
          }),
        { timeout: ASYNC_TIMEOUT_MS },
      );
      expect(
        await slack.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS }),
      ).toBeInTheDocument();
      expect(slack.queryByDisplayValue('xoxb-0123456789abcdef')).not.toBeInTheDocument();

      fireEvent.click(slack.getByRole('button', { name: 'Send test' }));
      expect(
        await slack.findByText(/Test delivered \(HTTP 200\)/, undefined, {
          timeout: ASYNC_TIMEOUT_MS,
        }),
      ).toBeInTheDocument();
    },
    SLACK_TEST_TIMEOUT_MS,
  );

  it(
    'validates a Slack channel before saving and clears a saved token',
    async () => {
      const errors: string[] = [];
      const captured = installFetch();
      const first = render(<ConfigPage onError={(message) => errors.push(message)} />);

      const firstCard = await screen.findByTestId('slack-delivery-card', undefined, { timeout: ASYNC_TIMEOUT_MS });
      const firstSlack = within(firstCard);
      fireEvent.click(
        firstSlack.getByRole('checkbox', {
          name: /deliver budget alerts to a Slack bot/i,
        }),
      );
      fireEvent.change(firstSlack.getByLabelText(/Slack bot token/i), {
        target: { value: 'xoxb-0123456789abcdef' },
      });
      fireEvent.click(firstSlack.getByRole('button', { name: 'Add destination' }));
      fireEvent.change(firstSlack.getByLabelText(/Slack destination 1 channel ID/i), {
        target: { value: 'not-a-channel' },
      });
      fireEvent.click(firstSlack.getByRole('button', { name: 'Save Slack delivery' }));
      await waitFor(() => expect(errors.join(' ')).toMatch(/Slack channel ID/), {
        timeout: ASYNC_TIMEOUT_MS,
      });
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
          routes: [{ cellId: 'c1', channelId: 'C0123456789' }],
        },
      );
      render(<ConfigPage onError={() => {}} />);
      const card = await screen.findByTestId('slack-delivery-card', undefined, { timeout: ASYNC_TIMEOUT_MS });
      const slack = within(card);
      expect(
        await slack.findByText('A bot token is saved.', undefined, {
          timeout: ASYNC_TIMEOUT_MS,
        }),
      ).toBeInTheDocument();

      // Saved destinations, default, and routes must be visible on first load;
      // an empty form here silently wipes them on the next save.
      expect(slack.getByLabelText(/Slack destination 1 channel ID/i)).toHaveValue(
        'C0123456789',
      );
      expect(slack.getByLabelText(/Slack destination 1 label/i)).toHaveValue('Ops');
      expect(slack.getByLabelText(/Slack default destination/i)).toHaveValue(
        'C0123456789',
      );
      expect(slack.getByLabelText(/Slack route 1 cell/i)).toHaveValue('c1');

      fireEvent.click(slack.getByRole('button', { name: 'Clear token' }));
      fireEvent.click(slack.getByRole('button', { name: 'Save Slack delivery' }));
      await waitFor(
        () =>
          expect(cleared.config?.notifications?.slack).toEqual({
            enabled: false,
            botToken: null,
            destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
            defaultChannelId: 'C0123456789',
            routes: [{ cellId: 'c1', channelId: 'C0123456789' }],
          }),
        { timeout: ASYNC_TIMEOUT_MS },
      );
    },
    SLACK_TEST_TIMEOUT_MS,
  );

  it('does not render an all-unpriced budget as measured zero', async () => {
    const view: BudgetsResponse = {
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
    };
    installFetch(view);
    render(
      <ConfigPage onError={() => {}} budgetFeed={makeBudgetFeed({ budgets: view })} />,
    );

    const card = within(
      await screen.findByTestId('spend-budgets-card', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    );
    expect(
      await card.findByText(/Spend unknown · 2 unpriced turns/, undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    expect(card.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(card.queryByText(/\(0%\)/)).not.toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

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

    const intake = await screen.findByRole('checkbox', { name: 'Automate Requests' }, { timeout: ASYNC_TIMEOUT_MS });
    expect(intake).not.toBeChecked();
    fireEvent.click(intake);
    fireEvent.click(screen.getByRole('button', { name: 'Save process' }));

    await waitFor(() => expect(captured.process).toBeDefined(), { timeout: ASYNC_TIMEOUT_MS });
    expect(
      captured.process?.segments?.find((segment) => segment.id === 'intake')?.enabled,
    ).toBe(true);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('shows the preserved process path when the server reports one', async () => {
    const preserved = '/tmp/agent-process-segments/process.json.invalid-2026-01-01T00-00-00-000Z';
    installFetch();
    stubProcessPreservedPath(preserved);

    render(<ConfigPage onError={() => {}} />);

    const status = await screen.findByRole('status', { name: 'Preserved process files' });
    expect(status).toHaveTextContent('The unusable process file was preserved');
    expect(status).toHaveTextContent(preserved);
    expect(status).toHaveTextContent('may contain prompts or policy');
    expect(status).toHaveTextContent('Delete it once you have reviewed it');
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('lists older preserved process copies after a restart', async () => {
    const newest = '/tmp/agent-process-segments/process.json.invalid-2026-01-01T00-00-01-000Z';
    const older = '/tmp/agent-process-segments/process.json.invalid-2026-01-01T00-00-00-000Z';
    installFetch();
    stubProcessPreservedPath(null, null, { before: [newest, older] });

    render(<ConfigPage onError={() => {}} />);

    const status = await screen.findByRole('status', { name: 'Preserved process files' });
    const items = within(status).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([newest, older]);
    expect(status).toHaveTextContent('Unusable process files were preserved');
    expect(status).toHaveTextContent('They may contain prompts or policy');
    expect(status).toHaveTextContent('Delete them once you have reviewed them');
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('merges the current preserved process path first without duplicates', async () => {
    const current = '/tmp/agent-process-segments/process.json.invalid-2026-01-01T00-00-02-000Z';
    const older = '/tmp/agent-process-segments/process.json.invalid-2026-01-01T00-00-00-000Z';
    installFetch();
    stubProcessPreservedPath(current, current, { before: [older, current] });

    render(<ConfigPage onError={() => {}} />);

    const status = await screen.findByRole('status', { name: 'Preserved process files' });
    const items = within(status).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([current, older]);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('shows the preserved process path after the save that copies the file', async () => {
    const preserved = '/tmp/agent-process-segments/process.json.invalid-2026-01-01T00-00-01-000Z';
    installFetch();
    stubProcessPreservedPath(null, preserved, { before: [], after: [preserved] });

    render(<ConfigPage onError={() => {}} />);

    const save = await screen.findByRole('button', { name: 'Save process' });
    expect(
      screen.queryByRole('status', { name: 'Preserved process files' }),
    ).not.toBeInTheDocument();

    fireEvent.click(save);

    const status = await screen.findByRole(
      'status',
      { name: 'Preserved process files' },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(status).toHaveTextContent(preserved);
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('renders no preserved process notice for an explicit null', async () => {
    installFetch();
    stubProcessPreservedPath(null);

    render(<ConfigPage onError={() => {}} />);

    await screen.findByRole('button', { name: 'Save process' });
    expect(
      screen.queryByRole('status', { name: 'Preserved process files' }),
    ).not.toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

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

    fireEvent.change(await screen.findByLabelText(/Model id/, undefined, { timeout: ASYNC_TIMEOUT_MS }), {
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

    await waitFor(() => expect(captured.price).toBeDefined(), { timeout: ASYNC_TIMEOUT_MS });
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
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('blocks a price without a model, source, or complete rates', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    await screen.findByLabelText(/Model id/, undefined, { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.click(screen.getByRole('button', { name: 'Add price' }));

    expect(
      await screen.findByText('Model, effective date, and source are required.', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(captured.price).toBeUndefined();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('shows a duplicate price error from the server', async () => {
    installFetch(budgetView, [event], [], { status: 409, message: 'a price already exists for model-a' });
    render(<ConfigPage onError={() => {}} />);

    fireEvent.change(await screen.findByLabelText(/Model id/, undefined, { timeout: ASYNC_TIMEOUT_MS }), {
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
      await screen.findByText('a price already exists for model-a', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('configures and saves email delivery independently', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const card = within(
      await screen.findByTestId('email-delivery-card', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    );
    const toggle = card.getByRole('checkbox', {
      name: /deliver budget alerts by email/i,
    });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.change(card.getByLabelText(/smtp host/i), {
      target: { value: 'smtp.example.test' },
    });
    fireEvent.change(card.getByLabelText(/smtp port/i), { target: { value: '465' } });
    fireEvent.click(card.getByRole('checkbox', { name: /implicit tls/i }));
    fireEvent.change(card.getByLabelText(/username/i), { target: { value: 'aps' } });
    fireEvent.change(card.getByLabelText(/^password/i), {
      target: { value: 'super-secret' },
    });
    fireEvent.change(card.getByLabelText(/from address/i), {
      target: { value: 'APS <alerts@example.test>' },
    });
    fireEvent.change(card.getByLabelText(/recipients/i), {
      target: { value: 'ops@example.test, oncall@example.test\nOPS@example.test' },
    });
    fireEvent.click(card.getByRole('button', { name: 'Save email delivery' }));

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
      }), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config?.notifications?.webhook).toBeUndefined();
    expect(await card.findByText('Saved', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(card.queryByDisplayValue('super-secret')).not.toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

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

    const card = within(
      await screen.findByTestId('email-delivery-card', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    );
    expect(
      await card.findByText('A password is saved.', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'Save email delivery' }));
    await waitFor(() => expect(captured.config).toBeDefined(), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(captured.config?.notifications?.email).not.toHaveProperty('password');
    expect(captured.config?.notifications?.email).toMatchObject({ username: 'aps' });

    fireEvent.click(card.getByRole('button', { name: 'Clear password' }));
    fireEvent.change(card.getByLabelText(/username/i), { target: { value: '' } });
    fireEvent.click(card.getByRole('button', { name: 'Save email delivery' }));
    await waitFor(() =>
      expect(captured.config?.notifications?.email).toMatchObject({
        username: null,
        password: null,
      }), { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('validates email delivery and reports a test result', async () => {
    const onError = vi.fn();
    const captured = installFetch();
    const view = render(<ConfigPage onError={onError} />);

    const card = within(
      await screen.findByTestId('email-delivery-card', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    );
    fireEvent.click(card.getByRole('checkbox', { name: /deliver budget alerts by email/i }));
    fireEvent.click(card.getByRole('button', { name: 'Save email delivery' }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Host, From address, and at least one recipient are required.',
      ), { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(captured.config).toBeUndefined();

    fireEvent.change(card.getByLabelText(/smtp host/i), {
      target: { value: 'smtp.example.test' },
    });
    fireEvent.change(card.getByLabelText(/from address/i), {
      target: { value: 'alerts@example.test' },
    });
    fireEvent.change(card.getByLabelText(/recipients/i), {
      target: { value: 'ops@example.test' },
    });
    fireEvent.click(card.getByRole('button', { name: 'Send test email' }));
    expect(
      await card.findByText(/Test email sent in 15 ms/, undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    view.unmount();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('shows email test failures', async () => {
    installFetch(budgetView, [event], [], undefined, undefined, webhook, email, {
      ok: false,
      error: 'eauth',
    });
    render(<ConfigPage onError={() => {}} />);
    const card = within(
      await screen.findByTestId('email-delivery-card', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    );
    fireEvent.click(card.getByRole('button', { name: 'Send test email' }));
    expect(await card.findByText('eauth', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('deletes a price after an inline confirmation', async () => {
    const price = makePrice();
    const captured = installFetch(budgetView, [event], [price]);
    render(<ConfigPage onError={() => {}} />);

    const remove = await screen.findByRole('button', { name: 'Delete price for model-a' }, { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.click(remove);
    expect(captured.deletedPriceId).toBeUndefined();
    expect(remove).toHaveTextContent('Confirm?');

    fireEvent.click(remove);
    await waitFor(() => expect(captured.deletedPriceId).toBe(price.id), { timeout: ASYNC_TIMEOUT_MS });
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('renders delivery history and filters by channel and status', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const card = within(
      await screen.findByTestId('delivery-history-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    expect(
      await card.findByText(/Overall · warning 80%/, undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    expect(card.getByText('HTTP 503')).toBeInTheDocument();
    expect(
      card.getByRole('button', { name: /Resend webhook delivery/i }),
    ).toBeInTheDocument();

    fireEvent.change(card.getByLabelText(/^Channel/), { target: { value: 'email' } });
    await waitFor(
      () => expect(captured.deliveryQuery).toContain('channel=email'),
      { timeout: ASYNC_TIMEOUT_MS },
    );

    fireEvent.change(card.getByLabelText(/^Status/), { target: { value: 'failed' } });
    await waitFor(
      () => expect(captured.deliveryQuery).toContain('status=failed'),
      { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

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
        deliveries: [
          deliveryRow,
          eventDeliveryRow,
          summaryDeliveryRow,
          overrideDeliveryRow,
        ],
        total: 4,
        limit: 10,
        offset: 0,
      },
    );
    render(<ConfigPage onError={() => {}} />);

    const card = within(
      await screen.findByTestId('delivery-history-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    expect(
      await card.findByText('Turn failed: Fix the parser', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    expect(card.getByText('Turn failed')).toBeInTheDocument();
    expect(card.getByText('Budget')).toBeInTheDocument();
    expect(card.getByText('Spend cap override expired: Overall')).toBeInTheDocument();
    expect(card.getByText('Override expired')).toBeInTheDocument();
    expect(card.getByText('Scorecard failed: Acme')).toBeInTheDocument();
    expect(card.getByText('Scorecard failed')).toBeInTheDocument();
    expect(
      card.getByRole('button', {
        name: /Resend webhook delivery for Turn failed: Fix the parser/i,
      }),
    ).toBeInTheDocument();

    fireEvent.change(card.getByLabelText(/^Type/), {
      target: { value: 'turn.failed' },
    });
    await waitFor(() => expect(captured.deliveryQuery).toContain('kind=turn.failed'), { timeout: ASYNC_TIMEOUT_MS });
    expect(captured.deliveryQuery).toContain('offset=0');

    fireEvent.change(card.getByLabelText(/^Type/), {
      target: { value: 'master.error' },
    });
    await waitFor(() => expect(captured.deliveryQuery).toContain('kind=master.error'), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.change(card.getByLabelText(/^Type/), {
      target: { value: 'summary.failed' },
    });
    await waitFor(() => expect(captured.deliveryQuery).toContain('kind=summary.failed'), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.change(card.getByLabelText(/^Type/), {
      target: { value: 'spend.override' },
    });
    await waitFor(() => expect(captured.deliveryQuery).toContain('kind=spend.override'), { timeout: ASYNC_TIMEOUT_MS });

    fireEvent.change(card.getByLabelText(/^Type/), { target: { value: 'budget' } });
    await waitFor(
      () => expect(captured.deliveryQuery).toContain('source=budget'),
      { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

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

    const card = within(await screen.findByTestId('delivery-history-card'));
    expect(await card.findByText('No deliveries yet.')).toBeInTheDocument();
    expect(card.queryByRole('button', { name: /Resend/i })).not.toBeInTheDocument();
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

    const card = within(
      await screen.findByTestId('delivery-history-card', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    );
    expect(
      await card.findByText('Showing 1–1 of 25', undefined, {
        timeout: ASYNC_TIMEOUT_MS,
      }),
    ).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'Older' }));
    await waitFor(
      () => expect(captured.deliveryQuery).toContain('offset=10'),
      { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CONFIG_PAGE_TEST_TIMEOUT_MS);

  it('resends a failed delivery and refreshes the list', async () => {
    const captured = installFetch();
    render(<ConfigPage onError={() => {}} />);

    const card = within(await screen.findByTestId('delivery-history-card'));
    fireEvent.click(card.getByRole('button', { name: /Resend webhook delivery/i }));
    await waitFor(() => expect(captured.resendId).toBe('d1'));
    expect(await card.findByRole('status')).toHaveTextContent(
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

    const card = within(await screen.findByTestId('delivery-history-card'));
    fireEvent.click(card.getByRole('button', { name: /Resend webhook delivery/i }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('already delivered'),
    );
  });
});
