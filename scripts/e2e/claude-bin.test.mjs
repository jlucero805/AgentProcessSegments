import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { looksLikeClaude, resolveClaudeBinary } from './claude-bin.mjs';

const CLAUDE_VERSION = '2.1.330 (Claude Code)\n';

function claude(version = CLAUDE_VERSION) {
  return { kind: 'file', executable: true, version };
}

function fakeHost(files) {
  return {
    inspect(candidate) {
      const entry = files[candidate];
      if (!entry || entry.kind === 'missing') return { ok: false, reason: 'does not exist' };
      if (entry.kind === 'dir') return { ok: false, reason: 'not a regular file' };
      if (entry.executable === false) return { ok: false, reason: 'not executable' };
      return { ok: true };
    },
    probe(candidate) {
      const entry = files[candidate];
      if (entry?.probeError) throw entry.probeError;
      return entry?.version ?? '';
    },
  };
}

function resolve(host, overrides = {}) {
  return resolveClaudeBinary({
    env: {},
    cwd: '/work',
    pathDirs: [],
    inspect: host.inspect,
    probe: host.probe,
    ...overrides,
  });
}

function timeoutError() {
  return Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
}

test('the explicit flag wins over both aliases and PATH', () => {
  const host = fakeHost({
    '/flag/claude': claude(),
    '/env/aps': claude(),
    '/path/claude': claude(),
  });
  const result = resolve(host, {
    flag: '/flag/claude',
    env: { APS_CLAUDE_BIN: '/env/aps', SBOX_CLAUDE_BIN: '/env/sbox' },
    pathDirs: ['/path'],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'flag');
  assert.equal(result.bin, '/flag/claude');
});

test('APS_CLAUDE_BIN wins over SBOX_CLAUDE_BIN', () => {
  const host = fakeHost({ '/env/aps': claude(), '/env/sbox': claude() });
  const result = resolve(host, {
    env: { APS_CLAUDE_BIN: '/env/aps', SBOX_CLAUDE_BIN: '/env/sbox' },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'APS_CLAUDE_BIN');
  assert.equal(result.bin, '/env/aps');
});

test('SBOX_CLAUDE_BIN is used when the canonical name is blank', () => {
  const host = fakeHost({ '/env/sbox': claude() });
  const result = resolve(host, { env: { APS_CLAUDE_BIN: '   ', SBOX_CLAUDE_BIN: '/env/sbox' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'SBOX_CLAUDE_BIN');
  assert.equal(result.bin, '/env/sbox');
});

test('a relative flag resolves against the working directory', () => {
  const host = fakeHost({ '/work/bin/claude': claude() });
  const result = resolve(host, { flag: 'bin/claude' });
  assert.equal(result.status, 'ok');
  assert.equal(result.bin, '/work/bin/claude');
  assert.ok(path.isAbsolute(result.bin));
});

test('a bare flag name resolves through PATH', () => {
  const host = fakeHost({ '/two/my-claude': claude() });
  const result = resolve(host, { flag: 'my-claude', pathDirs: ['/one', '/two'] });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'flag');
  assert.equal(result.bin, '/two/my-claude');
});

test('a missing explicit flag is an error naming the flag and path', () => {
  const result = resolve(fakeHost({}), { flag: '/nope/claude' });
  assert.equal(result.status, 'error');
  assert.equal(result.source, 'flag');
  assert.equal(result.path, '/nope/claude');
  assert.match(result.reason, /--claude-bin \/nope\/claude/);
  assert.match(result.reason, /does not exist/);
});

test('a directory behind the flag is an error', () => {
  const result = resolve(fakeHost({ '/flag': { kind: 'dir' } }), { flag: '/flag' });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /not a regular file/);
});

test('a non-executable flag file is an error', () => {
  const host = fakeHost({ '/flag/claude': { kind: 'file', executable: false } });
  const result = resolve(host, { flag: '/flag/claude' });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /not executable/);
});

test('a flag whose version probe times out is an error', () => {
  const host = fakeHost({ '/flag/claude': { ...claude(), probeError: timeoutError() } });
  const result = resolve(host, { flag: '/flag/claude' });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /version probe timed out/);
});

test('a flag whose version probe fails is an error', () => {
  const host = fakeHost({ '/flag/claude': { ...claude(), probeError: new Error('exit 1') } });
  const result = resolve(host, { flag: '/flag/claude' });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /version probe failed/);
});

