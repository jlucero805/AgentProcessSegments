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
  disabled?: boolean;
  placeholder?: string;
}

/**
 * One chat per request. React owns the messages and running flag; a live turn is
 * reattached from the NDJSON stream on mount, and finished turns fall back to the
 * snapshot from GET /clarify.
 */
export function ClarifyChat({
  requestId,
  started,
  commands,
  onError,
  onRequest,
  disabled,
  placeholder,
}: ClarifyChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;

  const setBusy = useCallback((value: boolean) => {
    runningRef.current = value;
    setRunning(value);
  }, []);

  const handleEvent = useCallback(
    (event: ClarifyEvent) => {
      if (event.t === 'done') {
        setMessages(fromTranscript(event.transcript));
        if (event.request) onRequestRef.current?.(event.request);
        setBusy(false);
        return;
      }
      if (event.t === 'error') onErrorRef.current(event.message);
      setMessages((current) => applyEvent(current, event));
    },
    [setBusy],
  );

  const hydrate = useCallback(async () => {
    try {
      const state = await api.getClarify(requestId);
      setMessages(fromTranscript(state.transcript));
      if (state.active) {
        setBusy(true);
        await api.streamClarify(requestId, handleEvent);
      }
    } catch (error) {
      onErrorRef.current(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [requestId, handleEvent, setBusy]);

  useEffect(() => {
    // Always read the snapshot: a live turn can exist even if the request row
    // has not flipped `clarifyStarted` yet.
    void hydrate();
  }, [hydrate, started]);

  const submit = useCallback(
    async (text: string) => {
      if (runningRef.current || !started || disabled) return;
      setMessages((current) => appendUser(current, text));
      setBusy(true);
      try {
        await streamNdjson(
          `/api/requests/${encodeURIComponent(requestId)}/clarify/send`,
          handleEvent,
          { method: 'POST', body: JSON.stringify({ text }) },
        );
      } catch (error) {
        onErrorRef.current(describeError(error));
      } finally {
        setBusy(false);
      }
    },
    [requestId, handleEvent, setBusy, started, disabled],
  );

  const runtime = useChatRuntime({
    messages,
    running,
    disabled: !started || disabled || running,
    onNew: submit,
  });

  return (
    <div className="flex h-full flex-col">
      {running ? (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1 text-[11px] text-blue-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
          Agent is working…
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Thread
          runtime={runtime}
          commands={commands}
          onSend={submit}
          disabled={!started || disabled || running}
          placeholder={!started ? 'Start clarify to chat.' : placeholder}
        />
      </div>
    </div>
  );
}
