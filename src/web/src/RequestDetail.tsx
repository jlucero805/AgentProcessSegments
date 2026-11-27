import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, describeError, streamNdjson } from './api';
import { ClarifyChat } from './ClarifyChat';
import { TranscriptList } from './TranscriptList';
import { formFromRequest, patchFromForm, type RequestFormState } from './requestForm';
import { mergeSlashCommands } from './slash';
import { formatCost, formatTokens } from './usageFormat';
import {
  EFFORT_LEVELS,
  HARNESS_IDS,
  HARNESS_LABELS,
  isTerminal,
  STATE_LABELS,
  type Cell,
  type CommandInfo,
  type HarnessId,
  type ModelOption,
  type Request,
  type State,
  type TranscriptMsg,
  type UsageResponse,
} from './types';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  IconButton,
  Input,
  SectionTitle,
  Select,
  Spinner,
  Textarea,
  cn,
} from './ui';

interface RequestDetailProps {
  id: string;
  onClose: () => void;
  onError: (message: string) => void;
  onChanged?: () => void;
}

const STATE_TONES: Record<State, 'purple' | 'blue' | 'amber' | 'green' | 'red' | 'neutral'> = {
  clarify: 'purple',
  dispatch: 'blue',
  review: 'amber',
  merge: 'blue',
  finalize: 'green',
  done: 'green',
  dropped: 'red',
};

