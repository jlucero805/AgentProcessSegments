import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HARDENING_FORBIDDEN,
  HARDENING_REQUIRED,
} from './verify-systemd-unit.mjs';
import {
  journalExcerpt,
  parseProbeArgs,
  PROBE_CANDIDATES,
  PROBE_READ_WRITE_PATHS,
  renderCheckTable,
  renderReadWritePaths,
  substituteHome,
  suggestedVerdict,
  UsageError,
} from './systemd-sandbox-probe.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const realUnit = readFileSync(
  path.join(repoRoot, 'deploy/agent-process-segments.service'),
  'utf8',
);

function assertUsage(fn, pattern) {
  assert.throws(fn, (error) => error instanceof UsageError && pattern.test(error.message));
}

test('probe defaults target the cache directory and both harnesses', () => {
  const options = parseProbeArgs([]);

  assert.match(options.root, /\.cache\/aps-sandbox-probe$/);
  assert.equal(options.harness, 'both');
  assert.equal(options.timeoutMs, 300_000);
  assert.deepEqual(options.candidates, []);
  assert.deepEqual(options.directives, []);
  assert.equal(options.keep, false);
});

test('probe flags parse and repeat', () => {
  const options = parseProbeArgs([
    '--root',
    '/home/me/.cache/probe',
    '--srv-root=/srv/probe',
    '--harness',
    'opencode',
    '--candidate',
    'control',
    '--candidate=private-devices',
    '--directive',
    'PrivateDevices=yes',
    '--directive=ProtectProc=invisible',
    '--report',
    '/home/me/report.md',
    '--timeout=12',
    '--keep',
  ]);

  assert.equal(options.root, '/home/me/.cache/probe');
  assert.equal(options.srvRoot, '/srv/probe');
  assert.equal(options.harness, 'opencode');
  assert.deepEqual(options.candidates, ['control', 'private-devices']);
  assert.deepEqual(options.directives, ['PrivateDevices=yes', 'ProtectProc=invisible']);
  assert.equal(options.report, '/home/me/report.md');
  assert.equal(options.timeoutMs, 12_000);
  assert.equal(options.keep, true);
});

test('probe rejects unsafe or malformed arguments', () => {
  assertUsage(() => parseProbeArgs(['--bogus']), /unknown argument/);
  assertUsage(() => parseProbeArgs(['--root']), /--root needs a value/);
  assertUsage(() => parseProbeArgs(['--root', 'relative/path']), /--root must be an absolute path/);
  assertUsage(() => parseProbeArgs(['--srv-root=relative']), /--srv-root must be an absolute path/);
  assertUsage(() => parseProbeArgs(['--harness', 'nope']), /--harness must be/);
  assertUsage(() => parseProbeArgs(['--timeout', '0']), /positive/);
  assertUsage(() => parseProbeArgs(['--candidate', 'nope']), /unknown candidate/);
  assertUsage(() => parseProbeArgs(['--directive', 'ProtectHome']), /Key=Value/);
});

test('probe substitutes every %h in a value', () => {
  assert.equal(
    substituteHome('%h/a %h/b -%h/.claude %h', '/root/.cache/run/home'),
    '/root/.cache/run/home/a /root/.cache/run/home/b -/root/.cache/run/home/.claude /root/.cache/run/home',
  );
  assert.equal(substituteHome('no expansion', '/home'), 'no expansion');
});

test('probe renders the reviewed ReadWritePaths list', () => {
  assert.equal(renderReadWritePaths(['a', 'b', '-c']), 'a b -c');
  assert.equal(renderReadWritePaths([]), '');
});

test('probe verdicts follow the pass-fail-skip rule', () => {
  assert.equal(suggestedVerdict([{ status: 'PASS' }, { status: 'PASS' }]), 'ADOPT');
  assert.equal(suggestedVerdict([{ status: 'PASS' }, { status: 'SKIP' }]), 'DEFER');
  assert.equal(suggestedVerdict([{ status: 'PASS' }, { status: 'FAIL' }]), 'REJECT');
  assert.equal(suggestedVerdict([{ status: 'FAIL' }, { status: 'SKIP' }]), 'REJECT');
});

test('journal excerpts are bounded and center the first failure', () => {
  const quiet = Array.from({ length: 100 }, (_, index) => `line ${index}`);
  const quietExcerpt = journalExcerpt(quiet.join('\n'));
  assert.equal(quietExcerpt.length, 40);
  assert.equal(quietExcerpt.at(-1), 'line 99');

  const noisy = [...quiet];
  noisy[50] = 'touch: cannot touch /home/x: Read-only file system';
  const noisyExcerpt = journalExcerpt(noisy.join('\n'));
  assert.equal(noisyExcerpt.length, 40);
  assert.ok(noisyExcerpt.includes(noisy[50]));
});

test('check tables escape pipes so one row cannot break the table', () => {
  const table = renderCheckTable([
    { id: 'terminal', status: 'FAIL', detail: 'ps=1 | free=1' },
    { id: 'boot', status: 'PASS', detail: 'ok' },
  ]);

  assert.match(table, /\| terminal \| FAIL \| ps=1 \\\| free=1 \|/);
  assert.match(table, /\| boot \| PASS \| ok \|/);
});

test('every candidate directive is classified in the lint maps or explicitly deferred', () => {
  const deferred = new Set(['RestrictNamespaces', 'SystemCallFilter', 'ReadWritePaths']);
  const classified = new Set([
    ...Object.keys(HARDENING_REQUIRED),
    ...Object.keys(HARDENING_FORBIDDEN),
    ...deferred,
  ]);

  for (const candidate of PROBE_CANDIDATES) {
    for (const [key] of candidate.directives) {
      assert.ok(classified.has(key), `${candidate.id}: ${key} is unclassified`);
    }
  }
});

test('candidates that match the shipped block use the shipped value', () => {
  for (const candidate of PROBE_CANDIDATES) {
    for (const [key, value] of candidate.directives) {
      // ProtectSystem=strict is a deliberate override of the shipped `full`.
      if (key === 'ProtectSystem') continue;
      if (!(key in HARDENING_REQUIRED)) continue;
      assert.equal(
        value,
        HARDENING_REQUIRED[key],
        `${candidate.id}: ${key} must match HARDENING_REQUIRED`,
      );
    }
  }
});

test('the reviewed ReadWritePaths list covers the deployment shapes', () => {
  for (const expected of [
    '%h/agent-process-segments',
    '%h/.agent-process-segments',
    '%h/.config/agent-process-segments',
    '%h/.local/state/agent-process-segments',
    '%h/.local/share/agent-process-segments',
  ]) {
    assert.ok(PROBE_READ_WRITE_PATHS.includes(expected), `missing ${expected}`);
  }
});

test('candidates classified as adopted appear in the shipped unit', () => {
  for (const candidate of PROBE_CANDIDATES) {
    const adopted = candidate.directives.every(
      ([key, value]) => HARDENING_REQUIRED[key] === value,
    );
    if (!adopted) continue;
    for (const [key, value] of candidate.directives) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(realUnit, new RegExp(`^${key}=${escaped}$`, 'm'), `${key} missing from the unit`);
    }
  }
});
