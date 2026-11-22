import { afterEach, describe, expect, it } from 'vitest';
import { CellNotFoundError } from '../src/cells/repository.js';
import { defaultProcess } from '../src/process/defaults.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
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

describe('cells', () => {
  it('creates, lists, and renames cells', () => {
    const { cells } = fresh();
    const a = cells.create('Alpha');
    const b = cells.create('beta');

    expect(cells.list().map((cell) => cell.name)).toEqual(['Alpha', 'beta']);
    expect(a.autocompactPercent).toBe(80);
    expect(cells.rename(a.id, 'Gamma').name).toBe('Gamma');
    expect(cells.get(b.id)?.name).toBe('beta');
    expect(cells.get('missing')).toBeNull();
  });

  it('detaches requests instead of deleting them', () => {
    const { cells, repo } = fresh();
    const cell = cells.create('Doomed');
    const request = repo.create({ title: 'keep me', cellId: cell.id });

    cells.remove(cell.id);

    expect(cells.get(cell.id)).toBeNull();
    const survivor = repo.require(request.id);
    expect(survivor.cellId).toBeNull();
    expect(survivor.title).toBe('keep me');
  });

  it('throws for a missing cell', () => {
    const { cells } = fresh();
    expect(() => cells.remove('nope')).toThrowError(CellNotFoundError);
    expect(() => cells.rename('nope', 'x')).toThrowError(CellNotFoundError);
  });

  it('stores and clears a cell process policy', () => {
    const { cells } = fresh();
    const process = defaultProcess(DEFAULT_SETTINGS.master);
    process.segments[0]!.enabled = true;

    const cell = cells.create('Strict repo', process, 3, {
      maxConcurrent: 2,
      harness: 'opencode',
      model: 'cell-model',
      effort: 'high',
      autocompactPercent: 55,
    });
    expect(cells.get(cell.id)?.process?.segments[0]?.enabled).toBe(true);
    expect(cells.get(cell.id)?.masterIntervalMinutes).toBe(3);
    expect(cells.get(cell.id)?.maxConcurrent).toBe(2);
    expect(cells.get(cell.id)?.harness).toBe('opencode');
    expect(cells.get(cell.id)?.model).toBe('cell-model');
    expect(cells.get(cell.id)?.effort).toBe('high');
    expect(cells.get(cell.id)?.autocompactPercent).toBe(55);
    expect(cells.setAutocompactPercent(cell.id, 65).autocompactPercent).toBe(65);
    expect(cells.getProcess(cell.id)?.segments[0]?.enabled).toBe(true);

    expect(cells.setHarness(cell.id, 'claude').harness).toBe('claude');
    expect(cells.setHarness(cell.id, null).harness).toBeNull();

    const cleared = cells.setProcess(cell.id, null);
    expect(cleared.process).toBeNull();
    expect(cells.getProcess(cell.id)).toBeNull();
    expect(cells.setMasterInterval(cell.id, null).masterIntervalMinutes).toBeNull();
  });
});

describe('knowledge base', () => {
  it('keeps one entry per request, replacing the prior digest', () => {
    const { kb, repo } = fresh();
    const request = repo.create({ title: 'Indexed' });

    kb.store({ requestId: request.id, title: 'First', content: 'one' });
    const replaced = kb.store({ requestId: request.id, title: 'Second', content: 'two' });

    expect(kb.list()).toHaveLength(1);
    expect(kb.getByRequest(request.id)?.content).toBe('two');
    expect(replaced.title).toBe('Second');
  });

  it('searches titles and bodies, treating LIKE wildcards literally', () => {
    const { kb } = fresh();
    kb.store({ requestId: 'r1', title: 'Cache warmup', content: 'reduce cold starts' });
    kb.store({ requestId: 'r2', title: 'Budget', content: 'we hit 100% of the cap' });
    kb.store({ requestId: 'r3', title: 'Windows path', content: 'look under C:\\temp' });

    expect(kb.search('cold').map((entry) => entry.requestId)).toEqual(['r1']);
    expect(kb.search('100%').map((entry) => entry.requestId)).toEqual(['r2']);
    expect(kb.search('100_').length).toBe(0);
    expect(kb.search('C:\\temp').map((entry) => entry.requestId)).toEqual(['r3']);
  });

  it('requires every term and ranks title hits above body hits', () => {
    const { kb } = fresh();
    kb.store({ requestId: 'a', title: 'Deploy cache', content: 'notes' });
    kb.store({ requestId: 'b', title: 'Deploy guide', content: 'cache cache cache' });
    kb.store({ requestId: 'c', title: 'Other', content: 'deploy cache' });
    kb.store({ requestId: 'd', title: 'Deploy only', content: 'unrelated' });

    expect(kb.search('deploy cache').map((entry) => entry.requestId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(kb.search('deploy unrelated').map((entry) => entry.requestId)).toEqual(['d']);
    expect(kb.search('deploy missing').length).toBe(0);
  });

  it('breaks relevance ties by recency and honours the limit', async () => {
    const { kb } = fresh();
    kb.store({ requestId: 'old', title: 'Same', content: 'hit' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    kb.store({ requestId: 'new', title: 'Same', content: 'hit' });

    expect(kb.search('hit').map((entry) => entry.requestId)).toEqual(['new', 'old']);
    expect(kb.search('hit', 1).map((entry) => entry.requestId)).toEqual(['new']);
  });
});
