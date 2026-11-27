#!/usr/bin/env node
// Opt-in external documentation link checker.
//
// The default docs gate (src/web/src/doc-links.ts) never touches the network.
// This script reuses its extraction logic and probes each unique external
// HTTP(S) destination so link rot can be found manually or on a schedule.
// It is deliberately not part of `npm test`, `npm run lint`,
// `npm run check:docs`, or CI's required gate: results depend on the network
// and on third-party rate limits.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectDocLinks, isExternalHref } from '../src/web/src/doc-links-core.mjs';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 4;
export const USER_AGENT =
  'agent-process-segments-doc-link-check/1.0 (+https://github.com/jlucero805/AgentProcessSegments)';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export class UsageError extends Error {}

const USAGE = `Usage: node scripts/check-external-links.mjs [options]

Fetch every external HTTP(S) link destination in the Markdown corpus and report
dead ones. This is a manual/periodic check; it is never part of npm test,
npm run lint, npm run check:docs, or CI.

Options:
  --root <dir>        Repository root to scan (default: this checkout)
  --timeout-ms <n>    Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --concurrency <n>   Maximum in-flight requests (default: ${DEFAULT_CONCURRENCY})
  -h, --help          Show this help

Output:
  Dead links are printed as "file:line: URL — reason".
  Rate limits and unverified HTTP statuses are printed as
  "skip file:line: URL — reason".
  The final line summarizes unique URLs, references, and files.

Classification:
  2xx/3xx pass. 404/410, DNS failures, timeouts, TLS/connection failures, and
  invalid URLs are dead. A 403 or 429 with x-ratelimit-remaining: 0 is a GitHub
  rate-limit skip. Other 4xx/5xx responses are skips, not failures.

Exit codes: 0 clean, 1 dead links found, 2 bad arguments or unreadable corpus.`;

function parsePositiveInt(flag, value) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new UsageError(`${flag} needs a positive integer`);
  }
  return Number(value);
}

/** Parse CLI arguments without touching the filesystem. */
export function parseArgs(argv) {
  const options = {
    root: repoRoot,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--root' || arg === '--timeout-ms' || arg === '--concurrency') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === '') throw new UsageError(`${arg} needs a value`);
      if (arg === '--root') options.root = path.resolve(value);
      else if (arg === '--timeout-ms') options.timeoutMs = parsePositiveInt(arg, value);
      else options.concurrency = parsePositiveInt(arg, value);
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (value === '') throw new UsageError('--root needs a value');
      options.root = path.resolve(value);
    } else if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = parsePositiveInt('--timeout-ms', arg.slice('--timeout-ms='.length));
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = parsePositiveInt('--concurrency', arg.slice('--concurrency='.length));
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      throw new UsageError(`unexpected argument ${arg}`);
    }
  }

  return options;
}

/**
 * Turn a raw Markdown destination into the URL this checker should probe.
 * Returns null for local paths and non-HTTP schemes. An http(s) target that
 * cannot be parsed is returned as `{ invalid: true }` so it can be reported.
 */
export function normalizeExternalTarget(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const protocolRelative = trimmed.startsWith('//');
  if (!isExternalHref(trimmed) && !protocolRelative) return null;

  const candidate = protocolRelative ? `https:${trimmed}` : trimmed;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    // A malformed mailto:/tel: target is not ours; a malformed http(s) one is
    // a real broken link.
    if (/^https?:/i.test(candidate)) return { url: trimmed, invalid: true };
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  return { url: url.href, invalid: false };
}

function rateLimited(headers) {
  return (
    headers !== undefined &&
    typeof headers.get === 'function' &&
    headers.get('x-ratelimit-remaining') === '0'
  );
}

/** Classify an HTTP response without knowing which URL produced it. */
export function classifyResponse(response) {
  const status = response.status;
  if (status >= 200 && status < 400) return { verdict: 'ok' };
  if (status === 404 || status === 410) return { verdict: 'dead', reason: `HTTP ${status}` };
  if ((status === 403 || status === 429) && rateLimited(response.headers)) {
    return { verdict: 'skip', reason: 'GitHub rate limit (x-ratelimit-remaining=0)' };
  }
  if (status === 429) return { verdict: 'skip', reason: 'HTTP 429' };
  return { verdict: 'skip', reason: `HTTP ${status}` };
}

function errorCode(error) {
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return null;
}

/** Classify a fetch rejection. Only transport-level failures are dead. */
export function classifyError(error, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const name = error?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { verdict: 'dead', reason: `timed out after ${timeoutMs} ms` };
  }

  const code = errorCode(error);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { verdict: 'dead', reason: `DNS lookup failed (${code})` };
  }
  if (code !== null && /TIMEOUT/i.test(code)) {
    return { verdict: 'dead', reason: `timed out after ${timeoutMs} ms` };
  }

  const detail = code ?? (error instanceof Error ? error.message : String(error));
  return { verdict: 'dead', reason: `transport failed (${detail})` };
}

