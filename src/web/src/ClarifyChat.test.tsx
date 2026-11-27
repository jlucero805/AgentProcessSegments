import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClarifyChat } from './ClarifyChat';
import { enqueueBack, inflightKey } from './queue';
import { jsonResponse, ndjsonResponse } from './test/fixtures';
import { installFakeLocks, uninstallFakeLocks } from './test/fakeLocks';

// These cases drive an NDJSON stream, a 1 s elapsed ticker, a 4 s stop fallback,
// and cross-tab queue locks. A scheduling stall can exceed Testing Library's 1 s
// query default or Vitest's 5 s case default under a parallel full-suite run, so
// give every query and case an explicit bounded budget. Widen waits only.
const ASYNC_TIMEOUT_MS = 10_000;
const CLARIFY_CHAT_TEST_TIMEOUT_MS = 30_000;
const WORKING_BANNER = /Agent is working…/;

const encoder = new TextEncoder();

function seedClaim(requestId: string, text: string, claimedAt: number, id = 'claim-1'): void {
  window.localStorage.setItem(
    inflightKey(`aps-queue:${requestId}`),
    JSON.stringify([{ id, text, claimedAt }]),
  );
}

function seedDirectClaim(
  requestId: string,
  text: string,
  claimedAt: number,
  id = 'direct-1',
): void {
  window.localStorage.setItem(
    inflightKey(`aps-queue:${requestId}`),
    JSON.stringify([{ id, text, claimedAt, kind: 'direct' }]),
  );
}

function doneWithUser(text: string, ts: number): string {
  return `{"t":"done","request":null,"transcript":[{"role":"you","kind":"text","text":${JSON.stringify(
    text,
  )},"ts":${ts}}]}\n`;
}

function controllableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return { stream, controller };
}

function doneEvent(text: string): string {
  return `{"t":"done","request":null,"transcript":[{"role":"agent","kind":"text","text":${JSON.stringify(
    text,
  )},"ts":1}]}\n`;
}

