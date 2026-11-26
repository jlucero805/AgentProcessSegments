/**
 * The SPA reuses the pure contract modules from the server workspace so the
 * workflow table, request shape, and master/plugin shapes cannot drift. Those
 * modules must stay free of Node-only imports; `npm run build --workspace src/web`
 * bundles them into the SPA.
 */
export type { HarnessId } from '../../server/src/domain/harness';
export { HARNESS_IDS, HARNESS_LABELS } from '../../server/src/domain/harness';
export type {
  AgentStatus,
  Cell,
  ClarifyEvent,
  Effort,
  IndexAllFailure,
  IndexAllResult,
  IndexAllSkipped,
  IndexAllSkipReason,
  KbEntry,
  Request,
  State,
  TranscriptMsg,
} from '../../server/src/domain/request';
export {
  EFFORT_LEVELS,
  STATES,
  TERMINAL_STATES,
  canTransition,
  isIntake,
  isTerminal,
} from '../../server/src/domain/request';
export type {
  MasterAction,
  MasterConfig,
  MasterEvent,
  MasterResult,
  MasterStatus,
} from '../../server/src/master/types';
export type {
  BudgetAlert,
  BudgetScope,
  BudgetSettings,
  BudgetState,
  BudgetStatus,
  BudgetThreshold,
  BudgetsResponse,
  ChatDestination,
  ChatPatch,
  ChatProvider,
  ChatRoute,
  ChatSettings,
  BudgetDeliveryHistoryItem,
  ChatView,
  DeliveryAlertSnapshot,
  DeliveryChannel,
  DeliveryFormat,
  DeliveryHistoryItem,
  DeliveryHistoryQuery,
  DeliveryHistoryResponse,
  DeliveryHistorySource,
  DeliveryStatus,
  EventDeliveryHistoryItem,
  EmailPatch,
  EmailSettings,
  EmailView,
  EventChannel,
  EventChannelSettings,
  EventNotificationSettings,
  EventRoute,
  NotificationsSettings,
  NotificationsView,
  SpendCapOverride,
  SpendCapOverrideHistoryItem,
  SpendCapOverrideHistoryQuery,
  SpendCapOverrideHistoryResponse,
  SpendCapOverrideState,
  SpendPause,
  SpendPauseReason,
  WebhookFormat,
  WebhookPatch,
  WebhookSettings,
  WebhookView,
} from '../../server/src/domain/budget';
export {
  CHAT_PROVIDERS,
  DEFAULT_BUDGET_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_EVENT_COALESCE_MINUTES,
  DEFAULT_NOTIFICATIONS,
  EVENT_CHANNELS,
  MAX_BUDGET_USD,
  MAX_CHAT_DESTINATIONS,
  MAX_CHAT_LABEL_LENGTH,
  MAX_CHAT_ROUTES,
  MAX_EVENT_COALESCE_MINUTES,
  MAX_EVENT_ROUTES,
  MIN_EVENT_COALESCE_MINUTES,
  SPEND_CAP_OVERRIDE_STATES,
  WEBHOOK_FORMATS,
  budgetAlertText,
  chatBotTokenError,
  chatChannelIdError,
  chatDeliveryConfigured,
  emailAddressError,
  emailRecipientsError,
  smtpHostError,
  webhookUrlError,
} from '../../server/src/domain/budget';
export type { CommandInfo, PluginInfo } from '../../server/src/plugins/types';
export type { SkillInfo } from '../../server/src/skills/types';
export { EVENT_NOTIFICATION_KINDS } from '../../server/src/domain/notifications';
export type {
  Summary,
  SummaryConfig,
  SummaryStats,
  SummaryStatus,
} from '../../server/src/summary/types';
export type { TerminalSessionInfo } from '../../server/src/terminal/types';
export type { ModelOption } from '../../server/src/clarify/models';
export type { UsageSettings } from '../../server/src/usage/settings';
export {
  DEFAULT_USAGE_RETENTION_DAYS,
  MAX_USAGE_RETENTION_DAYS,
} from '../../server/src/usage/settings';
export type { RetentionSettings } from '../../server/src/retention/settings';
export {
  DEFAULT_BUDGET_ALERTS_RETENTION_DAYS,
  DEFAULT_CELL_SUMMARIES_RETENTION_DAYS,
  DEFAULT_MASTER_EVENTS_RETENTION_DAYS,
  DEFAULT_REQUEST_ARTIFACTS_RETENTION_DAYS,
  MAX_BUDGET_ALERTS_RETENTION_DAYS,
  MAX_CELL_SUMMARIES_RETENTION_DAYS,
  MAX_MASTER_EVENTS_RETENTION_DAYS,
  MAX_REQUEST_ARTIFACTS_RETENTION_DAYS,
} from '../../server/src/retention/settings';
export type {
  ModelPrice,
  ModelPriceInput,
  ModelPricesResponse,
} from '../../server/src/pricing/types';
export type {
  UsageBucket,
  UsageCoverage,
  UsageFilter,
  UsageGroup,
  UsagePruneSummary,
  UsageResponse,
  UsageTotals,
} from '../../server/src/usage/types';
export { USAGE_BUCKETS, USAGE_BUCKET_MS, usageBucketStart } from '../../server/src/usage/types';
export type {
  CellDetail,
  FollowUpPolicy,
  ProcessConfig,
  SegmentConfig,
  SegmentId,
} from '../../server/src/process/definition';
export {
  SEGMENT_IDS,
  SEGMENT_STATES,
  isSchedulableSegment,
} from '../../server/src/process/definition';
export {
  KB_SESSION_ID,
  SETUP_SESSION_PREFIX,
  isSetupSession,
  masterSessionId,
  setupSessionId,
} from '../../server/src/domain/sessions';

