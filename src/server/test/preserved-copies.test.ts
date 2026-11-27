import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe('preservedCopyPrefix', () => {
  it('uses the basename and the invalid suffix', () => {
    expect(preservedCopyPrefix('/tmp/settings/config.json')).toBe('config.json.invalid-');
    expect(preservedCopyPrefix('process.json')).toBe('process.json.invalid-');
  });
});

describe('createPreservedCopy', () => {
  const STAMP = '2026-01-01T00-00-00-000Z';

  function frozen(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  }

  it('copies the exact bytes to a stamped owner-only sibling', () => {
    frozen();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { file } = fixture();
      const original = `{"secret":"value"}\n`;
      writeFileSync(file, original);

      const copy = createPreservedCopy(file, { label: 'settings' });

      expect(copy).toBe(`${file}.invalid-${STAMP}`);
      expect(readFileSync(copy!, 'utf8')).toBe(original);
      expect(readFileSync(file, 'utf8')).toBe(original);
      if (process.platform !== 'win32') {
        expect(statSync(copy!).mode & 0o777).toBe(0o600);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain('preserving unusable settings');
      expect(line).toContain(file);
      expect(line).toContain(copy);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('adds the first free numeric suffix without overwriting a copy', () => {
    frozen();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { file } = fixture();
      const base = `${file}.invalid-${STAMP}`;
      writeFileSync(file, 'current');
      writeFileSync(base, 'first');
      expect(createPreservedCopy(file, { label: 'settings' })).toBe(`${base}-1`);
      writeFileSync(`${base}-1`, 'second');
      expect(createPreservedCopy(file, { label: 'settings' })).toBe(`${base}-2`);
      expect(readFileSync(base, 'utf8')).toBe('first');
      expect(readFileSync(`${base}-1`, 'utf8')).toBe('second');
      expect(readFileSync(`${base}-2`, 'utf8')).toBe('current');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('returns null and stays silent when the source is gone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = vi.fn();
    try {
      const { dir, file } = fixture();

      expect(createPreservedCopy(file, { label: 'settings', onError })).toBeNull();
      expect(onError).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(existsSync(`${file}.invalid-${STAMP}`)).toBe(false);
      expect(readdirNames(dir)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports a read failure once and rethrows without a copy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { file } = fixture();
      mkdirSync(file);
      const onError = vi.fn();

      expect(() => createPreservedCopy(file, { label: 'settings', onError })).toThrow();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(warn).not.toHaveBeenCalled();

      expect(() => createPreservedCopy(file, { label: 'settings' })).toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  it('reports a write failure once and rethrows without a warning', () => {
    frozen();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = tmpDir('preserved-copies');
      // The source name is legal, but every candidate copy name (and the write
      // helper's temp name) exceeds the 255-byte component limit.
      const file = path.join(dir, `${'a'.repeat(240)}.json`);
      writeFileSync(file, 'original');
      const onError = vi.fn();

      expect(() => createPreservedCopy(file, { label: 'settings', onError })).toThrow();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(readdirNames(dir)).toEqual([path.basename(file)]);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
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
