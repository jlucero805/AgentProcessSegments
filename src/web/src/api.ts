import type {
  CellDetail,
  ClarifyEvent,
  ClarifyState,
  CommandInfo,
  ConfigResponse,
  KbEntry,
  MasterConfig,
  MasterEvent,
  MasterResult,
  MasterStatus,
  ModelsResult,
  PluginInfo,
  ProcessConfig,
  ProcessResponse,
  Request,
  State,
  SegmentConfig,
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
  const message =
    (typeof body?.['message'] === 'string' && body['message']) ||
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
  const response = await fetch(path, init);
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
  getModels(refresh = false): Promise<ModelsResult> {
    return request(withQuery('/api/models', refresh ? { refresh: 1 } : {}));
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
  createCell(
    name: string,
    process?: ProcessConfig,
  ): Promise<CellDetail> {
    return request('/api/cells', {
      method: 'POST',
      body: JSON.stringify({ name, process }),
    });
  },
  patchCell(
    id: string,
    fields: { name?: string; masterEnabled?: boolean; process?: ProcessConfig | null },
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
  getConfig(): Promise<ConfigResponse> {
    return request('/api/config');
  },
  patchConfig(master: Partial<MasterConfig>): Promise<ConfigResponse> {
    return request('/api/config', { method: 'PATCH', body: JSON.stringify({ master }) });
  },
  getProcess(): Promise<ProcessResponse> {
    return request('/api/process');
  },
  patchProcess(segments: SegmentConfig[]): Promise<ProcessResponse> {
    return request('/api/process', { method: 'PATCH', body: JSON.stringify({ segments }) });
  },
  getMasterStatus(): Promise<MasterStatus> {
    return request('/api/master/status');
  },
  runMaster(): Promise<MasterResult> {
    return request('/api/master/run', { method: 'POST' });
  },
  getMasterEvents(options: { cellId?: string; limit?: number } = {}): Promise<MasterEvent[]> {
    return request(withQuery('/api/master/events', options));
  },
};
