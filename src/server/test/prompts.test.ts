import { describe, expect, it } from 'vitest';
import { dispatchPrompt } from '../src/clarify/prompts.js';
import type { Request } from '../src/domain/request.js';

function request(patch: Partial<Request> = {}): Request {
  return {
    id: 'req-1',
    title: 'Test request',
    body: '',
    state: 'dispatch',
    groomed: true,
    clarifyStarted: true,
    model: null,
    effort: null,
    targetRepo: null,
    acceptanceCriteria: null,
    context: null,
    skills: [],
    kbDigest: true,
    digest: null,
    agentStatus: 'none',
    unchecked: false,
    hcRunIds: [],
    branch: null,
    crUrl: null,
    cellId: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe('dispatchPrompt', () => {
  it('uses the branch stored on the request', () => {
    expect(dispatchPrompt(request({ branch: 'sbox/legacy' }))).toContain('`sbox/legacy`');
  });

  it('falls back to the canonical aps branch when none is stored', () => {
    expect(dispatchPrompt(request())).toContain('`aps/req-1`');
  });
});
