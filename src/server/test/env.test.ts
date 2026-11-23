import { describe, expect, it } from 'vitest';
import { legacyEnvNames, legacyEnvWarning, readEnv } from '../src/env.js';

describe('readEnv', () => {
  it('prefers APS_* over SBOX_*', () => {
    expect(readEnv({ APS_PORT: '7391', SBOX_PORT: '1234' }, 'PORT')).toBe('7391');
  });

  it('treats an empty APS_* value as defined and does not fall back', () => {
    const env = { APS_DEFAULT_MODEL: '', SBOX_DEFAULT_MODEL: 'legacy-model' };
    expect(readEnv(env, 'DEFAULT_MODEL')).toBe('');
  });

  it('falls back to SBOX_* only when the APS_* name is absent', () => {
    expect(readEnv({ SBOX_PORT: '1234' }, 'PORT')).toBe('1234');
  });

  it('returns undefined when neither prefix is set', () => {
    expect(readEnv({}, 'PORT')).toBeUndefined();
  });
});

describe('legacyEnvNames', () => {
  it('returns the sorted legacy names and ignores other keys', () => {
    const names = legacyEnvNames({
      SBOX_PORT: '1234',
      SBOX_HARNESS: 'claude',
      APS_PORT: '7391',
      sbox_lowercase: 'x',
      XSBOX_PORT: 'x',
      PATH: '/usr/bin',
    });

    expect(names).toEqual(['SBOX_HARNESS', 'SBOX_PORT']);
  });

  it('counts an empty-string legacy value as present', () => {
    expect(legacyEnvNames({ SBOX_DEFAULT_MODEL: '' })).toEqual(['SBOX_DEFAULT_MODEL']);
  });

  it('ignores legacy keys whose value is undefined', () => {
    expect(legacyEnvNames({ SBOX_PORT: undefined })).toEqual([]);
  });

  it('returns an empty list for an environment with no legacy names', () => {
    expect(legacyEnvNames({ APS_PORT: '7391', PATH: '/usr/bin' })).toEqual([]);
  });
});

describe('legacyEnvWarning', () => {
  it('returns null when there is nothing to report', () => {
    expect(legacyEnvWarning([])).toBeNull();
  });

  it('names the variables and points at the canonical prefix and migration', () => {
    const warning = legacyEnvWarning(['SBOX_HARNESS', 'SBOX_PORT']);

    expect(warning).toContain('SBOX_HARNESS, SBOX_PORT');
    expect(warning).toContain('APS_*');
    expect(warning).toContain('npm run migrate:paths');
    expect(warning?.includes('\n')).toBe(false);
  });

  it('never includes a legacy value', () => {
    const env = { SBOX_PORT: 'super-secret-value' };
    const warning = legacyEnvWarning(legacyEnvNames(env));

    expect(warning).toContain('SBOX_PORT');
    expect(warning).not.toContain('super-secret-value');
  });
});
