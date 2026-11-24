import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.js';
import { describe, expect, it } from 'vitest';
import { ErrorLogger } from '../src/logging/errors.js';

function tempPath(name = 'errors.log'): string {
  return path.join(tmpDir('errors'), name);
}

function records(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('ErrorLogger', () => {
  it('appends one structured JSON record with context and a stack', () => {
    const file = tempPath();
    const logger = new ErrorLogger(file);
    const error = new Error('boom');

    logger.error('engine.turn', error, { session: 'req-1' });

    const [record] = records(file);
    expect(record).toMatchObject({
      source: 'engine.turn',
      name: 'Error',
      message: 'boom',
      context: { session: 'req-1' },
    });
    expect(record?.stack).toContain('boom');
    expect(record?.pid).toBe(process.pid);
  });

  it('rotates to a .1 backup at the size limit', () => {
    const file = tempPath();
    const logger = new ErrorLogger(file, { maxBytes: 120 });
    logger.error('first', new Error('one'));
    logger.error('second', new Error('two'));

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(records(`${file}.1`)[0]?.source).toBe('first');
    expect(records(file)[0]?.source).toBe('second');
  });

  it('never throws for a non-serializable context or an unusable path', () => {
    const file = tempPath();
    const logger = new ErrorLogger(file);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.error('circular', new Error('still logs'), circular)).not.toThrow();
    expect(records(file)[0]?.context).toEqual({ note: 'context was not JSON-serializable' });

    const directory = tempPath('a-directory');
    mkdirSync(directory);
    expect(() => new ErrorLogger(directory).error('bad.path', new Error('ignored'))).not.toThrow();
  });
});
