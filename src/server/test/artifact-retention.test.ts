import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWorktree, worktreePath } from '../src/clarify/worktree.js';
import { openDb, type Db } from '../src/db.js';
import { ArtifactRetention } from '../src/retention/artifacts.js';
import { RequestRepository } from '../src/requests/repository.js';
import { SettingsStore } from '../src/settings.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 31, 12);
const openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function tempRoot(): string {
  return tmpDir('artifact-retention');
}

function makeStore(days = 30): SettingsStore {
  const store = new SettingsStore(path.join(tempRoot(), 'config.json'));
  store.patch({ retention: { requestArtifactsDays: days } });
  return store;
}

interface Env {
  db: Db;
  repo: RequestRepository;
  dataDir: string;
}

function makeEnv(): Env {
  const db = openDb(':memory:');
  openDbs.push(db);
  const dataDir = tempRoot();
  mkdirSync(path.join(dataDir, 'requests'), { recursive: true });
  return { db, repo: new RequestRepository(db), dataDir };
}

function makeRepo(): string {
  const dir = tempRoot();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
    { cwd: dir },
  );
  return dir;
}

function setAge(target: string, ms: number): void {
  const seconds = ms / 1000;
  utimesSync(target, seconds, seconds);
}

function writeRequestDir(dataDir: string, id: string, age = NOW - 100 * DAY): string {
  const dir = path.join(dataDir, 'requests', id);
  mkdirSync(path.join(dir, 'cwd'), { recursive: true });
  writeFileSync(path.join(dir, 'transcript.json'), '[]');
  writeFileSync(path.join(dir, 'session.json'), '{}');
  setAge(path.join(dir, 'cwd'), age);
  setAge(path.join(dir, 'transcript.json'), age);
  setAge(path.join(dir, 'session.json'), age);
  setAge(dir, age);
  return dir;
}

function setRow(env: Env, id: string, state: string, updatedAt: number): void {
  env.db
    .prepare('UPDATE requests SET state = ?, updated_at = ? WHERE id = ?')
    .run(state, updatedAt, id);
}

