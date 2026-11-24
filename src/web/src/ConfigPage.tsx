import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import { ACTION_TONES, eventDetail } from './masterView';
import { ChatDeliveryCard, emptyChatView } from './ChatDeliveryCard';
import { ProcessEditor } from './ProcessEditor';
import {
  DEFAULT_BUDGET_SETTINGS,
  DEFAULT_NOTIFICATIONS,
  MAX_BUDGET_USD,
  MAX_CELL_SUMMARIES_RETENTION_DAYS,
  MAX_MASTER_EVENTS_RETENTION_DAYS,
  MAX_REQUEST_ARTIFACTS_RETENTION_DAYS,
  MAX_USAGE_RETENTION_DAYS,
  WEBHOOK_FORMATS,
  emailAddressError,
  emailRecipientsError,
  smtpHostError,
  timeAgo,
  webhookUrlError,
  type BudgetSettings,
  type BudgetStatus,
  type BudgetsResponse,
  type CellDetail,
  type ChatView,
  type DeliveryChannel,
  type DeliveryHistoryItem,
  type DeliveryHistoryResponse,
  type DeliveryStatus,
  type EmailPatch,
  type MasterConfig,
  type MasterEvent,
  type ModelPrice,
  type ModelPriceInput,
  type NotificationStatusResponse,
  type NotificationsView,
  type ProcessConfig,
  type RetentionSettings,
  type SegmentConfig,
  type SummaryConfig,
  type UsageSettings,
  type WebhookFormat,
  type WebhookPatch,
} from './types';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionTitle,
  Select,
  Spinner,
  Textarea,
} from './ui';

interface ConfigPageProps {
  onError: (message: string) => void;
  onEditCell?: (cell: CellDetail) => void;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function moneyLabel(value: number): string {
  return money.format(value);
}

function pct(value: number): string {
  return `${value.toFixed(0)}%`;
}

const DELIVERY_TONES: Record<
  DeliveryStatus,
  'neutral' | 'green' | 'blue' | 'amber' | 'red' | 'purple'
> = {
  pending: 'amber',
  delivering: 'blue',
  delivered: 'green',
  failed: 'red',
  skipped: 'neutral',
};

function deliveryAlertLabel(item: DeliveryHistoryItem): string {
  const scope =
    item.alert.scope === 'overall' ? 'Overall' : item.alert.cellName ?? 'Deleted cell';
  return `${scope} · ${item.alert.threshold} ${pct(item.alert.alertAtPercent)} · ${moneyLabel(
    item.alert.spendUsd,
  )} of ${moneyLabel(item.alert.budgetUsd)}`;
}

/** Split the recipients box on commas, semicolons, or newlines and dedupe. */
function parseRecipients(value: string): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const raw of value.split(/[\n,;]+/)) {
    const recipient = raw.trim();
    if (recipient === '') continue;
    const key = recipient.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(recipient);
  }
  return recipients;
}

function budgetTone(status: BudgetStatus): 'neutral' | 'green' | 'amber' | 'red' {
  if (status.state === 'exceeded') return 'red';
  if (status.state === 'warning') return 'amber';
  if (status.state === 'unknown') return 'neutral';
  return 'green';
}

interface PriceFormState {
  model: string;
  effectiveDate: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  reasoning: string;
  source: string;
  note: string;
}

