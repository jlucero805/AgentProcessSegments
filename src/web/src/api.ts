import type {
  BudgetAlert,
  BudgetSettings,
  BudgetsResponse,
  CellDetail,
  CellDraft,
  ClarifyEvent,
  ClarifyState,
  CommandInfo,
  ConfigResponse,
  DocContent,
  DocPage,
  HarnessId,
  IndexAllResult,
  KbEntry,
  MasterConfig,
  MasterEvent,
  MasterResult,
  MasterStatus,
  ModelPrice,
  ModelPriceInput,
  ModelPricesResponse,
  ModelsResult,
  NotificationStatusResponse,
  PluginInfo,
  ProcessConfig,
  ProcessResponse,
  Request,
  SegmentConfig,
  SkillInfo,
  State,
  Summary,
  SummaryConfig,
  SummaryStatus,
  TerminalSessionInfo,
  TerminalStatus,
  UsageFilter,
  UsageResponse,
  UsageSettings,
  WebhookPatch,
  WebhookTestResult,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export { describe as describeError };

async function toApiError(response: Response): Promise<ApiError> {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error bodies fall back to the status text.
  }
  const issues = Array.isArray(body?.['issues']) ? body['issues'] : [];
  const firstIssue = issues.find((issue) => issue && typeof issue === 'object') as
    | { message?: unknown }
    | undefined;
  const issueMessage =
    typeof firstIssue?.message === 'string' && firstIssue.message !== ''
      ? firstIssue.message
      : null;
  const message =
    (typeof body?.['message'] === 'string' && body['message']) ||
    issueMessage ||
    (typeof body?.['error'] === 'string' && body['error']) ||
    `${response.status} ${response.statusText}`;
  return new ApiError(response.status, message, body?.['issues']);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** Reads a newline-delimited JSON stream and hands each parsed event to the caller. */
export async function streamNdjson(
  path: string,
  onEvent: (event: ClarifyEvent) => void,
  init: RequestInit = {},
): Promise<void> {
  const headers = new Headers(init.headers);
  // Chat send/start bodies are JSON. Without this header Fastify parses the
  // string body as text/plain and the request fails validation.
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw await toApiError(response);
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emit = (line: string): void => {
    if (!line) return;
    try {
      onEvent(JSON.parse(line) as ClarifyEvent);
    } catch {
      // A non-JSON line is transport noise, not a reason to abort the turn.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      emit(line);
      newline = buffer.indexOf('\n');
    }
  }
  emit(buffer.trim());
}

export const api = {
  getRequests(query: Record<string, string | undefined> = {}): Promise<Request[]> {
    return request(withQuery('/api/requests', query));
  },
  getRequest(id: string): Promise<Request> {
    return request(`/api/requests/${encodeURIComponent(id)}`);
  },
  createRequest(input: {
    title: string;
    body?: string;
    targetRepo?: string | null;
    cellId?: string | null;
  }): Promise<Request> {
    return request('/api/requests', { method: 'POST', body: JSON.stringify(input) });
  },
  patchRequest(id: string, fields: Record<string, unknown>): Promise<Request> {
    return request(`/api/requests/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
  },
  transition(id: string, to: State): Promise<Request> {
    return request(`/api/requests/${encodeURIComponent(id)}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    });
  },
  drop(id: string): Promise<Request> {
    return request(`/api/requests/${encodeURIComponent(id)}/drop`, { method: 'POST' });
  },
  markSeen(id: string): Promise<Request> {
    return request(`/api/requests/${encodeURIComponent(id)}/seen`, { method: 'POST' });
  },
  getClarify(id: string): Promise<ClarifyState> {
    return request(`/api/requests/${encodeURIComponent(id)}/clarify`);
  },
  startClarify(id: string): Promise<{ started: boolean }> {
    return request(`/api/requests/${encodeURIComponent(id)}/clarify/start?detach=1`, {
      method: 'POST',
    });
  },
  kickoffDispatch(id: string): Promise<{ started: boolean }> {
    return request(`/api/requests/${encodeURIComponent(id)}/dispatch?detach=1`, {
      method: 'POST',
    });
  },
  kickoffFinalize(id: string): Promise<{ started: boolean }> {
    return request(`/api/requests/${encodeURIComponent(id)}/finalize?detach=1`, {
      method: 'POST',
    });
  },
  stopClarify(id: string): Promise<{ stopped: boolean }> {
    return request(`/api/requests/${encodeURIComponent(id)}/clarify/stop`, { method: 'POST' });
  },
  streamClarify(
    id: string,
    onEvent: (event: ClarifyEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return streamNdjson(
      `/api/requests/${encodeURIComponent(id)}/clarify/stream`,
      onEvent,
      { method: 'GET', signal },
    );
  },
  indexAndFinalize(id: string, digest: string | null, index: boolean): Promise<Request> {
    return request(`/api/requests/${encodeURIComponent(id)}/index`, {
      method: 'POST',
      body: JSON.stringify({ digest, index }),
    });
  },
  indexAll(cellId?: string): Promise<IndexAllResult> {
    return request('/api/requests/index-all', {
      method: 'POST',
      body: JSON.stringify(cellId ? { cellId } : {}),
    });
  },
  getModels(
    refresh = false,
    harness?: HarnessId,
    cellId?: string,
    requestId?: string,
  ): Promise<ModelsResult> {
    return request(
      withQuery('/api/models', {
        ...(refresh ? { refresh: 1 } : {}),
        ...(harness ? { harness } : {}),
        ...(cellId ? { cellId } : {}),
        ...(requestId ? { requestId } : {}),
      }),
    );
  },
  getKb(q?: string, limit?: number): Promise<KbEntry[]> {
    return request(withQuery('/api/kb', { q, limit }));
  },
  storeKb(input: { requestId: string; title: string; content: string }): Promise<KbEntry> {
    return request('/api/kb', { method: 'POST', body: JSON.stringify(input) });
  },
  getCells(): Promise<CellDetail[]> {
    return request('/api/cells');
  },
  getCell(id: string): Promise<CellDetail> {
    return request(`/api/cells/${encodeURIComponent(id)}`);
  },
  createCell(input: {
    name: string;
    process?: ProcessConfig;
    masterIntervalMinutes?: number | null;
    maxConcurrent?: number;
    harness?: HarnessId | null;
    model?: string | null;
    effort?: string | null;
    monthlyBudgetUsd?: number | null;
  }): Promise<CellDetail> {
    return request('/api/cells', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  patchCell(
    id: string,
    fields: {
      name?: string;
      masterEnabled?: boolean;
      masterIntervalMinutes?: number | null;
      maxConcurrent?: number;
      harness?: HarnessId | null;
      model?: string | null;
      effort?: string | null;
      monthlyBudgetUsd?: number | null;
      process?: ProcessConfig | null;
    },
  ): Promise<CellDetail> {
    return request(`/api/cells/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
  },
  deleteCell(id: string): Promise<void> {
    return request(`/api/cells/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  getPlugins(): Promise<PluginInfo[]> {
    return request('/api/plugins');
  },
  installPlugin(input: { url: string; subdir?: string; name?: string }): Promise<PluginInfo> {
    return request('/api/plugins', { method: 'POST', body: JSON.stringify(input) });
  },
  removePlugin(name: string): Promise<void> {
    return request(`/api/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },
  getCommands(): Promise<CommandInfo[]> {
    return request('/api/commands');
  },
  getSkills(requestId?: string): Promise<SkillInfo[]> {
    return request(withQuery('/api/skills', { requestId }));
  },
  getDocs(): Promise<{ pages: DocPage[] }> {
    return request('/api/docs');
  },
  getDoc(slug: string): Promise<DocContent> {
    return request(`/api/docs/${encodeURIComponent(slug)}`);
  },
  getCellDraft(id: string): Promise<CellDraft> {
    return request(`/api/cell-drafts/${encodeURIComponent(id)}`);
  },
  putCellDraft(
    id: string,
    draft: Omit<CellDraft, 'id' | 'updatedAt'>,
  ): Promise<CellDraft> {
    return request(`/api/cell-drafts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(draft),
    });
  },
  deleteCellDraft(id: string): Promise<void> {
    return request(`/api/cell-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  getConfig(): Promise<ConfigResponse> {
    return request('/api/config');
  },
  patchConfig(patch: {
    master?: Partial<MasterConfig>;
    summary?: Partial<SummaryConfig>;
    usage?: Partial<UsageSettings>;
    budget?: Partial<BudgetSettings>;
    notifications?: { webhook?: WebhookPatch };
  }): Promise<ConfigResponse> {
    return request('/api/config', { method: 'PATCH', body: JSON.stringify(patch) });
  },
  getBudgets(): Promise<BudgetsResponse> {
    return request('/api/budgets');
  },
  ackBudgetAlert(id: string): Promise<BudgetAlert> {
    return request(`/api/budgets/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' });
  },
  getNotificationStatus(): Promise<NotificationStatusResponse> {
    return request('/api/notifications/status');
  },
  async testWebhook(): Promise<WebhookTestResult> {
    try {
      return await request<WebhookTestResult>('/api/notifications/webhook/test', {
        method: 'POST',
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return { ok: false, durationMs: 0, error: describe(error) };
      }
      throw error;
    }
  },
  getProcess(): Promise<ProcessResponse> {
    return request('/api/process');
  },
  getTerminalStatus(): Promise<TerminalStatus> {
    return request('/api/terminal');
  },
  getTerminals(): Promise<TerminalSessionInfo[]> {
    return request('/api/terminals');
  },
  createTerminal(input: { cols?: number; rows?: number } = {}): Promise<TerminalSessionInfo> {
    return request('/api/terminals', { method: 'POST', body: JSON.stringify(input) });
  },
  closeTerminal(id: string): Promise<void> {
    return request(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  patchProcess(segments: SegmentConfig[]): Promise<ProcessResponse> {
    return request('/api/process', { method: 'PATCH', body: JSON.stringify({ segments }) });
  },
  getMasterStatus(cellId?: string): Promise<MasterStatus> {
    return request(withQuery('/api/master/status', { cellId }));
  },
  runMaster(cellId: string): Promise<MasterResult> {
    return request(withQuery('/api/master/run', { cellId }), { method: 'POST' });
  },
  getMasterEvents(options: { cellId?: string; limit?: number } = {}): Promise<MasterEvent[]> {
    return request(withQuery('/api/master/events', options));
  },
  getSummaries(options: { cellId?: string; limit?: number } = {}): Promise<Summary[]> {
    return request(withQuery('/api/summaries', options));
  },
  getLatestSummary(cellId: string): Promise<Summary | null> {
    return request(withQuery('/api/summaries/latest', { cellId }));
  },
  getSummaryStatus(cellId?: string): Promise<SummaryStatus> {
    return request(withQuery('/api/summaries/status', { cellId }));
  },
  runSummary(cellId: string): Promise<Summary> {
    return request(withQuery('/api/summaries/run', { cellId }), { method: 'POST' });
  },
  getUsage(filters: UsageFilter = {}): Promise<UsageResponse> {
    return request(
      withQuery('/api/usage', {
        cellId: filters.cellId,
        requestId: filters.requestId,
        from: filters.from,
        to: filters.to,
        bucket: filters.bucket,
        limit: filters.limit,
      }),
    );
  },
  getPricing(): Promise<ModelPricesResponse> {
    return request('/api/pricing');
  },
  createPrice(input: ModelPriceInput): Promise<ModelPrice> {
    return request('/api/pricing', { method: 'POST', body: JSON.stringify(input) });
  },
  deletePrice(id: string): Promise<void> {
    return request(`/api/pricing/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
