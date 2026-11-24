import { useEffect, useState } from 'react';
import { api, describeError } from './api';
import {
  MAX_CHAT_LABEL_LENGTH,
  chatBotTokenError,
  chatChannelIdError,
  timeAgo,
  type CellDetail,
  type ChatDestination,
  type ChatPatch,
  type ChatRoute,
  type ChatStatus,
  type ChatView,
  type NotificationStatusResponse,
} from './types';
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionTitle,
  Select,
  Spinner,
  cn,
} from './ui';

interface TestResult {
  ok: boolean;
  message: string;
}

export interface ChatDeliveryCardProps {
  provider: 'slack' | 'discord';
  settings: ChatView;
  cells: CellDetail[];
  status: ChatStatus | null;
  onError: (message: string) => void;
  onSaved: (settings: ChatView) => void;
  onStatus: (status: NotificationStatusResponse | null) => void;
}

export function emptyChatView(): ChatView {
  return {
    enabled: false,
    botToken: null,
    botTokenSet: false,
    destinations: [],
    defaultChannelId: null,
    routes: [],
  };
}

export function ChatDeliveryCard({
  provider,
  settings,
  cells,
  status,
  onError,
  onSaved,
  onStatus,
}: ChatDeliveryCardProps) {
  const label = provider === 'slack' ? 'Slack' : 'Discord';
  const [enabled, setEnabled] = useState(settings.enabled);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [destinations, setDestinations] = useState<ChatDestination[]>([]);
  const [defaultChannelId, setDefaultChannelId] = useState('');
  const [routes, setRoutes] = useState<ChatRoute[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    setEnabled(settings.enabled);
    setToken('');
    setClearToken(false);
    setDestinations(settings.destinations.map((destination) => ({ ...destination })));
    setDefaultChannelId(settings.defaultChannelId ?? '');
    setRoutes(settings.routes.map((route) => ({ ...route })));
    setTestResults({});
  }, [settings]);

  const hasToken = !clearToken && (token.trim() !== '' || settings.botTokenSet);
  const channels = destinations
    .map((destination) => destination.channelId.trim())
    .filter((channelId) => channelId !== '');

  function updateDestination(
    index: number,
    field: keyof ChatDestination,
    value: string,
  ): void {
    setDestinations((current) =>
      current.map((destination, position) =>
        position === index
          ? { ...destination, [field]: field === 'label' ? value || null : value }
          : destination,
      ),
    );
    setSaved(false);
  }

  function addDestination(): void {
    setDestinations((current) => [...current, { channelId: '', label: null }]);
    setSaved(false);
  }

  function removeDestination(index: number): void {
    const removed = destinations[index]?.channelId ?? '';
    setDestinations((current) => current.filter((_destination, position) => position !== index));
    if (defaultChannelId === removed) setDefaultChannelId('');
    setRoutes((current) => current.filter((route) => route.channelId !== removed));
    setSaved(false);
  }

  function addRoute(): void {
    const cell = cells.find(
      (candidate) => !routes.some((route) => route.cellId === candidate.id),
    );
    const channelId = destinations[0]?.channelId ?? '';
    if (!cell || channelId === '') {
      onError(`Add a ${label} cell and destination before adding a route.`);
      return;
    }
    setRoutes((current) => [...current, { cellId: cell.id, channelId }]);
    setSaved(false);
  }

  function updateRoute(index: number, field: keyof ChatRoute, value: string): void {
    setRoutes((current) =>
      current.map((route, position) =>
        position === index ? { ...route, [field]: value } : route,
      ),
    );
    setSaved(false);
  }

  function removeRoute(index: number): void {
    setRoutes((current) => current.filter((_route, position) => position !== index));
    setSaved(false);
  }

  function validate(): string | null {
    const cleanDestinations = destinations.map((destination) => ({
      channelId: destination.channelId.trim(),
      label: destination.label?.trim() || null,
    }));
    const cleanRoutes = routes.map((route) => ({
      cellId: route.cellId.trim(),
      channelId: route.channelId.trim(),
    }));

    for (const destination of cleanDestinations) {
      const problem = chatChannelIdError(provider, destination.channelId);
      if (problem !== null) {
        return `The ${label} channel ID ${problem}.`;
      }
      if (destination.label !== null && destination.label.length > MAX_CHAT_LABEL_LENGTH) {
        return `The ${label} destination label must be at most ${MAX_CHAT_LABEL_LENGTH} characters.`;
      }
    }
    const duplicate = cleanDestinations.find(
      (destination, index) =>
        cleanDestinations.findIndex(
          (candidate) => candidate.channelId === destination.channelId,
        ) !== index,
    );
    if (duplicate) return `The ${label} destination ${duplicate.channelId} is duplicated.`;

    const channelIds = new Set(cleanDestinations.map((destination) => destination.channelId));
    if (defaultChannelId !== '' && !channelIds.has(defaultChannelId)) {
      return `The ${label} default must be a configured destination.`;
    }
    const routeCells = new Set<string>();
    for (const route of cleanRoutes) {
      if (route.cellId === '') return `Every ${label} route needs a cell.`;
      if (routeCells.has(route.cellId)) return `Each ${label} cell may have one route.`;
      routeCells.add(route.cellId);
      if (!channelIds.has(route.channelId)) {
        return `Every ${label} route must use a configured destination.`;
      }
    }

    if (token.trim() !== '') {
      const problem = chatBotTokenError(token.trim());
      if (problem !== null) return `The ${label} bot token ${problem}.`;
    }
    if (enabled && !hasToken) return `A ${label} bot token is required when delivery is enabled.`;
    if (enabled && cleanDestinations.length === 0) {
      return `Add at least one ${label} destination before enabling delivery.`;
    }
    if (enabled && defaultChannelId === '' && cleanRoutes.length === 0) {
      return `Choose a ${label} default destination or add a cell route.`;
    }
    return null;
  }

  async function save(): Promise<void> {
    const problem = validate();
    if (problem !== null) {
      onError(problem);
      return;
    }
    const patch: ChatPatch = {
      enabled,
      destinations: destinations.map((destination) => ({
        channelId: destination.channelId.trim(),
        label: destination.label?.trim() || null,
      })),
      defaultChannelId: defaultChannelId === '' ? null : defaultChannelId,
      routes: routes.map((route) => ({
        cellId: route.cellId.trim(),
        channelId: route.channelId.trim(),
      })),
    };
    if (clearToken) patch.botToken = null;
    else if (token.trim() !== '') patch.botToken = token.trim();

    setSaving(true);
    try {
      const config = await api.patchConfig({ notifications: { [provider]: patch } });
      const next = config.notifications?.[provider] ?? emptyChatView();
      onSaved(next);
      setToken('');
      setClearToken(false);
      setSaved(true);
      setTestResults({});
      const status = await api.getNotificationStatus().catch(() => null);
      onStatus(status);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  async function testDestination(channelId: string): Promise<void> {
    setTestingChannel(channelId);
    try {
      const result =
        provider === 'slack'
          ? await api.testSlack(channelId)
          : await api.testDiscord(channelId);
      setTestResults((current) => ({
        ...current,
        [channelId]: {
          ok: result.ok,
          message: result.ok
            ? `Test delivered (HTTP ${result.status ?? 200}) in ${result.durationMs} ms.`
            : result.error ?? `The ${label} test failed.`,
        },
      }));
      const status = await api.getNotificationStatus().catch(() => null);
      onStatus(status);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setTestingChannel(null);
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div>
        <SectionTitle>{label} alerts</SectionTitle>
        <p className="mt-1 text-sm text-zinc-500">
          Send budget alerts through a {label} bot, with a default channel and optional
          per-cell routes. Delivery is advisory and independent of the webhook and email
          channels.
        </p>
      </div>

      <Checkbox
        label={`Deliver budget alerts to a ${label} bot`}
        checked={enabled}
        onChange={(event) => {
          setEnabled(event.target.checked);
          setSaved(false);
        }}
      />

      <Field
        label={`${label} bot token`}
        hint="blank keeps the saved token; stored in the settings file"
      >
        <Input
          type="password"
          autoComplete="off"
          value={token}
          placeholder={settings.botTokenSet ? 'Saved token (leave blank to keep)' : 'Bot token'}
          onChange={(event) => {
            setToken(event.target.value);
            setClearToken(false);
            setSaved(false);
          }}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-zinc-500">
          {settings.botTokenSet ? 'A bot token is saved.' : 'No bot token saved.'}
        </span>
        {settings.botTokenSet && !clearToken ? (
          <Button
            size="sm"
            onClick={() => {
              setClearToken(true);
              setEnabled(false);
              setToken('');
              setSaved(false);
            }}
          >
            Clear token
          </Button>
        ) : null}
        {clearToken ? (
          <>
            <span className="text-amber-400">The token will be cleared on save.</span>
            <Button size="sm" onClick={() => setClearToken(false)}>
              Keep token
            </Button>
          </>
        ) : null}
      </div>

      <div className="space-y-2">
        <SectionTitle>Destinations</SectionTitle>
        {destinations.map((destination, index) => {
          const result = testResults[destination.channelId];
          return (
            <div key={`${index}:${destination.channelId}`} className="space-y-1">
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Field label={`${label} destination ${index + 1} channel ID`}>
                  <Input
                    value={destination.channelId}
                    placeholder={provider === 'slack' ? 'C0123456789' : '123456789012345678'}
                    onChange={(event) =>
                      updateDestination(index, 'channelId', event.target.value)
                    }
                  />
                </Field>
                <Field label={`${label} destination ${index + 1} label`}>
                  <Input
                    value={destination.label ?? ''}
                    placeholder="Ops"
                    onChange={(event) =>
                      updateDestination(index, 'label', event.target.value)
                    }
                  />
                </Field>
                <div className="flex items-end gap-2">
                  <Button
                    size="sm"
                    disabled={testingChannel !== null || !hasToken}
                    onClick={() => void testDestination(destination.channelId)}
                  >
                    {testingChannel === destination.channelId ? <Spinner /> : 'Send test'}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => removeDestination(index)}>
                    Remove
                  </Button>
                </div>
              </div>
              {result ? (
                <p
                  role="status"
                  className={cn(
                    'text-[11px]',
                    result.ok ? 'text-emerald-400' : 'text-red-400',
                  )}
                >
                  {result.message}
                </p>
              ) : null}
            </div>
          );
        })}
        <Button size="sm" onClick={addDestination}>
          Add destination
        </Button>
      </div>

      <Field
        label={`${label} default destination`}
        hint="overall alerts and the fallback for unrouted cells"
      >
        <Select
          value={defaultChannelId}
          onChange={(event) => {
            setDefaultChannelId(event.target.value);
            setSaved(false);
          }}
        >
          <option value="">None</option>
          {destinations.map((destination, index) => (
            <option key={`${index}:${destination.channelId}`} value={destination.channelId}>
              {destination.label ?? (destination.channelId || `Destination ${index + 1}`)}
            </option>
          ))}
        </Select>
      </Field>

      <div className="space-y-2">
        <SectionTitle>Cell routes</SectionTitle>
        {routes.map((route, index) => (
          <div key={`${index}:${route.cellId}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field label={`${label} route ${index + 1} cell`}>
              <Select
                value={route.cellId}
                onChange={(event) => updateRoute(index, 'cellId', event.target.value)}
              >
                {cells.map((cell) => (
                  <option key={cell.id} value={cell.id}>
                    {cell.name}
                  </option>
                ))}
                {cells.some((cell) => cell.id === route.cellId) ? null : (
                  <option value={route.cellId}>Deleted cell ({route.cellId})</option>
                )}
              </Select>
            </Field>
            <Field label={`${label} route ${index + 1} destination`}>
              <Select
                value={route.channelId}
                onChange={(event) => updateRoute(index, 'channelId', event.target.value)}
              >
                {destinations.map((destination, position) => (
                  <option
                    key={`${position}:${destination.channelId}`}
                    value={destination.channelId}
                  >
                    {destination.label ??
                      (destination.channelId || `Destination ${position + 1}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button size="sm" variant="danger" onClick={() => removeRoute(index)}>
                Remove
              </Button>
            </div>
          </div>
        ))}
        <Button size="sm" onClick={addRoute}>
          Add route
        </Button>
      </div>

      <p className="text-[11px] text-zinc-600">
        The bot must already be invited to each channel. {label} ignores the webhook
        signing secret; it is not used for bot delivery.
      </p>

      <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          {status ? (
            <p className="text-[11px] text-zinc-600">
              {status.configured ? `${label} configured` : `No ${label} destination configured`}{' '}
              · {status.pending} pending · {status.failed} failed
              {status.lastDeliveryAt !== null
                ? ` · last ${status.lastDeliveryStatus ?? 'unknown'} ${timeAgo(status.lastDeliveryAt)} ago`
                : ' · no deliveries yet'}
              {status.lastError ? ` · ${status.lastError}` : ''}
            </p>
          ) : null}
          {status?.destinations.map((destination) => (
            <p key={destination.channelId} className="text-[11px] text-zinc-600">
              {destination.label ?? destination.channelId}: {destination.pending} pending ·{' '}
              {destination.failed} failed
              {destination.lastError ? ` · ${destination.lastError}` : ''}
            </p>
          ))}
          {channels.length === 0 ? (
            <p className="text-[11px] text-zinc-600">Add a destination to send a test.</p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2">
          {saved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner /> : `Save ${label} delivery`}
          </Button>
        </div>
      </div>
    </Card>
  );
}