/** Advance the active fake clock and flush React/stream work in one `act`. */
async function advanceFakeTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('ClarifyChat live turns', () => {
  it('attaches to a live turn, streams text, and re-enables the composer', async () => {
    const live = controllableStream();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-1" started commands={[]} onError={() => {}} />);

    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    const composer = screen.getByPlaceholderText('Queue a message…');
    expect(composer).not.toBeDisabled();

    await act(async () => {
      live.controller.enqueue(encoder.encode('{"t":"text","text":"streamed "}\n'));
      live.controller.enqueue(encoder.encode('{"t":"text","text":"live"}\n'));
      live.controller.enqueue(encoder.encode(doneEvent('streamed live')));
      live.controller.close();
    });

    expect(await screen.findByText('streamed live', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Ask a question...')).not.toBeDisabled(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.queryByText(WORKING_BANNER)).not.toBeInTheDocument();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('queues a message while running and sends it when the turn ends', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return ndjsonResponse([
            '{"t":"text","text":"second reply"}\n',
            doneEvent('second reply'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-queue" started commands={[]} onError={() => {}} />);
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'queued next' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(sendBodies).toHaveLength(0);

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('first reply')));
      live.controller.close();
    });

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[0]).toMatchObject({ text: 'queued next' });
    expect(await screen.findByText('second reply', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('stops the live turn, clears queued messages, and allows an interjection', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    const stopped: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/stop')) {
          stopped.push(url);
          return jsonResponse({ stopped: true });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse([]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-stop" started commands={[]} onError={() => {}} />);
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    seedClaim('req-stop', 'in flight', Date.now());

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'do not send' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopped).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() => expect(screen.queryByText('do not send')).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() =>
      expect(window.localStorage.getItem(inflightKey('aps-queue:req-stop'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('partial reply')));
      live.controller.close();
    });

    expect(await screen.findByText('Stopped. You can interject.', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask a question...')).not.toBeDisabled();
    expect(sendBodies).toHaveLength(0);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('reports a rejected stop, keeps the live turn, and discards the queue', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    const stops: string[] = [];
    const onError = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/stop')) {
          stops.push(url);
          return jsonResponse({ error: 'internal', message: 'stop failed' }, 500);
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return ndjsonResponse([
            '{"t":"text","text":"second reply"}\n',
            doneEvent('second reply'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat
        requestId="req-stop-fail"
        started
        commands={[]}
        onError={onError}
        inlineErrors
      />,
    );
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'do not send' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    seedClaim('req-stop-fail', 'in flight', Date.now());
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-stop-fail'))).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stops).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });

    await waitFor(
      () => expect(screen.queryByText('Stopping…')).not.toBeInTheDocument(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('stop failed');
    expect(screen.getByRole('alert')).toHaveTextContent('stop failed');
    expect(screen.getAllByText('stop failed')).toHaveLength(1);

    await waitFor(
      () => expect(screen.queryByText('1 queued')).not.toBeInTheDocument(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(screen.queryByText('do not send')).not.toBeInTheDocument();
    await waitFor(
      () => expect(window.localStorage.getItem('aps-queue:req-stop-fail')).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await waitFor(
      () => expect(window.localStorage.getItem(inflightKey('aps-queue:req-stop-fail'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(sendBodies).toHaveLength(0);

    expect(screen.queryByText('Stopped. You can interject.')).not.toBeInTheDocument();
    expect(screen.getByText(WORKING_BANNER)).toBeInTheDocument();
    const queueAgain = screen.getByPlaceholderText('Queue a message…');
    expect(queueAgain).not.toBeDisabled();
    fireEvent.change(queueAgain, { target: { value: 'after failure' } });
    fireEvent.keyDown(queueAgain, { key: 'Enter' });
    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('after failure')).toBeInTheDocument();

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('first reply')));
      live.controller.close();
    });

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[0]).toMatchObject({ text: 'after failure' });
    expect(await screen.findByText('second reply', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(
      () => expect(screen.queryByText(WORKING_BANNER)).not.toBeInTheDocument(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('clears the stopping state when the stop request never resolves', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    const stopped: string[] = [];
    let resolveStop!: (response: Response) => void;
    const stopResponse = new Promise<Response>((resolve) => {
      resolveStop = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/stop')) {
          stopped.push(url);
          return stopResponse;
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return ndjsonResponse([doneEvent('unexpected')]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-stop-fallback" started commands={[]} onError={() => {}} />);
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    seedClaim('req-stop-fallback', 'in flight', Date.now());

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'do not send' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    // Fake only the fallback timeout. Leaving setInterval real means the live
    // elapsed ticker can still be cleared by the component's real clearInterval.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

      expect(stopped).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
      expect(screen.getAllByText('Stopping…')).toHaveLength(2);
      expect(screen.queryByText('Stopped. You can interject.')).not.toBeInTheDocument();

      await advanceFakeTimers(4_000);

      expect(screen.queryByText(WORKING_BANNER)).not.toBeInTheDocument();
      expect(screen.queryByText('Stopping…')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText('Ask a question...')).not.toBeDisabled();
      expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
      expect(window.localStorage.getItem('aps-queue:req-stop-fallback')).toBeNull();
      expect(window.localStorage.getItem(inflightKey('aps-queue:req-stop-fallback'))).toBeNull();
      expect(sendBodies).toHaveLength(0);

      await advanceFakeTimers(4_000);
      expect(screen.queryByText(WORKING_BANNER)).not.toBeInTheDocument();
      expect(screen.queryByText('Stopping…')).not.toBeInTheDocument();

      await act(async () => {
        resolveStop(jsonResponse({ stopped: true }));
      });
      expect(screen.getByText('Stopped. You can interject.')).toBeInTheDocument();

      await act(async () => {
        live.controller.close();
      });
    } finally {
      vi.useRealTimers();
    }
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('ticks elapsed seconds while the turn runs and stops after done', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return ndjsonResponse([doneEvent('unexpected')]);
        }
        return jsonResponse([]);
      }),
    );

    // The ticker interval is created as soon as running flips, so the fake
    // clock must be installed before render. Keep setTimeout real so Testing
    // Library and unrelated timers are not driven by the fake clock.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      render(<ClarifyChat requestId="req-elapsed" started commands={[]} onError={() => {}} />);
      await advanceFakeTimers(0);

      expect(screen.getByText('Agent is working…')).toBeInTheDocument();
      expect(screen.queryByText('Agent is working… 1s')).not.toBeInTheDocument();

      await advanceFakeTimers(1_000);
      expect(screen.getByText('Agent is working… 1s')).toBeInTheDocument();

      await advanceFakeTimers(1_000);
      expect(screen.getByText('Agent is working… 2s')).toBeInTheDocument();

      await act(async () => {
        live.controller.enqueue(encoder.encode(doneEvent('ticker done')));
        live.controller.close();
      });
      await advanceFakeTimers(0);

      expect(screen.getByText('ticker done')).toBeInTheDocument();
      expect(screen.queryByText(WORKING_BANNER)).not.toBeInTheDocument();

      await advanceFakeTimers(5_000);
      expect(screen.queryByText(WORKING_BANNER)).not.toBeInTheDocument();
      expect(screen.queryByText(/3s/)).not.toBeInTheDocument();
      expect(sendBodies).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('clears queued messages when a hard cap stops the turn', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse([]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-paused" started commands={[]} onError={() => {}} />);
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    seedClaim('req-paused', 'in flight', Date.now());

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'queued behind the cap' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    const pause = {
      scope: 'overall',
      cellId: null,
      cellName: null,
      label: 'Overall',
      periodStart: 1,
      periodEnd: 2,
      budgetUsd: 100,
      spendUsd: 100,
      spendIsLowerBound: false,
      unpricedTurns: 0,
      percentUsed: 100,
    };
    await act(async () => {
      live.controller.enqueue(encoder.encode(`{"t":"paused","pause":${JSON.stringify(pause)}}\n`));
      live.controller.enqueue(encoder.encode(doneEvent('⏸ stopped by the cap')));
      live.controller.close();
    });

    expect(await screen.findByText('⏸ stopped by the cap', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('1 queued')).not.toBeInTheDocument(), { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() =>
      expect(window.localStorage.getItem(inflightKey('aps-queue:req-paused'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(sendBodies).toHaveLength(0);
    expect(screen.getAllByText(/⏸/)).toHaveLength(1);
    expect(screen.getByPlaceholderText('Ask a question...')).not.toBeDisabled();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('aborts the live stream when the chat unmounts', async () => {
    let signal: AbortSignal | undefined;
    const live = controllableStream();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          signal = init?.signal ?? undefined;
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        return jsonResponse([]);
      }),
    );

    const { unmount } = render(
      <ClarifyChat requestId="req-abort" started commands={[]} onError={() => {}} />,
    );
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(() => expect(signal).toBeDefined(), { timeout: ASYNC_TIMEOUT_MS });

    unmount();
    expect(signal?.aborted).toBe(true);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('retries a failed send without duplicating the user message', async () => {
    const sends: string[] = [];
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          const body = JSON.parse(String(init?.body)) as { text: string };
          sends.push(body.text);
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ error: 'internal', message: 'send failed' }, 500);
          }
          return ndjsonResponse([
            '{"t":"text","text":"retried reply"}\n',
            doneEvent('retried reply'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat requestId="req-retry" started commands={[]} onError={() => {}} inlineErrors />,
    );
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.change(composer, { target: { value: 'retry me' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('send failed', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(sends).toEqual(['retry me']);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('retried reply', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(sends).toEqual(['retry me', 'retry me']);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('notifies the wizard after a successful draft update tool result', async () => {
    const changed = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          return ndjsonResponse([
            '{"t":"tool","id":"t1","name":"aps_update_cell_draft","input":"{}"}\n',
            '{"t":"tool_result","id":"t1","text":"ok","isError":false}\n',
            doneEvent('updated'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat
        requestId="req-draft"
        started
        commands={[]}
        onError={() => {}}
        onDraftChanged={changed}
      />,
    );
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.change(composer, { target: { value: 'enable review' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText('updated', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('still notifies the wizard for a legacy harness draft-update tool result', async () => {
    const changed = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          return ndjsonResponse([
            '{"t":"tool","id":"t1","name":"mcp__harness__update_cell_draft","input":"{}"}\n',
            '{"t":"tool_result","id":"t1","text":"ok","isError":false}\n',
            doneEvent('updated'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat
        requestId="req-legacy-draft"
        started
        commands={[]}
        onError={() => {}}
        onDraftChanged={changed}
      />,
    );
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.change(composer, { target: { value: 'enable review' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText('updated', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('does not open a stream when the turn is already finished', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/clarify')) {
        return jsonResponse({
          started: true,
          active: false,
          transcript: [{ role: 'agent', kind: 'text', text: 'saved history', ts: 1 }],
        });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ClarifyChat requestId="req-2" started commands={[]} onError={() => {}} />);

    expect(await screen.findByText('saved history', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.queryByText(WORKING_BANNER)).not.toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith('/clarify/stream'))).toBe(false);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);
});

describe('ClarifyChat queue persistence', () => {
  function stubIdleClarify(sendBodies: unknown[] = []) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return ndjsonResponse(['{"t":"text","text":"sent"}\n', doneEvent('sent')]);
        }
        return jsonResponse([]);
      }),
    );
  }

  it('hydrates and persists the queue under the aps key', async () => {
    stubIdleClarify();
    window.localStorage.setItem('aps-queue:req-store', JSON.stringify(['first', 'second']));

    render(
      <ClarifyChat requestId="req-store" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByText('2 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-store')).toBe(
      JSON.stringify(['first', 'second']),
    );
    expect(window.localStorage.getItem('sbox-queue:req-store')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('migrates a queue from the legacy sbox key and removes it', async () => {
    stubIdleClarify();
    window.localStorage.setItem('sbox-queue:req-legacy', JSON.stringify(['carry me']));

    render(
      <ClarifyChat requestId="req-legacy" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('carry me')).toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-legacy')).toBe(
      JSON.stringify(['carry me']),
    );
    expect(window.localStorage.getItem('sbox-queue:req-legacy')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('prefers the aps key and discards a stale legacy queue', async () => {
    stubIdleClarify();
    window.localStorage.setItem('aps-queue:req-both', JSON.stringify(['new message']));
    window.localStorage.setItem('sbox-queue:req-both', JSON.stringify(['old message']));

    render(
      <ClarifyChat requestId="req-both" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('new message')).toBeInTheDocument();
    expect(screen.queryByText('old message')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('sbox-queue:req-both')).toBeNull();
    expect(window.localStorage.getItem('aps-queue:req-both')).toBe(
      JSON.stringify(['new message']),
    );
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('does not fall back when the aps key is malformed', async () => {
    stubIdleClarify();
    window.localStorage.setItem('aps-queue:req-bad', 'not-json');
    window.localStorage.setItem('sbox-queue:req-bad', JSON.stringify(['legacy message']));

    render(
      <ClarifyChat requestId="req-bad" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByPlaceholderText('Start clarify to chat.', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
    expect(screen.queryByText('legacy message')).not.toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem('aps-queue:req-bad')).toBeNull(), { timeout: ASYNC_TIMEOUT_MS });
    expect(window.localStorage.getItem('sbox-queue:req-bad')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('drains a migrated queue once and does not resurrect it', async () => {
    const sendBodies: unknown[] = [];
    stubIdleClarify(sendBodies);
    window.localStorage.setItem('sbox-queue:req-drain', JSON.stringify(['adopted']));

    const view = render(
      <ClarifyChat requestId="req-drain" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-drain')).toBe(
      JSON.stringify(['adopted']),
    );

    view.rerender(
      <ClarifyChat requestId="req-drain" started commands={[]} onError={() => {}} />,
    );

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[0]).toMatchObject({ text: 'adopted' });
    expect(await screen.findByText('sent', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    view.unmount();

    stubIdleClarify();
    render(
      <ClarifyChat requestId="req-drain" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByPlaceholderText('Start clarify to chat.', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-drain')).toBeNull();
    expect(window.localStorage.getItem('sbox-queue:req-drain')).toBeNull();
    expect(sendBodies).toHaveLength(1);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);
});

describe('ClarifyChat reload during a live turn', () => {
  function liveResponse(live: ReturnType<typeof controllableStream>): Response {
    return new Response(live.stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  }

  it('holds a persisted queue until the reattached turn ends', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify/stream')) return liveResponse(live);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return ndjsonResponse([
            '{"t":"text","text":"queued reply"}\n',
            doneEvent('queued reply'),
          ]);
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem('aps-queue:req-reload', JSON.stringify(['after reload']));

    render(<ClarifyChat requestId="req-reload" started commands={[]} onError={() => {}} />);

    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('1 queued')).toBeInTheDocument();
    expect(sendBodies).toHaveLength(0);

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('first reply')));
      live.controller.close();
    });

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[0]).toMatchObject({ text: 'after reload' });
    expect(await screen.findByText('queued reply', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-reload')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('does not drain before the initial snapshot resolves', async () => {
    const sendBodies: unknown[] = [];
    let resolveClarify!: (response: Response) => void;
    const clarify = new Promise<Response>((resolve) => {
      resolveClarify = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) return clarify;
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return ndjsonResponse(['{"t":"text","text":"sent"}\n', doneEvent('sent')]);
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem('aps-queue:req-slow', JSON.stringify(['slow start']));

    render(<ClarifyChat requestId="req-slow" started commands={[]} onError={() => {}} />);

    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendBodies).toHaveLength(0);

    await act(async () => {
      resolveClarify(jsonResponse({ started: true, active: false, transcript: [] }));
    });

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[0]).toMatchObject({ text: 'slow start' });
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('drains a restored queue one message per turn, in order', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify/stream')) return liveResponse(live);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          const body = JSON.parse(String(init?.body)) as { text: string };
          sendBodies.push(body);
          return ndjsonResponse([
            `{"t":"text","text":"reply to ${body.text}"}\n`,
            doneEvent(`reply to ${body.text}`),
          ]);
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem(
      'aps-queue:req-order',
      JSON.stringify(['first queued', 'second queued']),
    );

    render(<ClarifyChat requestId="req-order" started commands={[]} onError={() => {}} />);

    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('2 queued')).toBeInTheDocument();

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('live reply')));
      live.controller.close();
    });

    await waitFor(() => expect(sendBodies).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies.map((body) => (body as { text: string }).text)).toEqual([
      'first queued',
      'second queued',
    ]);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('keeps a restored queue when hydration fails and drains after retry', async () => {
    const sendBodies: unknown[] = [];
    let clarifyCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          clarifyCalls += 1;
          return clarifyCalls === 1
            ? jsonResponse({ error: 'internal', message: 'snapshot failed' }, 500)
            : jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return ndjsonResponse(['{"t":"text","text":"sent"}\n', doneEvent('sent')]);
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem('aps-queue:req-fail', JSON.stringify(['held']));

    render(
      <ClarifyChat
        requestId="req-fail"
        started
        commands={[]}
        onError={() => {}}
        inlineErrors
      />,
    );

    expect(await screen.findByText('snapshot failed', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(sendBodies).toHaveLength(0);
    expect(screen.getByText('1 queued')).toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-fail')).toBe(JSON.stringify(['held']));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[0]).toMatchObject({ text: 'held' });
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('requeues and reattaches when a send races a live turn', async () => {
    const live = controllableStream();
    const sendBodies: unknown[] = [];
    let clarifyCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify/stream')) return liveResponse(live);
        if (url.endsWith('/clarify')) {
          clarifyCalls += 1;
          return clarifyCalls === 1
            ? jsonResponse({ started: true, active: false, transcript: [] })
            : jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          if (sendBodies.length === 1) {
            return jsonResponse(
              { error: 'turn_active', message: 'A turn is already running.' },
              409,
            );
          }
          return ndjsonResponse([
            '{"t":"text","text":"delivered"}\n',
            doneEvent('delivered'),
          ]);
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem('aps-queue:req-race', JSON.stringify(['race text']));

    render(
      <ClarifyChat requestId="req-race" started commands={[]} onError={() => {}} inlineErrors />,
    );

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem('aps-queue:req-race')).toBe(
        JSON.stringify(['race text']),
      ),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-race'))).toBeNull();

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('live finished')));
      live.controller.close();
    });

    await waitFor(() => expect(sendBodies).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[1]).toMatchObject({ text: 'race text' });
    await waitFor(() =>
      expect(window.localStorage.getItem('aps-queue:req-race')).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('treats a spend-cap 409 as an error instead of requeueing', async () => {
    const sendBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({ error: 'spend_cap', message: 'Spend cap reached' }, 409);
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem('aps-queue:req-cap', JSON.stringify(['too expensive']));

    render(
      <ClarifyChat requestId="req-cap" started commands={[]} onError={() => {}} inlineErrors />,
    );

    expect(await screen.findByText('Spend cap reached', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(sendBodies).toHaveLength(1);
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem('aps-queue:req-cap')).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-cap'))).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);
});

describe('ClarifyChat queue across tabs', () => {
  beforeEach(() => {
    installFakeLocks();
  });

  afterEach(() => {
    uninstallFakeLocks();
  });

  function storageEvent(key: string, queue: string[]): void {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        newValue: JSON.stringify(queue),
        storageArea: window.localStorage,
      }),
    );
  }

  it('delivers a persisted queue item from only one tab', async () => {
    const lives = [controllableStream(), controllableStream()];
    let streamIndex = 0;
    const sendBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          const live = lives[streamIndex];
          streamIndex += 1;
          if (!live) return ndjsonResponse([doneEvent('extra')]);
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem('aps-queue:req-two', JSON.stringify(['hello']));

    render(<ClarifyChat requestId="req-two" started commands={[]} onError={() => {}} />);
    render(<ClarifyChat requestId="req-two" started commands={[]} onError={() => {}} />);

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[0]).toBe('hello');
    await waitFor(() => expect(screen.queryAllByText('1 queued')).toHaveLength(0), { timeout: ASYNC_TIMEOUT_MS });
    expect(window.localStorage.getItem('aps-queue:req-two')).toBeNull();

    await act(async () => {
      lives[0]!.controller.enqueue(encoder.encode(doneEvent('hello')));
      lives[0]!.controller.close();
    });

    await waitFor(() => expect(screen.queryAllByText('1 queued')).toHaveLength(0), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies).toHaveLength(1);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('drains a message appended in another tab once', async () => {
    const lives = [controllableStream(), controllableStream()];
    let streamIndex = 0;
    const sendBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          const live = lives[streamIndex];
          streamIndex += 1;
          return new Response(live!.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([doneEvent('from B')]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-share" started commands={[]} onError={() => {}} />);
    render(<ClarifyChat requestId="req-share" started commands={[]} onError={() => {}} />);
    await waitFor(() => expect(screen.getAllByText(WORKING_BANNER)).toHaveLength(2), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    await enqueueBack('aps-queue:req-share', 'from B');
    storageEvent('aps-queue:req-share', ['from B']);
    await waitFor(() => expect(screen.getAllByText('1 queued')).toHaveLength(2), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    await act(async () => {
      for (const live of lives) {
        live.controller.enqueue(encoder.encode(doneEvent('finished')));
        live.controller.close();
      }
    });

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[0]).toBe('from B');
    await waitFor(() => expect(screen.queryAllByText('1 queued')).toHaveLength(0), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies).toHaveLength(1);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('delivers a 409-requeued message once across tabs', async () => {
    let clarifyCalls = 0;
    let blocked = false;
    let turnEnded = false;
    const lives: Array<ReturnType<typeof controllableStream>> = [];
    const sendBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          clarifyCalls += 1;
          const active = clarifyCalls === 1 || blocked;
          return jsonResponse({ started: true, active, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          const live = controllableStream();
          lives.push(live);
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          if (!turnEnded) {
            blocked = true;
            return jsonResponse(
              { error: 'turn_active', message: 'A turn is already running.' },
              409,
            );
          }
          return ndjsonResponse([doneEvent('retry me')]);
        }
        return jsonResponse([]);
      }),
    );

    // Tab A is attached to the live turn; tab B is idle and races a send.
    render(<ClarifyChat requestId="req-race-two" started commands={[]} onError={() => {}} />);
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    render(<ClarifyChat requestId="req-race-two" started commands={[]} onError={() => {}} />);
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, { timeout: ASYNC_TIMEOUT_MS });
    fireEvent.change(composer, { target: { value: 'retry me' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(sendBodies).toHaveLength(1), { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() =>
      expect(window.localStorage.getItem('aps-queue:req-race-two')).toBe(
        JSON.stringify(['retry me']),
      ),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    // Tab A sees the requeue through the storage event while its turn still runs.
    storageEvent('aps-queue:req-race-two', ['retry me']);
    await waitFor(() => expect(screen.queryAllByText('1 queued')).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() => expect(lives).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });

    turnEnded = true;
    await act(async () => {
      for (const live of lives) {
        live.controller.enqueue(encoder.encode(doneEvent('finished')));
        live.controller.close();
      }
    });

    await waitFor(() => expect(sendBodies).toHaveLength(2), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies[1]).toBe('retry me');
    await waitFor(() => expect(screen.queryAllByText('1 queued')).toHaveLength(0), { timeout: ASYNC_TIMEOUT_MS });
    expect(sendBodies).toHaveLength(2);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('mirrors another tab queue write into the banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ started: true, active: false, transcript: [] })),
    );

    render(<ClarifyChat requestId="req-mirror" started={false} commands={[]} onError={() => {}} />);
    await screen.findByPlaceholderText('Start clarify to chat.', undefined, { timeout: ASYNC_TIMEOUT_MS });

    window.localStorage.setItem('aps-queue:req-mirror', JSON.stringify(['from another tab']));
    storageEvent('aps-queue:req-mirror', ['from another tab']);

    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(screen.getByText('from another tab')).toBeInTheDocument();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);
});

describe('ClarifyChat crash-safe queue claims', () => {
  it('recovers a claimed item when the tab closes before the send is accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          // Hold the POST open so the claim is written but never accepted.
          return new Promise<Response>(() => {});
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem('aps-queue:req-crash', JSON.stringify(['lost message']));

    const first = render(
      <ClarifyChat requestId="req-crash" started commands={[]} onError={() => {}} />,
    );

    await waitFor(() =>
      expect(window.localStorage.getItem(inflightKey('aps-queue:req-crash'))).not.toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(window.localStorage.getItem('aps-queue:req-crash')).toBeNull();
    first.unmount();

    const sendBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([
            '{"t":"text","text":"recovered reply"}\n',
            doneEvent('recovered reply'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-crash" started commands={[]} onError={() => {}} />);

    await waitFor(() => expect(sendBodies).toEqual(['lost message']), { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText('recovered reply', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-crash'))).toBeNull();
    expect(window.localStorage.getItem('aps-queue:req-crash')).toBeNull();
    expect(screen.queryByText(/queued/)).not.toBeInTheDocument();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('does not resend a claim the transcript already proves delivered', async () => {
    const sendBodies: string[] = [];
    const now = Date.now();
    seedClaim('req-delivered', 'already sent', now);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({
            started: true,
            active: false,
            transcript: [{ role: 'you', kind: 'text', text: 'already sent', ts: now + 1 }],
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([doneEvent('unexpected')]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-delivered" started commands={[]} onError={() => {}} />);

    expect(await screen.findByText('already sent', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem(inflightKey('aps-queue:req-delivered'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendBodies).toHaveLength(0);
    expect(window.localStorage.getItem('aps-queue:req-delivered')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('defers a claim until a live turn ends and drops it when done proves delivery', async () => {
    const live = controllableStream();
    const sendBodies: string[] = [];
    const now = Date.now();
    seedClaim('req-live-claim', 'in flight', now);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([doneEvent('unexpected')]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-live-claim" started commands={[]} onError={() => {}} />);
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-live-claim'))).not.toBeNull();
    expect(sendBodies).toHaveLength(0);

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneWithUser('in flight', now + 1)));
      live.controller.close();
    });

    await waitFor(() =>
      expect(window.localStorage.getItem(inflightKey('aps-queue:req-live-claim'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(sendBodies).toHaveLength(0);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('requeues an unproven claim after a live turn ends and sends it once', async () => {
    const live = controllableStream();
    const sendBodies: string[] = [];
    const now = Date.now();
    seedClaim('req-live-miss', 'retry after live', now);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([
            '{"t":"text","text":"recovered after live"}\n',
            doneEvent('recovered after live'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-live-miss" started commands={[]} onError={() => {}} />);
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('live finished')));
      live.controller.close();
    });

    await waitFor(() => expect(sendBodies).toEqual(['retry after live']), { timeout: ASYNC_TIMEOUT_MS });
    expect(await screen.findByText('recovered after live', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-live-miss'))).toBeNull();
    expect(window.localStorage.getItem('aps-queue:req-live-miss')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('clears a claim when a send completes without any NDJSON events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) return ndjsonResponse([]);
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem('aps-queue:req-silent', JSON.stringify(['silent send']));

    render(<ClarifyChat requestId="req-silent" started commands={[]} onError={() => {}} />);

    await waitFor(() =>
      expect(window.localStorage.getItem(inflightKey('aps-queue:req-silent'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(window.localStorage.getItem('aps-queue:req-silent')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('keeps a claim across a retryable send failure and clears it on retry', async () => {
    let attempts = 0;
    const sends: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          const body = JSON.parse(String(init?.body)) as { text: string };
          sends.push(body.text);
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ error: 'internal', message: 'send failed' }, 500);
          }
          return ndjsonResponse(['{"t":"text","text":"recovered"}\n', doneEvent('recovered')]);
        }
        return jsonResponse([]);
      }),
    );
    window.localStorage.setItem(
      'aps-queue:req-retry-claim',
      JSON.stringify(['retry claimed']),
    );

    render(
      <ClarifyChat
        requestId="req-retry-claim"
        started
        commands={[]}
        onError={() => {}}
        inlineErrors
      />,
    );

    expect(await screen.findByText('send failed', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(sends).toEqual(['retry claimed']);
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-retry-claim'))).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('recovered', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(sends).toEqual(['retry claimed', 'retry claimed']);
    await waitFor(() =>
      expect(window.localStorage.getItem(inflightKey('aps-queue:req-retry-claim'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('clears an in-flight marker when the user clears the queue', async () => {
    const live = controllableStream();
    seedClaim('req-clear-marker', 'in flight', Date.now());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat requestId="req-clear-marker" started commands={[]} onError={() => {}} />,
    );
    expect(await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'queued behind the claim' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText('1 queued', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() =>
      expect(window.localStorage.getItem('aps-queue:req-clear-marker')).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-clear-marker'))).toBeNull();
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);
});

describe('ClarifyChat crash-safe direct sends', () => {
  it('recovers a direct send when the tab closes before the send is accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          // Hold the POST open so the claim is written but never accepted.
          return new Promise<Response>(() => {});
        }
        return jsonResponse([]);
      }),
    );

    const first = render(
      <ClarifyChat requestId="req-direct-crash" started commands={[]} onError={() => {}} />,
    );
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    fireEvent.change(composer, { target: { value: 'lost direct message' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => {
      const raw = window.localStorage.getItem(inflightKey('aps-queue:req-direct-crash'));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual([
        expect.objectContaining({ text: 'lost direct message', kind: 'direct' }),
      ]);
    });
    expect(window.localStorage.getItem('aps-queue:req-direct-crash')).toBeNull();
    first.unmount();

    const sendBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([
            '{"t":"text","text":"recovered direct reply"}\n',
            doneEvent('recovered direct reply'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-direct-crash" started commands={[]} onError={() => {}} />);

    await waitFor(() => expect(sendBodies).toEqual(['lost direct message']), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(
      await screen.findByText('recovered direct reply', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-crash'))).toBeNull();
    expect(window.localStorage.getItem('aps-queue:req-direct-crash')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('does not resend a direct send the transcript already proves delivered', async () => {
    const now = Date.now();
    seedDirectClaim('req-direct-delivered', 'already sent directly', now);
    const sendBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({
            started: true,
            active: false,
            transcript: [{ role: 'you', kind: 'text', text: 'already sent directly', ts: now + 5 }],
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([doneEvent('unexpected')]);
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat requestId="req-direct-delivered" started commands={[]} onError={() => {}} />,
    );

    await waitFor(
      () =>
        expect(
          window.localStorage.getItem(inflightKey('aps-queue:req-direct-delivered')),
        ).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(sendBodies).toEqual([]);
    expect(window.localStorage.getItem('aps-queue:req-direct-delivered')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('defers a direct send until a live turn ends and drops it when done proves delivery', async () => {
    const live = controllableStream();
    const now = Date.now();
    const sendBodies: string[] = [];
    seedDirectClaim('req-direct-live', 'sent before the crash', now);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([doneEvent('unexpected')]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-direct-live" started commands={[]} onError={() => {}} />);
    expect(
      await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem(inflightKey('aps-queue:req-direct-live')),
    ).not.toBeNull();
    expect(sendBodies).toEqual([]);

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneWithUser('sent before the crash', now + 5)));
      live.controller.close();
    });

    await waitFor(
      () => expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-live'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(sendBodies).toEqual([]);
    expect(window.localStorage.getItem('aps-queue:req-direct-live')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('requeues a direct send the live turn did not deliver and sends it once', async () => {
    const live = controllableStream();
    const now = Date.now();
    const sendBodies: string[] = [];
    seedDirectClaim('req-direct-live-miss', 'retry after live', now);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([
            '{"t":"text","text":"recovered after live"}\n',
            doneEvent('recovered after live'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat requestId="req-direct-live-miss" started commands={[]} onError={() => {}} />,
    );
    expect(
      await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('live finished')));
      live.controller.close();
    });

    await waitFor(() => expect(sendBodies).toEqual(['retry after live']), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(
      await screen.findByText('recovered after live', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem(inflightKey('aps-queue:req-direct-live-miss')),
    ).toBeNull();
    expect(window.localStorage.getItem('aps-queue:req-direct-live-miss')).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('keeps a direct-send marker across a retryable failure and reuses it on retry', async () => {
    let attempts = 0;
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const sends: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          const body = JSON.parse(String(init?.body)) as { text: string };
          sends.push(body.text);
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ error: 'internal', message: 'send failed' }, 500);
          }
          return held;
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat
        requestId="req-direct-retry"
        started
        commands={[]}
        onError={() => {}}
        inlineErrors
      />,
    );
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    fireEvent.change(composer, { target: { value: 'direct retry' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(
      await screen.findByText('send failed', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(sends).toEqual(['direct retry']);
    const before = window.localStorage.getItem(inflightKey('aps-queue:req-direct-retry'));
    expect(JSON.parse(before!)).toEqual([
      expect.objectContaining({ text: 'direct retry', kind: 'direct' }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sends).toEqual(['direct retry', 'direct retry']), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    // A retry with an owned claim reuses its marker instead of adding a second one.
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-retry'))).toBe(before);

    await act(async () => {
      release(
        ndjsonResponse(['{"t":"text","text":"retried direct"}\n', doneEvent('retried direct')]),
      );
    });
    expect(
      await screen.findByText('retried direct', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-retry'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('clears a rejected direct send and journals a fresh marker when retried', async () => {
    let attempts = 0;
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ error: 'spend_cap', message: 'Spend cap reached' }, 409);
          }
          return held;
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat
        requestId="req-direct-rejected"
        started
        commands={[]}
        onError={() => {}}
        inlineErrors
      />,
    );
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    fireEvent.change(composer, { target: { value: 'too expensive' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(
      await screen.findByText('Spend cap reached', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-rejected'))).toBeNull();
    expect(window.localStorage.getItem('aps-queue:req-direct-rejected')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      const raw = window.localStorage.getItem(inflightKey('aps-queue:req-direct-rejected'));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual([
        expect.objectContaining({ text: 'too expensive', kind: 'direct' }),
      ]);
    });

    await act(async () => {
      release(ndjsonResponse(['{"t":"text","text":"paid"}\n', doneEvent('paid')]));
    });
    expect(await screen.findByText('paid', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    await waitFor(
      () =>
        expect(
          window.localStorage.getItem(inflightKey('aps-queue:req-direct-rejected')),
        ).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('requeues a direct send that races a live turn and drains it once', async () => {
    const live = controllableStream();
    const sends: string[] = [];
    let clarifyCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify/stream')) {
          return new Response(live.stream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        if (url.endsWith('/clarify')) {
          clarifyCalls += 1;
          return clarifyCalls === 1
            ? jsonResponse({ started: true, active: false, transcript: [] })
            : jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/send')) {
          sends.push((JSON.parse(String(init?.body)) as { text: string }).text);
          if (sends.length === 1) {
            return jsonResponse(
              { error: 'turn_active', message: 'A turn is already running.' },
              409,
            );
          }
          return ndjsonResponse([
            '{"t":"text","text":"direct delivered"}\n',
            doneEvent('direct delivered'),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    render(
      <ClarifyChat requestId="req-direct-race" started commands={[]} onError={() => {}} inlineErrors />,
    );
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    fireEvent.change(composer, { target: { value: 'race direct' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(
      await screen.findByText(WORKING_BANNER, undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(window.localStorage.getItem('aps-queue:req-direct-race')).toBe(
          JSON.stringify(['race direct']),
        ),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-race'))).toBeNull();

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('live finished')));
      live.controller.close();
    });

    await waitFor(() => expect(sends).toEqual(['race direct', 'race direct']), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(
      await screen.findByText('direct delivered', undefined, { timeout: ASYNC_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-direct-race')).toBeNull();
    expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-race'))).toBeNull();
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);

  it('clears a direct-send marker when the user stops the turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: false, transcript: [] });
        }
        if (url.endsWith('/clarify/stop')) {
          return jsonResponse({ stopped: true });
        }
        if (url.endsWith('/clarify/send')) {
          return new Promise<Response>(() => {});
        }
        return jsonResponse([]);
      }),
    );

    const first = render(
      <ClarifyChat requestId="req-direct-stop" started commands={[]} onError={() => {}} />,
    );
    const composer = await screen.findByPlaceholderText('Ask a question...', undefined, {
      timeout: ASYNC_TIMEOUT_MS,
    });
    fireEvent.change(composer, { target: { value: 'discard me' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(
      () => expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-stop'))).not.toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(
      () =>
        expect(window.localStorage.getItem(inflightKey('aps-queue:req-direct-stop'))).toBeNull(),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(window.localStorage.getItem('aps-queue:req-direct-stop')).toBeNull();
    first.unmount();

    const sendBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({
            started: true,
            active: false,
            transcript: [{ role: 'agent', kind: 'text', text: 'hydrated', ts: 1 }],
          });
        }
        if (url.endsWith('/clarify/send')) {
          sendBodies.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return ndjsonResponse([doneEvent('unexpected')]);
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-direct-stop" started commands={[]} onError={() => {}} />);
    expect(await screen.findByText('hydrated', undefined, { timeout: ASYNC_TIMEOUT_MS })).toBeInTheDocument();
    expect(sendBodies).toEqual([]);
  }, CLARIFY_CHAT_TEST_TIMEOUT_MS);
});

