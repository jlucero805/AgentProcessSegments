// Offline guard for scripts/check-external-links.mjs. Every scan injects a fake
// fetcher, so no test opens a socket or depends on DNS.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
  UsageError,
  checkExternalLinks,
  classifyError,
  classifyResponse,
  main,
  normalizeExternalTarget,
  parseArgs,
  probeTarget,
} from './check-external-links.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempRoots = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-external-links-'));
  tempRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function response(status, headers = {}) {
  return { status, headers: new Headers(headers) };
}

function fakeFetcher(handler) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  fetcher.calls = calls;
  return fetcher;
}

function capture() {
  const chunks = [];
  return {
    write: (chunk) => chunks.push(String(chunk)),
    text: () => chunks.join(''),
  };
}

async function runCli(root, fetcher, args = []) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(['--root', root, ...args], { fetcher, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('arguments and target normalization', () => {
  it('parses defaults and flags', () => {
    assert.deepEqual(parseArgs([]), {
      root: repoRoot,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      concurrency: DEFAULT_CONCURRENCY,
      help: false,
    });
    assert.deepEqual(parseArgs(['--timeout-ms', '2500', '--concurrency=2', '--help']), {
      root: repoRoot,
      timeoutMs: 2500,
      concurrency: 2,
      help: true,
    });
    assert.equal(parseArgs(['--root', '/tmp/example']).root, '/tmp/example');
  });

  it('rejects bad arguments with a usage error', () => {
    for (const argv of [
      ['--concurrency', '0'],
      ['--timeout-ms', 'nope'],
      ['--concurrency='],
      ['--root'],
      ['--wat'],
      ['unexpected'],
    ]) {
      assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
    }
  });

  it('normalizes HTTP targets and ignores everything else', () => {
    assert.deepEqual(normalizeExternalTarget('https://Example.COM/a?x=1#frag'), {
      url: 'https://example.com/a?x=1',
      invalid: false,
    });
    assert.deepEqual(normalizeExternalTarget('//example.com/a'), {
      url: 'https://example.com/a',
      invalid: false,
    });
    assert.deepEqual(normalizeExternalTarget('https://'), { url: 'https://', invalid: true });
    for (const target of ['docs/a.md', '#anchor', '?help=guide', 'mailto:a@b.test', 'tel:123', 'file:///tmp/x']) {
      assert.equal(normalizeExternalTarget(target), null, target);
    }
  });
});

describe('response and error classification', () => {
  it('passes 2xx/3xx and fails 404/410', () => {
    assert.deepEqual(classifyResponse(response(200)), { verdict: 'ok' });
    assert.deepEqual(classifyResponse(response(204)), { verdict: 'ok' });
    assert.deepEqual(classifyResponse(response(301)), { verdict: 'ok' });
    assert.deepEqual(classifyResponse(response(404)), { verdict: 'dead', reason: 'HTTP 404' });
    assert.deepEqual(classifyResponse(response(410)), { verdict: 'dead', reason: 'HTTP 410' });
  });

  it('separates rate limits, other 4xx, and 5xx into skips', () => {
    assert.deepEqual(classifyResponse(response(403, { 'x-ratelimit-remaining': '0' })), {
      verdict: 'skip',
      reason: 'GitHub rate limit (x-ratelimit-remaining=0)',
    });
    assert.deepEqual(classifyResponse(response(429, { 'x-ratelimit-remaining': '0' })), {
      verdict: 'skip',
      reason: 'GitHub rate limit (x-ratelimit-remaining=0)',
    });
    assert.deepEqual(classifyResponse(response(429)), { verdict: 'skip', reason: 'HTTP 429' });
    assert.deepEqual(classifyResponse(response(403, { 'x-ratelimit-remaining': '7' })), {
      verdict: 'skip',
      reason: 'HTTP 403',
    });
    assert.deepEqual(classifyResponse(response(401)), { verdict: 'skip', reason: 'HTTP 401' });
    assert.deepEqual(classifyResponse(response(500)), { verdict: 'skip', reason: 'HTTP 500' });
  });

  it('classifies timeouts, DNS, and transport failures as dead', () => {
    assert.deepEqual(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 2000), {
      verdict: 'dead',
      reason: 'timed out after 2000 ms',
    });
    assert.deepEqual(classifyError(Object.assign(new Error('x'), { name: 'AbortError' })), {
      verdict: 'dead',
      reason: 'timed out after 10000 ms',
    });
    assert.deepEqual(
      classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })),
      { verdict: 'dead', reason: 'DNS lookup failed (ENOTFOUND)' },
    );
    assert.deepEqual(
      classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } })),
      { verdict: 'dead', reason: 'DNS lookup failed (EAI_AGAIN)' },
    );
    assert.deepEqual(
      classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
      { verdict: 'dead', reason: 'transport failed (ECONNREFUSED)' },
    );
    assert.deepEqual(
      classifyError(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }),
      ),
      { verdict: 'dead', reason: 'transport failed (CERT_HAS_EXPIRED)' },
    );
  });
});

