import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildE2eEnv, buildE2ePins, SCRUB_PREFIXES } from './env.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const mockBin = path.join(repoRoot, 'scripts', 'e2e', 'mock-claude.mjs');

function validPins(overrides = {}) {
  return {
    root: repoRoot,
    mock: mockBin,
    home: '/tmp/e2e/home',
    temp: '/tmp/e2e',
    dbPath: '/tmp/e2e/e2e.sqlite',
    port: 7391,
    base: 'http://127.0.0.1:7391',
    pluginsDir: '/tmp/e2e/plugins',
    ...overrides,
  };
}

const pins = {
  HOME: '/tmp/e2e/home',
  NODE_ENV: 'production',
  APS_HARNESS: 'claude',
  APS_HARNESS_BIN: '/repo/scripts/e2e/mock-claude.mjs',
  APS_CLAUDE_BIN: '/repo/scripts/e2e/mock-claude.mjs',
  APS_PLUGINS_DIR: '/tmp/e2e/plugins',
  APS_BRAIN_URL: 'http://127.0.0.1:7391',
};

const hostile = {
  PATH: '/usr/bin:/bin',
  TMPDIR: '/tmp',
  LANG: 'en_US.UTF-8',
  SHELL: '/bin/bash',
  HTTPS_PROXY: 'http://proxy:8080',
  HOME: '/root',
  NODE_ENV: 'test',
  APS_HARNESS: 'opencode',
  APS_HARNESS_BIN: '/bin/false',
  APS_CLAUDE_BIN: '/bin/false',
  APS_OPENCODE_BIN: '/bin/false',
  APS_PLUGINS_DIR: '/host/plugins',
  APS_BRAIN_URL: 'http://example.test',
  APS_TURN_TIMEOUT_MS: '1',
  APS_DEFAULT_MODEL: 'host/model',
  SBOX_HARNESS: 'opencode',
  // The exact value from the report: a host exporting the OpenCode binary used
  // to make the suite launch it with Claude flags.
  SBOX_HARNESS_BIN: 'opencode',
  SBOX_CLAUDE_BIN: '/bin/false',
  SBOX_PLUGINS_DIR: '/host/plugins',
  SBOX_BRAIN_URL: 'http://example.test',
  SBOX_TURN_TIMEOUT_MS: '1',
  SBOX_DEFAULT_MODEL: 'host/model',
  ANTHROPIC_API_KEY: 'sk-live',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  CLAUDE_CODE_OAUTH_TOKEN: 'live-token',
  OPENAI_API_KEY: 'sk-live',
};

test('scrubs the documented host prefixes', () => {
  assert.deepEqual([...SCRUB_PREFIXES], [
    'APS_',
    'SBOX_',
    'ANTHROPIC_',
    'CLAUDE_',
    'OPENAI_',
  ]);
});

test('drops inherited harness settings and credentials', () => {
  const env = buildE2eEnv(hostile, pins);
  const scrubbed = Object.keys(hostile).filter((name) =>
    SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  assert.ok(scrubbed.length > 0, 'fixture should contain names to scrub');
  for (const name of scrubbed) {
    if (Object.hasOwn(pins, name)) {
      // A pin may reuse the name, but the host value must never survive.
      assert.equal(env[name], pins[name], `${name} should use the pinned value`);
      assert.notEqual(env[name], hostile[name], `${name} should not keep the host value`);
    } else {
      assert.equal(Object.hasOwn(env, name), false, `${name} should be dropped`);
    }
  }
});

test('keeps ordinary host env like PATH and locale', () => {
  const env = buildE2eEnv(hostile, pins);
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.TMPDIR, '/tmp');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.SHELL, '/bin/bash');
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
});

test('pins win over colliding host values', () => {
  const env = buildE2eEnv(hostile, pins);
  assert.equal(env.HOME, '/tmp/e2e/home');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.APS_HARNESS, 'claude');
  assert.equal(env.APS_HARNESS_BIN, '/repo/scripts/e2e/mock-claude.mjs');
  assert.equal(env.APS_CLAUDE_BIN, '/repo/scripts/e2e/mock-claude.mjs');
  assert.equal(env.APS_PLUGINS_DIR, '/tmp/e2e/plugins');
  assert.equal(env.APS_BRAIN_URL, 'http://127.0.0.1:7391');
  // The reported regression: a host `SBOX_HARNESS_BIN=opencode` must never win.
  assert.notEqual(env.APS_HARNESS_BIN, 'opencode');
  assert.notEqual(env.APS_HARNESS_BIN, '/bin/false');
});

