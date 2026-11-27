import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkExternalTargets,
  externalTargets,
  formatExternalReport,
  type ExternalFetch,
  type ExternalTarget,
} from './doc-links-external';

const repoRoot = path.resolve(process.cwd(), '../..');
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-external-links-'));
  tempRoots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const absolute = path.join(root, name);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function target(file: string, line: number, url: string): ExternalTarget {
  return { file, line, target: url };
}

function recordingFetch(handler: (url: string, init: RequestInit) => { status: number }): {
  fetch: ExternalFetch;
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, method: String(init.method) });
      return Promise.resolve(handler(url, init));
    },
  };
}

describe('external link collection', () => {
  it('collects every external destination form and skips code and non-HTTP schemes', () => {
    const root = fixture({
      'docs/links.md': [
        '# Links',
        '',
        '[external](https://docs.acme.com/a)',
        '![img](https://docs.acme.com/i.png)',
        '<a href="https://docs.acme.com/h">h</a>',
        '<img src="https://docs.acme.com/s.png">',
        '[ref]: https://docs.acme.com/r',
        '[local](b.md)',
        '[anchor](#top)',
        '[help](?help=getting-started)',
        '[mail](mailto:x@y.z)',
        '[data](data:text/plain,x)',
        '[ftp](ftp://docs.acme.com/file)',
        '`[code](https://docs.acme.com/code)`',
        '```md',
        '[fenced](https://docs.acme.com/fenced)',
        '```',
        '[proto](//docs.acme.com/proto)',
      ].join('\n'),
    });

    expect(externalTargets(root)).toEqual([
      { file: 'docs/links.md', line: 3, target: 'https://docs.acme.com/a' },
      { file: 'docs/links.md', line: 4, target: 'https://docs.acme.com/i.png' },
      { file: 'docs/links.md', line: 5, target: 'https://docs.acme.com/h' },
      { file: 'docs/links.md', line: 6, target: 'https://docs.acme.com/s.png' },
      { file: 'docs/links.md', line: 7, target: 'https://docs.acme.com/r' },
      { file: 'docs/links.md', line: 18, target: '//docs.acme.com/proto' },
    ]);
  });

  it('reports an unparseable external target without requesting it', async () => {
    const { fetch, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await checkExternalTargets([target('docs/x.md', 1, 'https://<host>/x')], {
      fetch,
      retryDelayMs: 0,
    });

    expect(calls).toEqual([]);
    expect(result.checked).toBe(0);
    expect(result.problems).toEqual([
      { file: 'docs/x.md', line: 1, target: 'https://<host>/x', reason: 'invalid URL', severity: 'dead' },
    ]);
  });

  it('skips non-public and reserved example hosts without requesting them', async () => {
    const { fetch, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await checkExternalTargets(
      [
        target('docs/x.md', 1, 'http://127.0.0.1:7391/health'),
        target('docs/x.md', 2, 'http://localhost/x'),
        target('docs/x.md', 3, 'http://intranet/x'),
        target('docs/x.md', 4, 'https://printer.local/x'),
        target('docs/x.md', 5, 'https://example.com/x'),
        target('docs/x.md', 6, 'https://docs.example.test/x'),
      ],
      { fetch, retryDelayMs: 0 },
    );

    expect(calls).toEqual([]);
    expect(result.checked).toBe(0);
    expect(result.problems).toEqual([]);
    expect(result.skipped.map((entry) => [entry.line, entry.reason])).toEqual([
      [1, 'non-public host'],
      [2, 'non-public host'],
      [3, 'non-public host'],
      [4, 'non-public host'],
      [5, 'reserved example host'],
      [6, 'reserved example host'],
    ]);
  });
});

describe('external link probing', () => {
  it('maps final statuses to ok, dead, and unverified', async () => {
    const statuses = [200, 204, 301, 400, 404, 410, 500, 401, 403, 405, 429];
    const { fetch } = recordingFetch((url) => ({
      status: Number(new URL(url).pathname.slice(1)),
    }));
    const result = await checkExternalTargets(
      statuses.map((status) => target('docs/x.md', status, `https://docs.acme.com/${status}`)),
      { fetch, retries: 1, retryDelayMs: 0 },
    );

    expect(result.problems.filter((problem) => problem.severity === 'dead').map((p) => p.reason)).toEqual([
      'HTTP 400',
      'HTTP 404',
      'HTTP 410',
      'HTTP 500',
    ]);
    expect(
      result.problems.filter((problem) => problem.severity === 'unverified').map((p) => p.reason),
    ).toEqual(['HTTP 401', 'HTTP 403', 'HTTP 405', 'HTTP 429']);
    expect(result.problems.some((problem) => ['HTTP 200', 'HTTP 204', 'HTTP 301'].includes(problem.reason))).toBe(false);
    expect(result.checked).toBe(statuses.length);
  });

  it('falls back to GET when HEAD is rejected or throws, and not after a 404', async () => {
    const fallback = async (head: { status: number } | Error): Promise<string[]> => {
      const calls: string[] = [];
      const fetch: ExternalFetch = (_url, init) => {
        const method = String(init.method);
        calls.push(method);
        if (method === 'HEAD') {
          if (head instanceof Error) return Promise.reject(head);
          return Promise.resolve({ status: head.status });
        }
        return Promise.resolve({ status: 200 });
      };
      const result = await checkExternalTargets([target('docs/x.md', 1, 'https://docs.acme.com/x')], {
        fetch,
        retries: 0,
        retryDelayMs: 0,
      });
      expect(result.problems).toEqual([]);
      return calls;
    };

    expect(await fallback({ status: 405 })).toEqual(['HEAD', 'GET']);
    expect(await fallback({ status: 403 })).toEqual(['HEAD', 'GET']);
    expect(await fallback(new Error('connection reset'))).toEqual(['HEAD', 'GET']);

    const calls: string[] = [];
    const fetch: ExternalFetch = (_url, init) => {
      calls.push(String(init.method));
      return Promise.resolve({ status: 404 });
    };
    const result = await checkExternalTargets([target('docs/x.md', 1, 'https://docs.acme.com/x')], {
      fetch,
      retries: 0,
      retryDelayMs: 0,
    });
    expect(calls).toEqual(['HEAD']);
    expect(result.problems[0]?.reason).toBe('HTTP 404');
  });

  it('retries network errors, 429, and 5xx once, then settles on the last result', async () => {
    const run = async (
      handler: () => { status: number },
    ): Promise<{ calls: number; result: Awaited<ReturnType<typeof checkExternalTargets>> }> => {
      let calls = 0;
      const fetch: ExternalFetch = () => {
        calls += 1;
        try {
          return Promise.resolve(handler());
        } catch (error) {
          return Promise.reject(error);
        }
      };
      const result = await checkExternalTargets([target('docs/x.md', 1, 'https://docs.acme.com/x')], {
        fetch,
        retries: 1,
        retryDelayMs: 0,
      });
      return { calls, result };
    };

    const network = Object.assign(new Error('getaddrinfo'), { cause: { code: 'ENOTFOUND' } });
    const failedNetwork = await run(() => {
      throw network;
    });
    expect(failedNetwork.calls).toBe(2);
    expect(failedNetwork.result.problems[0]?.reason).toBe('request failed: ENOTFOUND');

    const failedServer = await run(() => ({ status: 500 }));
    expect(failedServer.calls).toBe(2);
    expect(failedServer.result.problems[0]).toMatchObject({ reason: 'HTTP 500', severity: 'dead' });

    const limited = await run(() => ({ status: 429 }));
    expect(limited.calls).toBe(2);
    expect(limited.result.problems[0]).toMatchObject({ reason: 'HTTP 429', severity: 'unverified' });

    let attempt = 0;
    const recovered = await run(() => {
      attempt += 1;
      return { status: attempt === 1 ? 500 : 200 };
    });
    expect(recovered.calls).toBe(2);
    expect(recovered.result.problems).toEqual([]);
  });

  it('names timeouts and transport causes', async () => {
    const run = async (error: Error) => {
      const fetch: ExternalFetch = () => Promise.reject(error);
      return checkExternalTargets([target('docs/x.md', 1, 'https://docs.acme.com/x')], {
        fetch,
        retries: 0,
        retryDelayMs: 0,
      });
    };

    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect((await run(timeout)).problems[0]?.reason).toBe('request failed: timeout');

    const dns = Object.assign(new Error('getaddrinfo'), { cause: { code: 'ENOTFOUND' } });
    expect((await run(dns)).problems[0]?.reason).toBe('request failed: ENOTFOUND');
  });

  it('requests each unique URL once and reports every occurrence', async () => {
    const { fetch, calls } = recordingFetch(() => ({ status: 404 }));
    const result = await checkExternalTargets(
      [
        target('docs/b.md', 2, 'https://docs.acme.com/x?q=1#top'),
        target('docs/a.md', 5, 'https://docs.acme.com/x?q=1'),
      ],
      { fetch, retries: 0, retryDelayMs: 0 },
    );

    expect(calls).toEqual([{ url: 'https://docs.acme.com/x?q=1', method: 'HEAD' }]);
    expect(result.checked).toBe(1);
    expect(result.problems).toEqual([
      { file: 'docs/a.md', line: 5, target: 'https://docs.acme.com/x?q=1', reason: 'HTTP 404', severity: 'dead' },
      {
        file: 'docs/b.md',
        line: 2,
        target: 'https://docs.acme.com/x?q=1#top',
        reason: 'HTTP 404',
        severity: 'dead',
      },
    ]);
  });

  it('probes protocol-relative targets over https', async () => {
    const { fetch, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await checkExternalTargets([target('docs/x.md', 1, '//docs.acme.com/p')], {
      fetch,
      retryDelayMs: 0,
    });

    expect(calls).toEqual([{ url: 'https://docs.acme.com/p', method: 'HEAD' }]);
    expect(result.problems).toEqual([]);
  });

  it('never runs more than the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch: ExternalFetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { status: 200 };
    };
    const targets = Array.from({ length: 6 }, (_value, index) =>
      target('docs/x.md', index + 1, `https://docs.acme.com/${index}`),
    );

    const result = await checkExternalTargets(targets, { fetch, concurrency: 2 });

    expect(result.checked).toBe(6);
    expect(peak).toBe(2);
  });

  it('sorts findings and summarizes them in the report', async () => {
    const { fetch } = recordingFetch(() => ({ status: 404 }));
    const result = await checkExternalTargets(
      [
        target('docs/b.md', 5, 'https://docs.acme.com/z'),
        target('docs/a.md', 2, 'https://docs.acme.com/y'),
      ],
      { fetch, retries: 0, retryDelayMs: 0 },
    );

    expect(result.problems.map((problem) => `${problem.file}:${problem.line}`)).toEqual([
      'docs/a.md:2',
      'docs/b.md:5',
    ]);
    const report = formatExternalReport(result);
    expect(report).toContain('external links: 2 checked, 0 skipped, 2 dead, 0 unverified');
    expect(report).toContain('docs/a.md:2: https://docs.acme.com/y — HTTP 404 (dead)');
  });

  it('exposes the documented opt-in shortcut', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['check:docs:external']).toBe(
      'APS_CHECK_DOCS_EXTERNAL=1 npm test --workspace src/web -- doc-links-external --reporter=verbose',
    );
  });
});

describe('the real documentation corpus', () => {
  it.runIf(process.env.APS_CHECK_DOCS_EXTERNAL === '1')(
    'has no dead external links',
    async () => {
      const targets = externalTargets(repoRoot);
      const result = await checkExternalTargets(targets);
      console.log(formatExternalReport(result));
      expect(result.problems.filter((problem) => problem.severity === 'dead')).toEqual([]);
    },
    120_000,
  );
});