async function request(fetcher, url, method, timeoutMs) {
  try {
    const response = await fetcher(url, {
      method,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // We only need the status line. Cancelling the body frees the socket
    // instead of buffering a potentially large page.
    const body = response.body;
    if (body !== undefined && body !== null && typeof body.cancel === 'function') {
      try {
        await body.cancel();
      } catch {
        // A body that cannot be cancelled is harmless; the request is done.
      }
    }
    return { response };
  } catch (error) {
    return { error };
  }
}

/** Probe one URL with HEAD, falling back to GET only when HEAD is rejected. */
export async function probeTarget(fetcher, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const head = await request(fetcher, url, 'HEAD', timeoutMs);
  if ('error' in head) return classifyError(head.error, timeoutMs);

  const headResult = classifyResponse(head.response);
  if (headResult.verdict !== 'skip') return headResult;

  const status = head.response.status;
  const retryWithGet =
    (status === 403 && !rateLimited(head.response.headers)) || status === 405 || status === 501;
  if (!retryWithGet) return headResult;

  const get = await request(fetcher, url, 'GET', timeoutMs);
  if ('error' in get) return classifyError(get.error, timeoutMs);
  return classifyResponse(get.response);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

function summaryLine(summary) {
  return (
    `checked ${summary.urls} unique external URLs across ${summary.references} references ` +
    `in ${summary.files} files: ${summary.ok} ok, ${summary.dead} dead, ${summary.skipped} skipped.`
  );
}

/**
 * Scan a repository and probe every unique external target.
 *
 * `fetcher` is injected so tests never touch the network. It receives
 * `(url, init)` and must resolve to a Response-like `{ status, headers }`.
 */
export async function checkExternalLinks({
  root,
  fetcher = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const references = [];
  for (const entry of collectDocLinks(root)) {
    const normalized = normalizeExternalTarget(entry.link.target);
    if (normalized === null) continue;
    references.push({
      file: entry.file,
      line: entry.link.line,
      url: normalized.url,
      invalid: normalized.invalid,
    });
  }

  const byUrl = new Map();
  for (const reference of references) {
    const list = byUrl.get(reference.url);
    if (list === undefined) byUrl.set(reference.url, [reference]);
    else list.push(reference);
  }

  const urls = [...byUrl.keys()].sort();
  const verdicts = await mapWithConcurrency(urls, concurrency, async (url) => {
    if (byUrl.get(url)[0].invalid) return { verdict: 'dead', reason: 'invalid URL' };
    return probeTarget(fetcher, url, timeoutMs);
  });

  const byUrlVerdict = new Map(urls.map((url, index) => [url, verdicts[index]]));
  const results = references
    .map((reference) => {
      const verdict = byUrlVerdict.get(reference.url);
      return {
        file: reference.file,
        line: reference.line,
        url: reference.url,
        verdict: verdict.verdict,
        reason: verdict.reason,
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  const summary = {
    urls: urls.length,
    references: references.length,
    files: new Set(references.map((reference) => reference.file)).size,
    ok: verdicts.filter((verdict) => verdict.verdict === 'ok').length,
    dead: verdicts.filter((verdict) => verdict.verdict === 'dead').length,
    skipped: verdicts.filter((verdict) => verdict.verdict === 'skip').length,
  };

  return { results, summary };
}

/** Format a scan report deterministically: sorted findings, then the summary. */
export function formatReport(report) {
  const lines = [];
  for (const result of report.results) {
    if (result.verdict === 'ok') continue;
    const prefix = result.verdict === 'dead' ? '' : 'skip ';
    lines.push(`${prefix}${result.file}:${result.line}: ${result.url} — ${result.reason}`);
  }
  if (report.summary.urls === 0) lines.push('no external http(s) links found.');
  lines.push(summaryLine(report.summary));
  return lines;
}

/** Run the CLI. Returns the process exit code; never calls process.exit. */
export async function main(
  argv = process.argv.slice(2),
  { fetcher = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`check:docs:external: ${error.message}\n`);
    stderr.write('Run node scripts/check-external-links.mjs --help for usage.\n');
    return 2;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const report = await checkExternalLinks({
      root: options.root,
      fetcher,
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
    });
    stdout.write(`${formatReport(report).join('\n')}\n`);
    return report.summary.dead > 0 ? 1 : 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    stderr.write(`check:docs:external: ${detail}\n`);
    return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main();
}