test('every scrub-prefixed name in the result comes from a pin', () => {
  const env = buildE2eEnv(hostile, pins);
  for (const name of Object.keys(env)) {
    if (!SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    assert.ok(Object.hasOwn(pins, name), `${name} must be pinned, not inherited`);
    assert.equal(env[name], pins[name], `${name} must carry the pinned value`);
  }
});

test('drops inherited empty strings too', () => {
  const env = buildE2eEnv(
    { PATH: '/usr/bin:/bin', APS_HARNESS: '', SBOX_HARNESS_BIN: '', APS_TURN_TIMEOUT_MS: '' },
    { APS_HARNESS: 'claude', APS_TURN_TIMEOUT_MS: '600000' },
  );
  assert.equal(env.APS_HARNESS, 'claude');
  assert.equal(env.APS_TURN_TIMEOUT_MS, '600000');
  assert.equal(Object.hasOwn(env, 'SBOX_HARNESS_BIN'), false);
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test('skips undefined host values instead of writing them out', () => {
  const env = buildE2eEnv({ PATH: undefined, KEEP: 'value' }, {});
  assert.equal(Object.hasOwn(env, 'PATH'), false);
  assert.equal(env.KEEP, 'value');
});

test('buildE2ePins returns the full pin set for the real repo', () => {
  const pinned = buildE2ePins(validPins());

  assert.deepEqual(
    Object.keys(pinned).sort(),
    [
      'APS_BRAIN_URL',
      'APS_CLAUDE_BIN',
      'APS_CONFIG',
      'APS_DATA_DIR',
      'APS_DB',
      'APS_DOCS_DIR',
      'APS_ERROR_LOG',
      'APS_HARNESS',
      'APS_HARNESS_BIN',
      'APS_HOST',
      'APS_PLUGINS_DIR',
      'APS_PORT',
      'APS_PROCESS',
      'APS_TERMINAL',
      'APS_WEB_DIR',
      'HOME',
      'NODE_ENV',
    ].sort(),
  );
  assert.equal(pinned.APS_HARNESS, 'claude');
  assert.equal(pinned.APS_HARNESS_BIN, mockBin);
  assert.equal(pinned.APS_CLAUDE_BIN, mockBin);
  assert.ok(path.isAbsolute(pinned.APS_HARNESS_BIN));
  assert.ok(existsSync(pinned.APS_HARNESS_BIN), 'the pinned mock binary exists');
  assert.equal(pinned.APS_PORT, '7391');
  assert.equal(pinned.APS_TERMINAL, '0');
  assert.equal(pinned.APS_DOCS_DIR, path.join(repoRoot, 'docs'));
  for (const [name, value] of Object.entries(pinned)) {
    assert.notEqual(value, undefined, `${name} must not be undefined`);
  }
});

test('buildE2ePins rejects missing, empty, and relative path arguments', () => {
  for (const name of ['root', 'mock', 'home', 'temp', 'dbPath', 'pluginsDir']) {
    for (const value of [undefined, '', 'relative/path']) {
      assert.throws(
        () => buildE2ePins(validPins({ [name]: value })),
        (error) => error instanceof TypeError && error.message.includes(name),
        `${name}=${String(value)} should throw`,
      );
    }
  }
});

test('buildE2ePins rejects a missing or empty base URL', () => {
  for (const value of [undefined, '']) {
    assert.throws(
      () => buildE2ePins(validPins({ base: value })),
      (error) => error instanceof TypeError && error.message.includes('base'),
      `base=${String(value)} should throw`,
    );
  }
});

test('buildE2ePins rejects an invalid port', () => {
  for (const value of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    65536,
    1.5,
    '7391',
  ]) {
    assert.throws(
      () => buildE2ePins(validPins({ port: value })),
      (error) => error instanceof TypeError && error.message.includes('port'),
      `port=${String(value)} should throw`,
    );
  }
});

test('the E2E entrypoint builds the brain env through the tested pins', () => {
  // Cheap source tripwire: the factory tests prove behavior; this keeps the
  // entrypoint from quietly going back to spreading the host environment.
  const entry = readFileSync(path.join(repoRoot, 'scripts', 'e2e.mjs'), 'utf8');
  assert.match(entry, /env:\s*buildE2eEnv\(/);
  assert.match(entry, /buildE2ePins\(/);
  assert.doesNotMatch(entry, /\.\.\.process\.env/);
  assert.doesNotMatch(entry, /APS_HARNESS_BIN\s*:/);
});

test('the real E2E pin set beats hostile harness overrides', () => {
  const e2ePins = buildE2ePins(validPins());

  const env = buildE2eEnv(hostile, e2ePins);

  for (const [name, value] of Object.entries(e2ePins)) {
    assert.equal(env[name], value, `${name} should use the pinned value`);
  }
  for (const name of Object.keys(hostile)) {
    if (Object.hasOwn(e2ePins, name)) continue;
    if (SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      assert.equal(Object.hasOwn(env, name), false, `${name} should be dropped`);
    }
  }

  // The hostile binaries must never survive under either prefix.
  assert.equal(env.APS_HARNESS_BIN, mockBin);
  assert.equal(env.APS_CLAUDE_BIN, mockBin);
  assert.ok(path.isAbsolute(env.APS_HARNESS_BIN));
  assert.ok(existsSync(env.APS_HARNESS_BIN));
  assert.equal(Object.hasOwn(env, 'SBOX_HARNESS_BIN'), false);
  assert.equal(Object.hasOwn(env, 'APS_OPENCODE_BIN'), false);

  // Ordinary host env still reaches the brain.
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
});
