import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClarifyChat } from './ClarifyChat';
import { jsonResponse, ndjsonResponse } from './test/fixtures';

const encoder = new TextEncoder();

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

    expect(await screen.findByText('Agent is working…')).toBeInTheDocument();
    const composer = screen.getByPlaceholderText('Queue a message…');
    expect(composer).not.toBeDisabled();

    await act(async () => {
      live.controller.enqueue(encoder.encode('{"t":"text","text":"streamed "}\n'));
      live.controller.enqueue(encoder.encode('{"t":"text","text":"live"}\n'));
      live.controller.enqueue(encoder.encode(doneEvent('streamed live')));
      live.controller.close();
    });

    expect(await screen.findByText('streamed live')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Ask a question...')).not.toBeDisabled(),
    );
    expect(screen.queryByText('Agent is working…')).not.toBeInTheDocument();
  });

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
    expect(await screen.findByText('Agent is working…')).toBeInTheDocument();

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'queued next' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('1 queued')).toBeInTheDocument();
    expect(sendBodies).toHaveLength(0);

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('first reply')));
      live.controller.close();
    });

    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toMatchObject({ text: 'queued next' });
    expect(await screen.findByText('second reply')).toBeInTheDocument();
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
  });

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
    expect(await screen.findByText('Agent is working…')).toBeInTheDocument();

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'do not send' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText('1 queued')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopped).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('do not send')).not.toBeInTheDocument());

    await act(async () => {
      live.controller.enqueue(encoder.encode(doneEvent('partial reply')));
      live.controller.close();
    });

    expect(await screen.findByText('Stopped. You can interject.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask a question...')).not.toBeDisabled();
    expect(sendBodies).toHaveLength(0);
  });

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
    expect(await screen.findByText('Agent is working…')).toBeInTheDocument();

    const composer = screen.getByPlaceholderText('Queue a message…');
    fireEvent.change(composer, { target: { value: 'queued behind the cap' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByText('1 queued')).toBeInTheDocument();

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

    expect(await screen.findByText('⏸ stopped by the cap')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('1 queued')).not.toBeInTheDocument());
    expect(sendBodies).toHaveLength(0);
    expect(screen.getAllByText(/⏸/)).toHaveLength(1);
    expect(screen.getByPlaceholderText('Ask a question...')).not.toBeDisabled();
  });

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
    expect(await screen.findByText('Agent is working…')).toBeInTheDocument();
    await waitFor(() => expect(signal).toBeDefined());

    unmount();
    expect(signal?.aborted).toBe(true);
  });

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
    const composer = await screen.findByPlaceholderText('Ask a question...');
    fireEvent.change(composer, { target: { value: 'retry me' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('send failed')).toBeInTheDocument();
    expect(sends).toEqual(['retry me']);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('retried reply')).toBeInTheDocument();
    expect(sends).toEqual(['retry me', 'retry me']);
  });

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
    const composer = await screen.findByPlaceholderText('Ask a question...');
    fireEvent.change(composer, { target: { value: 'enable review' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('updated')).toBeInTheDocument();
  });

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
    const composer = await screen.findByPlaceholderText('Ask a question...');
    fireEvent.change(composer, { target: { value: 'enable review' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('updated')).toBeInTheDocument();
  });

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

    expect(await screen.findByText('saved history')).toBeInTheDocument();
    expect(screen.queryByText('Agent is working…')).not.toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith('/clarify/stream'))).toBe(false);
  });
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

    expect(await screen.findByText('2 queued')).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-store')).toBe(
      JSON.stringify(['first', 'second']),
    );
    expect(window.localStorage.getItem('sbox-queue:req-store')).toBeNull();
  });

  it('migrates a queue from the legacy sbox key and removes it', async () => {
    stubIdleClarify();
    window.localStorage.setItem('sbox-queue:req-legacy', JSON.stringify(['carry me']));

    render(
      <ClarifyChat requestId="req-legacy" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByText('1 queued')).toBeInTheDocument();
    expect(screen.getByText('carry me')).toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-legacy')).toBe(
      JSON.stringify(['carry me']),
    );
    expect(window.localStorage.getItem('sbox-queue:req-legacy')).toBeNull();
  });

  it('prefers the aps key and discards a stale legacy queue', async () => {
    stubIdleClarify();
    window.localStorage.setItem('aps-queue:req-both', JSON.stringify(['new message']));
    window.localStorage.setItem('sbox-queue:req-both', JSON.stringify(['old message']));

    render(
      <ClarifyChat requestId="req-both" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByText('1 queued')).toBeInTheDocument();
    expect(screen.getByText('new message')).toBeInTheDocument();
    expect(screen.queryByText('old message')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('sbox-queue:req-both')).toBeNull();
    expect(window.localStorage.getItem('aps-queue:req-both')).toBe(
      JSON.stringify(['new message']),
    );
  });

  it('does not fall back when the aps key is malformed', async () => {
    stubIdleClarify();
    window.localStorage.setItem('aps-queue:req-bad', 'not-json');
    window.localStorage.setItem('sbox-queue:req-bad', JSON.stringify(['legacy message']));

    render(
      <ClarifyChat requestId="req-bad" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByPlaceholderText('Start clarify to chat.')).toBeInTheDocument();
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
    expect(screen.queryByText('legacy message')).not.toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem('aps-queue:req-bad')).toBeNull());
    expect(window.localStorage.getItem('sbox-queue:req-bad')).toBeNull();
  });

  it('drains a migrated queue once and does not resurrect it', async () => {
    const sendBodies: unknown[] = [];
    stubIdleClarify(sendBodies);
    window.localStorage.setItem('sbox-queue:req-drain', JSON.stringify(['adopted']));

    const view = render(
      <ClarifyChat requestId="req-drain" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByText('1 queued')).toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-drain')).toBe(
      JSON.stringify(['adopted']),
    );

    view.rerender(
      <ClarifyChat requestId="req-drain" started commands={[]} onError={() => {}} />,
    );

    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toMatchObject({ text: 'adopted' });
    expect(await screen.findByText('sent')).toBeInTheDocument();
    view.unmount();

    stubIdleClarify();
    render(
      <ClarifyChat requestId="req-drain" started={false} commands={[]} onError={() => {}} />,
    );

    expect(await screen.findByPlaceholderText('Start clarify to chat.')).toBeInTheDocument();
    expect(screen.queryByText('1 queued')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('aps-queue:req-drain')).toBeNull();
    expect(window.localStorage.getItem('sbox-queue:req-drain')).toBeNull();
    expect(sendBodies).toHaveLength(1);
  });
});
