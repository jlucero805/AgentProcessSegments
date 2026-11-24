import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildClaudeSmokePins,
  buildE2eEnv,
  buildE2ePins,
  buildMcpSmokeClientPins,
  buildMcpSmokePins,
  buildPinnedEnv,
  buildScreenshotPins,
  resolveClaudeBin,
  SCRUB_PREFIXES,
  scrubEnv,
} from './env.mjs';

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

const proofHostile = {
  ...hostile,
  APS_DB: '/tmp/host.sqlite',
  APS_REQUEST_ID: 'hostile-request',
  XDG_CONFIG_HOME: '/hostile/xdg-config',
  XDG_STATE_HOME: '/hostile/xdg-state',
};

const claudePinsArgs = {
  root: repoRoot,
  claude: '/opt/claude/bin/claude',
  home: '/tmp/claude-smoke/home',
  temp: '/tmp/claude-smoke',
  dbPath: '/tmp/claude-smoke/brain.sqlite',
  dataDir: '/tmp/claude-smoke/data',
  port: 7391,
  mockUrl: 'http://127.0.0.1:8888',
};

const mcpPinsArgs = {
  root: repoRoot,
  work: '/tmp/mcp-smoke',
  home: '/tmp/mcp-smoke/home',
  port: 7392,
};

const mcpClientPinsArgs = {
  home: '/tmp/mcp-smoke/home',
  base: 'http://127.0.0.1:7392',
  requestId: 'request-1',
};

const screenshotPinsArgs = {
  root: repoRoot,
  temp: '/tmp/screenshots',
  dbPath: '/tmp/screenshots/screenshots.sqlite',
  dataDir: '/tmp/screenshots/data',
  configPath: '/tmp/screenshots/config.json',
  processPath: '/tmp/screenshots/process.json',
  errorLogPath: '/tmp/screenshots/errors.log',
  xdgConfig: '/tmp/screenshots/xdg-config',
  xdgState: '/tmp/screenshots/xdg-state',
  port: 7393,
};

const proofBuilders = {
  buildClaudeSmokePins,
  buildMcpSmokePins,
  buildMcpSmokeClientPins,
  buildScreenshotPins,
};

function assertOnlyPinnedScrubNames(env, pins) {
  for (const name of Object.keys(env)) {
    if (!SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    assert.ok(Object.hasOwn(pins, name), `${name} must be pinned, not inherited`);
    assert.equal(env[name], pins[name], `${name} must carry the pinned value`);
  }
}

test('scrubEnv drops prefixed names and keeps ordinary host env', () => {
  const env = scrubEnv(proofHostile);
  for (const name of Object.keys(proofHostile)) {
    if (SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      assert.equal(Object.hasOwn(env, name), false, `${name} should be dropped`);
    }
  }
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.LANG, 'en_US.UTF-8');
  // XDG_* is not a scrub prefix; a builder that resolves paths through it must
  // pin the dirs itself.
  assert.equal(env.XDG_CONFIG_HOME, '/hostile/xdg-config');
});

