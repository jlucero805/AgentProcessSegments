// End-to-end guard for scripts/screenshots.mjs: a skipped capture must never
// look like a refresh of the committed images. The policy itself is unit-tested
// in scripts/e2e/puppeteer.test.mjs; this file spawns the real script with a
// module-resolution hook, so the top-level wiring, exit code, output stream, and
// untouched PNGs are proven without Puppeteer, Chrome, or a built app.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(repoRoot, 'scripts', 'screenshots.mjs');
const images = [
  'docs/screenshots/board.png',
  'docs/screenshots/master.png',
  'docs/screenshots/help-getting-started.png',
].map((label) => ({ label, file: path.join(repoRoot, label) }));

function snapshotImages() {
  return images.map(({ file }) => {
    const { mtimeMs, size } = statSync(file);
    return { mtimeMs, size };
  });
}

const MISSING_MODULE_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'puppeteer') {
    const error = new Error(
      "Cannot find package 'puppeteer' imported from /repo/scripts/screenshots.mjs",
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

function runScreenshots(t, hook, args = []) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aps-screenshots-test-'));
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

test('a missing puppeteer fails and leaves the committed images untouched', (t) => {
  const before = snapshotImages();
  const result = runScreenshots(t, MISSING_MODULE_HOOK);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /puppeteer is not installed/);
  assert.match(result.stderr, /NOT refreshed/);
  for (const { label } of images) {
    assert.match(result.stderr, new RegExp(`${label}: not refreshed`));
  }
  assert.match(result.stderr, /npm install --no-save puppeteer/);
  assert.match(result.stderr, /npx puppeteer browsers install chrome/);
  assert.deepEqual(snapshotImages(), before);
});

test('the deliberate skip exits 0 but reports each image timestamp', (t) => {
  const before = snapshotImages();
  const result = runScreenshots(t, MISSING_MODULE_HOOK, ['--allow-missing-puppeteer']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /SKIPPED/);
  assert.match(result.stderr, /nothing was captured/);
  for (const { label } of images) {
    assert.match(result.stderr, new RegExp(`${label}: unchanged since `));
  }
  assert.deepEqual(snapshotImages(), before);
});

test('a broken puppeteer install fails with the underlying error', (t) => {
  const before = snapshotImages();
  const result = runScreenshots(t, BROKEN_INSTALL_HOOK);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /puppeteer is installed but failed to load/);
  assert.match(result.stderr, /simulated broken puppeteer install/);
  assert.match(result.stderr, /npm install --no-save puppeteer/);
  assert.deepEqual(snapshotImages(), before);
});

test('an unknown argument fails before Puppeteer is loaded', (t) => {
  const before = snapshotImages();
  const result = runScreenshots(t, MISSING_MODULE_HOOK, ['--allow-missing-pupeteer']);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown argument "--allow-missing-pupeteer"/);
  assert.match(result.stderr, /usage: node scripts\/screenshots\.mjs/);
  assert.deepEqual(snapshotImages(), before);
});
