import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigPage } from './ConfigPage';
import { jsonResponse } from './test/fixtures';
import type { MasterConfig } from './types';

const master: MasterConfig = {
  enabled: true,
  intervalMinutes: 5,
  idleMinutes: 10,
  autoReview: true,
  includeUnassigned: true,
  prompt: 'prod prompt',
};

describe('ConfigPage', () => {
  it('loads settings, saves a patch, and shows the path', async () => {
    const captured: { body: { master?: Partial<MasterConfig> } | null } = { body: null };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        captured.body = JSON.parse(String(init.body)) as { master: Partial<MasterConfig> };
        return jsonResponse({
          master: { ...master, ...captured.body?.master },
          path: '/tmp/sandbox-harness/config.json',
        });
      }
      return jsonResponse({ master, path: '/tmp/sandbox-harness/config.json' });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfigPage onError={() => {}} />);

    const interval = await screen.findByRole('spinbutton', { name: /interval/i });
    expect(interval).toHaveValue(5);
    expect(screen.getByText('/tmp/sandbox-harness/config.json')).toBeInTheDocument();

    fireEvent.change(interval, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body?.master).toMatchObject({ intervalMinutes: 8, idleMinutes: 10 });
  });

  it('toggles the master switch', async () => {
    const captured: { body: { master?: Partial<MasterConfig> } | null } = { body: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          captured.body = JSON.parse(String(init.body)) as { master: Partial<MasterConfig> };
          return jsonResponse({
            master: { ...master, ...captured.body?.master },
            path: '/tmp/config.json',
          });
        }
        return jsonResponse({ master, path: '/tmp/config.json' });
      }),
    );

    render(<ConfigPage onError={() => {}} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Master enabled' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body?.master).toMatchObject({ enabled: false });
  });
});
