import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, describeError, streamNdjson } from './api';
import { ClarifyChat } from './ClarifyChat';
import {
  EFFORT_LEVELS,
  STATE_LABELS,
  type Cell,
  type CommandInfo,
  type ModelOption,
  type Request,
  type State,
  type TranscriptMsg,
} from './types';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
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

interface FormState {
  title: string;
  body: string;
  targetRepo: string;
  acceptanceCriteria: string;
  context: string;
  skillsText: string;
  groomed: boolean;
  model: string;
  effort: string;
  kbDigest: boolean;
  cellId: string;
}

const STATE_TONES: Record<State, 'purple' | 'blue' | 'amber' | 'green' | 'red' | 'neutral'> = {
  clarify: 'purple',
  dispatch: 'blue',
  review: 'amber',
  finalize: 'green',
  done: 'green',
  dropped: 'red',
};

function fromRequest(request: Request): FormState {
  return {
    title: request.title,
    body: request.body,
    targetRepo: request.targetRepo ?? '',
    acceptanceCriteria: request.acceptanceCriteria ?? '',
    context: request.context ?? '',
    skillsText: request.skills.join(', '),
    groomed: request.groomed,
    model: request.model ?? '',
    effort: request.effort ?? '',
    kbDigest: request.kbDigest,
    cellId: request.cellId ?? '',
  };
}

function TranscriptList({ transcript }: { transcript: TranscriptMsg[] }) {
  if (transcript.length === 0) {
    return <EmptyState title="No agent output yet" hint="Start a step to see the transcript." />;
  }
  return (
    <div className="space-y-2">
      {transcript.map((message, index) => (
        <div
          key={`${message.ts}-${index}`}
          className={cn(
            'rounded-lg border p-2 text-xs',
            message.role === 'you'
              ? 'border-zinc-800 bg-zinc-900/60'
              : 'border-zinc-900 bg-zinc-950',
          )}
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            {message.role === 'you' ? 'You' : message.kind === 'tool' ? message.toolName ?? 'Tool' : 'Agent'}
          </div>
          <pre className="whitespace-pre-wrap font-sans text-zinc-300">
            {message.kind === 'tool' ? message.toolInput ?? '' : message.text}
          </pre>
          {message.toolResult ? (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-black/40 p-1.5 font-mono text-[10px] text-zinc-500">
              {message.toolResult}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Right-side request drawer: editable fields, workflow actions, chat, and digest. */
export function RequestDetail({ id, onClose, onError, onChanged }: RequestDetailProps) {
  const [request, setRequest] = useState<Request | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [efforts, setEfforts] = useState<readonly string[]>(EFFORT_LEVELS);
  const [harness, setHarness] = useState<string | null>(null);
  const [supportsEffort, setSupportsEffort] = useState(true);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [transcript, setTranscript] = useState<TranscriptMsg[]>([]);
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
      setForm(fromRequest(found));
      setDigest(found.digest ?? '');

      const [clarify, modelResult, commandList, cellList] = await Promise.all([
        api.getClarify(id).catch(() => ({ started: found.clarifyStarted, transcript: [] })),
        api.getModels().catch(() => null),
        api.getCommands().catch(() => [] as CommandInfo[]),
        api.getCells().catch(() => [] as Cell[]),
      ]);
      setTranscript(clarify.transcript);
      if (modelResult) {
        setModels(modelResult.models);
        setEfforts(modelResult.effortLevels);
        setHarness(modelResult.harness ?? null);
        setSupportsEffort(modelResult.supportsEffort !== false);
      }
      setCommands(commandList);
      setCells(cellList);
    } catch (error) {
      onError(describeError(error));
    }
  }, [id, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.markSeen(id).catch(() => {});
  }, [id]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  async function save() {
    if (!form) return;
    setBusy('save');
    try {
      const updated = await api.patchRequest(id, {
        title: form.title.trim(),
        body: form.body,
        targetRepo: form.targetRepo.trim() || null,
        acceptanceCriteria: form.acceptanceCriteria.trim() === '' ? null : form.acceptanceCriteria,
        context: form.context.trim() === '' ? null : form.context,
        skills: form.skillsText
          .split(',')
          .map((skill) => skill.trim())
          .filter(Boolean),
        groomed: form.groomed,
        model: form.model || null,
        effort: form.effort || null,
        kbDigest: form.kbDigest,
        digest: digest.trim() === '' ? null : digest,
        cellId: form.cellId || null,
      });
      setRequest(updated);
      setForm(fromRequest(updated));
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
    try {
      await streamNdjson(
        path,
        (event) => {
          if (event.t === 'text') setStreamText((current) => current + event.text);
          else if (event.t === 'error') onError(event.message);
          else if (event.t === 'done') {
            if (event.request) {
              setRequest(event.request);
              setForm(fromRequest(event.request));
            }
            setTranscript(event.transcript);
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
      await load();
    }
  }

  async function transitionTo(to: State) {
    setBusy(`to:${to}`);
    setPending(null);
    try {
      const updated = await api.transition(id, to);
      setRequest(updated);
      setForm(fromRequest(updated));
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
      setForm(fromRequest(updated));
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
      setForm(fromRequest(updated));
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

  const terminal = request?.state === 'done' || request?.state === 'dropped';

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
        key: 'finalize',
        label: 'Finalize',
        run: () => runStream(`/api/requests/${encodeURIComponent(id)}/finalize`, 'finalize'),
      });
      states.push({ key: 'dispatch', label: 'Back to implement', run: () => transitionTo('dispatch') });
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
              {harness ? (
                <span className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono">
                  harness: {harness}
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
                    <option value="">CLI default</option>
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
                setForm(fromRequest(updated));
              }}
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
