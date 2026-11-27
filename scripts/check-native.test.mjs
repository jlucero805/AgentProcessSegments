// Offline guard for scripts/check-native.mjs. Module probes run against a stub
// `node_modules`, and the toolchain probes run against fake `make`/`g++`/
// `python3`/`npm` shell scripts, so no test needs a compiler, a real install,
// or network access.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  formatHuman,
  formatVersion,
  MIN_NPM_FOR_PYTHON_314,
  parseArgs,
  parseVersion,
  UsageError,
  versionAtLeast,
} from './check-native.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = path.join(repoRoot, 'scripts', 'check-native.mjs');
const posixOnly = { skip: process.platform === 'win32' };

const roots = [];

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writePackage(root, name, { version, main = 'index.js', source }) {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, main }));
  writeFileSync(path.join(dir, main), source);
}

/** A root whose native modules load. */
function goodRoot() {
  const root = tempDir('aps-native-good-');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stub', version: '0.0.0' }));
  writePackage(root, 'better-sqlite3', {
    version: '13.2.0',
    source: [
      'class Database {',
      "  constructor() { this.path = ':memory:'; }",
      "  prepare() { return { get: () => ({ v: '3.54.1' }) }; }",
      '  close() {}',
      '}',
      'module.exports = Database;',
      '',
    ].join('\n'),
  });
  writePackage(root, 'node-pty', {
    version: '1.1.0',
    source: 'module.exports = { spawn: () => ({}) };\n',
  });
  return root;
}

/** A bin dir with the four toolchain commands; `versions` overrides banners. */
function fakeBin({ make = 'GNU Make 4.4.1', gxx = 'g++ (stub) 15.2.0', python = 'Python 3.14.4', npm = '11.19.1' } = {}) {
  const dir = tempDir('aps-native-bin-');
  const shells = { make, 'g++': gxx, python3: python, npm };
  for (const [name, banner] of Object.entries(shells)) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${banner}'\n`, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  return dir;
}

