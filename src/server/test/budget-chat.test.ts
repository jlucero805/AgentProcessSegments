import { describe, expect, it } from 'vitest';
import { budgetPeriod, type BudgetAlert, type ChatSettings } from '../src/domain/budget.js';
import {
  chatDestinationHash,
  chatRequest,
  chatText,
  classifyChatResponse,
  resolveChatTarget,
} from '../src/usage/budget-chat.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const PERIOD = budgetPeriod(NOW);

function alert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  return {
    id: 'alert-1',
    scope: 'overall',
    cellId: null,
    cellName: null,
    threshold: 'warning',
    alertAtPercent: 80,
    budgetUsd: 100,
    spendUsd: 85,
    unknownCostTurns: 0,
    periodStart: PERIOD.start,
    createdAt: NOW,
    acknowledgedAt: null,
    ...overrides,
  };
}

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    enabled: true,
    botToken: 'xoxb-0123456789abcdef',
    destinations: [{ channelId: 'C0123456789', label: 'Ops' }],
    defaultChannelId: 'C0123456789',
    routes: [],
    ...overrides,
  };
}

function response(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): Response {
  return new Response(body === '' ? null : body, { status, headers });
}

describe('chat delivery transport', () => {
  it('hashes the provider, channel, and token without exposing them', () => {
    const first = chatDestinationHash('slack', { botToken: 'token-a' }, 'C0123456789');
    const same = chatDestinationHash('slack', { botToken: 'token-a' }, 'C0123456789');
    const rotated = chatDestinationHash('slack', { botToken: 'token-b' }, 'C0123456789');
    const other = chatDestinationHash('discord', { botToken: 'token-a' }, 'C0123456789');
    expect(first).toBe(same);
    expect(first).not.toBe(rotated);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves the default and per-cell route to a durable target', () => {
    const scoped = settings({
      destinations: [
        { channelId: 'C0123456789', label: 'Ops' },
        { channelId: 'C9876543210', label: 'Cell' },
      ],
      routes: [{ cellId: 'cell-a', channelId: 'C9876543210' }],
    });
    expect(resolveChatTarget('slack', scoped, alert())).toMatchObject({
      provider: 'slack',
      channelId: 'C0123456789',
      destinationId: 'slack:C0123456789',
    });
    expect(
      resolveChatTarget(
        'slack',
        scoped,
        alert({ scope: 'cell', cellId: 'cell-a', cellName: 'A' }),
      ),
    ).toMatchObject({ channelId: 'C9876543210', destinationId: 'slack:C9876543210' });
    expect(
      resolveChatTarget(
        'slack',
        settings({ defaultChannelId: null, routes: [] }),
        alert({ scope: 'cell', cellId: 'cell-a' }),
      ),
    ).toBeNull();
  });

  it('builds Slack and Discord requests with provider auth and safe bodies', () => {
    const slack = chatRequest('slack', 'xoxb-token', 'C0123456789', 'hello');
    expect(slack.url).toBe('https://slack.com/api/chat.postMessage');
    expect(slack.headers.authorization).toBe('Bearer xoxb-token');
    expect(JSON.parse(slack.body)).toEqual({
      channel: 'C0123456789',
      text: 'hello',
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
      link_names: false,
    });

    const discord = chatRequest('discord', 'discord-token', '123456789012345678', 'hello');
    expect(discord.url).toBe(
      'https://discord.com/api/v10/channels/123456789012345678/messages',
    );
    expect(discord.headers.authorization).toBe('Bot discord-token');
    expect(JSON.parse(discord.body)).toEqual({
      content: 'hello',
      allowed_mentions: { parse: [] },
    });
  });

  it('caps provider bodies and strips dynamic angle brackets', () => {
    const text = chatText(
      alert({ cellName: '<!channel> ' + 'x'.repeat(4_000), scope: 'cell', cellId: 'c1' }),
      'discord',
    );
    expect(text).not.toContain('<!channel>');
    expect(text.length).toBeLessThanOrEqual(1_900);
    expect(text.endsWith('…')).toBe(true);
  });

  it('classifies Slack success and error payloads', () => {
    expect(
      classifyChatResponse('slack', response(200, '{"ok":true}'), '{"ok":true}', NOW),
    ).toEqual({ ok: true, status: 200 });
    expect(
      classifyChatResponse(
        'slack',
        response(200, '{"ok":false,"error":"not_in_channel"}'),
        '{"ok":false,"error":"not_in_channel"}',
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 200, reason: 'slack_not_in_channel', retryable: false });
    expect(
      classifyChatResponse(
        'slack',
        response(200, '{"ok":false,"error":"ratelimited"}'),
        '{"ok":false,"error":"ratelimited"}',
        NOW,
      ),
    ).toMatchObject({ ok: false, reason: 'slack_ratelimited', retryable: true });
    expect(
      classifyChatResponse('slack', response(200, 'nope'), 'nope', NOW),
    ).toMatchObject({ ok: false, reason: 'invalid_response', retryable: false });
    expect(
      classifyChatResponse('slack', response(429, '', { 'retry-after': '30' }), '', NOW),
    ).toMatchObject({ ok: false, status: 429, retryable: true, retryAfterMs: 30_000 });
  });

  it('classifies Discord success, rate limits, and permanent failures', () => {
    expect(classifyChatResponse('discord', response(204), '', NOW)).toEqual({
      ok: true,
      status: 204,
    });
    expect(
      classifyChatResponse(
        'discord',
        response(429, '{"retry_after":1.5}', { 'retry-after': '99' }),
        '{"retry_after":1.5}',
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 429, retryable: true, retryAfterMs: 1_500 });
    expect(
      classifyChatResponse('discord', response(403), '', NOW),
    ).toMatchObject({ ok: false, status: 403, reason: 'HTTP 403', retryable: false });
    expect(
      classifyChatResponse('discord', response(503), '', NOW),
    ).toMatchObject({ ok: false, status: 503, retryable: true });
    expect(
      classifyChatResponse('discord', response(302, '', { location: '/x' }), '', NOW),
    ).toMatchObject({ ok: false, status: 302, retryable: false });
  });
});
