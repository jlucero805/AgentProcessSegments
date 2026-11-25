import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreateModal } from './CreateModal';
import { jsonResponse } from './test/fixtures';

describe('CreateModal', () => {
  it('creates a request and hands back its id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'new-1', title: 'Ship it' }, 201)));
    const onCreated = vi.fn();
    const onError = vi.fn();

    render(
      <CreateModal
        open
        onClose={() => {}}
        cellId="c1"
        onCreated={onCreated}
        onError={onError}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'Ship it' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create request' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
    expect(onError).not.toHaveBeenCalled();
  });

  it('starts with an empty form after it is closed and reopened', () => {
    const { rerender } = render(
      <CreateModal open onClose={() => {}} cellId={null} onCreated={() => {}} onError={() => {}} />,
    );

    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), {
      target: { value: 'Draft title' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/repo or git URL'), {
      target: { value: '/tmp/draft' },
    });

    rerender(
      <CreateModal
        open={false}
        onClose={() => {}}
        cellId={null}
        onCreated={() => {}}
        onError={() => {}}
      />,
    );
    expect(screen.queryByPlaceholderText('What should the agent do?')).toBeNull();

    rerender(
      <CreateModal open onClose={() => {}} cellId={null} onCreated={() => {}} onError={() => {}} />,
    );
    expect(screen.getByPlaceholderText('What should the agent do?')).toHaveValue('');
    expect(screen.getByPlaceholderText('/path/to/repo or git URL')).toHaveValue('');
  });

  it('refuses an empty title without calling the API', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    render(
      <CreateModal open onClose={() => {}} cellId={null} onCreated={() => {}} onError={onError} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create request' }));
    expect(onError).toHaveBeenCalledWith('A title is required.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
