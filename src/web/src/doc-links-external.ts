import { collectDocLinks } from './doc-links';

/** One external destination as written, with where it lives. */
export interface ExternalTarget {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** 1-based line in the file that contains the link. */
  line: number;
  /** Raw destination exactly as written. */
  target: string;
}

export interface ExternalProblem extends ExternalTarget {
  reason: string;
  severity: 'dead' | 'unverified';
}

export interface SkippedExternalTarget extends ExternalTarget {
  reason: string;
}

/** Minimal fetch seam: tests inject a stub and never touch the network. */
export type ExternalFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number }>;

export interface ExternalCheckOptions {
  fetch?: ExternalFetch;
  timeoutMs?: number;
  concurrency?: number;
  /** Extra attempts after the first, for network errors, 429, and 5xx. */
  retries?: number;
  retryDelayMs?: number;
}

export interface ExternalCheckResult {
  /** Dead and unverified findings, sorted by file, line, and target. */
  problems: ExternalProblem[];
  /** Unique checkable URLs that were actually requested. */
  checked: number;
  /** Non-public and reserved destinations that were never requested. */
  skipped: SkippedExternalTarget[];
}

const DEFAULTS = {
  timeoutMs: 10_000,
  concurrency: 4,
  retries: 1,
  retryDelayMs: 500,
} as const;

const USER_AGENT =
  'agent-process-segments-doc-link-check (+https://github.com/jlucero805/AgentProcessSegments)';

const HTTP_SCHEME = /^https?:/i;
const UNVERIFIED_STATUSES = new Set([401, 403, 405, 429]);
const RESERVED_EXAMPLE_HOSTS = ['example.com', 'example.net', 'example.org'];
const RESERVED_EXAMPLE_SUFFIXES = ['.example', '.test', '.invalid'];
const NON_PUBLIC_SUFFIXES = ['.localhost', '.local', '.internal'];

interface ProbeVerdict {
  severity: 'ok' | 'dead' | 'unverified';
  reason: string;
}

function probeUrl(raw: string): string {
  return raw.startsWith('//') ? `https:${raw}` : raw;
}

/** `true` when the destination names an external HTTP(S) resource we can probe. */
function isExternalTarget(raw: string): boolean {
  return HTTP_SCHEME.test(raw) || raw.startsWith('//');
}

function hostSkipReason(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    !host.includes('.')
  ) {
    return 'non-public host';
  }
  if (NON_PUBLIC_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return 'non-public host';
  }
  if (RESERVED_EXAMPLE_HOSTS.some((base) => host === base || host.endsWith(`.${base}`))) {
    return 'reserved example host';
  }
  if (RESERVED_EXAMPLE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return 'reserved example host';
  }
  return null;
}

/** Every external link, image, HTML target, and reference definition in the corpus. */
export function externalTargets(root: string): ExternalTarget[] {
  const targets: ExternalTarget[] = [];
  for (const { file, link } of collectDocLinks(root)) {
    const raw = link.target.trim();
    if (isExternalTarget(raw)) targets.push({ file, line: link.line, target: raw });
  }
  return targets;
}

function errorReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const named = error as { name?: unknown; message?: unknown; cause?: unknown };
    if (named.name === 'TimeoutError' || named.name === 'AbortError') return 'timeout';
    if (typeof named.cause === 'object' && named.cause !== null) {
      const cause = named.cause as { code?: unknown; message?: unknown };
      if (typeof cause.code === 'string' && cause.code !== '') return cause.code;
      if (typeof cause.message === 'string' && cause.message !== '') {
        return cause.message.slice(0, 120);
      }
    }
    if (typeof named.message === 'string' && named.message !== '') {
      return named.message.slice(0, 120);
    }
  }
  return 'unknown error';
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProbeContext {
  fetch: ExternalFetch;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
}

async function request(
  context: ProbeContext,
  url: string,
  method: 'HEAD' | 'GET',
): Promise<{ status: number }> {
  return context.fetch(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(context.timeoutMs),
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
  });
}

/**
 * Probe one URL with a bounded attempt budget. A HEAD that is rejected or
 * throws falls back to GET once; that fallback then shares the same retry
 * budget as any other attempt.
 */