describe('probing', () => {
  it('sends one HEAD with a user agent, redirects, and an abort signal', async () => {
    const fetcher = fakeFetcher(() => response(200));
    assert.deepEqual(await probeTarget(fetcher, 'https://example.com/'), { verdict: 'ok' });

    assert.equal(fetcher.calls.length, 1);
    const [{ init }] = fetcher.calls;
    assert.equal(init.method, 'HEAD');
    assert.equal(init.redirect, 'follow');
    assert.equal(init.headers['user-agent'], USER_AGENT);
    assert.ok(init.signal instanceof AbortSignal);
  });

  it('falls back to GET when HEAD is rejected', async () => {
    const fetcher = fakeFetcher((url, init) =>
      init.method === 'HEAD' ? response(405) : response(200),
    );
    assert.deepEqual(await probeTarget(fetcher, 'https://example.com/'), { verdict: 'ok' });
    assert.deepEqual(
      fetcher.calls.map((call) => call.init.method),
      ['HEAD', 'GET'],
    );
  });

  it('falls back to GET for a non-rate-limit 403', async () => {
    const fetcher = fakeFetcher((url, init) =>
      init.method === 'HEAD' ? response(403) : response(200),
    );
    assert.deepEqual(await probeTarget(fetcher, 'https://example.com/'), { verdict: 'ok' });
    assert.deepEqual(
      fetcher.calls.map((call) => call.init.method),
      ['HEAD', 'GET'],
    );
  });

  it('does not retry a GitHub rate-limited HEAD', async () => {
    const fetcher = fakeFetcher(() => response(403, { 'x-ratelimit-remaining': '0' }));
    assert.deepEqual(await probeTarget(fetcher, 'https://api.github.com/x'), {
      verdict: 'skip',
      reason: 'GitHub rate limit (x-ratelimit-remaining=0)',
    });
    assert.equal(fetcher.calls.length, 1);
  });

  it('does not retry a dead HEAD', async () => {
    const fetcher = fakeFetcher(() => response(404));
    assert.deepEqual(await probeTarget(fetcher, 'https://example.com/gone'), {
      verdict: 'dead',
      reason: 'HTTP 404',
    });
    assert.equal(fetcher.calls.length, 1);
  });
});

