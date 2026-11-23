import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TranscriptList } from './TranscriptList';

describe('TranscriptList', () => {
  it('renders a legacy tool name with the canonical aps identity', () => {
    render(
      <TranscriptList
        transcript={[
          {
            role: 'agent',
            kind: 'tool',
            text: 'mcp__harness__get_request',
            toolId: 't1',
            toolName: 'mcp__harness__get_request',
            toolInput: '{}',
            ts: 1,
          },
        ]}
      />,
    );

    expect(screen.getByText('mcp__aps__get_request')).toBeInTheDocument();
    expect(screen.queryByText('mcp__harness__get_request')).not.toBeInTheDocument();
  });
});
