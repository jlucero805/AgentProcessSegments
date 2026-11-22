import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from './UsagePage';
import { jsonResponse, makeUsageResponse } from './test/fixtures';

const CELLS = [
  {
    id: 'cell-1',
    name: 'Alpha',
    masterEnabled: true,
    masterIntervalMinutes: null,
    maxConcurrent: 3,
    model: null,
    effort: null,
    createdAt: 1,
  },
];

function installFetch(response = makeUsageResponse()) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/cells') return jsonResponse(CELLS);
    if (url.startsWith('/api/usage')) return jsonResponse(response);
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UsagePage', () => {
  it('renders totals, a lower-bound cost, and all breakdown tables', async () => {
    installFetch();
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findByText('Known cost')).toBeInTheDocument();
    expect(screen.getAllByText('≥ $0.0120 · 1 unpriced').length).toBeGreaterThan(0);
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getByText('By model')).toBeInTheDocument();
    expect(screen.getByText('Model A')).toBeInTheDocument();
    expect(screen.getByText('Model B')).toBeInTheDocument();
    expect(screen.getByText('By cell')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getByText('Top requests')).toBeInTheDocument();
    expect(screen.getByText('A request')).toBeInTheDocument();
  });

  it('shows unknown instead of zero when no turn is priced', async () => {
    const base = makeUsageResponse();
    installFetch({
      ...base,
      totals: { ...base.totals, costUsd: null, unknownCostTurns: 2 },
      byModel: [],
    });
    render(<UsagePage onError={vi.fn()} />);

    expect(await screen.findAllByText('unknown')).not.toHaveLength(0);
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('refetches with hour buckets when the range changes', async () => {
    const fetchMock = installFetch();
    render(<UsagePage onError={vi.fn()} />);
    await screen.findByText('Known cost');

    fireEvent.click(screen.getByText('24h'));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('/api/usage?') && url.includes('bucket=hour'))).toBe(
        true,
      );
      const hourly = urls.find(
        (url) => url.includes('/api/usage?') && url.includes('bucket=hour'),
      ) ?? '';
      expect(hourly).toContain('from=');
      expect(hourly).toContain('to=');
    });
  });

  it('refetches with the selected cell', async () => {
    const fetchMock = installFetch();
    render(<UsagePage onError={vi.fn()} />);
    await screen.findByText('Known cost');

    fireEvent.change(screen.getByLabelText('Filter usage by cell'), {
      target: { value: 'cell-1' },
    });

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes('cellId=cell-1'))).toBe(true);
    });
  });
});
