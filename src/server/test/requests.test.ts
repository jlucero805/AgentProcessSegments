import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from '../src/requests/repository.js';
import { createHarness, type Harness } from './helpers.js';

let harness: Harness | null = null;

function fresh(): Harness {
  harness = createHarness();
  return harness;
}

afterEach(() => {
  harness?.db.close();
  harness = null;
});

describe('request repository', () => {
  it('creates a request in clarify with the documented defaults', () => {
    const { repo } = fresh();
    const request = repo.create({ title: 'Add cells', body: 'floors' });

    expect(request.state).toBe('clarify');
    expect(request.clarifyStarted).toBe(false);
    expect(request.groomed).toBe(false);
    expect(request.kbDigest).toBe(true);
    expect(request.agentStatus).toBe('none');
    expect(request.unchecked).toBe(false);
    expect(request.skills).toEqual([]);
    expect(request.hcRunIds).toEqual([]);
    expect(request.model).toBeNull();
    expect(request.cellId).toBeNull();
    expect(request.harness).toBeNull();
    expect(request.createdAt).toBeGreaterThan(0);
  });

  it('encodes arrays, booleans, and nulls on edit', () => {
    const { repo } = fresh();
    const request = repo.create({ title: 't' });

    const edited = repo.edit(request.id, {
      skills: ['pstack', 'tdd'],
      groomed: true,
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      kbDigest: false,
      digest: 'notes',
      cellId: null,
      harness: 'opencode',
    });

    expect(edited.skills).toEqual(['pstack', 'tdd']);
    expect(edited.groomed).toBe(true);
    expect(edited.model).toBe('claude-opus-5-5');
    expect(edited.effort).toBe('xhigh');
    expect(edited.kbDigest).toBe(false);
    expect(edited.digest).toBe('notes');
    expect(edited.harness).toBe('opencode');

    const cleared = repo.edit(request.id, { model: null, digest: null, harness: null });
    expect(cleared.model).toBeNull();
    expect(cleared.digest).toBeNull();
    expect(cleared.harness).toBeNull();
    expect(cleared.skills).toEqual(['pstack', 'tdd']);
  });

  it('enforces the transition table and reports the reason', () => {
    const { repo } = fresh();
    const request = repo.create({ title: 't' });

    expect(() => repo.transition(request.id, 'done')).toThrowError(RequestError);
    try {
      repo.transition(request.id, 'done');
    } catch (error) {
      expect((error as RequestError).code).toBe('ILLEGAL_TRANSITION');
    }

    expect(repo.transition(request.id, 'dispatch').state).toBe('dispatch');
    expect(repo.transition(request.id, 'review').state).toBe('review');
    expect(repo.transition(request.id, 'finalize').state).toBe('finalize');
    expect(repo.transition(request.id, 'done').state).toBe('done');
  });

  it('throws NOT_FOUND for a missing request', () => {
    const { repo } = fresh();
    try {
      repo.require('nope');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as RequestError).code).toBe('NOT_FOUND');
    }
  });

  it('filters by intake view, state, and cell', () => {
    const { repo, cells } = fresh();
    const cell = cells.create('Floor 2');
    const intake = repo.create({ title: 'intake' });
    const started = repo.create({ title: 'started' });
    repo.setClarifyStarted(started.id, true);
    const dispatched = repo.create({ title: 'dispatched', cellId: cell.id });
    repo.transition(dispatched.id, 'dispatch');

    expect(repo.list({ view: 'intake' }).map((r) => r.id)).toEqual([intake.id]);
    expect(repo.list({ state: 'dispatch' }).map((r) => r.id)).toEqual([dispatched.id]);
    expect(repo.list({ cellId: cell.id }).map((r) => r.id)).toEqual([dispatched.id]);
    expect(repo.list({ cellId: null }).map((r) => r.id).sort()).toEqual(
      [intake.id, started.id].sort(),
    );
  });

  it('accumulates run ids and status flags', () => {
    const { repo } = fresh();
    const request = repo.create({ title: 't' });

    repo.addRun(request.id, 'run-a');
    const twoRuns = repo.addRun(request.id, 'run-b');
    expect(twoRuns.hcRunIds).toEqual(['run-a', 'run-b']);

    repo.setAgentStatus(request.id, 'working');
    expect(repo.require(request.id).agentStatus).toBe('working');

    repo.setUnchecked(request.id, true);
    expect(repo.require(request.id).unchecked).toBe(true);
    repo.setUnchecked(request.id, false);
    expect(repo.require(request.id).unchecked).toBe(false);

    repo.setBranch(request.id, 'sbox/abc');
    expect(repo.require(request.id).branch).toBe('sbox/abc');
  });

  it('does not count unseen-badge changes as activity', () => {
    const { repo } = fresh();
    const request = repo.create({ title: 't' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(request.updatedAt + 60_000);

    try {
      repo.setUnchecked(request.id, true);
      repo.setUnchecked(request.id, false);
      expect(repo.require(request.id).updatedAt).toBe(request.updatedAt);
    } finally {
      clock.mockRestore();
    }
  });
});
