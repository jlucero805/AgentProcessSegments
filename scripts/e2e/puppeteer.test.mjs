import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOW_MISSING_PUPPETEER,
  classifyPuppeteerLoad,
  describeMissingPuppeteer,
  parseScreenshotArgs,
  resolvePuppeteer,
  resolveUiSmokePuppeteer,
} from './puppeteer.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const outputs = [
  { label: 'docs/screenshots/board.png', file: '/repo/docs/screenshots/board.png' },
  { label: 'docs/screenshots/master.png', file: '/repo/docs/screenshots/master.png' },
  {
    label: 'docs/screenshots/help-getting-started.png',
    file: '/repo/docs/screenshots/help-getting-started.png',
  },
];
const BOARD_MTIME = Date.parse('2026-11-23T00:11:00.000Z');
const MASTER_MTIME = Date.parse('2026-11-24T09:30:00.000Z');
const HELP_MTIME = Date.parse('2026-11-27T03:45:00.000Z');

function statWith(times) {
  return (file) => {
    const mtimeMs = times[file];
    if (mtimeMs === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { mtimeMs };
  };
}

const knownOutputs = {
  '/repo/docs/screenshots/board.png': BOARD_MTIME,
  '/repo/docs/screenshots/master.png': MASTER_MTIME,
  '/repo/docs/screenshots/help-getting-started.png': HELP_MTIME,
};

function moduleNotFound(target, importer = '/repo/scripts/screenshots.mjs') {
  const error = new Error(`Cannot find package '${target}' imported from ${importer}`);
  error.code = 'ERR_MODULE_NOT_FOUND';
  return error;
}

function missingPuppeteer() {
  throw moduleNotFound('puppeteer');
}

function brokenLoader() {
  throw moduleNotFound('ws', '/repo/node_modules/puppeteer/lib/cjs/puppeteer/node.js');
}

/** A loader that records whether it was reached. */
function countingLoader(result) {
  const calls = { count: 0 };
  calls.load = async () => {
    calls.count += 1;
    if (result.error) throw result.error;
    return result.module;
  };
  return calls;
}

const fakeModule = { default: { launch: async () => {} } };

test('parseScreenshotArgs accepts the documented argument shapes', () => {
  assert.deepEqual(parseScreenshotArgs([]), { ok: true, allowMissing: false });
  assert.deepEqual(parseScreenshotArgs([ALLOW_MISSING_PUPPETEER]), {
    ok: true,
    allowMissing: true,
  });
});

test('parseScreenshotArgs rejects unknown and repeated flags', () => {
  const typo = parseScreenshotArgs(['--allow-missing-pupeteer']);
  assert.equal(typo.ok, false);
  assert.equal(typo.exitCode, 1);
  assert.match(typo.lines.join('\n'), /unknown argument "--allow-missing-pupeteer"/);
  assert.match(typo.lines.join('\n'), /usage: node scripts\/screenshots\.mjs/);

  const repeated = parseScreenshotArgs([ALLOW_MISSING_PUPPETEER, ALLOW_MISSING_PUPPETEER]);
  assert.equal(repeated.ok, false);
  assert.match(repeated.lines.join('\n'), /more than once/);
});

test('a missing puppeteer fails with install commands and the unrefreshed files', async () => {
  const result = await resolvePuppeteer({
    argv: [],
    outputs,
    load: missingPuppeteer,
    stat: statWith(knownOutputs),
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  const text = result.lines.join('\n');
  assert.match(text, /puppeteer is not installed/);
  assert.match(text, /NOT refreshed/);
  assert.match(text, /docs\/screenshots\/board\.png/);
  assert.match(text, /docs\/screenshots\/master\.png/);
  assert.match(text, /docs\/screenshots\/help-getting-started\.png/);
  assert.match(text, /npm install --no-save puppeteer/);
  assert.match(text, /npx puppeteer browsers install chrome/);
  assert.match(text, new RegExp(ALLOW_MISSING_PUPPETEER));
  assert.doesNotMatch(text, /SKIPPED/);
});

test('--allow-missing-puppeteer exits 0 with the current image timestamps', async () => {
  const result = await resolvePuppeteer({
    argv: [ALLOW_MISSING_PUPPETEER],
    outputs,
    load: missingPuppeteer,
    stat: statWith(knownOutputs),
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 0);
  const text = result.lines.join('\n');
  assert.match(text, /SKIPPED/);
  assert.match(text, /nothing was captured/);
  assert.match(text, /docs\/screenshots\/board\.png: unchanged since 2026-11-23T00:11:00\.000Z/);
  assert.match(text, /docs\/screenshots\/master\.png: unchanged since 2026-11-24T09:30:00\.000Z/);
  assert.match(
    text,
    /docs\/screenshots\/help-getting-started\.png: unchanged since 2026-11-27T03:45:00\.000Z/,
  );
});

test('a missing image renders as not present instead of a timestamp', () => {
  const result = describeMissingPuppeteer({
    allowMissing: true,
    outputs,
    stat: statWith({ '/repo/docs/screenshots/board.png': BOARD_MTIME }),
  });

  assert.equal(result.exitCode, 0);
  const text = result.lines.join('\n');
  assert.match(text, /board\.png: unchanged since/);
  assert.match(text, /master\.png: not present/);
  assert.match(text, /help-getting-started\.png: not present/);
});

test('a broken puppeteer install is not reported as missing', async () => {
  const classified = await classifyPuppeteerLoad(brokenLoader);
  assert.equal(classified.ok, false);
  assert.equal(classified.missing, false);

  const result = await resolvePuppeteer({
    argv: [],
    outputs,
    load: brokenLoader,
    stat: statWith(knownOutputs),
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  const text = result.lines.join('\n');
  assert.match(text, /puppeteer is installed but failed to load/);
  assert.match(text, /Cannot find package 'ws'/);
  assert.doesNotMatch(text, /not installed/);
  assert.doesNotMatch(text, /SKIPPED/);
});

test('a successful load captures even with the opt-out flag', async () => {
  const result = await resolvePuppeteer({
    argv: [ALLOW_MISSING_PUPPETEER],
    outputs,
    load: async () => fakeModule,
    stat: statWith(knownOutputs),
  });

  assert.equal(result.ok, true);
  assert.equal(result.puppeteer, fakeModule.default);
});

test('an unknown argument fails before the loader runs', async () => {
  const loader = countingLoader({ error: new Error('should not load') });
  const result = await resolvePuppeteer({
    argv: ['--allow-missing-pupeteer'],
    outputs,
    load: loader.load,
    stat: statWith(knownOutputs),
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(loader.count, 0);
  assert.match(result.lines.join('\n'), /usage: node scripts\/screenshots\.mjs/);
});

test('scripts/screenshots.mjs routes the decision through the guard', () => {
  const source = readFileSync(path.join(repoRoot, 'scripts', 'screenshots.mjs'), 'utf8');

  assert.match(source, /from '\.\/e2e\/puppeteer\.mjs'/);
  assert.match(source, /await resolvePuppeteer\(/);
  assert.doesNotMatch(source, /skipping screenshot capture/);
  assert.doesNotMatch(source, /process\.exit\(0\)/);
});

test('ui smoke: a missing puppeteer fails and says the smoke did not run', async () => {
  const result = await resolveUiSmokePuppeteer({ argv: [], load: missingPuppeteer });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  const text = result.lines.join('\n');
  assert.match(text, /ui smoke: puppeteer is not installed/);
  assert.match(text, /UI smoke did NOT run/);
  assert.match(text, /npm install --no-save puppeteer/);
  assert.match(text, /npx puppeteer browsers install chrome/);
  assert.match(text, new RegExp(ALLOW_MISSING_PUPPETEER));
  assert.doesNotMatch(text, /ui smoke ok/);
  assert.doesNotMatch(text, /SKIPPED/);
});

test('ui smoke: the opt-out skips loudly instead of reporting a pass', async () => {
  const result = await resolveUiSmokePuppeteer({
    argv: [ALLOW_MISSING_PUPPETEER],
    load: missingPuppeteer,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 0);
  const text = result.lines.join('\n');
  assert.match(text, /SKIPPED/);
  assert.match(text, /nothing was run/);
  assert.match(text, /not a pass/);
  assert.doesNotMatch(text, /ui smoke ok/);
});

test('ui smoke: a broken puppeteer install surfaces the underlying error', async () => {
  const result = await resolveUiSmokePuppeteer({ argv: [], load: brokenLoader });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  const text = result.lines.join('\n');
  assert.match(text, /ui smoke: puppeteer is installed but failed to load/);
  assert.match(text, /Cannot find package 'ws'/);
  assert.doesNotMatch(text, /not installed/);
  assert.doesNotMatch(text, /SKIPPED/);
});

test('ui smoke: unknown and repeated arguments fail before the loader runs', async () => {
  const loader = countingLoader({ error: new Error('should not load') });

  const unknown = await resolveUiSmokePuppeteer({
    argv: ['--allow-missing-pupeteer'],
    load: loader.load,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.exitCode, 1);
  assert.equal(loader.count, 0);
  assert.match(unknown.lines.join('\n'), /unknown argument "--allow-missing-pupeteer"/);
  assert.match(unknown.lines.join('\n'), /usage: node scripts\/ui-smoke\.mjs/);

  const repeated = await resolveUiSmokePuppeteer({
    argv: [ALLOW_MISSING_PUPPETEER, ALLOW_MISSING_PUPPETEER],
    load: loader.load,
  });
  assert.equal(repeated.ok, false);
  assert.equal(repeated.exitCode, 1);
  assert.equal(loader.count, 0);
  assert.match(repeated.lines.join('\n'), /more than once/);
});

test('ui smoke: a successful load runs even with the opt-out flag', async () => {
  const result = await resolveUiSmokePuppeteer({
    argv: [ALLOW_MISSING_PUPPETEER],
    load: async () => fakeModule,
  });

  assert.equal(result.ok, true);
  assert.equal(result.puppeteer, fakeModule.default);
});