import type { HarnessId } from '../../server/src/domain/harness';
import type { AgentStatus, Effort, Request, State, TranscriptMsg } from '../../server/src/domain/request';
import type {
  BudgetSettings,
  DeliveryStatus,
  NotificationsView,
  WebhookFormat,
} from '../../server/src/domain/budget';
import type { MasterConfig } from '../../server/src/master/types';
import type { ModelOption } from '../../server/src/clarify/models';
import type { NotificationEventKind } from '../../server/src/domain/notifications';
import type { ProcessConfig } from '../../server/src/process/definition';
import type { SummaryConfig } from '../../server/src/summary/types';
import type { UsageSettings } from '../../server/src/usage/settings';
import type { RetentionSettings } from '../../server/src/retention/settings';

export interface ModelsResult {
  models: ModelOption[];
  source: 'probe' | 'fallback';
  effortLevels: readonly string[];
  /** Additive capability fields from the brain. */
  harness?: HarnessId;
  supportsEffort?: boolean;
  defaultModel?: string | null;
}

export interface AppConfig {
  master: MasterConfig;
  summary: SummaryConfig;
  usage: UsageSettings;
  retention: RetentionSettings;
  budget: BudgetSettings;
  notifications: NotificationsView;
}

export interface WebhookStatus {
  enabled: boolean;
  configured: boolean;
  format: WebhookFormat;
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
}

export interface ChatDestinationStatus {
  channelId: string;
  label: string | null;
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
}

export interface ChatStatus {
  enabled: boolean;
  configured: boolean;
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
  destinations: ChatDestinationStatus[];
}

export interface EventKindStatus {
  pending: number;
  failed: number;
}

export interface EventNotificationStatus {
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
  byKind: Record<NotificationEventKind, EventKindStatus>;
}

export interface NotificationStatusResponse {
  webhook: WebhookStatus;
  email: EmailStatus;
  slack: ChatStatus;
  discord: ChatStatus;
  events: EventNotificationStatus;
}

export interface EmailStatus {
  enabled: boolean;
  configured: boolean;
  pending: number;
  failed: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastError: string | null;
}

export interface WebhookTestResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
}

export type EmailTestResult = WebhookTestResult;
export type ChatTestResult = WebhookTestResult;

export interface ConfigResponse extends AppConfig {
  path: string;
}

export interface ProcessResponse extends ProcessConfig {
  path: string;
}

export interface DocPage {
  slug: string;
  title: string;
  group: string;
  description?: string;
}

export interface DocContent extends DocPage {
  markdown: string;
  updatedAt: number;
}

export interface CellDraft {
  id: string;
  name: string;
  masterIntervalMinutes: number | null;
  maxConcurrent: number;
  harness: HarnessId | null;
  model: string | null;
  effort: Effort | null;
  autocompactPercent: number;
  process: ProcessConfig;
  updatedAt: number;
}

export interface TerminalStatus {
  available: boolean;
  cwd: string;
  sessions?: number;
}

export interface ClarifyState {
  started: boolean;
  transcript: TranscriptMsg[];
  /** True when a turn is live and can be reattached. */
  active?: boolean;
}

export type Column = 'intake' | 'clarify' | 'dispatch' | 'review' | 'merge' | 'finalize';
export const COLUMNS: readonly Column[] = [
  'intake',
  'clarify',
  'dispatch',
  'review',
  'merge',
  'finalize',
];

export const COLUMN_LABELS: Record<Column, string> = {
  intake: 'Requests',
  clarify: 'Plan',
  dispatch: 'Implement',
  review: 'Review',
  merge: 'Merge',
  finalize: 'Finalize',
};

/** Human labels for the workflow states themselves. */
export const STATE_LABELS: Record<State, string> = {
  clarify: 'Clarify',
  dispatch: 'Implement',
  review: 'Review',
  merge: 'Merge',
  finalize: 'Finalize',
  done: 'Done',
  dropped: 'Dropped',
};

/** The state a column represents; null for intake, which is a view over clarify. */
export const COLUMN_STATE: Record<Column, State | null> = {
  intake: null,
  clarify: 'clarify',
  dispatch: 'dispatch',
  review: 'review',
  merge: 'merge',
  finalize: 'finalize',
};

export function columnOf(request: Pick<Request, 'state' | 'clarifyStarted'>): Column | null {
  if (request.state === 'clarify') return request.clarifyStarted ? 'clarify' : 'intake';
  if (request.state === 'dispatch') return 'dispatch';
  if (request.state === 'review') return 'review';
  if (request.state === 'merge') return 'merge';
  if (request.state === 'finalize') return 'finalize';
  return null;
}

export const AGENT_BADGE: Record<AgentStatus, { label: string; className: string }> = {
  none: { label: 'none', className: 'text-zinc-500' },
  idle: { label: 'idle', className: 'text-emerald-400' },
  working: { label: 'working', className: 'text-blue-400' },
  blocked: { label: 'blocked', className: 'text-amber-400' },
  error: { label: 'error', className: 'text-red-400' },
};

export function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
