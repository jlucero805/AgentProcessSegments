import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createPreservedCopy,
  listPreservedCopies,
  preservedCopyPrefix,
} from '../src/util/preserved-copies.js';
import { tmpDir } from './tmp.js';

function fixture(): { dir: string; file: string } {
  const dir = tmpDir('preserved-copies');
  return { dir, file: path.join(dir, 'config.json') };
}

describe('preservedCopyPrefix', () => {
  it('uses the basename and the invalid suffix', () => {
    expect(preservedCopyPrefix('/tmp/settings/config.json')).toBe('config.json.invalid-');
    expect(preservedCopyPrefix('process.json')).toBe('process.json.invalid-');
  });
});

describe('listPreservedCopies', () => {
  it('lists only matching regular files, newest first', () => {
    const { dir, file } = fixture();
    const base = `${file}.invalid-2026-01-01T00-00-00-000Z`;
    const older = `${file}.invalid-2025-12-31T23-59-59-999Z`;
    writeFileSync(file, JSON.stringify({ ok: true }));
    writeFileSync(base, 'base');
    writeFileSync(`${base}-2`, 'two');
    writeFileSync(`${base}-10`, 'ten');
    writeFileSync(older, 'older');
    writeFileSync(path.join(dir, 'other.json.invalid-2026-01-01T00-00-00-000Z'), 'other');
    writeFileSync(`${file}.tmp-1`, 'tmp');
    mkdirSync(`${base}-dir`);
    symlinkSync(base, `${file}.invalid-2026-01-02T00-00-00-000Z`);

    expect(listPreservedCopies(file)).toEqual([
      `${base}-10`,
      `${base}-2`,
      base,
      older,
    ]);
  });

  it('pins the newest copy first only when it is present', () => {
    const { dir, file } = fixture();
    const older = `${file}.invalid-2025-12-31T23-59-59-999Z`;
    const newer = `${file}.invalid-2026-01-01T00-00-00-000Z`;
    writeFileSync(file, JSON.stringify({ ok: true }));
    writeFileSync(older, 'older');
    writeFileSync(newer, 'newer');

    expect(listPreservedCopies(file, { newest: older })).toEqual([older, newer]);
    expect(
      listPreservedCopies(file, {
        newest: path.join(dir, 'missing', 'config.json.invalid-2024-01-01T00-00-00-000Z'),
      }),
    ).toEqual([newer, older]);
    expect(listPreservedCopies(file, { newest: null })).toEqual([newer, older]);
  });

  it('returns no copies for a missing directory and reports the error once', () => {
    const { dir } = fixture();
    const file = path.join(dir, 'missing', 'config.json');
    const onError = vi.fn();

    expect(listPreservedCopies(file)).toEqual([]);
    expect(listPreservedCopies(file, { onError })).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable directory as having no copies', () => {
    const { dir } = fixture();
    const parent = path.join(dir, 'not-a-directory');
    writeFileSync(parent, 'x');
    const onError = vi.fn();

    expect(listPreservedCopies(path.join(parent, 'config.json'))).toEqual([]);
    expect(listPreservedCopies(path.join(parent, 'config.json'), { onError })).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(existsSync(parent)).toBe(true);
  });
});

describe('createPreservedCopy', () => {
  const NOW = new Date('2026-02-03T04:05:06.789Z');
  const STAMP = '2026-02-03T04-05-06-789Z';

  it('writes the exact bytes owner-only under the frozen stamp', () => {
    const { file } = fixture();
    const copy = createPreservedCopy(file, '{original\n', { now: NOW });

    expect(copy).toBe(`${file}.invalid-${STAMP}`);
    expect(readFileSync(copy, 'utf8')).toBe('{original\n');
    if (process.platform !== 'win32') {
      expect(statSync(copy).mode & 0o777).toBe(0o600);
    }
  });

  it('skips every occupied suffix instead of overwriting', () => {
    const { file } = fixture();
    const base = `${file}.invalid-${STAMP}`;
    writeFileSync(base, 'base\n');
    writeFileSync(`${base}-1`, 'one\n');

    const copy = createPreservedCopy(file, 'new\n', { now: NOW });

    expect(copy).toBe(`${base}-2`);
    expect(readFileSync(base, 'utf8')).toBe('base\n');
    expect(readFileSync(`${base}-1`, 'utf8')).toBe('one\n');
    expect(readFileSync(copy, 'utf8')).toBe('new\n');
  });

  it('lists the new copy first when pinned as newest', () => {
    const { file } = fixture();
    const older = `${file}.invalid-2025-12-31T23-59-59-999Z`;
    writeFileSync(older, 'older\n');

    const copy = createPreservedCopy(file, 'newer\n', { now: NOW });

    expect(listPreservedCopies(file, { newest: copy })).toEqual([copy, older]);
  });

  it('propagates a create failure without leaving a copy', () => {
    const { dir } = fixture();
    const parent = path.join(dir, 'not-a-directory');
    writeFileSync(parent, 'x');
    const file = path.join(parent, 'config.json');

    expect(() => createPreservedCopy(file, 'x', { now: NOW })).toThrow();
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(`${file}.invalid-${STAMP}`)).toBe(false);
  });
});
