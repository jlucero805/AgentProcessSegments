import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

describe('Composer', () => {
  it('sends on Enter and clears the input', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} commands={[]} />);

    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: 'hello there' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('hello there');
    expect(input).toHaveValue('');
  });

  it('keeps a newline on Shift+Enter', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} commands={[]} />);

    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: 'line' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('autocompletes slash commands with Tab', () => {
    render(
      <Composer
        onSend={() => {}}
        commands={[
          { command: 'review', description: 'Review the diff', plugin: 'harness' },
          { command: 'release', description: 'Cut a release', plugin: 'harness' },
        ]}
      />,
    );

    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: '/rel' } });

    expect(screen.getByText('/release')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/release');
  });

  it('does not double the slash when the API already includes one', () => {
    render(
      <Composer
        onSend={() => {}}
        commands={[
          { command: '/demo-kit:hello', description: 'Say hello', plugin: 'demo-kit' },
        ]}
      />,
    );

    const input = screen.getByPlaceholderText('Ask a question...');
    fireEvent.change(input, { target: { value: '/hel' } });

    expect(screen.getByText('/demo-kit:hello')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/demo-kit:hello');
  });

  it('is disabled when the chat has not started', () => {
    render(
      <Composer
        onSend={() => {}}
        commands={[]}
        disabled
        placeholder="Start clarify to chat."
      />,
    );
    expect(screen.getByPlaceholderText('Start clarify to chat.')).toBeDisabled();
  });
});
