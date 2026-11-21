import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClarifyChat } from './ClarifyChat';
import { jsonResponse } from './test/fixtures';

const encoder = new TextEncoder();

describe('ClarifyChat reattach', () => {
  it('shows the live turn, streams text, and re-enables the composer', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const liveStream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/clarify')) {
          return jsonResponse({ started: true, active: true, transcript: [] });
        }
        if (url.endsWith('/clarify/stream')) {
          return new Response(liveStream, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          });
        }
        return jsonResponse([]);
      }),
    );

    render(<ClarifyChat requestId="req-1" started commands={[]} onError={() => {}} />);

    expect(await screen.findByText('Agent is working…')).toBeInTheDocument();
    const composer = screen.getByPlaceholderText('Ask a question...');
    expect(composer).toBeDisabled();

    await act(async () => {
      controller.enqueue(encoder.encode('{"t":"text","text":"streamed "}\n'));
      controller.enqueue(encoder.encode('{"t":"text","text":"live"}\n'));
      controller.enqueue(
        encoder.encode(
          '{"t":"done","request":null,"transcript":[{"role":"agent","kind":"text","text":"streamed live","ts":1}]}\n',
        ),
      );
      controller.close();
    });

    expect(await screen.findByText('streamed live')).toBeInTheDocument();
    await waitFor(() => expect(composer).not.toBeDisabled());
    expect(screen.queryByText('Agent is working…')).not.toBeInTheDocument();
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