function listWorktrees(repo: string): string {
  return execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

describe('ArtifactRetention', () => {
  it('removes an old terminal request directory and reports the cutoff', async () => {
    const env = makeEnv();
    const request = env.repo.create({ title: 'Done' });
    setRow(env, request.id, 'done', NOW - 40 * DAY);
    const dir = writeRequestDir(env.dataDir, request.id);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    const result = await retention.runOnce();

    expect(result.requestDirs).toEqual({ deleted: 1, cutoff: NOW - 30 * DAY });
    expect(existsSync(dir)).toBe(false);
    await expect(retention.runOnce()).resolves.toMatchObject({
      requestDirs: { deleted: 0 },
    });
  });

  it('keeps a directory exactly at the cutoff and removes one older', async () => {
    const env = makeEnv();
    const boundary = env.repo.create({ title: 'Boundary' });
    const older = env.repo.create({ title: 'Older' });
    const cutoff = NOW - 30 * DAY;
    setRow(env, boundary.id, 'done', cutoff);
    setRow(env, older.id, 'dropped', cutoff - 1);
    writeRequestDir(env.dataDir, boundary.id, cutoff);
    writeRequestDir(env.dataDir, older.id, cutoff - 1);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    await retention.runOnce();

    expect(existsSync(path.join(env.dataDir, 'requests', boundary.id))).toBe(true);
    expect(existsSync(path.join(env.dataDir, 'requests', older.id))).toBe(false);
  });

  it('keeps a terminal directory whose transcript was touched recently', async () => {
    const env = makeEnv();
    const request = env.repo.create({ title: 'Recently chatted' });
    setRow(env, request.id, 'done', NOW - 100 * DAY);
    const dir = writeRequestDir(env.dataDir, request.id);
    setAge(path.join(dir, 'transcript.json'), NOW - DAY);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    await retention.runOnce();

    expect(existsSync(dir)).toBe(true);
  });

  it('keeps non-terminal requests, live turns, reserved chats, and unknown entries', async () => {
    const env = makeEnv();
    const active = env.repo.create({ title: 'Active' });
    const live = env.repo.create({ title: 'Live' });
    setRow(env, live.id, 'done', NOW - 100 * DAY);
    writeRequestDir(env.dataDir, active.id);
    writeRequestDir(env.dataDir, live.id);
    for (const name of ['__kb__', '__master__:cell-a', '__summary__:cell-a', '__setup__:draft-a']) {
      writeRequestDir(env.dataDir, name);
    }
    const unknown = writeRequestDir(env.dataDir, 'not-a-request-uuid');
    writeFileSync(path.join(env.dataDir, 'requests', 'notes.txt'), 'keep');
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      isBusy: (id) => id === live.id,
      now: () => NOW,
    });

    const result = await retention.runOnce();

    expect(result.requestDirs.deleted).toBe(0);
    for (const name of ['__kb__', '__master__:cell-a', '__summary__:cell-a', '__setup__:draft-a']) {
      expect(existsSync(path.join(env.dataDir, 'requests', name))).toBe(true);
    }
    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(path.join(env.dataDir, 'requests', 'notes.txt'))).toBe(true);
    expect(existsSync(path.join(env.dataDir, 'requests', active.id))).toBe(true);
    expect(existsSync(path.join(env.dataDir, 'requests', live.id))).toBe(true);
  });

  it('deletes orphan directories whose request row is gone', async () => {
    const env = makeEnv();
    const request = env.repo.create({ title: 'Deleted row' });
    const dir = writeRequestDir(env.dataDir, request.id);
    env.db.prepare('DELETE FROM requests WHERE id = ?').run(request.id);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    await retention.runOnce();

    expect(existsSync(dir)).toBe(false);
  });

  it('does nothing when the window is zero', async () => {
    const env = makeEnv();
    const request = env.repo.create({ title: 'Keep forever' });
    setRow(env, request.id, 'done', NOW - 1000 * DAY);
    const dir = writeRequestDir(env.dataDir, request.id);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(0),
      now: () => NOW,
    });

    const result = await retention.runOnce();

    expect(result).toEqual({
      requestDirs: { deleted: 0, cutoff: null },
      worktrees: { deleted: 0, cutoff: null },
    });
    expect(existsSync(dir)).toBe(true);
  });

  it('removes an expired terminal checkout and keeps its branch', async () => {
    const env = makeEnv();
    const repo = makeRepo();
    const request = env.repo.create({ title: 'Checkout', targetRepo: repo });
    await ensureWorktree({
      targetRepo: repo,
      requestId: request.id,
      dataDir: env.dataDir,
      scratchDir: path.join(env.dataDir, 'requests', request.id, 'cwd'),
    });
    setRow(env, request.id, 'done', NOW - 100 * DAY);
    const dir = worktreePath(env.dataDir, request.id);
    setAge(dir, NOW - 100 * DAY);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    const result = await retention.runOnce();

    expect(result.worktrees.deleted).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(listWorktrees(repo)).not.toContain(dir);
    expect(branchExists(repo, `aps/${request.id}`)).toBe(true);
  });

  it('removes an orphan checkout with no request row', async () => {
    const env = makeEnv();
    const repo = makeRepo();
    const request = env.repo.create({ title: 'Orphan', targetRepo: repo });
    await ensureWorktree({
      targetRepo: repo,
      requestId: request.id,
      dataDir: env.dataDir,
      scratchDir: path.join(env.dataDir, 'requests', request.id, 'cwd'),
    });
    env.db.prepare('DELETE FROM requests WHERE id = ?').run(request.id);
    const dir = worktreePath(env.dataDir, request.id);
    setAge(dir, NOW - 100 * DAY);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    await retention.runOnce();

    expect(existsSync(dir)).toBe(false);
    expect(branchExists(repo, `aps/${request.id}`)).toBe(true);
  });

  it('removes a checkout when a non-terminal request has no target repo', async () => {
    const env = makeEnv();
    const repo = makeRepo();
    const request = env.repo.create({ title: 'Cleared repo', targetRepo: repo });
    await ensureWorktree({
      targetRepo: repo,
      requestId: request.id,
      dataDir: env.dataDir,
      scratchDir: path.join(env.dataDir, 'requests', request.id, 'cwd'),
    });
    env.repo.edit(request.id, { targetRepo: null });
    setRow(env, request.id, 'clarify', NOW - 100 * DAY);
    const dir = worktreePath(env.dataDir, request.id);
    setAge(dir, NOW - 100 * DAY);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    await retention.runOnce();

    expect(existsSync(dir)).toBe(false);
  });

  it('keeps a non-terminal checkout with a live target repo', async () => {
    const env = makeEnv();
    const repo = makeRepo();
    const request = env.repo.create({ title: 'Still working', targetRepo: repo });
    await ensureWorktree({
      targetRepo: repo,
      requestId: request.id,
      dataDir: env.dataDir,
      scratchDir: path.join(env.dataDir, 'requests', request.id, 'cwd'),
    });
    setRow(env, request.id, 'dispatch', NOW - 100 * DAY);
    const dir = worktreePath(env.dataDir, request.id);
    setAge(dir, NOW - 100 * DAY);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    await retention.runOnce();

    expect(existsSync(dir)).toBe(true);
  });

  it('removes a plain worktree directory with the rm fallback without reporting an error', async () => {
    const env = makeEnv();
    const request = env.repo.create({ title: 'Plain worktree dir' });
    setRow(env, request.id, 'done', NOW - 100 * DAY);
    const dir = path.join(env.dataDir, 'worktrees', request.id);
    mkdirSync(dir, { recursive: true });
    setAge(dir, NOW - 100 * DAY);
    const errors = { error: vi.fn() };
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      errors,
      now: () => NOW,
    });

    const result = await retention.runOnce();

    expect(result.worktrees.deleted).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(errors.error).not.toHaveBeenCalled();
  });

  it('prunes a stale registration when the checkout directory is already gone', async () => {
    const env = makeEnv();
    const repo = makeRepo();
    const request = env.repo.create({ title: 'Stale', targetRepo: repo });
    await ensureWorktree({
      targetRepo: repo,
      requestId: request.id,
      dataDir: env.dataDir,
      scratchDir: path.join(env.dataDir, 'requests', request.id, 'cwd'),
    });
    const dir = worktreePath(env.dataDir, request.id);
    rmSync(dir, { recursive: true, force: true });
    setRow(env, request.id, 'done', NOW - 100 * DAY);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    await retention.runOnce();

    expect(listWorktrees(repo)).not.toContain(dir);
  });

  it('drains a backlog with a small batch size', async () => {
    const env = makeEnv();
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const request = env.repo.create({ title: `Batch ${index}` });
      setRow(env, request.id, 'done', NOW - 100 * DAY);
      writeRequestDir(env.dataDir, request.id);
      ids.push(request.id);
    }
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
      batchSize: 1,
    });

    const result = await retention.runOnce();

    expect(result.requestDirs.deleted).toBe(4);
    for (const id of ids) expect(existsSync(path.join(env.dataDir, 'requests', id))).toBe(false);
  });

  it('joins an in-flight pass instead of starting a second one', async () => {
    const env = makeEnv();
    const request = env.repo.create({ title: 'Overlap' });
    setRow(env, request.id, 'done', NOW - 100 * DAY);
    writeRequestDir(env.dataDir, request.id);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      now: () => NOW,
    });

    const first = retention.runOnce();
    const second = retention.runOnce();
    expect(second).toBe(first);
    await first;
  });

  it('reports one error, keeps going, and recovers on the next run', async () => {
    const env = makeEnv();
    const first = env.repo.create({ title: 'First' });
    const second = env.repo.create({ title: 'Second' });
    for (const request of [first, second]) {
      setRow(env, request.id, 'done', NOW - 100 * DAY);
      writeRequestDir(env.dataDir, request.id);
    }
    const errors = { error: vi.fn() };
    const firstDir = path.join(env.dataDir, 'requests', first.id);
    let failOnce = true;
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      errors,
      now: () => NOW,
      removeDir: async (dir) => {
        if (failOnce && dir === firstDir) {
          failOnce = false;
          throw new Error('busy');
        }
        rmSync(dir, { recursive: true, force: true });
      },
    });

    const result = await retention.runOnce();

    expect(result.requestDirs.deleted).toBe(1);
    expect(errors.error).toHaveBeenCalledTimes(1);
    expect(errors.error).toHaveBeenCalledWith(
      'retention.artifacts',
      expect.any(Error),
      expect.objectContaining({ requestDirs: 1, failures: 1, cutoff: NOW - 30 * DAY }),
    );
    expect(existsSync(firstDir)).toBe(true);

    await retention.runOnce();
    expect(existsSync(firstDir)).toBe(false);
  });

  it('reports a listing failure without rejecting', async () => {
    const env = makeEnv();
    rmSync(path.join(env.dataDir, 'requests'), { recursive: true, force: true });
    writeFileSync(path.join(env.dataDir, 'requests'), 'not a directory');
    const errors = { error: vi.fn() };
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: makeStore(30),
      errors,
      now: () => NOW,
    });

    await expect(retention.runOnce()).resolves.toMatchObject({
      requestDirs: { deleted: 0 },
    });
    expect(errors.error).toHaveBeenCalledTimes(1);
  });

  it('prunes on start, hourly, and settings changes, then stops', async () => {
    const env = makeEnv();
    const store = makeStore(30);
    const retention = new ArtifactRetention({
      dataDir: env.dataDir,
      repo: env.repo,
      settings: store,
      now: () => NOW,
      intervalMs: 20,
    });
    const addOld = (): string => {
      const request = env.repo.create({ title: 'Lifecycle' });
      setRow(env, request.id, 'done', NOW - 100 * DAY);
      writeRequestDir(env.dataDir, request.id);
      return request.id;
    };
    const gone = async (id: string): Promise<void> => {
      await vi.waitFor(
        () => expect(existsSync(path.join(env.dataDir, 'requests', id))).toBe(false),
        { timeout: 2000 },
      );
    };

    const startup = addOld();
    retention.start();
    await gone(startup);

    const hourly = addOld();
    await gone(hourly);

    const changed = addOld();
    store.patch({ retention: { requestArtifactsDays: 10 } });
    await gone(changed);

    const stopped = addOld();
    retention.stop();
    retention.stop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    store.patch({ retention: { requestArtifactsDays: 5 } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(existsSync(path.join(env.dataDir, 'requests', stopped))).toBe(true);

    // Drain any in-flight pass before the database closes.
    await retention.runOnce();
  });
});
