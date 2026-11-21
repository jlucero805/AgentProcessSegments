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
      await api.streamClarify(requestId, handleEvent);
    } catch (error) {
      onErrorRef.current(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [requestId, handleEvent, setBusy]);

  useEffect(() => {
    if (!started) {
      setMessages([]);
      setBusy(false);
      return;
    }
    void hydrate();
  }, [hydrate, started, setBusy]);

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
    disabled: !started || disabled,
    onNew: submit,
  });

  return (
    <div className="h-full">
      <Thread
        runtime={runtime}
        commands={commands}
        onSend={submit}
        disabled={!started || disabled}
        placeholder={placeholder}
      />
    </div>
  );
}