test('a flag that is not Claude Code is an error', () => {
  const host = fakeHost({ '/flag/claude': claude('opencode 1.2.3\n') });
  const result = resolve(host, { flag: '/flag/claude' });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /not Claude Code/);
});

test('an empty flag is an error rather than a fallback', () => {
  const host = fakeHost({ '/path/claude': claude() });
  const result = resolve(host, { flag: '', pathDirs: ['/path'] });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /non-empty path/);
});

test('an inherited non-Claude binary skips and names the variable', () => {
  const host = fakeHost({ '/hostile/false': claude('false\n') });
  const result = resolve(host, { env: { APS_CLAUDE_BIN: '/hostile/false' } });
  assert.equal(result.status, 'skip');
  assert.equal(result.source, 'APS_CLAUDE_BIN');
  assert.equal(result.path, '/hostile/false');
  assert.match(result.reason, /APS_CLAUDE_BIN=\/hostile\/false/);
  assert.match(result.reason, /not Claude Code/);
});

test('an inherited missing path skips', () => {
  const result = resolve(fakeHost({}), { env: { APS_CLAUDE_BIN: '/nope/claude' } });
  assert.equal(result.status, 'skip');
  assert.equal(result.source, 'APS_CLAUDE_BIN');
  assert.match(result.reason, /does not exist/);
});

test('an inherited directory skips', () => {
  const result = resolve(fakeHost({ '/hostile/dir': { kind: 'dir' } }), {
    env: { SBOX_CLAUDE_BIN: '/hostile/dir' },
  });
  assert.equal(result.status, 'skip');
  assert.equal(result.source, 'SBOX_CLAUDE_BIN');
  assert.match(result.reason, /not a regular file/);
});

test('an invalid canonical alias does not fall through to the legacy one', () => {
  const host = fakeHost({ '/env/sbox': claude(), '/hostile/false': claude('false\n') });
  const result = resolve(host, {
    env: { APS_CLAUDE_BIN: '/hostile/false', SBOX_CLAUDE_BIN: '/env/sbox' },
  });
  assert.equal(result.status, 'skip');
  assert.equal(result.source, 'APS_CLAUDE_BIN');
});

test('a validated inherited path is used', () => {
  const host = fakeHost({ '/env/aps': claude() });
  const result = resolve(host, { env: { APS_CLAUDE_BIN: '/env/aps' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.bin, '/env/aps');
  assert.equal(result.source, 'APS_CLAUDE_BIN');
});

test('a blank inherited value falls through to PATH', () => {
  const host = fakeHost({ '/path/claude': claude() });
  const result = resolve(host, { env: { APS_CLAUDE_BIN: '' }, pathDirs: ['/path'] });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'PATH');
  assert.equal(result.bin, '/path/claude');
});

test('PATH scanning skips unusable entries and probe failures', () => {
  const host = fakeHost({
    '/a/claude': { kind: 'dir' },
    '/b/claude': { kind: 'file', executable: false },
    '/c/claude': claude('opencode 1.2.3\n'),
    '/d/claude': claude(),
  });
  const result = resolve(host, { pathDirs: ['/a', '/b', '/c', '/d'] });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'PATH');
  assert.equal(result.bin, '/d/claude');
});

test('no usable candidate skips with the existing message', () => {
  const host = fakeHost({ '/a/claude': { kind: 'dir' } });
  const result = resolve(host, { pathDirs: ['/a', ''] });
  assert.equal(result.status, 'skip');
  assert.equal(result.source, 'none');
  assert.equal(result.reason, 'no claude binary found on PATH');
});

test('an empty environment and PATH skip', () => {
  const result = resolve(fakeHost({}));
  assert.equal(result.status, 'skip');
  assert.equal(result.source, 'none');
});

test('Claude detection is case-insensitive and tolerates noise', () => {
  assert.equal(looksLikeClaude('2.1.330 (Claude Code)\n'), true);
  assert.equal(looksLikeClaude('noise\n2.1.330 (claude code)\nmore noise'), true);
  assert.equal(looksLikeClaude('opencode 1.2.3'), false);
  assert.equal(looksLikeClaude(''), false);
  assert.equal(looksLikeClaude(undefined), false);
  assert.equal(looksLikeClaude(null), false);
});