test('buildPinnedEnv applies pins after the scrub', () => {
  const env = buildPinnedEnv(proofHostile, {
    APS_HARNESS: 'claude',
    HOME: '/pin/home',
  });
  assert.equal(env.APS_HARNESS, 'claude');
  assert.equal(env.HOME, '/pin/home');
  assert.equal(Object.hasOwn(env, 'APS_DB'), false);
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test('buildClaudeSmokePins keeps the legacy aliases and drops host APS_* names', () => {
  const pinned = buildClaudeSmokePins(claudePinsArgs);
  assert.equal(pinned.SBOX_HARNESS, 'claude');
  assert.equal(pinned.SBOX_HARNESS_BIN, claudePinsArgs.claude);
  assert.equal(pinned.SBOX_CLAUDE_BIN, claudePinsArgs.claude);
  assert.equal(pinned.SBOX_PORT, '7391');
  assert.equal(pinned.SBOX_DB, claudePinsArgs.dbPath);
  assert.equal(pinned.SBOX_CONFIG, '/tmp/claude-smoke/config.json');
  assert.equal(pinned.SBOX_PROCESS, '/tmp/claude-smoke/process.json');
  assert.equal(pinned.SBOX_ERROR_LOG, '/tmp/claude-smoke/errors.log');
  assert.equal(pinned.XDG_CONFIG_HOME, '/tmp/claude-smoke/xdg-config');
  assert.equal(pinned.XDG_STATE_HOME, '/tmp/claude-smoke/xdg-state');
  assert.equal(pinned.ANTHROPIC_BASE_URL, claudePinsArgs.mockUrl);
  assert.equal(pinned.ANTHROPIC_API_KEY, 'test-key');

  const env = buildPinnedEnv(proofHostile, pinned);
  assertOnlyPinnedScrubNames(env, pinned);
  assert.equal(env.SBOX_HARNESS_BIN, claudePinsArgs.claude);
  assert.notEqual(env.SBOX_HARNESS_BIN, '/bin/false');
  assert.equal(env.SBOX_DB, claudePinsArgs.dbPath);
  assert.equal(env.SBOX_DATA_DIR, claudePinsArgs.dataDir);
  assert.notEqual(env.SBOX_DB, '/tmp/host.sqlite');
  assert.equal(Object.hasOwn(env, 'APS_HARNESS'), false);
  assert.equal(Object.hasOwn(env, 'APS_DB'), false);
  assert.equal(Object.hasOwn(env, 'APS_BRAIN_URL'), false);
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/claude-smoke/xdg-config');
  assert.equal(env.ANTHROPIC_API_KEY, 'test-key');
  assert.equal(Object.hasOwn(env, 'CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test('resolveClaudeBin prefers the flag, then the script env, then PATH', () => {
  const env = { CLAUDE_MOCK_SMOKE_BIN: '/env/claude', PATH: '/path' };
  assert.equal(
    resolveClaudeBin({ argv: ['--claude-bin', '/flag/claude'], env, isExecutable: () => true }),
    '/flag/claude',
  );
  assert.equal(
    resolveClaudeBin({ argv: ['--claude-bin=/flag/claude'], env, isExecutable: () => true }),
    '/flag/claude',
  );
  assert.equal(resolveClaudeBin({ argv: [], env, isExecutable: () => true }), '/env/claude');
  assert.equal(
    resolveClaudeBin({
      argv: [],
      env: { PATH: '/path' },
      isExecutable: (file) => file === '/path/claude',
    }),
    '/path/claude',
  );
});

test('resolveClaudeBin ignores inherited APS_CLAUDE_BIN and SBOX_CLAUDE_BIN', () => {
  assert.equal(
    resolveClaudeBin({
      argv: [],
      env: {
        APS_CLAUDE_BIN: '/bin/false',
        SBOX_CLAUDE_BIN: '/bin/false',
        PATH: '/nowhere',
      },
      isExecutable: (file) => file === '/nowhere/claude',
    }),
    '/nowhere/claude',
  );
  assert.equal(
    resolveClaudeBin({
      argv: [],
      env: { APS_CLAUDE_BIN: '/bin/false', SBOX_CLAUDE_BIN: '/bin/false', PATH: '' },
      isExecutable: () => true,
    }),
    null,
  );
});

test('resolveClaudeBin skips non-executable PATH candidates and misses', () => {
  const env = { PATH: ['/one', '/two'].join(path.delimiter) };
  assert.equal(
    resolveClaudeBin({
      argv: [],
      env,
      isExecutable: (file) => file === '/two/claude',
    }),
    '/two/claude',
  );
  assert.equal(resolveClaudeBin({ argv: [], env, isExecutable: () => false }), null);
});

test('resolveClaudeBin rejects invalid explicit binaries', () => {
  const cases = [
    { argv: ['--claude-bin'], env: {}, message: /requires a path/ },
    { argv: ['--claude-bin', '--other'], env: {}, message: /requires a path/ },
    { argv: ['--claude-bin='], env: {}, message: /non-empty path/ },
    { argv: ['--claude-bin', './claude'], env: {}, message: /absolute path/ },
    { argv: [], env: { CLAUDE_MOCK_SMOKE_BIN: '' }, message: /non-empty path/ },
    {
      argv: [],
      env: { CLAUDE_MOCK_SMOKE_BIN: '/nope/claude' },
      message: /not an executable file/,
    },
  ];

  for (const { argv, env, message } of cases) {
    assert.throws(
      () => resolveClaudeBin({ argv, env, isExecutable: () => false }),
      (error) => error instanceof TypeError && message.test(error.message),
      `${argv.join(' ') || env.CLAUDE_MOCK_SMOKE_BIN} should throw`,
    );
  }
});

test('buildMcpSmokePins isolates the temp brain from host harness env', () => {
  const pinned = buildMcpSmokePins(mcpPinsArgs);
  assert.equal(pinned.APS_DB, '/tmp/mcp-smoke/harness.sqlite');
  assert.equal(pinned.APS_PORT, '7392');
  assert.equal(pinned.HOME, '/tmp/mcp-smoke/home');
  assert.equal(pinned.APS_HARNESS, 'claude');
  assert.equal(pinned.APS_HARNESS_BIN, '/bin/false');
  assert.equal(pinned.APS_TERMINAL, '0');

  const env = buildPinnedEnv(proofHostile, pinned);
  assertOnlyPinnedScrubNames(env, pinned);
  assert.equal(env.APS_DB, '/tmp/mcp-smoke/harness.sqlite');
  assert.equal(Object.hasOwn(env, 'SBOX_HARNESS'), false);
  assert.equal(Object.hasOwn(env, 'SBOX_BRAIN_URL'), false);
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false);
});

test('buildMcpSmokeClientPins uses legacy names without inherited APS_* names', () => {
  const pinned = buildMcpSmokeClientPins(mcpClientPinsArgs);
  const env = buildPinnedEnv(proofHostile, pinned);
  assert.equal(env.SBOX_BRAIN_URL, 'http://127.0.0.1:7392');
  assert.equal(env.SBOX_REQUEST_ID, 'request-1');
  assert.equal(Object.hasOwn(env, 'APS_BRAIN_URL'), false);
  assert.equal(Object.hasOwn(env, 'APS_REQUEST_ID'), false);
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test('buildScreenshotPins keeps the staged paths and pins XDG/HOME', () => {
  const pinned = buildScreenshotPins(screenshotPinsArgs);
  assert.equal(pinned.APS_PORT, '7393');
  assert.equal(pinned.APS_DB, '/tmp/screenshots/screenshots.sqlite');
  assert.equal(pinned.APS_CONFIG, '/tmp/screenshots/config.json');
  assert.equal(pinned.APS_ERROR_LOG, '/tmp/screenshots/errors.log');
  assert.equal(pinned.HOME, '/tmp/screenshots/home');
  assert.equal(pinned.XDG_CONFIG_HOME, '/tmp/screenshots/xdg-config');
  assert.equal(pinned.APS_TERMINAL_CWD, repoRoot);

  const env = buildPinnedEnv(proofHostile, pinned);
  assertOnlyPinnedScrubNames(env, pinned);
  assert.equal(env.APS_DB, '/tmp/screenshots/screenshots.sqlite');
  assert.equal(env.HOME, '/tmp/screenshots/home');
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false);
  assert.equal(Object.hasOwn(env, 'SBOX_HARNESS'), false);
});

test('proof pin builders reject missing, empty, and relative paths', () => {
  const cases = [
    ['buildClaudeSmokePins', claudePinsArgs, ['root', 'home', 'temp', 'dbPath', 'dataDir']],
    ['buildMcpSmokePins', mcpPinsArgs, ['root', 'work', 'home']],
    ['buildMcpSmokeClientPins', mcpClientPinsArgs, ['home']],
    [
      'buildScreenshotPins',
      screenshotPinsArgs,
      [
        'root',
        'temp',
        'dbPath',
        'dataDir',
        'configPath',
        'processPath',
        'errorLogPath',
        'xdgConfig',
        'xdgState',
      ],
    ],
  ];

  for (const [builder, args, fields] of cases) {
    for (const field of fields) {
      for (const value of [undefined, '', 'relative/path']) {
        assert.throws(
          () => proofBuilders[builder]({ ...args, [field]: value }),
          (error) =>
            error instanceof TypeError &&
            error.message.includes(builder) &&
            error.message.includes(field),
          `${builder}.${field}=${String(value)} should throw`,
        );
      }
    }
  }
});

test('proof pin builders reject missing strings and invalid ports', () => {
  assert.throws(
    () => buildClaudeSmokePins({ ...claudePinsArgs, claude: '' }),
    (error) => error instanceof TypeError && error.message.includes('claude'),
  );
  assert.throws(
    () => buildClaudeSmokePins({ ...claudePinsArgs, mockUrl: '' }),
    (error) => error instanceof TypeError && error.message.includes('mockUrl'),
  );
  assert.throws(
    () => buildMcpSmokeClientPins({ ...mcpClientPinsArgs, base: '' }),
    (error) => error instanceof TypeError && error.message.includes('base'),
  );
  assert.throws(
    () => buildMcpSmokeClientPins({ ...mcpClientPinsArgs, requestId: '' }),
    (error) => error instanceof TypeError && error.message.includes('requestId'),
  );

  for (const [builder, args] of [
    ['buildClaudeSmokePins', claudePinsArgs],
    ['buildMcpSmokePins', mcpPinsArgs],
    ['buildScreenshotPins', screenshotPinsArgs],
  ]) {
    for (const port of [undefined, Number.NaN, 0, 65536, 1.5, '7391']) {
      assert.throws(
        () => proofBuilders[builder]({ ...args, port }),
        (error) => error instanceof TypeError && error.message.includes('port'),
        `${builder}.port=${String(port)} should throw`,
      );
    }
  }
});

test('every proof script builds child env through the shared helper', () => {
  const expected = [
    ['scripts/e2e.mjs', 'buildE2eEnv', 1],
    ['scripts/claude-mock-smoke.mjs', 'buildPinnedEnv', 1],
    ['scripts/mcp-smoke.mjs', 'buildPinnedEnv', 2],
    ['scripts/screenshots.mjs', 'buildPinnedEnv', 1],
  ];

  for (const [file, builder, count] of expected) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    assert.match(
      source,
      /from '\.\/e2e\/env\.mjs'/,
      `${file} must import the shared env helper`,
    );
    assert.equal(
      (source.match(new RegExp(`env:\\s*${builder}\\(`, 'g')) ?? []).length,
      count,
      `${file} must build every spawn env through ${builder}`,
    );
    assert.doesNotMatch(source, /\.\.\.process\.env/, `${file} must not spread process.env`);
    assert.doesNotMatch(
      source,
      /Object\.entries\(process\.env\)/,
      `${file} must not copy process.env manually`,
    );
    assert.doesNotMatch(
      source,
      /process\.env\.(APS|SBOX)_/,
      `${file} must not read inherited APS/SBOX settings directly`,
    );
  }
});
