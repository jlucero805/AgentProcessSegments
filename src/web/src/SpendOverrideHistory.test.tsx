import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpendOverrideHistory } from './SpendOverrideHistory';
import { jsonResponse } from './test/fixtures';
import type {
  SpendCapOverrideHistoryItem,
  SpendCapOverrideHistoryResponse,
} from './types';

const periodStart = Date.UTC(2026, 10, 1);
const createdAt = Date.UTC(2026, 10, 15, 12);
const extendedAt = Date.UTC(2026, 10, 15, 12, 30);
const expiresAt = Date.UTC(2026, 10, 15, 13);
const revokedAt = Date.UTC(2026, 10, 15, 12, 45);

function item(
  overrides: Partial<SpendCapOverrideHistoryItem> = {},
): SpendCapOverrideHistoryItem {
  return {
    id: 'o1',
    scope: 'overall',
    cellId: null,
    cellName: null,
    periodStart,
    createdAt,
    updatedAt: extendedAt,
    expiresAt,
    note: 'release review',
    revokedAt: null,
    state: 'active',
    extensionCount: 2,
    lastExtendedAt: extendedAt,
    ...overrides,
  };
}

function response(
  overrides: SpendCapOverrideHistoryItem[] = [item()],
  total = overrides.length,
): SpendCapOverrideHistoryResponse {
  return { overrides, total, limit: 10, offset: 0 };
}

function install(handler: (url: URL) => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const raw = String(input);
      urls.push(raw);
      return handler(new URL(raw, 'http://localhost'));
    }),
  );
  return urls;
}

function renderHistory(
  props: Partial<{
    refreshToken: number;
    onError: (message: string) => void;
  }> = {},
) {
  return render(
    <SpendOverrideHistory
      cells={[{ id: 'c1', name: 'Alpha' }]}
      onError={props.onError ?? (() => {})}
      refreshToken={props.refreshToken ?? 0}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SpendOverrideHistory', () => {
  it('renders active, revoked, and expired rows with lifecycle detail', async () => {
    const revoked = item({
      id: 'o2',
      scope: 'cell',
      cellId: 'c1',
      cellName: 'Alpha',
      note: 'ended early',
      state: 'revoked',
      revokedAt,
      extensionCount: 0,
      lastExtendedAt: null,
    });
    const expired = item({
      id: 'o3',
      scope: 'cell',
      cellId: 'deleted',
      cellName: 'Deleted cell',
      note: null,
      state: 'expired',
      extensionCount: 1,
      lastExtendedAt: extendedAt,
    });
    install(() => jsonResponse(response([item(), revoked, expired], 3)));
    renderHistory();

    const table = await screen.findByRole('table', { name: 'Spend cap override history' });
    expect(within(table).getByText('Overall spend')).toBeInTheDocument();
    expect(within(table).getByText('Alpha')).toBeInTheDocument();
    expect(within(table).getByText('Deleted cell')).toBeInTheDocument();
    expect(within(table).getByText('release review')).toBeInTheDocument();
    expect(within(table).getByText('ended early')).toBeInTheDocument();
    expect(within(table).getByText(/×2/)).toBeInTheDocument();
    expect(within(table).getByText(/×1/)).toBeInTheDocument();
    expect(within(table).getByText('active')).toBeInTheDocument();
    expect(within(table).getByText('revoked')).toBeInTheDocument();
    expect(within(table).getByText('expired')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–3 of 3')).toBeInTheDocument();
    expect(screen.getAllByTitle(new Date(createdAt).toISOString()).length).toBeGreaterThan(0);
    expect(screen.getByTitle(new Date(revokedAt).toISOString())).toBeInTheDocument();
  });

  it('filters by scope and state from page zero', async () => {
    const urls = install(() => jsonResponse(response()));
    renderHistory();
    await screen.findByRole('table', { name: 'Spend cap override history' });

    fireEvent.change(screen.getByLabelText('Override scope filter'), {
      target: { value: 'c1' },
    });
    await waitFor(() => {
      const last = new URL(urls[urls.length - 1]!, 'http://localhost');
      expect(last.searchParams.get('scope')).toBe('cell');
      expect(last.searchParams.get('cellId')).toBe('c1');
      expect(last.searchParams.get('offset')).toBe('0');
    });

    fireEvent.change(screen.getByLabelText('Override state filter'), {
      target: { value: 'revoked' },
    });
    await waitFor(() => {
      const last = new URL(urls[urls.length - 1]!, 'http://localhost');
      expect(last.searchParams.get('state')).toBe('revoked');
      expect(last.searchParams.get('offset')).toBe('0');
    });
  });

  it('pages with the server total and refreshes on demand', async () => {
    const urls = install(() => jsonResponse(response([item()], 23)));
    renderHistory();
    await screen.findByRole('table', { name: 'Spend cap override history' });

    const older = screen.getByRole('button', { name: 'Older override history' });
    expect(older).not.toBeDisabled();
    fireEvent.click(older);
    await waitFor(() => {
      const last = new URL(urls[urls.length - 1]!, 'http://localhost');
      expect(last.searchParams.get('limit')).toBe('10');
      expect(last.searchParams.get('offset')).toBe('10');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Newer override history' }));
    await waitFor(() => {
      const last = new URL(urls[urls.length - 1]!, 'http://localhost');
      expect(last.searchParams.get('offset')).toBe('0');
    });

    const beforeRefresh = urls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh override history' }));
    await waitFor(() => expect(urls.length).toBeGreaterThan(beforeRefresh));
  });

  it('refetches page zero when the refresh token changes', async () => {
    const urls = install(() => jsonResponse(response([item()], 23)));
    const { rerender } = renderHistory();
    await screen.findByRole('table', { name: 'Spend cap override history' });
    fireEvent.click(screen.getByRole('button', { name: 'Older override history' }));
    await waitFor(() => {
      const last = new URL(urls[urls.length - 1]!, 'http://localhost');
      expect(last.searchParams.get('offset')).toBe('10');
    });

    rerender(
      <SpendOverrideHistory
        cells={[{ id: 'c1', name: 'Alpha' }]}
        onError={() => {}}
        refreshToken={1}
      />,
    );
    await waitFor(() => {
      const last = new URL(urls[urls.length - 1]!, 'http://localhost');
      expect(last.searchParams.get('offset')).toBe('0');
    });
  });

  it('keeps the previous rows and reports a failed refresh', async () => {
    let fail = false;
    const urls = install(() =>
      fail
        ? jsonResponse({ error: 'boom', message: 'history unavailable' }, 500)
        : jsonResponse(response()),
    );
    const onError = vi.fn();
    renderHistory({ onError });
    await screen.findByText('release review');

    fail = true;
    const before = urls.length;
    fireEvent.change(screen.getByLabelText('Override state filter'), {
      target: { value: 'expired' },
    });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('history unavailable'));
    expect(urls.length).toBeGreaterThan(before);
    expect(screen.getByText('release review')).toBeInTheDocument();
  });

  it('shows an empty state and a filtered empty state', async () => {
    install(() => jsonResponse({ overrides: [], total: 0, limit: 10, offset: 0 }));
    renderHistory();
    expect(await screen.findByText('No override history yet.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Override state filter'), {
      target: { value: 'active' },
    });
    expect(await screen.findByText('No overrides match these filters.')).toBeInTheDocument();
  });
});
