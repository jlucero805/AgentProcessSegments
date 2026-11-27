// End-to-end guard for scripts/ui-smoke.mjs: a run that never launched a browser
// must not look like a pass. The policy itself is unit-tested in
// scripts/e2e/puppeteer.test.mjs; this file spawns the real script with a
// module-resolution hook, so the top-level wiring, exit code, output stream, and
// no-brain behavior are proven without Puppeteer, Chrome, or a built app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(repoRoot, 'scripts', 'ui-smoke.mjs');

const MISSING_MODULE_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'puppeteer') {
    const error = new Error(
      "Cannot find package 'puppeteer' imported from /repo/scripts/ui-smoke.mjs",
    );
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return nextResolve(specifier, context);
}
`;

const BROKEN_INSTALL_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'puppeteer') throw new Error('simulated broken puppeteer install');
  return nextResolve(specifier, context);
}
`;

function runUiSmoke(t, hook, args = []) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aps-ui-smoke-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(path.join(temp, 'hooks.mjs'), hook);
  writeFileSync(
    path.join(temp, 'register.mjs'),
    "import { register } from 'node:module';\n" +
      "register(new URL('./hooks.mjs', import.meta.url));\n",
  );
  const register = pathToFileURL(path.join(temp, 'register.mjs')).href;
  const result = spawnSync(process.execPath, ['--import', register, script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`);
  return result;
}

test('a missing puppeteer fails and never claims the UI smoke passed', (t) => {
  const result = runUiSmoke(t, MISSING_MODULE_HOOK);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ui smoke: puppeteer is not installed/);
  assert.match(result.stderr, /UI smoke did NOT run/);
  assert.match(result.stderr, /npm install --no-save puppeteer/);
  assert.match(result.stderr, /npx puppeteer browsers install chrome/);
  assert.match(result.stderr, /--allow-missing-puppeteer/);
  assert.doesNotMatch(result.stderr, /ui smoke ok/);
});

test('the deliberate skip exits 0 but says nothing ran', (t) => {
  const result = runUiSmoke(t, MISSING_MODULE_HOOK, ['--allow-missing-puppeteer']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /SKIPPED/);
  assert.match(result.stderr, /nothing was run/);
  assert.match(result.stderr, /not a pass/);
  assert.doesNotMatch(result.stderr, /ui smoke ok/);
});

test('a broken puppeteer install fails with the underlying error', (t) => {
  const result = runUiSmoke(t, BROKEN_INSTALL_HOOK);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /puppeteer is installed but failed to load/);
  assert.match(result.stderr, /simulated broken puppeteer install/);
  assert.doesNotMatch(result.stderr, /not installed/);
  assert.doesNotMatch(result.stderr, /ui smoke ok/);
});

test('an unknown argument fails before Puppeteer is loaded', (t) => {
  const result = runUiSmoke(t, BROKEN_INSTALL_HOOK, ['--allow-missing-pupeteer']);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown argument "--allow-missing-pupeteer"/);
  assert.match(result.stderr, /usage: node scripts\/ui-smoke\.mjs/);
  assert.doesNotMatch(result.stderr, /simulated broken puppeteer install/);
  assert.doesNotMatch(result.stderr, /ui smoke ok/);
});

test('scripts/ui-smoke.mjs routes the decision through the guard', () => {
  const source = readFileSync(script, 'utf8');

  assert.match(source, /from '\.\/e2e\/puppeteer\.mjs'/);
  assert.match(source, /await resolveUiSmokePuppeteer\(/);
  assert.doesNotMatch(source, /skipping UI smoke/);
  assert.doesNotMatch(source, /process\.exit\(0\)/);
});

test('ui smoke removes its artifacts through the shared cleanup path', () => {
  const source = readFileSync(script, 'utf8');

  assert.match(source, /from '\.\/e2e\/ui-smoke-cleanup\.mjs'/);
  assert.match(source, /cleanupUiSmokeArtifacts\(/);
  assert.match(source, /from '\.\/e2e\/signal-cleanup\.mjs'/);
  assert.match(source, /createSignalCleanup\(/);
  assert.match(source, /handleSIGINT: false/);
  assert.match(source, /handleSIGTERM: false/);
  assert.match(source, /signalCleanup\.run\(\)/);
  assert.match(source, /baselineRequestIds/);
  assert.match(source, /baselineCellIds/);
  assert.match(source, /if \(cleanupFailed\)/);

  assert.doesNotMatch(source, /list\.find\(\(request\) => request\.title === 'Browser smoke'\)/);
  assert.doesNotMatch(source, /cells\.find\(\(cell\) => cell\.name === 'Smoke cell'\)/);
  assert.doesNotMatch(source, /\/drop`, \{ method: 'POST' \}/);
});

function productionWebSource() {
  const webRoot = path.join(repoRoot, 'src', 'web', 'src');
  const files = readdirSync(webRoot, { recursive: true }).filter(
    (file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'),
  );
  return files.map((file) => readFileSync(path.join(webRoot, file), 'utf8')).join('\n');
}

test('ui smoke locates elements through data-testid hooks that exist in the SPA', () => {
  const source = readFileSync(script, 'utf8');
  const hooks = [
    ...new Set(
      [...source.matchAll(/data-testid(?:[\^$*]?=)"([^"]+)"/g)].map((match) => match[1]),
    ),
  ];

  assert.ok(
    hooks.length >= 20,
    `expected at least 20 data-testid hooks in the smoke, found ${hooks.length}`,
  );

  const web = productionWebSource();
  for (const hook of hooks) {
    const present =
      web.includes(`data-testid="${hook}"`) ||
      web.includes(`testId="${hook}"`) ||
      web.includes('data-testid={`' + hook);
    assert.ok(
      present,
      `ui-smoke uses data-testid "${hook}" but no production web component defines it`,
    );
  }
});

test('ui smoke does not match visible UI copy', () => {
  const source = readFileSync(script, 'utf8');

  assert.doesNotMatch(source, /function\s+(?:hasText|clickText)\s*\(/);
  for (const line of source.split('\n')) {
    assert.ok(
      !(line.includes('document.body.innerText') && line.includes('.includes(')),
      `ui-smoke must not match body copy: ${line.trim()}`,
    );
  }
});
