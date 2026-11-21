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
