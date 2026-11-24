import { createHash } from 'node:crypto';
import {
  budgetChatText,
  chatDestinationId,
  resolveChatChannel,
  truncateChatText,
  type BudgetAlert,
  type BudgetAlertEvent,
  type ChatProvider,
  type ChatSettings,
} from '../domain/budget.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const SLACK_MAX_TEXT = 3_900;
export const DISCORD_MAX_TEXT = 1_900;

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const USER_AGENT = 'aps-budget-alert/1';

const SLACK_RETRYABLE_ERRORS = new Set([
  'ratelimited',
  'rate_limited',
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
]);

export interface ChatTarget {
  provider: ChatProvider;
  channelId: string;
  destinationId: string;
  destinationHash: string;
}

export interface ChatDecision {
  ok: boolean;
  status?: number;
  reason?: string;
  retryable?: boolean;
  retryAfterMs?: number | null;
}

export interface ChatTextOptions {
  event?: BudgetAlertEvent['event'];
  brainUrl?: string | null;
}

/** The identity a chat delivery was enqueued for. Never returned or logged. */
export function chatDestinationHash(
  provider: ChatProvider,
  settings: Pick<ChatSettings, 'botToken'>,
  channelId: string,
): string {
  return createHash('sha256')
    .update(`${provider}\n${channelId}\n${settings.botToken ?? ''}`)
    .digest('hex');
}

/** Resolve one alert to a configured provider channel and its durable identity. */
export function resolveChatTarget(
  provider: ChatProvider,
  settings: ChatSettings,
  alert: BudgetAlert,
): ChatTarget | null {
  const channelId = resolveChatChannel(settings, alert.scope, alert.cellId);
  if (channelId === null) return null;
  const destination = settings.destinations.find(
    (candidate) => candidate.channelId === channelId,
  );
  if (!destination) return null;
  return {
    provider,
    channelId,
    destinationId: chatDestinationId(provider, channelId),
    destinationHash: chatDestinationHash(provider, settings, channelId),
  };
}

export function chatText(
  alert: BudgetAlert,
  provider: ChatProvider,
  options: ChatTextOptions = {},
): string {
  const text = budgetChatText(alert, options);
  return truncateChatText(
    text,
    provider === 'slack' ? SLACK_MAX_TEXT : DISCORD_MAX_TEXT,
  );
}

export function chatUrl(provider: ChatProvider, channelId: string): string {
  if (provider === 'slack') return 'https://slack.com/api/chat.postMessage';
  return `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`;
}

export function chatRequest(
  provider: ChatProvider,
  botToken: string,
  channelId: string,
  text: string,
): { url: string; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    authorization: provider === 'slack' ? `Bearer ${botToken}` : `Bot ${botToken}`,
  };
  const payload =
    provider === 'slack'
      ? {
          channel: channelId,
          text,
          mrkdwn: false,
          unfurl_links: false,
          unfurl_media: false,
          link_names: false,
        }
      : {
          content: text,
          allowed_mentions: { parse: [] },
        };
  return { url: chatUrl(provider, channelId), headers, body: JSON.stringify(payload) };
}

export async function readChatBody(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
}

function headerValue(response: Response, name: string): string | null {
  try {
    return response.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

function capRetryAfter(value: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, value));
}

function retryAfterFromHeader(response: Response, now: number): number | null {
  const raw = headerValue(response, 'retry-after');
  if (raw === null || raw.trim() === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return capRetryAfter(seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return capRetryAfter(date - now);
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function retryAfterFromDiscordBody(body: string): number | null {
  const parsed = parseJson(body);
  const seconds = parsed?.['retry_after'];
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return capRetryAfter(seconds * 1000);
}

function sanitizeSlackCode(value: string): string {
  const code = value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
  return code === '' ? 'error' : code;
}

function genericFailure(
  status: number,
  retryAfterMs: number | null,
): ChatDecision {
  if (status === 429) {
    return { ok: false, status, reason: 'HTTP 429', retryable: true, retryAfterMs };
  }
  if (status === 408 || status >= 500) {
    return { ok: false, status, reason: `HTTP ${status}`, retryable: true };
  }
  return { ok: false, status, reason: `HTTP ${status}`, retryable: false };
}

/** Classify a provider response without exposing its body. */
export function classifyChatResponse(
  provider: ChatProvider,
  response: Response,
  body: string,
  now: number,
): ChatDecision {
  const status = response.status;
  if (provider === 'slack') {
    if (status >= 200 && status < 300) {
      const parsed = parseJson(body);
      if (parsed?.['ok'] === true) return { ok: true, status };
      if (parsed?.['ok'] === false && typeof parsed['error'] === 'string') {
        const code = sanitizeSlackCode(parsed['error']);
        return {
          ok: false,
          status,
          reason: `slack_${code}`,
          retryable: SLACK_RETRYABLE_ERRORS.has(parsed['error']),
        };
      }
      return { ok: false, status, reason: 'invalid_response', retryable: false };
    }
    return genericFailure(status, retryAfterFromHeader(response, now));
  }

  if (status >= 200 && status < 300) return { ok: true, status };
  if (status === 429) {
    return {
      ok: false,
      status,
      reason: 'HTTP 429',
      retryable: true,
      retryAfterMs:
        retryAfterFromDiscordBody(body) ?? retryAfterFromHeader(response, now),
    };
  }
  return genericFailure(status, retryAfterFromHeader(response, now));
}
