import {
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
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