describe('scanning and reporting', () => {
  it('dedupes requests but reports every reference, sorted by file and line', async () => {
    const root = makeRoot({
      'docs/b.md': '[b](https://b.example/gone)\n',
      'docs/a.md': [
        '[first](https://example.com/gone)',
        '[fragment](https://example.com/gone#section)',
        '[a](https://a.example/gone)',
        '',
      ].join('\n'),
    });
    const fetcher = fakeFetcher(() => response(404));

    const { code, stdout } = await runCli(root, fetcher);
    assert.equal(code, 1);
    assert.equal(fetcher.calls.length, 3);
    assert.match(stdout, /docs\/a\.md:1: https:\/\/example\.com\/gone — HTTP 404/);
    assert.match(stdout, /docs\/a\.md:2: https:\/\/example\.com\/gone — HTTP 404/);
    assert.ok(stdout.indexOf('docs/a.md:1:') < stdout.indexOf('docs/a.md:3:'));
    assert.ok(stdout.indexOf('docs/a.md:3:') < stdout.indexOf('docs/b.md:1:'));
    assert.match(
      stdout,
      /checked 3 unique external URLs across 4 references in 2 files: 0 ok, 3 dead, 0 skipped\./,
    );
  });

  it('exits 0 with a summary when every target is reachable', async () => {
    const root = makeRoot({ 'docs/a.md': '[ok](https://example.com/)\n' });
    const fetcher = fakeFetcher(() => response(200));

    const { code, stdout } = await runCli(root, fetcher);
    assert.equal(code, 0);
    assert.equal(
      stdout,
      'checked 1 unique external URLs across 1 references in 1 files: 1 ok, 0 dead, 0 skipped.\n',
    );
  });

  it('prints rate limits as skips and still exits 0', async () => {
    const root = makeRoot({ 'docs/a.md': '[api](https://api.github.com/repos/x/y)\n' });
    const fetcher = fakeFetcher(() => response(403, { 'x-ratelimit-remaining': '0' }));

    const { code, stdout } = await runCli(root, fetcher);
    assert.equal(code, 0);
    assert.match(
      stdout,
      /skip docs\/a\.md:1: https:\/\/api\.github\.com\/repos\/x\/y — GitHub rate limit/,
    );
    assert.match(stdout, /0 ok, 0 dead, 1 skipped\./);
  });

  it('prints a zero summary and makes no request when there are no external targets', async () => {
    const root = makeRoot({
      'docs/a.md': '[local](other.md)\n',
      'docs/other.md': '# Other\n',
    });
    const fetcher = fakeFetcher(() => response(200));

    const { code, stdout } = await runCli(root, fetcher);
    assert.equal(code, 0);
    assert.equal(fetcher.calls.length, 0);
    assert.match(stdout, /no external http\(s\) links found\./);
    assert.match(stdout, /checked 0 unique external URLs across 0 references in 0 files: 0 ok, 0 dead, 0 skipped\./);
  });

  it('reports a malformed http(s) target as dead without fetching', async () => {
    const root = makeRoot({ 'docs/a.md': '[bad](https://)\n' });
    const fetcher = fakeFetcher(() => response(200));

    const { code, stdout } = await runCli(root, fetcher);
    assert.equal(code, 1);
    assert.equal(fetcher.calls.length, 0);
    assert.match(stdout, /docs\/a\.md:1: https:\/\/ — invalid URL/);
  });

  it('bounds a hanging request and reports a timeout', async () => {
    const root = makeRoot({ 'docs/a.md': '[slow](https://slow.example/)\n' });
    const fetcher = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
          { once: true },
        );
      });

    const started = Date.now();
    const { code, stdout } = await runCli(root, fetcher, ['--timeout-ms', '50']);
    assert.equal(code, 1);
    assert.match(stdout, /timed out after 50 ms/);
    assert.ok(Date.now() - started < 5000);
  });

  it('never exceeds the requested concurrency', async () => {
    const root = makeRoot({
      'docs/a.md': [
        '[1](https://one.example/)',
        '[2](https://two.example/)',
        '[3](https://three.example/)',
        '[4](https://four.example/)',
        '',
      ].join('\n'),
    });
    let active = 0;
    let peak = 0;
    const fetcher = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return response(200);
    };

    const report = await checkExternalLinks({ root, fetcher, concurrency: 2 });
    assert.equal(report.summary.ok, 4);
    assert.equal(peak, 2);
  });

  it('handles --help and bad arguments with the documented exit codes', async () => {
    const stdout = capture();
    const stderr = capture();
    assert.equal(await main(['--help'], { stdout, stderr }), 0);
    assert.match(stdout.text(), /Usage: node scripts\/check-external-links\.mjs/);

    for (const argv of [['--concurrency', '0'], ['--timeout-ms', 'nope'], ['--wat']]) {
      const out = capture();
      const err = capture();
      assert.equal(await main(argv, { stdout: out, stderr: err }), 2, argv.join(' '));
      assert.match(err.text(), /check:docs:external:/);
    }

    const missing = await main(['--root', path.join(repoRoot, 'no-such-directory')], {
      stdout: capture(),
      stderr: capture(),
    });
    assert.equal(missing, 2);
  });
});

describe('gate isolation', () => {
  it('keeps the network checker out of the default gates and CI', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['check:docs:external'], 'node scripts/check-external-links.mjs');
    for (const name of ['test', 'lint', 'check:docs']) {
      assert.doesNotMatch(pkg.scripts[name], /check:docs:external/);
      assert.doesNotMatch(pkg.scripts[name], /scripts\/check-external-links\.mjs/);
    }
    assert.equal(pkg.scripts['check:docs'], 'npm test --workspace src/web -- doc-links');
    assert.match(pkg.scripts['test:e2e-env'], /scripts\/check-external-links\.test\.mjs/);

    // The checker is dependency-free: only Node built-ins and the shared core.
    const source = readFileSync(path.join(repoRoot, 'scripts/check-external-links.mjs'), 'utf8');
    const specifiers = [...source.matchAll(/^import\s[^']*?from\s+'([^']+)'/gm)].map(
      (match) => match[1],
    );
    assert.ok(specifiers.length > 0);
    for (const specifier of specifiers) assert.match(specifier, /^(node:|\.)/, specifier);

    for (const workflow of ['.github/workflows/ci.yml', 'deploy/ci-workflow.yml']) {
      const text = readFileSync(path.join(repoRoot, workflow), 'utf8');
      assert.doesNotMatch(text, /check:docs:external/);
      assert.doesNotMatch(text, /scripts\/check-external-links\.mjs/);
    }
  });
});