function runCli(args, { pathEnv } = {}) {
  const env = { ...process.env };
  if (pathEnv !== undefined) env.PATH = pathEnv;
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`);
  return result;
}

function parseJson(result) {
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one JSON line, got: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

test('a root whose native modules load passes', posixOnly, () => {
  const root = goodRoot();
  const result = runCli(['--root', root], { pathEnv: fakeBin() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS better-sqlite3 13\.2\.0/);
  assert.match(result.stdout, /PASS node-pty 1\.1\.0/);
  assert.match(result.stdout, /OK: native modules load\./);
  assert.equal(result.stderr, '');
});

test('a missing module fails and still reports the module that loaded', posixOnly, () => {
  const root = goodRoot();
  rmSync(path.join(root, 'node_modules', 'node-pty'), { recursive: true, force: true });

  const result = runCli(['--root', root], { pathEnv: fakeBin() });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /PASS better-sqlite3 13\.2\.0/);
  assert.match(result.stdout, /FAIL node-pty: .*node-pty/);
  assert.match(result.stdout, /npm rebuild node-pty --foreground-scripts/);
  assert.match(result.stdout, /sudo apt-get install -y make g\+\+ python3/);
  assert.match(result.stdout, /needs npm >= 11\.7/);
  assert.match(result.stdout, /ENOSPC/);
});

test('a module that throws reports only the first line of the error', posixOnly, () => {
  const root = goodRoot();
  writePackage(root, 'node-pty', {
    version: '1.1.0',
    source: [
      "throw new Error('Failed to load native module: pty.node');",
      "console.log('unreachable');",
      '',
    ].join('\n'),
  });

  const result = runCli(['--root', root], { pathEnv: fakeBin() });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL node-pty 1\.1\.0: Failed to load native module: pty\.node/);
  assert.doesNotMatch(result.stdout, /at Module\._compile/);
  assert.equal(result.stderr, '');
});

test('--json prints one line whose exitCode matches the process exit', posixOnly, () => {
  const root = goodRoot();
  const ok = runCli(['--root', root, '--json'], { pathEnv: fakeBin() });
  assert.equal(ok.status, 0);
  const okJson = parseJson(ok);
  assert.equal(okJson.ok, true);
  assert.equal(okJson.exitCode, 0);
  assert.deepEqual(
    okJson.modules.map((module) => [module.name, module.ok]),
    [
      ['better-sqlite3', true],
      ['node-pty', true],
    ],
  );
  assert.deepEqual(okJson.toolchain.warnings, []);
  assert.equal(okJson.toolchain.python.version, '3.14.4');
  assert.equal(ok.stdout.includes(String.fromCharCode(27)), false);

  rmSync(path.join(root, 'node_modules', 'better-sqlite3'), { recursive: true, force: true });
  const failed = runCli(['--root', root, '--json'], { pathEnv: fakeBin() });
  assert.equal(failed.status, 1);
  const failedJson = parseJson(failed);
  assert.equal(failedJson.ok, false);
  assert.equal(failedJson.exitCode, 1);
  assert.equal(failedJson.modules[0].ok, false);
  assert.equal(typeof failedJson.modules[0].error, 'string');
});

test('Python 3.14 with npm older than the floor warns but does not fail', posixOnly, () => {
  const result = runCli(['--root', goodRoot()], { pathEnv: fakeBin({ npm: '11.6.0' }) });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /WARN python3 3\.14\.4 needs npm >= 11\.7\.0/);
  assert.match(result.stdout, /npm install -g npm@latest/);
});

test('Python 3.14 with a current npm does not warn', posixOnly, () => {
  const result = runCli(['--root', goodRoot()], {
    pathEnv: fakeBin({ npm: MIN_NPM_FOR_PYTHON_314 }),
  });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /needs npm/);
});

test('--toolchain-only skips the modules and needs no node_modules', posixOnly, () => {
  const root = tempDir('aps-native-empty-');
  const result = runCli(['--root', root, '--toolchain-only'], { pathEnv: fakeBin() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIP \(--toolchain-only\)/);
  assert.doesNotMatch(result.stdout, /PASS node-pty/);
});

test('an unknown flag is a usage error on stderr only', posixOnly, () => {
  const result = runCli(['--bogus']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown option: --bogus/);
  assert.match(result.stderr, /Usage: node scripts\/check-native\.mjs/);
});

test('a missing --root value and a missing root are usage errors', posixOnly, () => {
  const missingValue = runCli(['--root']);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /--root needs a directory/);

  const missingRoot = runCli(['--root', path.join(os.tmpdir(), 'aps-native-never-created')]);
  assert.equal(missingRoot.status, 2);
  assert.equal(missingRoot.stdout, '');
  assert.match(missingRoot.stderr, /root does not exist/);
});

test('parseArgs defaults to the repo root and accepts --root=', () => {
  const options = parseArgs([]);
  assert.equal(options.root, repoRoot);
  assert.equal(options.json, false);
  assert.equal(options.toolchainOnly, false);
  assert.equal(options.help, false);

  const custom = parseArgs(['--root=' + tempDir('aps-native-arg-'), '--json', '--toolchain-only']);
  assert.equal(custom.json, true);
  assert.equal(custom.toolchainOnly, true);

  assert.throws(() => parseArgs(['extra']), UsageError);
});

test('version helpers compare numerically', () => {
  assert.deepEqual(parseVersion('Python 3.14.4'), { major: 3, minor: 14, patch: 4 });
  assert.deepEqual(parseVersion('11.7'), { major: 11, minor: 7, patch: 0 });
  assert.equal(parseVersion('no numbers'), null);
  assert.equal(formatVersion(parseVersion('v12.4.0')), '12.4.0');
  assert.equal(formatVersion(null), null);

  assert.equal(versionAtLeast('11.7.0', '11.7.0'), true);
  assert.equal(versionAtLeast('11.19.1', '11.7.0'), true);
  assert.equal(versionAtLeast('11.6.0', '11.7.0'), false);
  assert.equal(versionAtLeast('9.99.0', '10.0.0'), false);
  assert.equal(versionAtLeast('3.14.0', '3.9.0'), true);
  assert.equal(versionAtLeast(null, '11.7.0'), false);
});

test('formatHuman names the failing module and the fix commands', () => {
  const text = formatHuman({
    root: '/tmp/stub-root',
    ok: false,
    modules: [
      { name: 'better-sqlite3', version: '13.2.0', ok: true, error: null },
      { name: 'node-pty', version: null, ok: false, error: 'Cannot find module' },
    ],
    toolchain: {
      skipped: false,
      make: { name: 'make', ok: true, version: '4.4.1' },
      gxx: { name: 'g++', ok: false, version: null },
      python: { name: 'python3', ok: true, version: '3.14.4' },
      npm: { name: 'npm', ok: true, version: '11.19.1' },
      warnings: [],
    },
    exitCode: 1,
  });

  assert.match(text, /^check-native: \/tmp\/stub-root\nNative modules\n/);
  assert.match(text, /PASS better-sqlite3 13\.2\.0/);
  assert.match(text, /FAIL node-pty: Cannot find module/);
  assert.match(text, /WARN g\+\+ not found/);
  assert.match(text, /FAIL: 1 native module failed to load\./);
  assert.match(text, /rm -rf node_modules && npm ci --include=dev/);
});
