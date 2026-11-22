import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError, streamNdjson } from './api';
import { appendUser, applyEvent, fromTranscript, type ChatMessage } from './chat';
import { useChatRuntime } from './runtime';
import { Thread } from './Thread';
import type { ClarifyEvent, CommandInfo, Request } from './types';

interface ClarifyChatProps {
  requestId: string;
  started: boolean;
  commands: CommandInfo[];
  onError: (message: string) => void;
  onRequest?: (request: Request) => void;
  onDone?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Render an inline error banner with a retry that replays the failed call. */
  inlineErrors?: boolean;
}

type FailedAttempt = { kind: 'hydrate' } | { kind: 'send'; text: string };

function readQueue(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeQueue(key: string, queue: string[]): void {
  try {
    if (queue.length > 0) window.localStorage.setItem(key, JSON.stringify(queue));
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode or a full quota: the queue stays in memory.
  }
}

/**
 * One chat per request. React owns the messages and running flag; a live turn is
 * reattached from the NDJSON stream on mount. Composing while a turn runs queues
 * the message, Stop cuts the turn short and clears the queue so the human can
 * interject, and the queue survives a reload.
 */
export function ClarifyChat({
  requestId,
  started,
  commands,
  onError,
  onRequest,
  onDone,
  disabled,
  placeholder,
  inlineErrors,
}: ClarifyChatProps) {
  const queueKey = `sbox-queue:${requestId}`;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [queue, setQueue] = useState<string[]>(() => readQueue(queueKey));
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const failedAttempt = useRef<FailedAttempt | null>(null);
  const runningRef = useRef(false);
  const activeStream = useRef<AbortController | null>(null);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    writeQueue(queueKey, queue);
  }, [queueKey, queue]);

  const setBusy = useCallback((value: boolean) => {
    runningRef.current = value;
    setRunning(value);
  }, []);

  const handleEvent = useCallback(
    (event: ClarifyEvent) => {
      if (event.t === 'done') {
        setMessages(fromTranscript(event.transcript));
        if (event.request) onRequestRef.current?.(event.request);
        onDoneRef.current?.();
        setBusy(false);
        setStopping(false);
        setInlineError(null);
        failedAttempt.current = null;
        return;
      }
      if (event.t === 'error') onErrorRef.current(event.message);
      setMessages((current) => applyEvent(current, event));
    },
    [setBusy],
  );

  const hydrate = useCallback(async () => {
    const controller = new AbortController();
    activeStream.current?.abort();
    activeStream.current = controller;
    try {
      const state = await api.getClarify(requestId);
      if (controller.signal.aborted) return;
      setInlineError(null);
      failedAttempt.current = null;
      setMessages(fromTranscript(state.transcript ?? []));
      if (state.active) {
        setBusy(true);
        await api.streamClarify(requestId, handleEvent, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = describeError(error);
        failedAttempt.current = { kind: 'hydrate' };
        setInlineError(message);
        onErrorRef.current(message);
      }
    } finally {
      if (activeStream.current === controller) activeStream.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        setStopping(false);
      }
    }
  }, [requestId, handleEvent, setBusy]);

  useEffect(() => {
    // Always read the snapshot: a live turn can exist even if the request row
    // has not flipped `clarifyStarted` yet.
    void hydrate();
  }, [hydrate, started]);

  useEffect(() => () => activeStream.current?.abort(), []);

  const sendText = useCallback(
    async (raw: string, retry = false) => {
      const text = raw.trim();
      if (text === '') return;
      const controller = new AbortController();
      activeStream.current?.abort();
      activeStream.current = controller;
      setStopped(false);
      setInlineError(null);
      failedAttempt.current = null;
      if (!retry) setMessages((current) => appendUser(current, text));
      setBusy(true);
      let received = false;
      try {
        await streamNdjson(
          `/api/requests/${encodeURIComponent(requestId)}/clarify/send`,
          (event) => {
            received = true;
            handleEvent(event);
          },
          { method: 'POST', body: JSON.stringify({ text }), signal: controller.signal },
        );
        setInlineError(null);
        failedAttempt.current = null;
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = describeError(error);
          // A failure after events were received may already have started the
          // turn on the server; reattach instead of sending the text twice.
          failedAttempt.current = received ? { kind: 'hydrate' } : { kind: 'send', text };
          setInlineError(message);
          onErrorRef.current(message);
        }
      } finally {
        if (activeStream.current === controller) activeStream.current = null;
        if (!controller.signal.aborted) {
          setBusy(false);
          setStopping(false);
        }
      }
    },
    [requestId, handleEvent, setBusy],
  );

  const retry = useCallback(() => {
    const failed = failedAttempt.current;
    setInlineError(null);
    if (failed?.kind === 'send') {
      void sendText(failed.text, true);
      return;
    }
    failedAttempt.current = null;
    void hydrate();
  }, [hydrate, sendText]);

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (text === '' || !started || disabled) return;
      if (runningRef.current) {
        setQueue((current) => [...current, text]);
        return;
      }
      await sendText(text);
    },
    [started, disabled, sendText],
  );

  // Drain one queued message whenever the previous turn has finished.
  useEffect(() => {
    if (running || !started || disabled || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void sendText(next);
  }, [running, started, disabled, queue, sendText]);

  const stop = useCallback(async () => {
    if (!runningRef.current) return;
    setQueue([]);
    setStopping(true);
    try {
      await api.stopClarify(requestId);
      setStopped(true);
    } catch (error) {
      onErrorRef.current(describeError(error));
      setStopping(false);
    }
  }, [requestId]);

  // If the child refuses to die, do not leave the composer stuck forever.
  useEffect(() => {
    if (!stopping) return;
    const timer = window.setTimeout(() => {
      setBusy(false);
      setStopping(false);
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [stopping, setBusy]);

  const runtime = useChatRuntime({
    messages,
    running,
    disabled: !started || disabled,
    onNew: submit,
  });

  return (
    <div className="flex h-full flex-col">
      {inlineErrors && inlineError ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-2 border-b border-red-900/60 bg-red-950/30 px-3 py-1.5 text-[11px] text-red-300"
        >
          <span className="min-w-0 break-words">{inlineError}</span>
          <button
            type="button"
            className="shrink-0 rounded border border-red-800 px-2 py-0.5 text-[11px] text-red-200 hover:border-red-500 hover:text-white disabled:opacity-40"
            onClick={retry}
            disabled={running}
          >
            Retry
          </button>
        </div>
      ) : null}
      {running ? (
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-1">
          <span className="flex items-center gap-2 text-[11px] text-blue-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
            {stopping ? 'Stopping…' : 'Agent is working…'}
          </span>
          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-40"
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      ) : null}

      {queue.length > 0 ? (
        <div className="border-b border-zinc-800 px-3 py-1 text-[11px] text-amber-300">
          <div className="flex items-center justify-between gap-2">
            <span>
              {queue.length} queued
            </span>
            <button
              type="button"
              className="text-zinc-500 hover:text-zinc-300"
              onClick={() => setQueue([])}
            >
              Clear
            </button>
          </div>
          <ul className="mt-0.5 space-y-0.5">
            {queue.map((item, index) => (
              <li key={`${index}-${item.slice(0, 12)}`} className="truncate text-zinc-500">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {stopped && !running ? (
        <div className="border-b border-amber-900/40 bg-amber-950/20 px-3 py-1 text-[11px] text-amber-300">
          Stopped. You can interject.
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <Thread
          runtime={runtime}
          commands={commands}
          onSend={submit}
          disabled={!started || disabled}
          placeholder={
            !started ? 'Start clarify to chat.' : running ? 'Queue a message…' : placeholder
          }
        />
      </div>
    </div>
  );
}