function utcDate(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function emptyPriceForm(): PriceFormState {
  return {
    model: '',
    effectiveDate: utcDate(),
    input: '',
    output: '',
    cacheRead: '',
    cacheWrite: '',
    reasoning: '',
    source: '',
    note: '',
  };
}

function parseUtcDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseRate(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function mergePrice(list: ModelPrice[], created: ModelPrice): ModelPrice[] {
  return [...list, created].sort(
    (left, right) =>
      left.model.localeCompare(right.model) ||
      right.effectiveFrom - left.effectiveFrom ||
      right.createdAt - left.createdAt,
  );
}

/** Edits the global master defaults, process template, and per-cell switches. */
export function ConfigPage({ onError, onEditCell }: ConfigPageProps) {
  const [master, setMaster] = useState<MasterConfig | null>(null);
  const [summary, setSummary] = useState<SummaryConfig | null>(null);
  const [usage, setUsage] = useState<UsageSettings | null>(null);
  const [retention, setRetentionSettings] = useState<RetentionSettings | null>(null);
  const [process, setProcess] = useState<ProcessConfig | null>(null);
  const [path, setPath] = useState('');
  const [processPath, setProcessPath] = useState('');
  const [cells, setCells] = useState<CellDetail[]>([]);
  const [events, setEvents] = useState<MasterEvent[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [usageSaving, setUsageSaving] = useState(false);
  const [usageSaved, setUsageSaved] = useState(false);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionSaved, setRetentionSaved] = useState(false);
  const [cellSummariesSaving, setCellSummariesSaving] = useState(false);
  const [cellSummariesSaved, setCellSummariesSaved] = useState(false);
  const [requestArtifactsSaving, setRequestArtifactsSaving] = useState(false);
  const [requestArtifactsSaved, setRequestArtifactsSaved] = useState(false);
  const [processSaving, setProcessSaving] = useState(false);
  const [processSaved, setProcessSaved] = useState(false);
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [budgetMonthly, setBudgetMonthly] = useState('');
  const [budgetAlertPercent, setBudgetAlertPercent] = useState('80');
  const [budgetPauseOnExceeded, setBudgetPauseOnExceeded] = useState(false);
  const [budgetView, setBudgetView] = useState<BudgetsResponse | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetSaved, setBudgetSaved] = useState(false);
  const [webhook, setWebhook] = useState<NotificationsView['webhook'] | null>(null);
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookFormat, setWebhookFormat] = useState<WebhookFormat>('json');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookClearSecret, setWebhookClearSecret] = useState(false);
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookSaved, setWebhookSaved] = useState(false);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [webhookTest, setWebhookTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [email, setEmail] = useState<NotificationsView['email'] | null>(null);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailHost, setEmailHost] = useState('');
  const [emailPort, setEmailPort] = useState('587');
  const [emailSecure, setEmailSecure] = useState(false);
  const [emailUsername, setEmailUsername] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailClearPassword, setEmailClearPassword] = useState(false);
  const [emailFrom, setEmailFrom] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailTesting, setEmailTesting] = useState(false);
  const [emailTest, setEmailTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [slack, setSlack] = useState<ChatView>(emptyChatView);
  const [discord, setDiscord] = useState<ChatView>(emptyChatView);
  const [notificationStatus, setNotificationStatus] =
    useState<NotificationStatusResponse | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryHistoryResponse | null>(null);
  const [deliveryChannel, setDeliveryChannel] = useState<DeliveryChannel | ''>('');
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatus | ''>('');
  const [deliveryOffset, setDeliveryOffset] = useState(0);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [priceForm, setPriceForm] = useState<PriceFormState>(emptyPriceForm);
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceError, setPriceError] = useState('');
  const [pendingPriceDelete, setPendingPriceDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [
        config,
        processConfig,
        cellList,
        eventList,
        budgetResponse,
        statusResponse,
        deliveryResponse,
      ] = await Promise.all([
        api.getConfig(),
        api.getProcess(),
        api.getCells(),
        api.getMasterEvents({ limit: 20 }),
        api.getBudgets().catch(() => null),
        api.getNotificationStatus().catch(() => null),
        api.getNotificationDeliveries({ limit: 10, offset: 0 }).catch(() => null),
      ]);
      const loadedBudget = config.budget ?? { ...DEFAULT_BUDGET_SETTINGS };
      const loadedWebhook = config.notifications?.webhook ?? {
        enabled: false,
        url: null,
        format: 'json' as const,
        secret: null,
        secretSet: false,
      };
      const loadedEmail = config.notifications?.email ?? {
        ...DEFAULT_NOTIFICATIONS.email,
        password: null,
        passwordSet: false,
      };
      const loadedSlack = config.notifications?.slack ?? emptyChatView();
      const loadedDiscord = config.notifications?.discord ?? emptyChatView();
      setMaster(config.master);
      setSummary(config.summary);
      setUsage(config.usage);
      setRetentionSettings(config.retention);
      setPath(config.path);
      setProcess({ version: processConfig.version, segments: processConfig.segments });
      setProcessPath(processConfig.path);
      setCells(cellList);
      setEvents(eventList);
      setBudget(loadedBudget);
      setBudgetMonthly(
        loadedBudget.monthlyUsd === null ? '' : String(loadedBudget.monthlyUsd),
      );
      setBudgetAlertPercent(String(loadedBudget.alertAtPercent));
      setBudgetPauseOnExceeded(loadedBudget.pauseOnExceeded);
      setBudgetView(
        budgetResponse && Array.isArray(budgetResponse.statuses) ? budgetResponse : null,
      );
      setWebhook(loadedWebhook);
      setWebhookEnabled(loadedWebhook.enabled);
      setWebhookUrl(loadedWebhook.url ?? '');
      setWebhookFormat(loadedWebhook.format);
      setWebhookSecret('');
      setWebhookClearSecret(false);
      setEmail(loadedEmail);
      setEmailEnabled(loadedEmail.enabled);
      setEmailHost(loadedEmail.host ?? '');
      setEmailPort(String(loadedEmail.port));
      setEmailSecure(loadedEmail.secure);
      setEmailUsername(loadedEmail.username ?? '');
      setEmailPassword('');
      setEmailClearPassword(false);
      setEmailFrom(loadedEmail.from ?? '');
      setEmailTo(loadedEmail.to.join(', '));
      setSlack(loadedSlack);
      setDiscord(loadedDiscord);
      setNotificationStatus(statusResponse ?? null);
      setDeliveries(
        deliveryResponse && Array.isArray(deliveryResponse.deliveries)
          ? deliveryResponse
          : null,
      );
      setDeliveryOffset(deliveryResponse?.offset ?? 0);
    } catch (error) {
      onError(describeError(error));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let mounted = true;
    api
      .getPricing()
      .then((response) => {
        if (mounted) setPrices(Array.isArray(response.prices) ? response.prices : []);
      })
      .catch((error) => {
        if (mounted) onError(describeError(error));
      });
    return () => {
      mounted = false;
    };
  }, [onError]);

  async function refreshDeliveries(
    offset = deliveryOffset,
    channel = deliveryChannel,
    status = deliveryStatus,
  ): Promise<void> {
    setDeliveryLoading(true);
    try {
      const response = await api.getNotificationDeliveries({
        channel: channel === '' ? undefined : channel,
        status: status === '' ? undefined : status,
        limit: 10,
        offset,
      });
      setDeliveries(response);
      setDeliveryOffset(response.offset);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setDeliveryLoading(false);
    }
  }

  async function resendDelivery(item: DeliveryHistoryItem): Promise<void> {
    setResendingId(item.id);
    setResendMessage(null);
    try {
      await api.resendNotificationDelivery(item.id);
      setResendMessage('Resend queued; delivery will retry on the next flush.');
      await refreshDeliveries();
      const status = await api.getNotificationStatus().catch(() => null);
      setNotificationStatus(status);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setResendingId(null);
    }
  }

  const set = <K extends keyof MasterConfig>(key: K, value: MasterConfig[K]) => {
    setMaster((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  const setScorecard = <K extends keyof SummaryConfig>(
    key: K,
    value: SummaryConfig[K],
  ) => {
    setSummary((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  const setRetention = (days: number) => {
    setUsage((current) => (current ? { ...current, retentionDays: days } : current));
    setUsageSaved(false);
  };

  const setMasterEventsDays = (days: number) => {
    setRetentionSettings((current) =>
      current ? { ...current, masterEventsDays: days } : current,
    );
    setRetentionSaved(false);
  };

  const setRequestArtifactsDays = (days: number) => {
    setRetentionSettings((current) =>
      current ? { ...current, requestArtifactsDays: days } : current,
    );
    setRequestArtifactsSaved(false);
  };

  const setCellSummariesDays = (days: number) => {
    setRetentionSettings((current) =>
      current ? { ...current, cellSummariesDays: days } : current,
    );
    setCellSummariesSaved(false);
  };

  const setSegment = <K extends keyof SegmentConfig>(
    id: SegmentConfig['id'],
    key: K,
    value: SegmentConfig[K],
  ) => {
    setProcess((current) =>
      current
        ? {
            ...current,
            segments: current.segments.map((segment) =>
              segment.id === id ? { ...segment, [key]: value } : segment,
            ),
          }
        : current,
    );
    setProcessSaved(false);
  };

  const setFollowUp = (
    id: SegmentConfig['id'],
    key: 'enabled' | 'marker',
    value: boolean | string,
  ) => {
    setProcess((current) =>
      current
        ? {
            ...current,
            segments: current.segments.map((segment) =>
              segment.id === id
                ? { ...segment, followUps: { ...segment.followUps, [key]: value } }
                : segment,
            ),
          }
        : current,
    );
    setProcessSaved(false);
  };

  async function save() {
    if (!master || !summary) return;
    setSaving(true);
    try {
      const config = await api.patchConfig({ master, summary });
      setMaster(config.master);
      setSummary(config.summary);
      setPath(config.path);
      setSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveUsage() {
    if (!usage) return;
    setUsageSaving(true);
    try {
      const config = await api.patchConfig({ usage });
      setUsage(config.usage);
      setPath(config.path);
      setUsageSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setUsageSaving(false);
    }
  }

  async function saveRetention() {
    if (!retention) return;
    setRetentionSaving(true);
    try {
      const config = await api.patchConfig({
        retention: { masterEventsDays: retention.masterEventsDays },
      });
      setRetentionSettings(config.retention);
      setPath(config.path);
      setRetentionSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setRetentionSaving(false);
    }
  }

  async function saveCellSummaries() {
    if (!retention) return;
    setCellSummariesSaving(true);
    try {
      const config = await api.patchConfig({
        retention: { cellSummariesDays: retention.cellSummariesDays },
      });
      setRetentionSettings(config.retention);
      setPath(config.path);
      setCellSummariesSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setCellSummariesSaving(false);
    }
  }

  async function saveRequestArtifacts() {
    if (!retention) return;
    setRequestArtifactsSaving(true);
    try {
      const config = await api.patchConfig({
        retention: { requestArtifactsDays: retention.requestArtifactsDays },
      });
      setRetentionSettings(config.retention);
      setPath(config.path);
      setRequestArtifactsSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setRequestArtifactsSaving(false);
    }
  }

  async function saveBudget() {
    if (!budget) return;
    const monthlyText = budgetMonthly.trim();
    const monthlyUsd = monthlyText === '' ? null : Number(monthlyText);
    if (
      monthlyUsd !== null &&
      (!Number.isFinite(monthlyUsd) ||
        monthlyUsd <= 0 ||
        monthlyUsd > MAX_BUDGET_USD ||
        Math.abs(monthlyUsd * 100 - Math.round(monthlyUsd * 100)) > 1e-6)
    ) {
      onError(
        `The overall budget must be a positive dollar amount up to ${moneyLabel(MAX_BUDGET_USD)} with at most two decimals, or blank for no budget.`,
      );
      return;
    }
    const alertAtPercent = Number(budgetAlertPercent);
    if (!Number.isInteger(alertAtPercent) || alertAtPercent < 1 || alertAtPercent > 100) {
      onError('The alert threshold must be a whole number from 1 to 100.');
      return;
    }

    setBudgetSaving(true);
    try {
      const config = await api.patchConfig({
        budget: { monthlyUsd, alertAtPercent, pauseOnExceeded: budgetPauseOnExceeded },
      });
      const savedBudget = config.budget ?? {
        monthlyUsd,
        alertAtPercent,
        pauseOnExceeded: budgetPauseOnExceeded,
      };
      setBudget(savedBudget);
      setBudgetMonthly(
        savedBudget.monthlyUsd === null ? '' : String(savedBudget.monthlyUsd),
      );
      setBudgetAlertPercent(String(savedBudget.alertAtPercent));
      setBudgetPauseOnExceeded(savedBudget.pauseOnExceeded);
      const nextView = await api.getBudgets().catch(() => null);
      setBudgetView(nextView && Array.isArray(nextView.statuses) ? nextView : null);
      setBudgetSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBudgetSaving(false);
    }
  }

  async function saveWebhook() {
    const url = webhookUrl.trim();
    if (webhookEnabled && url === '') {
      onError('A webhook URL is required when alert delivery is enabled.');
      return;
    }
    if (url !== '') {
      const problem = webhookUrlError(url);
      if (problem !== null) {
        onError(`The webhook URL ${problem}.`);
        return;
      }
    }
    if (webhookSecret !== '' && (webhookSecret.length < 16 || webhookSecret.length > 256)) {
      onError('The signing secret must be 16 to 256 characters.');
      return;
    }

    const patch: WebhookPatch = {
      enabled: webhookEnabled,
      url: url === '' ? null : url,
      format: webhookFormat,
    };
    if (webhookClearSecret) patch.secret = null;
    else if (webhookSecret !== '') patch.secret = webhookSecret;

    setWebhookSaving(true);
    try {
      const config = await api.patchConfig({ notifications: { webhook: patch } });
      const saved =
        config.notifications?.webhook ?? {
          enabled: false,
          url: null,
          format: 'json' as const,
          secret: null,
          secretSet: false,
        };
      setWebhook(saved);
      setWebhookEnabled(saved.enabled);
      setWebhookUrl(saved.url ?? '');
      setWebhookFormat(saved.format);
      setWebhookSecret('');
      setWebhookClearSecret(false);
      const status = await api.getNotificationStatus().catch(() => null);
      setNotificationStatus(status);
      void refreshDeliveries();
      setWebhookSaved(true);
      setWebhookTest(null);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setWebhookSaving(false);
    }
  }

  async function testWebhook() {
    setWebhookTesting(true);
    setWebhookTest(null);
    try {
      const result = await api.testWebhook();
      setWebhookTest({
        ok: result.ok,
        message: result.ok
          ? `Test delivered (HTTP ${result.status ?? 200}) in ${result.durationMs} ms.`
          : result.error ?? 'The webhook test failed.',
      });
      const status = await api.getNotificationStatus().catch(() => null);
      setNotificationStatus(status);
      void refreshDeliveries();
    } finally {
      setWebhookTesting(false);
    }
  }

  async function saveEmail() {
    const host = emailHost.trim();
    const from = emailFrom.trim();
    const username = emailUsername.trim();
    const recipients = parseRecipients(emailTo);
    const port = Number(emailPort);

    if (host !== '') {
      const problem = smtpHostError(host);
      if (problem !== null) {
        onError(`The SMTP host ${problem}.`);
        return;
      }
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      onError('The SMTP port must be a whole number from 1 to 65535.');
      return;
    }
    if (emailEnabled && (host === '' || from === '' || recipients.length === 0)) {
      onError('Host, From address, and at least one recipient are required.');
      return;
    }
    if (from !== '') {
      const problem = emailAddressError(from);
      if (problem !== null) {
        onError(`The From address ${problem}.`);
        return;
      }
    }
    if (recipients.length > 0) {
      const problem = emailRecipientsError(recipients);
      if (problem !== null) {
        onError(`The recipients ${problem}.`);
        return;
      }
    }
    const keepsSavedPassword = email?.passwordSet === true && !emailClearPassword;
    const hasPassword = emailPassword !== '' || keepsSavedPassword;
    if ((username !== '') !== hasPassword) {
      onError('Set both a username and a password, or clear both.');
      return;
    }

    const patch: EmailPatch = {
      enabled: emailEnabled,
      host: host === '' ? null : host,
      port,
      secure: emailSecure,
      username: username === '' ? null : username,
      from: from === '' ? null : from,
      to: recipients,
    };
    if (emailClearPassword) patch.password = null;
    else if (emailPassword !== '') patch.password = emailPassword;

    setEmailSaving(true);
    try {
      const config = await api.patchConfig({ notifications: { email: patch } });
      const saved = config.notifications?.email ?? {
        ...DEFAULT_NOTIFICATIONS.email,
        password: null,
        passwordSet: false,
      };
      setEmail(saved);
      setEmailEnabled(saved.enabled);
      setEmailHost(saved.host ?? '');
      setEmailPort(String(saved.port));
      setEmailSecure(saved.secure);
      setEmailUsername(saved.username ?? '');
      setEmailPassword('');
      setEmailClearPassword(false);
      setEmailFrom(saved.from ?? '');
      setEmailTo(saved.to.join(', '));
      const status = await api.getNotificationStatus().catch(() => null);
      setNotificationStatus(status);
      void refreshDeliveries();
      setEmailSaved(true);
      setEmailTest(null);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setEmailSaving(false);
    }
  }

  async function testEmail() {
    setEmailTesting(true);
    setEmailTest(null);
    try {
      const result = await api.testEmail();
      setEmailTest({
        ok: result.ok,
        message: result.ok
          ? `Test email sent in ${result.durationMs} ms.`
          : result.error ?? 'The email test failed.',
      });
      const status = await api.getNotificationStatus().catch(() => null);
      setNotificationStatus(status);
      void refreshDeliveries();
    } finally {
      setEmailTesting(false);
    }
  }

  async function saveProcess() {
    if (!process) return;
    setProcessSaving(true);
    try {
      const savedProcess = await api.patchProcess(process.segments);
      setProcess({ version: savedProcess.version, segments: savedProcess.segments });
      setProcessPath(savedProcess.path);
      setProcessSaved(true);
    } catch (error) {
      onError(describeError(error));
    } finally {
      setProcessSaving(false);
    }
  }

  async function toggleCell(cell: CellDetail) {
    try {
      const updated = await api.patchCell(cell.id, { masterEnabled: !cell.masterEnabled });
      setCells((current) => current.map((item) => (item.id === cell.id ? updated : item)));
    } catch (error) {
      onError(describeError(error));
    }
  }

  function setPrice<K extends keyof PriceFormState>(key: K, value: PriceFormState[K]) {
    setPriceForm((current) => ({ ...current, [key]: value }));
    setPriceError('');
  }

  async function addPrice() {
    setPriceError('');
    const effectiveFrom = parseUtcDate(priceForm.effectiveDate);
    const rates = [
      parseRate(priceForm.input),
      parseRate(priceForm.output),
      parseRate(priceForm.cacheRead),
      parseRate(priceForm.cacheWrite),
      parseRate(priceForm.reasoning),
    ];
    if (priceForm.model.trim() === '' || priceForm.source.trim() === '' || effectiveFrom === null) {
      setPriceError('Model, effective date, and source are required.');
      return;
    }
    if (rates.some((value) => value === null)) {
      setPriceError('Enter a non-negative USD rate for every token category.');
      return;
    }

    const [input, output, cacheRead, cacheWrite, reasoning] = rates as [
      number,
      number,
      number,
      number,
      number,
    ];
    const inputPrice: ModelPriceInput = {
      model: priceForm.model.trim(),
      effectiveFrom,
      inputUsdPerMtok: input,
      outputUsdPerMtok: output,
      cacheReadUsdPerMtok: cacheRead,
      cacheWriteUsdPerMtok: cacheWrite,
      reasoningUsdPerMtok: reasoning,
      source: priceForm.source.trim(),
      note: priceForm.note.trim() === '' ? null : priceForm.note.trim(),
    };

    setPriceSaving(true);
    try {
      const created = await api.createPrice(inputPrice);
      setPrices((current) => mergePrice(current, created));
      setPriceForm(emptyPriceForm());
    } catch (error) {
      setPriceError(describeError(error));
    } finally {
      setPriceSaving(false);
    }
  }

  async function removePrice(price: ModelPrice) {
    if (pendingPriceDelete !== price.id) {
      setPendingPriceDelete(price.id);
      return;
    }
    setPendingPriceDelete(null);
    try {
      await api.deletePrice(price.id);
      setPrices((current) => current.filter((item) => item.id !== price.id));
    } catch (error) {
      onError(describeError(error));
    }
  }

  if (!master || !summary || !usage || !retention || !process) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
        <Spinner /> Loading settings...
      </div>
    );
  }

  return (
    <div className="mx-auto h-full w-full max-w-3xl space-y-4 overflow-y-auto p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Cell master</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Each cell runs its own master on a cadence, starts or prods due work, records
          follow-up requests, and advances on exact markers. Requests without a cell stay
          manual until you assign one.
        </p>
      </div>

      <Card className="space-y-5 p-4">
        <SectionTitle>Schedule</SectionTitle>

        <Checkbox
          label="Master enabled"
          checked={master.enabled}
          onChange={(event) => set('enabled', event.target.checked)}
        />

        <Field label="Interval (minutes)" hint="how often each cell is reviewed">
          <Input
            type="number"
            min={1}
            max={1440}
            value={master.intervalMinutes}
            onChange={(event) => set('intervalMinutes', Number(event.target.value))}
          />
        </Field>

        <p className="text-[11px] text-zinc-600">
          Idle thresholds, prompts, markers, and advancement are per segment below.
        </p>

        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="break-all font-mono text-[11px] text-zinc-600">{path}</p>
          <div className="flex items-center justify-end gap-2">
            {saved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner /> : 'Save schedule'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-5 p-4">
        <div>
          <SectionTitle>Scorecards</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Each cell gets a periodic report of the work in its trailing window. Run one
            now from the Cell master drawer.
          </p>
        </div>

        <Checkbox
          label="Automatic scorecards enabled"
          checked={summary.enabled}
          onChange={(event) => setScorecard('enabled', event.target.checked)}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Every (minutes)" hint="how often to write a report">
            <Input
              type="number"
              min={1}
              max={10080}
              value={summary.intervalMinutes}
              onChange={(event) => setScorecard('intervalMinutes', Number(event.target.value))}
            />
          </Field>
          <Field label="Window (minutes)" hint="how far back each report looks">
            <Input
              type="number"
              min={1}
              max={10080}
              value={summary.windowMinutes}
              onChange={(event) => setScorecard('windowMinutes', Number(event.target.value))}
            />
          </Field>
        </div>

        <Field label="Report instructions" hint="the facts are added automatically">
          <Textarea
            rows={5}
            value={summary.prompt}
            onChange={(event) => setScorecard('prompt', event.target.value)}
          />
        </Field>

        <p className="text-[11px] text-zinc-600">
          6 hours = 360 minutes. Saved with the schedule above. A failed report is retried
          with backoff.
        </p>
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Usage retention</SectionTitle>
        <p className="text-sm text-zinc-400">
          Raw turns older than this window are summarized into daily totals, then pruned in
          the background. Cost is reported by the harness, never estimated here.
        </p>
        <Field label="Retention (days)" hint="0 keeps raw turns forever">
          <Input
            type="number"
            aria-label="Usage retention (days)"
            min={0}
            max={MAX_USAGE_RETENTION_DAYS}
            step={1}
            value={usage.retentionDays}
            onChange={(event) => setRetention(Number(event.target.value))}
          />
        </Field>
        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-zinc-600">
            Runs shortly after startup, then hourly. Older history is preserved as daily
            totals. Raising the window cannot restore already-pruned raw turns.
          </p>
          <div className="flex items-center justify-end gap-2">
            {usageSaved ? (
              <span className="text-[11px] text-emerald-400">Saved</span>
            ) : null}
            <Button
              variant="primary"
              disabled={usageSaving}
              onClick={() => void saveUsage()}
            >
              {usageSaving ? <Spinner /> : 'Save usage retention'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Master activity retention</SectionTitle>
        <p className="text-sm text-zinc-400">
          Master cycles write activity rows for every prod, review, advance, skip, and
          follow-up. Old rows are pruned in the background; activity is not rolled up.
        </p>
        <Field label="Activity retention (days)" hint="0 keeps all master activity forever">
          <Input
            type="number"
            aria-label="Activity retention (days)"
            min={0}
            max={MAX_MASTER_EVENTS_RETENTION_DAYS}
            step={1}
            value={retention.masterEventsDays}
            onChange={(event) => setMasterEventsDays(Number(event.target.value))}
          />
        </Field>
        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-zinc-600">
            Runs shortly after startup, then hourly. Follow-up markers are kept so
            follow-up requests stay deduplicated.
          </p>
          <div className="flex items-center justify-end gap-2">
            {retentionSaved ? (
              <span className="text-[11px] text-emerald-400">Saved</span>
            ) : null}
            <Button
              variant="primary"
              disabled={retentionSaving}
              onClick={() => void saveRetention()}
            >
              {retentionSaving ? <Spinner /> : 'Save activity retention'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Scorecard retention</SectionTitle>
        <p className="text-sm text-zinc-400">
          Each generated scorecard is a report row. Old reports are pruned in the
          background; the newest report per cell is always kept so its drawer and the next
          scheduled run stay intact.
        </p>
        <Field
          label="Scorecard retention (days)"
          hint="0 keeps all scorecard history forever"
        >
          <Input
            type="number"
            aria-label="Scorecard retention (days)"
            min={0}
            max={MAX_CELL_SUMMARIES_RETENTION_DAYS}
            step={1}
            value={retention.cellSummariesDays}
            onChange={(event) => setCellSummariesDays(Number(event.target.value))}
          />
        </Field>
        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-zinc-600">
            Runs shortly after startup, then hourly. Scorecard history is not rolled up.
          </p>
          <div className="flex items-center justify-end gap-2">
            {cellSummariesSaved ? (
              <span className="text-[11px] text-emerald-400">Saved</span>
            ) : null}
            <Button
              variant="primary"
              disabled={cellSummariesSaving}
              onClick={() => void saveCellSummaries()}
            >
              {cellSummariesSaving ? <Spinner /> : 'Save scorecard retention'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Request artifacts retention</SectionTitle>
        <p className="text-sm text-zinc-400">
          Finished requests keep their transcript, session id, scratch workdir, and any
          leftover checkout only until this window expires. Only done or dropped requests
          are affected; live and in-flight work is never touched.
        </p>
        <Field
          label="Artifacts retention (days)"
          hint="0 keeps request folders and worktrees forever"
        >
          <Input
            type="number"
            aria-label="Request artifacts retention (days)"
            min={0}
            max={MAX_REQUEST_ARTIFACTS_RETENTION_DAYS}
            step={1}
            value={retention.requestArtifactsDays}
            onChange={(event) => setRequestArtifactsDays(Number(event.target.value))}
          />
        </Field>
        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-zinc-600">
            Runs shortly after startup, then hourly. Git branches are kept, and master,
            summary, setup, and KB chats are not pruned here.
          </p>
          <div className="flex items-center justify-end gap-2">
            {requestArtifactsSaved ? (
              <span className="text-[11px] text-emerald-400">Saved</span>
            ) : null}
            <Button
              variant="primary"
              disabled={requestArtifactsSaving}
              onClick={() => void saveRequestArtifacts()}
            >
              {requestArtifactsSaving ? <Spinner /> : 'Save artifact retention'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <SectionTitle>Spend budgets</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Monthly budgets for the whole brain and each cell. Alerts are warnings; enable
            pause-on-exceeded to stop new work for that scope at its cap and stop its
            in-flight turns.
          </p>
        </div>

        {budgetView && budgetView.statuses.length > 0 ? (
          <div className="space-y-2">
            {budgetView.statuses.map((status) => (
              <div
                key={`${status.scope}:${status.cellId ?? ''}`}
                className="space-y-1.5 rounded-lg border border-zinc-800 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-zinc-300">{status.label}</span>
                  <div className="flex items-center gap-2">
                    {status.paused ? <Badge tone="red">paused</Badge> : null}
                    <Badge tone={budgetTone(status)}>{status.state}</Badge>
                  </div>
                </div>
                {status.state === 'unknown' ? (
                  <p className="text-[11px] text-zinc-500">
                    Spend unknown
                    {status.unknownCostTurns > 0
                      ? ` · ${status.unknownCostTurns} unpriced turn${status.unknownCostTurns === 1 ? '' : 's'}`
                      : ''}
                  </p>
                ) : (
                  <>
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className={
                          status.state === 'exceeded'
                            ? 'h-full rounded-full bg-red-500'
                            : status.state === 'warning'
                              ? 'h-full rounded-full bg-amber-400'
                              : 'h-full rounded-full bg-emerald-500'
                        }
                        style={{
                          width: `${Math.min(100, Math.max(0, status.percentUsed))}%`,
                        }}
                      />
                    </div>
                    <p className="text-[11px] text-zinc-500">
                      {status.spendIsLowerBound ? 'At least ' : ''}
                      {moneyLabel(status.spendUsd)} of {moneyLabel(status.budgetUsd)} (
                      {pct(status.percentUsed)})
                      {status.unknownCostTurns > 0
                        ? ` · ${status.unknownCostTurns} unpriced turn${status.unknownCostTurns === 1 ? '' : 's'}`
                        : ''}
                    </p>
                    {status.paused ? (
                      <p className="text-[11px] text-red-300">
                        New work is paused and in-flight turns were stopped at{' '}
                        {moneyLabel(status.capSpendUsd)} of {moneyLabel(status.budgetUsd)} cap
                        spend{status.capSpendIsLowerBound ? ' (lower bound)' : ''}.
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">
            No budgets configured. Set an overall budget below or edit a cell.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Overall monthly budget (USD)" hint="blank means no overall budget">
            <Input
              type="number"
              min={0.01}
              step="0.01"
              value={budgetMonthly}
              onChange={(event) => {
                setBudgetMonthly(event.target.value);
                setBudgetSaved(false);
              }}
              placeholder="No overall budget"
            />
          </Field>
          <Field
            label="Alert threshold (%)"
            hint="warning percentage; 100 alerts only at the budget"
          >
            <Input
              type="number"
              min={1}
              max={100}
              step={1}
              value={budgetAlertPercent}
              onChange={(event) => {
                setBudgetAlertPercent(event.target.value);
                setBudgetSaved(false);
              }}
            />
          </Field>
        </div>

        <Checkbox
          label="Pause new work when the overall budget is exceeded"
          checked={budgetPauseOnExceeded}
          onChange={() => {
            setBudgetPauseOnExceeded((current) => !current);
            setBudgetSaved(false);
          }}
        />

        <p className="text-[11px] text-zinc-600">
          Budgets use the UTC calendar month. Alerts use harness-reported cost; hard caps also
          count estimated cost, and unpriced turns are shown as a lower bound. Cell budgets and
          their pause option are set when editing a cell.
        </p>

        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-zinc-600">
            {budget?.monthlyUsd === null
              ? 'No overall budget saved.'
              : `Overall budget ${moneyLabel(budget?.monthlyUsd ?? 0)} per month${
                  budget?.pauseOnExceeded ? ' with pause on exceeded.' : '.'
                }`}
          </p>
          <div className="flex items-center justify-end gap-2">
            {budgetSaved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
            <Button variant="primary" disabled={budgetSaving} onClick={() => void saveBudget()}>
              {budgetSaving ? <Spinner /> : 'Save budgets'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <SectionTitle>Alert delivery</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Send budget warning and exceeded alerts to an HTTPS webhook. Delivery is
            advisory; a failed webhook never pauses work or hides the in-app banner.
          </p>
        </div>

        <Checkbox
          label="Deliver budget alerts to a webhook"
          checked={webhookEnabled}
          onChange={(event) => {
            setWebhookEnabled(event.target.checked);
            setWebhookSaved(false);
          }}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Webhook URL" hint="https required; localhost may use http">
            <Input
              type="url"
              value={webhookUrl}
              placeholder="https://example.com/hooks/budget"
              onChange={(event) => {
                setWebhookUrl(event.target.value);
                setWebhookSaved(false);
              }}
            />
          </Field>
          <Field label="Payload format" hint="Slack/Discord ignore signatures">
            <Select
              value={webhookFormat}
              onChange={(event) => {
                setWebhookFormat(event.target.value as WebhookFormat);
                setWebhookSaved(false);
              }}
            >
              {WEBHOOK_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format === 'json' ? 'JSON' : format === 'slack' ? 'Slack' : 'Discord'}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Signing secret" hint="16-256 chars; blank keeps the saved secret">
          <Input
            type="password"
            autoComplete="off"
            value={webhookSecret}
            placeholder={webhook?.secretSet ? 'Saved secret (leave blank to keep)' : 'Optional'}
            onChange={(event) => {
              setWebhookSecret(event.target.value);
              setWebhookSaved(false);
            }}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-zinc-500">
            {webhook?.secretSet ? 'A signing secret is saved.' : 'No signing secret saved.'}
          </span>
          {webhook?.secretSet && !webhookClearSecret ? (
            <Button
              size="sm"
              onClick={() => {
                setWebhookClearSecret(true);
                setWebhookSaved(false);
              }}
            >
              Clear secret
            </Button>
          ) : null}
          {webhookClearSecret ? (
            <>
              <span className="text-amber-400">The secret will be cleared on save.</span>
              <Button size="sm" onClick={() => setWebhookClearSecret(false)}>
                Keep secret
              </Button>
            </>
          ) : null}
        </div>

        <p className="text-[11px] text-zinc-600">
          JSON payloads carry an HMAC-SHA256 signature in{' '}
          <code className="text-zinc-500">X-APS-Signature</code>. Slack and Discord incoming
          webhooks accept the text-only format and ignore that header.
        </p>

        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            {notificationStatus?.webhook ? (
              <p className="text-[11px] text-zinc-600">
                {notificationStatus.webhook.configured
                  ? 'Webhook configured'
                  : 'No webhook configured'}{' '}
                · {notificationStatus.webhook.pending} pending ·{' '}
                {notificationStatus.webhook.failed} failed
                {notificationStatus.webhook.lastDeliveryAt !== null
                  ? ` · last ${notificationStatus.webhook.lastDeliveryStatus ?? 'unknown'} ${timeAgo(notificationStatus.webhook.lastDeliveryAt)} ago`
                  : ' · no deliveries yet'}
                {notificationStatus.webhook.lastError
                  ? ` · ${notificationStatus.webhook.lastError}`
                  : ''}
              </p>
            ) : null}
            {webhookTest ? (
              <p
                role="status"
                className={webhookTest.ok ? 'text-[11px] text-emerald-400' : 'text-[11px] text-red-400'}
              >
                {webhookTest.message}
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2">
            {webhookSaved ? (
              <span className="text-[11px] text-emerald-400">Saved</span>
            ) : null}
            <Button disabled={webhookTesting} onClick={() => void testWebhook()}>
              {webhookTesting ? <Spinner /> : 'Send test'}
            </Button>
            <Button
              variant="primary"
              disabled={webhookSaving}
              onClick={() => void saveWebhook()}
            >
              {webhookSaving ? <Spinner /> : 'Save delivery'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <SectionTitle>Email delivery</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Send budget warning and exceeded alerts over SMTP. Email is advisory and
            independent of the webhook; a failed send never pauses work or hides the
            in-app banner.
          </p>
        </div>

        <Checkbox
          label="Deliver budget alerts by email"
          checked={emailEnabled}
          onChange={(event) => {
            setEmailEnabled(event.target.checked);
            setEmailSaved(false);
          }}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="SMTP host" hint="hostname or IP address">
            <Input
              value={emailHost}
              placeholder="smtp.example.com"
              onChange={(event) => {
                setEmailHost(event.target.value);
                setEmailSaved(false);
              }}
            />
          </Field>
          <Field label="SMTP port" hint="587 STARTTLS, 465 implicit TLS">
            <Input
              type="number"
              min={1}
              max={65535}
              value={emailPort}
              onChange={(event) => {
                setEmailPort(event.target.value);
                setEmailSaved(false);
              }}
            />
          </Field>
        </div>

        <Checkbox
          label="Implicit TLS (usually port 465)"
          checked={emailSecure}
          onChange={(event) => {
            setEmailSecure(event.target.checked);
            setEmailSaved(false);
          }}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" hint="optional; clear both to use an open relay">
            <Input
              autoComplete="off"
              value={emailUsername}
              placeholder="smtp-user"
              onChange={(event) => {
                setEmailUsername(event.target.value);
                setEmailSaved(false);
              }}
            />
          </Field>
          <Field label="Password" hint="blank keeps the saved password">
            <Input
              type="password"
              autoComplete="new-password"
              value={emailPassword}
              placeholder={email?.passwordSet ? 'Saved password (leave blank to keep)' : 'Optional'}
              onChange={(event) => {
                setEmailPassword(event.target.value);
                setEmailClearPassword(false);
                setEmailSaved(false);
              }}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-zinc-500">
            {email?.passwordSet ? 'A password is saved.' : 'No password saved.'}
          </span>
          {email?.passwordSet && !emailClearPassword ? (
            <Button
              size="sm"
              onClick={() => {
                setEmailClearPassword(true);
                setEmailPassword('');
                setEmailSaved(false);
              }}
            >
              Clear password
            </Button>
          ) : null}
          {emailClearPassword ? (
            <>
              <span className="text-amber-400">The password will be cleared on save.</span>
              <Button size="sm" onClick={() => setEmailClearPassword(false)}>
                Keep password
              </Button>
            </>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From address" hint="addr@domain or Name <addr@domain>">
            <Input
              type="email"
              value={emailFrom}
              placeholder="APS Alerts <alerts@example.com>"
              onChange={(event) => {
                setEmailFrom(event.target.value);
                setEmailSaved(false);
              }}
            />
          </Field>
          <Field label="Recipients" hint="comma or newline separated; up to 10">
            <Textarea
              rows={2}
              value={emailTo}
              placeholder="ops@example.com"
              onChange={(event) => {
                setEmailTo(event.target.value);
                setEmailSaved(false);
              }}
            />
          </Field>
        </div>

        <p className="text-[11px] text-zinc-600">
          STARTTLS is required for remote hosts when implicit TLS is off. Credentials are
          stored in the settings file and never returned by the API.
        </p>

        <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            {notificationStatus?.email ? (
              <p className="text-[11px] text-zinc-600">
                {notificationStatus.email.configured
                  ? 'Email configured'
                  : 'No email configured'}{' '}
                · {notificationStatus.email.pending} pending ·{' '}
                {notificationStatus.email.failed} failed
                {notificationStatus.email.lastDeliveryAt !== null
                  ? ` · last ${notificationStatus.email.lastDeliveryStatus ?? 'unknown'} ${timeAgo(notificationStatus.email.lastDeliveryAt)} ago`
                  : ' · no deliveries yet'}
                {notificationStatus.email.lastError
                  ? ` · ${notificationStatus.email.lastError}`
                  : ''}
              </p>
            ) : null}
            {emailTest ? (
              <p
                role="status"
                className={emailTest.ok ? 'text-[11px] text-emerald-400' : 'text-[11px] text-red-400'}
              >
                {emailTest.message}
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2">
            {emailSaved ? (
              <span className="text-[11px] text-emerald-400">Saved</span>
            ) : null}
            <Button disabled={emailTesting} onClick={() => void testEmail()}>
              {emailTesting ? <Spinner /> : 'Send test email'}
            </Button>
            <Button
              variant="primary"
              disabled={emailSaving}
              onClick={() => void saveEmail()}
            >
              {emailSaving ? <Spinner /> : 'Save email delivery'}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <SectionTitle>Delivery history</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Recent webhook, email, and chat delivery attempts for budget alerts. Delivery
            is advisory; history is read-only and bounded.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Channel" hint="webhook, email, Slack, or Discord">
            <Select
              value={deliveryChannel}
              onChange={(event) => {
                const value = event.target.value as DeliveryChannel | '';
                setDeliveryChannel(value);
                void refreshDeliveries(0, value, deliveryStatus);
              }}
            >
              <option value="">All channels</option>
              <option value="webhook">Webhook</option>
              <option value="email">Email</option>
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
            </Select>
          </Field>
          <Field label="Status" hint="delivery outcome">
            <Select
              value={deliveryStatus}
              onChange={(event) => {
                const value = event.target.value as DeliveryStatus | '';
                setDeliveryStatus(value);
                void refreshDeliveries(0, deliveryChannel, value);
              }}
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="delivering">Delivering</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
            </Select>
          </Field>
        </div>

        {!deliveries || deliveries.deliveries.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {deliveryChannel !== '' || deliveryStatus !== ''
              ? 'No deliveries match these filters.'
              : 'No deliveries yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-zinc-600">
                <tr>
                  <th className="pb-2 font-medium">Created</th>
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 font-medium">Alert</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 text-right font-medium">Attempts</th>
                  <th className="pb-2 font-medium">Last error</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {deliveries.deliveries.map((item) => (
                  <tr key={item.id}>
                    <td
                      className="whitespace-nowrap py-2 pr-3 text-zinc-500"
                      title={new Date(item.createdAt).toISOString()}
                    >
                      {timeAgo(item.createdAt)} ago
                    </td>
                    <td className="py-2 pr-3 text-zinc-400">{item.channel}</td>
                    <td className="py-2 pr-3 text-zinc-300">{deliveryAlertLabel(item)}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={DELIVERY_TONES[item.status]}>{item.status}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-right text-zinc-400">{item.attempts}</td>
                    <td
                      className="max-w-[14rem] truncate py-2 pr-3 text-zinc-500"
                      title={item.lastError ?? ''}
                    >
                      {item.lastError ?? '—'}
                    </td>
                    <td className="py-2 text-right">
                      {item.canResend ? (
                        <Button
                          size="sm"
                          disabled={resendingId !== null}
                          aria-label={`Resend ${item.channel} delivery for ${deliveryAlertLabel(item)}`}
                          onClick={() => void resendDelivery(item)}
                        >
                          {resendingId === item.id ? <Spinner /> : 'Resend'}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3 text-[11px] text-zinc-500">
          <span>
            {deliveries && deliveries.total > 0
              ? `Showing ${deliveries.offset + 1}–${Math.min(
                  deliveries.offset + deliveries.deliveries.length,
                  deliveries.total,
                )} of ${deliveries.total}`
              : 'No deliveries'}
          </span>
          <div className="flex items-center gap-2">
            {resendMessage ? (
              <span role="status" className="text-emerald-400">
                {resendMessage}
              </span>
            ) : null}
            <Button
              size="sm"
              disabled={deliveryLoading || deliveryOffset === 0}
              onClick={() => void refreshDeliveries(Math.max(0, deliveryOffset - 10))}
            >
              Newer
            </Button>
            <Button
              size="sm"
              disabled={
                deliveryLoading ||
                !deliveries ||
                deliveryOffset + deliveries.deliveries.length >= deliveries.total
              }
              onClick={() => void refreshDeliveries(deliveryOffset + 10)}
            >
              Older
            </Button>
            <Button size="sm" disabled={deliveryLoading} onClick={() => void refreshDeliveries()}>
              Refresh
            </Button>
          </div>
        </div>

        <p className="text-[11px] text-zinc-600">
          History keeps 400 days of delivery rows. Clearing a budget, changing its threshold,
          or deleting a cell removes its unacknowledged alerts and their delivery rows.
        </p>
      </Card>

      <ChatDeliveryCard
        provider="slack"
        settings={slack}
        cells={cells}
        status={notificationStatus?.slack ?? null}
        onError={onError}
        onSaved={setSlack}
        onStatus={setNotificationStatus}
      />

      <ChatDeliveryCard
        provider="discord"
        settings={discord}
        cells={cells}
        status={notificationStatus?.discord ?? null}
        onError={onError}
        onSaved={setDiscord}
        onStatus={setNotificationStatus}
      />

      <ProcessEditor
        process={process}
        path={processPath}
        saving={processSaving}
        saved={processSaved}
        title="Global process template"
        description="Inherited by cells without their own policy; new cells start with a copy that can diverge."
        onChange={setSegment}
        onFollowUp={setFollowUp}
        onSave={() => void saveProcess()}
      />

      <Card className="space-y-4 p-4">
        <div>
          <SectionTitle>Model pricing</SectionTitle>
          <p className="mt-1 text-sm text-zinc-500">
            Used only when the harness does not report cost. Reported cost is never
            overwritten. A model with no effective price stays unknown.
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">
            USD per 1,000,000 tokens. Enter 0 only when that category is genuinely free.
            A change is a new row with a new effective date.
          </p>
        </div>

        {prices.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No prices configured. Unreported turns remain unknown until you add one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-zinc-600">
                <tr>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">Effective</th>
                  <th className="pb-2 text-right font-medium">Input</th>
                  <th className="pb-2 text-right font-medium">Output</th>
                  <th className="pb-2 text-right font-medium">Cache R</th>
                  <th className="pb-2 text-right font-medium">Cache W</th>
                  <th className="pb-2 text-right font-medium">Reasoning</th>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {prices.map((price) => (
                  <tr key={price.id}>
                    <td className="max-w-[14rem] truncate py-2 pr-3 text-zinc-300" title={price.model}>
                      {price.model}
                      {price.note ? (
                        <span className="block truncate text-[10px] text-zinc-600" title={price.note}>
                          {price.note}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-zinc-500">{utcDate(price.effectiveFrom)}</td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.inputUsdPerMtok}
                    </td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.outputUsdPerMtok}
                    </td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.cacheReadUsdPerMtok}
                    </td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.cacheWriteUsdPerMtok}
                    </td>
                    <td className="py-2 text-right text-zinc-400">
                      ${price.reasoningUsdPerMtok}
                    </td>
                    <td className="max-w-[14rem] truncate py-2 pr-3 text-zinc-500">
                      {price.source.startsWith('http') ? (
                        <a
                          className="text-sky-400 hover:text-sky-300"
                          href={price.source}
                          target="_blank"
                          rel="noreferrer"
                          title={price.source}
                        >
                          {price.source}
                        </a>
                      ) : (
                        <span title={price.source}>{price.source}</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant={pendingPriceDelete === price.id ? 'danger' : 'ghost'}
                        size="sm"
                        aria-label={`Delete price for ${price.model}`}
                        onClick={() => void removePrice(price)}
                      >
                        {pendingPriceDelete === price.id ? 'Confirm?' : 'Delete'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model id" hint="exact match">
            <Input
              value={priceForm.model}
              placeholder="provider/model"
              onChange={(event) => setPrice('model', event.target.value)}
            />
          </Field>
          <Field label="Effective date" hint="UTC">
            <Input
              type="date"
              value={priceForm.effectiveDate}
              onChange={(event) => setPrice('effectiveDate', event.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Input $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.input}
              onChange={(event) => setPrice('input', event.target.value)}
            />
          </Field>
          <Field label="Output $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.output}
              onChange={(event) => setPrice('output', event.target.value)}
            />
          </Field>
          <Field label="Cache read $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.cacheRead}
              onChange={(event) => setPrice('cacheRead', event.target.value)}
            />
          </Field>
          <Field label="Cache write $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.cacheWrite}
              onChange={(event) => setPrice('cacheWrite', event.target.value)}
            />
          </Field>
          <Field label="Reasoning $/1M">
            <Input
              type="number"
              min={0}
              step="any"
              value={priceForm.reasoning}
              onChange={(event) => setPrice('reasoning', event.target.value)}
            />
          </Field>
          <Field label="Source" hint="URL or citation">
            <Input
              value={priceForm.source}
              placeholder="https://…"
              onChange={(event) => setPrice('source', event.target.value)}
            />
          </Field>
        </div>

        <Field label="Note" hint="optional">
          <Input
            value={priceForm.note}
            placeholder="Plan, region, or contract note"
            onChange={(event) => setPrice('note', event.target.value)}
          />
        </Field>

        {priceError ? <p className="text-xs text-red-400">{priceError}</p> : null}

        <div className="flex items-center justify-end gap-2">
          <Button variant="primary" disabled={priceSaving} onClick={() => void addPrice()}>
            {priceSaving ? <Spinner /> : 'Add price'}
          </Button>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Cells</SectionTitle>
        {cells.length === 0 ? (
          <p className="text-sm text-zinc-500">No cells yet. Create one in the left menu.</p>
        ) : (
          <div className="space-y-2">
            {cells.map((cell) => (
              <div
                key={cell.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 py-2"
              >
                <span className="truncate text-sm text-zinc-300">{cell.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-600">
                    {cell.masterIntervalMinutes ? `${cell.masterIntervalMinutes}m` : 'global'} ·{' '}
                    {cell.maxConcurrent}× · {cell.harness ?? 'brain default'} ·{' '}
                    {cell.monthlyBudgetUsd === null
                      ? 'no budget'
                      : `${moneyLabel(cell.monthlyBudgetUsd)}/mo`}{' '}
                    · {cell.autocompactPercent}% compact
                  </span>
                  {onEditCell ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEditCell(cell)}
                    >
                      Process
                    </Button>
                  ) : null}
                  <Checkbox
                    label={`${cell.name} master`}
                    checked={cell.masterEnabled}
                    onChange={() => void toggleCell(cell)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>Activity</SectionTitle>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-500">No master activity yet.</p>
        ) : (
          <ul
            aria-label="Recent activity"
            className="max-h-80 divide-y divide-zinc-800 overflow-y-auto overscroll-contain pr-1"
          >
            {events.map((event) => (
              <li key={event.id} className="flex items-start gap-2 py-2 text-xs">
                <span className="w-10 shrink-0 text-zinc-600">{timeAgo(event.createdAt)}</span>
                <Badge tone={ACTION_TONES[event.action]}>{event.action}</Badge>
                <span className="w-24 shrink-0 truncate text-zinc-500">
                  {event.cellId
                    ? cells.find((cell) => cell.id === event.cellId)?.name ?? 'Deleted cell'
                    : 'Unassigned'}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-400">
                  {eventDetail(event)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