/** Right-side request drawer: editable fields, workflow actions, chat, and digest. */
export function RequestDetail({ id, onClose, onError, onChanged }: RequestDetailProps) {
  const [request, setRequest] = useState<Request | null>(null);
  const [form, setForm] = useState<RequestFormState | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [efforts, setEfforts] = useState<readonly string[]>(EFFORT_LEVELS);
  const [harness, setHarness] = useState<HarnessId | null>(null);
  const [supportsEffort, setSupportsEffort] = useState(true);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [transcript, setTranscript] = useState<TranscriptMsg[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [digest, setDigest] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [maximized, setMaximized] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await api.getRequest(id);
      setRequest(found);
      setForm(formFromRequest(found));
      setDigest(found.digest ?? '');

      const [clarify, commandList, skillList, cellList] = await Promise.all([
        api.getClarify(id).catch(() => ({ started: found.clarifyStarted, transcript: [] })),
        api.getCommands().catch(() => [] as CommandInfo[]),
        api.getSkills(id).catch(() => []),
        api.getCells().catch(() => [] as Cell[]),
      ]);
      setTranscript(clarify.transcript);
      setCommands(mergeSlashCommands(commandList, skillList));
      setCells(cellList);
    } catch (error) {
      onError(describeError(error));
    }
  }, [id, onError]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await api.getUsage({ requestId: id }));
    } catch {
      // Usage is supplementary; a failed card must not break the request drawer.
      setUsage(null);
    }
  }, [id]);

  useEffect(() => {
    void (async () => {
      await loadUsage();
    })();
  }, [loadUsage]);

  useEffect(() => {
    api.markSeen(id).catch(() => {});
  }, [id]);

  // The request override wins, then its cell, then the brain default. Follow a
  // harness/cell change and clear a model id that the new adapter does not
  // advertise. The first load keeps the request's explicit model even when a
  // probe falls back to a partial list.
  const modelContextRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    modelContextRef.current = undefined;
  }, [id]);
  const formReady = form !== null;
  const cellId = form?.cellId ?? '';
  const requestHarness = form?.harness ?? '';
  useEffect(() => {
    if (!formReady) return;
    const context = `${requestHarness}|${cellId}`;
    const previous = modelContextRef.current;
    modelContextRef.current = context;
    let cancelled = false;
    api
      .getModels(
        false,
        requestHarness ? (requestHarness as HarnessId) : undefined,
        requestHarness ? undefined : cellId || undefined,
      )
      .then((result) => {
        if (cancelled) return;
        const options = Array.isArray(result.models) ? result.models : [];
        setModels(options);
        setEfforts(
          Array.isArray(result.effortLevels) && result.effortLevels.length > 0
            ? result.effortLevels
            : EFFORT_LEVELS,
        );
        setHarness(result.harness ?? null);
        setSupportsEffort(result.supportsEffort !== false);
        setForm((current) => {
          if (!current || previous == null || !current.model) return current;
          const previousHarness = previous.split('|')[0] ?? '';
          if (previousHarness !== requestHarness) return { ...current, model: '' };
          if (previous !== context && !options.some((option) => option.id === current.model)) {
            return { ...current, model: '' };
          }
          return current;
        });
      })
      .catch(() => {
        // Model discovery is optional.
      });
    return () => {
      cancelled = true;
    };
  }, [formReady, requestHarness, cellId]);

  const set = <K extends keyof RequestFormState>(key: K, value: RequestFormState[K]) => {
    setForm((current) => {
      if (!current) return current;
      const next = { ...current, [key]: value };
      if (key === 'harness' && value !== current.harness) next.model = '';
      return next;
    });
    setSaved(false);
  };

  async function save() {
    if (!form) return;
    setBusy('save');
    try {
      const updated = await api.patchRequest(id, patchFromForm(form, digest));
      setRequest(updated);
      setForm(formFromRequest(updated));
      setSaved(true);
      onChanged?.();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function runStream(path: string, key: string) {
    setBusy(key);
    setPending(null);
    setStreamText('');
    let sawDone = false;
    try {
      await streamNdjson(
        path,
        (event) => {
          if (event.t === 'text') setStreamText((current) => current + event.text);
          else if (event.t === 'error') onError(event.message);
          else if (event.t === 'done') {
            sawDone = true;
            if (event.request) {
              setRequest(event.request);
              setForm(formFromRequest(event.request));
            }
            setTranscript(event.transcript);
            void loadUsage();
            onChanged?.();
            if (key === 'finalize') {
              const text = event.transcript
                .filter((message) => message.role === 'agent' && message.kind === 'text')
                .map((message) => message.text)
                .join('\n\n')
                .trim();
              if (text) setDigest(text);
            }
          }
        },
        { method: 'POST' },
      );
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBusy(null);
      // On a clean `done` the event already carried fresh row data. A stream
      // that ends early may have changed state server-side, so resync then.
      if (!sawDone) await load();
    }
  }

  async function transitionTo(to: State) {
    setBusy(`to:${to}`);
    setPending(null);
    try {
      const updated = await api.transition(id, to);
      setRequest(updated);
      setForm(formFromRequest(updated));
      onChanged?.();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function dropRequest() {
    setBusy('drop');
    setPending(null);
    try {
      const updated = await api.drop(id);
      setRequest(updated);
      setForm(formFromRequest(updated));
      onChanged?.();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function indexAndFinalize() {
    setBusy('index');
    setPending(null);
    try {
      const updated = await api.indexAndFinalize(id, digest.trim() === '' ? null : digest, true);
      setRequest(updated);
      setForm(formFromRequest(updated));
      onChanged?.();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBusy(null);
    }
  }

  function confirmThen(key: string, action: () => Promise<void>) {
    if (pending === key) {
      setPending(null);
      void action();
    } else {
      setPending(key);
    }
  }

  const terminal = request ? isTerminal(request.state) : false;
  const selectedCell = form?.cellId
    ? cells.find((candidate) => candidate.id === form.cellId)
    : undefined;
  const effectiveHarness = form?.harness || selectedCell?.harness || harness;
  const harnessLabel = effectiveHarness
    ? (HARNESS_LABELS[effectiveHarness as HarnessId] ?? effectiveHarness)
    : 'not resolved';
  const harnessSource = form?.harness
    ? 'request override'
    : selectedCell?.harness
      ? `cell ${selectedCell.name}`
      : 'brain default';

  const actions = useMemo(() => {
    if (!request) return null;
    const states: { key: string; label: string; run: () => Promise<void>; tone?: 'danger' }[] = [];

    if (request.state === 'clarify') {
      if (!request.clarifyStarted) {
        states.push({
          key: 'start',
          label: 'Start clarify',
          run: () => runStream(`/api/requests/${encodeURIComponent(id)}/clarify/start`, 'start'),
        });
      }
      states.push({
        key: 'dispatch',
        label: 'Dispatch',
        run: () => runStream(`/api/requests/${encodeURIComponent(id)}/dispatch`, 'dispatch'),
      });
    } else if (request.state === 'dispatch') {
      states.push({ key: 'review', label: 'Send to review', run: () => transitionTo('review') });
      states.push({ key: 'clarify', label: 'Back to plan', run: () => transitionTo('clarify') });
    } else if (request.state === 'review') {
      states.push({
        key: 'merge',
        label: 'Send to merge',
        run: () => transitionTo('merge'),
      });
      states.push({
        key: 'finalize',
        label: 'Finalize',
        run: () => runStream(`/api/requests/${encodeURIComponent(id)}/finalize`, 'finalize'),
      });
      states.push({ key: 'dispatch', label: 'Back to implement', run: () => transitionTo('dispatch') });
    } else if (request.state === 'merge') {
      states.push({
        key: 'finalize',
        label: 'Finalize',
        run: () => runStream(`/api/requests/${encodeURIComponent(id)}/finalize`, 'finalize'),
      });
      states.push({ key: 'review', label: 'Back to review', run: () => transitionTo('review') });
    }
    if (request.state !== 'done' && request.state !== 'dropped') {
      states.push({ key: 'drop', label: 'Drop', run: dropRequest, tone: 'danger' });
    }
    return states;
  }, [request, id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside
      className={cn(
        'fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl',
        maximized ? 'max-w-none' : 'max-w-[46rem]',
      )}
    >
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        {request ? (
          <>
            <Badge tone={STATE_TONES[request.state]}>{STATE_LABELS[request.state]}</Badge>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">
              {request.title}
            </span>
            <span className="hidden text-[11px] text-zinc-500 sm:inline">
              {request.agentStatus}
            </span>
          </>
        ) : (
          <Spinner />
        )}
        <IconButton
          label={maximized ? 'Restore drawer' : 'Maximize drawer'}
          onClick={() => setMaximized((value) => !value)}
        >
          {maximized ? '⤡' : '⤢'}
        </IconButton>
        <IconButton label="Close drawer" onClick={onClose}>
          ×
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!request || !form ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-zinc-500">
            <Spinner /> Loading request...
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-1.5 text-[11px] text-zinc-500">
              <span className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono">
                {request.id.slice(0, 8)}
              </span>
              {request.branch ? (
                <span className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono">
                  {request.branch}
                </span>
              ) : null}
              {request.targetRepo ? (
                <span className="truncate rounded border border-zinc-800 px-1.5 py-0.5 font-mono">
                  {request.targetRepo}
                </span>
              ) : null}
              {effectiveHarness ? (
                <span className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono">
                  harness: {harnessLabel} ({harnessSource})
                </span>
              ) : null}
            </div>

            <div className="space-y-3">
              <Field label="Title">
                <Input value={form.title} onChange={(event) => set('title', event.target.value)} />
              </Field>
              <Field label="Body">
                <Textarea rows={4} value={form.body} onChange={(event) => set('body', event.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Target repo" hint="worktree base">
                  <Input
                    value={form.targetRepo}
                    onChange={(event) => set('targetRepo', event.target.value)}
                    placeholder="optional"
                  />
                </Field>
                <Field label="Cell">
                  <Select value={form.cellId} onChange={(event) => set('cellId', event.target.value)}>
                    <option value="">Unassigned</option>
                    {cells.map((cell) => (
                      <option key={cell.id} value={cell.id}>
                        {cell.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <p className="text-[11px] text-zinc-600">
                Requests without a cell stay manual; assign one to let its master automate
                this request.
              </p>
              <Field label="Harness" hint={`effective: ${harnessLabel} (${harnessSource})`}>
                <Select
                  value={form.harness}
                  onChange={(event) => set('harness', event.target.value)}
                >
                  <option value="">Inherit</option>
                  {HARNESS_IDS.map((id) => (
                    <option key={id} value={id}>
                      {HARNESS_LABELS[id]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Acceptance criteria">
                <Textarea
                  rows={2}
                  value={form.acceptanceCriteria}
                  onChange={(event) => set('acceptanceCriteria', event.target.value)}
                  placeholder="optional"
                />
              </Field>
              <Field label="Context">
                <Textarea
                  rows={2}
                  value={form.context}
                  onChange={(event) => set('context', event.target.value)}
                  placeholder="optional"
                />
              </Field>
              <Field label="Skills" hint="comma separated">
                <Input
                  value={form.skillsText}
                  onChange={(event) => set('skillsText', event.target.value)}
                  placeholder="e.g. testing, release"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Model">
                  <Select value={form.model} onChange={(event) => set('model', event.target.value)}>
                    <option value="">Harness default</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Effort" hint={supportsEffort ? undefined : 'not used by this harness'}>
                  {supportsEffort ? (
                    <Select value={form.effort} onChange={(event) => set('effort', event.target.value)}>
                      <option value="">Default</option>
                      {efforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input value="—" disabled readOnly />
                  )}
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <Checkbox
                  label="Groomed"
                  checked={form.groomed}
                  onChange={(event) => set('groomed', event.target.checked)}
                />
                <Checkbox
                  label="Index digest to the KB on finalize"
                  checked={form.kbDigest}
                  onChange={(event) => set('kbDigest', event.target.checked)}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                {saved ? <span className="text-[11px] text-emerald-400">Saved</span> : null}
                <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void save()}>
                  {busy === 'save' ? <Spinner /> : 'Save changes'}
                </Button>
              </div>
            </div>

            <Card className="space-y-2 p-3">
              <SectionTitle>Workflow</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {actions?.map((action) => (
                  <Button
                    key={action.key}
                    size="sm"
                    variant={
                      action.tone === 'danger'
                        ? 'danger'
                        : action.key === 'start' || action.key === 'dispatch'
                          ? 'primary'
                          : 'secondary'
                    }
                    disabled={busy !== null}
                    onClick={() =>
                      action.tone === 'danger'
                        ? confirmThen(action.key, action.run)
                        : void action.run()
                    }
                  >
                    {busy === action.key ? (
                      <Spinner />
                    ) : pending === action.key ? (
                      'Confirm?'
                    ) : (
                      action.label
                    )}
                  </Button>
                ))}
              </div>
              {streamText ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-2 font-mono text-[11px] text-zinc-400">
                  {streamText}
                </pre>
              ) : null}
            </Card>

            {usage ? (
              <Card className="space-y-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <SectionTitle>Usage</SectionTitle>
                  <span className="text-xs text-zinc-400">{formatCost(usage.totals)}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-sm font-semibold text-zinc-100">{usage.totals.turns}</p>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-600">Turns</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-100">
                      {formatTokens(usage.totals.totalTokens)}
                    </p>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-600">Tokens</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-zinc-100">
                      {usage.totals.unpricedTurns}
                    </p>
                    <p className="text-[10px] uppercase tracking-wide text-zinc-600">Unpriced</p>
                  </div>
                </div>
                {usage.byModel.length > 0 ? (
                  <div className="space-y-1 border-t border-zinc-900 pt-2">
                    {usage.byModel.slice(0, 3).map((model) => (
                      <div
                        key={model.key || model.label}
                        className="flex items-center justify-between gap-2 text-[11px]"
                      >
                        <span className="truncate text-zinc-500" title={model.label}>
                          {model.label}
                        </span>
                        <span className="shrink-0 text-zinc-600">{formatCost(model)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Card>
            ) : null}

      {!terminal ? (
        <div className="space-y-2">
          <SectionTitle>Thread</SectionTitle>
          <Card className="h-[26rem] overflow-hidden">
            <ClarifyChat
              requestId={id}
              started={request.state !== 'clarify' || request.clarifyStarted}
              commands={commands}
              onError={onError}
              onRequest={(updated) => {
                setRequest(updated);
                setForm(formFromRequest(updated));
              }}
              onDone={() => void loadUsage()}
              placeholder="Message this thread…"
            />
          </Card>
        </div>
      ) : (
        <div className="space-y-2">
          <SectionTitle>Transcript</SectionTitle>
          <TranscriptList transcript={transcript} />
        </div>
      )}

            <Card className="space-y-2 p-3">
              <SectionTitle>Finalize digest</SectionTitle>
              <p className="text-[11px] text-zinc-500">
                Review the digest the agent proposed. Indexing stores it in the knowledge base and
                closes the request.
              </p>
              <Textarea
                rows={5}
                value={digest}
                onChange={(event) => {
                  setDigest(event.target.value);
                  setSaved(false);
                }}
                placeholder="The finalize turn proposes a digest here."
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-600">
                  {request.state === 'finalize'
                    ? 'Ready to close.'
                    : 'Available once the request reaches Finalize.'}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={request.state !== 'finalize' || busy !== null}
                  onClick={() => confirmThen('index', indexAndFinalize)}
                >
                  {busy === 'index' ? <Spinner /> : pending === 'index' ? 'Confirm index?' : 'Index and finalize'}
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>
    </aside>
  );
}
