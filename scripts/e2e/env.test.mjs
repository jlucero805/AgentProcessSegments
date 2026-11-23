import assert from 'node:assert/strict';
import test from 'node:test';
import { buildE2eEnv, buildE2ePins, SCRUB_PREFIXES } from './env.mjs';

const pins = {
  HOME: '/tmp/e2e/home',
  NODE_ENV: 'production',
  APS_HARNESS: 'claude',
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
  SBOX_HARNESS_BIN: '/bin/false',
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
  assert.equal(env.APS_CLAUDE_BIN, '/repo/scripts/e2e/mock-claude.mjs');
  assert.equal(env.APS_PLUGINS_DIR, '/tmp/e2e/plugins');
  assert.equal(env.APS_BRAIN_URL, 'http://127.0.0.1:7391');
});

test('skips undefined host values instead of writing them out', () => {
  const env = buildE2eEnv({ PATH: undefined, KEEP: 'value' }, {});
  assert.equal(Object.hasOwn(env, 'PATH'), false);
  assert.equal(env.KEEP, 'value');
});

test('the real E2E pin set beats hostile harness overrides', () => {
  const e2ePins = buildE2ePins({
    root: '/repo',
    mock: '/repo/scripts/e2e/mock-claude.mjs',
    home: '/tmp/e2e/home',
    temp: '/tmp/e2e',
    dbPath: '/tmp/e2e/e2e.sqlite',
    port: 7391,
    base: 'http://127.0.0.1:7391',
    pluginsDir: '/tmp/e2e/plugins',
  });

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
  assert.equal(env.APS_HARNESS_BIN, '/repo/scripts/e2e/mock-claude.mjs');
  assert.equal(env.APS_CLAUDE_BIN, '/repo/scripts/e2e/mock-claude.mjs');
  assert.equal(Object.hasOwn(env, 'SBOX_HARNESS_BIN'), false);
  assert.equal(Object.hasOwn(env, 'APS_OPENCODE_BIN'), false);

  // Ordinary host env still reaches the brain.
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
});