async function probe(context: ProbeContext, url: string): Promise<ProbeVerdict> {
  const maxAttempts = context.retries + 1;
  let method: 'HEAD' | 'GET' = 'HEAD';
  let attempts = 0;

  for (;;) {
    attempts += 1;
    let response: { status: number };
    try {
      response = await request(context, url, method);
    } catch (error) {
      if (method === 'HEAD') {
        method = 'GET';
        continue;
      }
      if (attempts < maxAttempts) {
        await delay(context.retryDelayMs);
        continue;
      }
      return { severity: 'dead', reason: `request failed: ${errorReason(error)}` };
    }

    const status = response.status;
    if (status >= 200 && status < 400) return { severity: 'ok', reason: 'ok' };
    if (method === 'HEAD' && (status === 403 || status === 405 || status === 501)) {
      // Some hosts reject HEAD outright; retry the probe as a GET.
      method = 'GET';
      continue;
    }
    if ((status === 429 || status >= 500) && attempts < maxAttempts) {
      await delay(context.retryDelayMs);
      continue;
    }
    if (UNVERIFIED_STATUSES.has(status)) {
      return { severity: 'unverified', reason: `HTTP ${status}` };
    }
    return { severity: 'dead', reason: `HTTP ${status}` };
  }
}

function compareTargets(left: ExternalTarget, right: ExternalTarget): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.target.localeCompare(right.target)
  );
}

/**
 * Probe every unique external URL once and fan the verdict back out to each
 * occurrence. Missing and reserved hosts are classified without a request.
 */
export async function checkExternalTargets(
  targets: readonly ExternalTarget[],
  options: ExternalCheckOptions = {},
): Promise<ExternalCheckResult> {
  const context: ProbeContext = {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retries: options.retries ?? DEFAULTS.retries,
    retryDelayMs: options.retryDelayMs ?? DEFAULTS.retryDelayMs,
  };
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULTS.concurrency));

  const problems: ExternalProblem[] = [];
  const skipped: SkippedExternalTarget[] = [];
  const groups = new Map<string, { url: string; occurrences: ExternalTarget[] }>();

  for (const target of targets) {
    const raw = target.target.trim();
    let url: URL;
    try {
      url = new URL(probeUrl(raw));
    } catch {
      problems.push({ ...target, target: raw, reason: 'invalid URL', severity: 'dead' });
      continue;
    }
    const skip = hostSkipReason(url.hostname);
    if (skip !== null) {
      skipped.push({ ...target, target: raw, reason: skip });
      continue;
    }
    url.hash = '';
    const key = url.href;
    const group = groups.get(key);
    if (group) group.occurrences.push({ ...target, target: raw });
    else groups.set(key, { url: key, occurrences: [{ ...target, target: raw }] });
  }

  const keys = [...groups.keys()];
  const verdicts = new Map<string, ProbeVerdict>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < keys.length) {
      const key = keys[cursor]!;
      cursor += 1;
      verdicts.set(key, await probe(context, key));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));

  for (const [key, group] of groups) {
    const verdict = verdicts.get(key);
    if (!verdict || verdict.severity === 'ok') continue;
    for (const occurrence of group.occurrences) {
      problems.push({ ...occurrence, reason: verdict.reason, severity: verdict.severity });
    }
  }

  return {
    problems: problems.sort(compareTargets),
    checked: keys.length,
    skipped: skipped.sort(compareTargets),
  };
}

/** Human-readable summary for the opt-in CLI run. */
export function formatExternalReport(result: ExternalCheckResult): string {
  const dead = result.problems.filter((problem) => problem.severity === 'dead').length;
  const unverified = result.problems.length - dead;
  const lines = [
    `external links: ${result.checked} checked, ${result.skipped.length} skipped, ${dead} dead, ${unverified} unverified`,
  ];
  for (const problem of result.problems) {
    lines.push(
      `${problem.file}:${problem.line}: ${problem.target} — ${problem.reason} (${problem.severity})`,
    );
  }
  for (const skip of result.skipped) {
    lines.push(`${skip.file}:${skip.line}: ${skip.target} — skipped (${skip.reason})`);
  }
  return lines.join('\n');
}
