import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  effectiveDirectiveValue,
  HARDENING_REQUIRED,
  hardeningProblems,
  serviceAssignments,
  systemdVersion,
  unitDiagnostics,
} from './verify-systemd-unit.mjs';

const UNIT = '/tmp/unit.service';
const repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const realUnit = readFileSync(
  path.join(repoRoot, 'deploy/agent-process-segments.service'),
  'utf8',
);
const hardenedLines = Object.entries(HARDENING_REQUIRED).map(
  ([key, value]) => `${key}=${value}`,
);

const TRUE_SPELLINGS = ['1', 'yes', 'y', 'true', 't', 'on', 'YES', 'Y', 'TRUE', 'T', 'On'];
const FALSE_SPELLINGS = ['0', 'no', 'n', 'false', 'f', 'off', 'NO', 'N', 'FALSE', 'F', 'Off'];
const BOOLEAN_FORBIDDEN = ['MemoryDenyWriteExecute', 'PrivateNetwork', 'PrivateUsers'];

function serviceUnit(lines) {
  return [
    '[Unit]',
    'Description=test',
    '',
    '[Service]',
    ...lines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function forbiddenLine(line) {
  return hardeningProblems(serviceUnit([...hardenedLines, line]));
}

test('returns diagnostics that name the unit file', () => {
  const output = [
    `${UNIT}:49: Unknown key 'Bogus' in section [Install], ignoring.`,
    `${UNIT}:41: Failed to parse Restart=bogus, ignoring: Invalid argument.`,
  ].join('\n');

  assert.deepEqual(unitDiagnostics(output, UNIT), [
    `${UNIT}:49: Unknown key 'Bogus' in section [Install], ignoring.`,
    `${UNIT}:41: Failed to parse Restart=bogus, ignoring: Invalid argument.`,
  ]);
});

test('ignores warnings about unrelated system units', () => {
  const output = [
    '/usr/lib/systemd/system/xfs_scrub_all.service:26: Support for option CPUAccounting= has been removed and it is ignored',
    '/usr/lib/systemd/system/system-xfs_scrub.slice:15: Support for option CPUAccounting= has been removed and it is ignored',
  ].join('\n');

  assert.deepEqual(unitDiagnostics(output, UNIT), []);
});

test('returns no diagnostics for clean or empty output', () => {
  assert.deepEqual(unitDiagnostics('', UNIT), []);
  assert.deepEqual(unitDiagnostics('/usr/lib/systemd/system/default.target: clean\n', UNIT), []);
});

test('the deploy unit carries the reviewed hardening directives', () => {
  assert.deepEqual(hardeningProblems(realUnit), []);
});

test('reports a missing hardening directive', () => {
  const unit = hardenedLines.filter((line) => !line.startsWith('NoNewPrivileges='));

  assert.deepEqual(hardeningProblems(serviceUnit(unit)), ['missing NoNewPrivileges=yes']);
});

test('reports a changed hardening value', () => {
  const unit = hardenedLines.map((line) =>
    line === 'ProtectSystem=full' ? 'ProtectSystem=no' : line,
  );

  assert.deepEqual(hardeningProblems(serviceUnit(unit)), [
    'ProtectSystem=no (expected full)',
  ]);
});

test('reports directives that must stay off', () => {
  const unit = serviceUnit([
    ...hardenedLines,
    'MemoryDenyWriteExecute=yes',
    'ProtectHome=read-only',
  ]);

  assert.deepEqual(hardeningProblems(unit), [
    'MemoryDenyWriteExecute=yes is not allowed',
    'ProtectHome=read-only is not allowed',
  ]);
});

test('reports a forbidden stricter filesystem or proc setting', () => {
  const unit = serviceUnit([
    ...hardenedLines,
    'ProtectSystem=strict',
    'ProcSubset=pid',
  ]);

  assert.deepEqual(hardeningProblems(unit), [
    'ProtectSystem=strict (expected full)',
    'ProtectSystem=strict is not allowed',
    'ProcSubset=pid is not allowed',
  ]);
});

test('rejects every accepted true spelling of a forbidden boolean directive', () => {
  for (const key of BOOLEAN_FORBIDDEN) {
    for (const spelling of TRUE_SPELLINGS) {
      assert.deepEqual(
        forbiddenLine(`${key}=${spelling}`),
        [`${key}=${spelling} is not allowed`],
        `${key}=${spelling}`,
      );
    }
  }
});

test('accepts false and empty spellings of a forbidden boolean directive', () => {
  for (const key of BOOLEAN_FORBIDDEN) {
    for (const spelling of FALSE_SPELLINGS) {
      assert.deepEqual(forbiddenLine(`${key}=${spelling}`), [], `${key}=${spelling}`);
    }
    assert.deepEqual(forbiddenLine(`${key}=`), [], `${key}=`);
  }
});

test('rejects every ProtectHome value that exposes the home directory', () => {
  for (const spelling of [...TRUE_SPELLINGS, 'read-only', 'tmpfs']) {
    assert.deepEqual(
      forbiddenLine(`ProtectHome=${spelling}`),
      [`ProtectHome=${spelling} is not allowed`],
      `ProtectHome=${spelling}`,
    );
  }
});

test('accepts false and empty ProtectHome spellings', () => {
  for (const spelling of FALSE_SPELLINGS) {
    assert.deepEqual(
      forbiddenLine(`ProtectHome=${spelling}`),
      [],
      `ProtectHome=${spelling}`,
    );
  }
  assert.deepEqual(forbiddenLine('ProtectHome='), []);
});

test('required directives keep their exact canonical spelling', () => {
  for (const [key, spelling, expected] of [
    ['NoNewPrivileges', '1', 'NoNewPrivileges=1 (expected yes)'],
    ['PrivateTmp', 'on', 'PrivateTmp=on (expected yes)'],
    ['ProtectSystem', 'yes', 'ProtectSystem=yes (expected full)'],
  ]) {
    const unit = hardenedLines.map((line) =>
      line.startsWith(`${key}=`) ? `${key}=${spelling}` : line,
    );

    assert.deepEqual(
      hardeningProblems(serviceUnit(unit)),
      [expected],
      `${key}=${spelling}`,
    );
  }
});

test('the CLI rejects a forbidden boolean synonym before platform checks', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aps-unit-synonym-'));
  try {
    const unitPath = path.join(dir, 'unit.service');
    writeFileSync(
      unitPath,
      realUnit.replace('[Service]\n', '[Service]\nMemoryDenyWriteExecute=1\n'),
    );

    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/verify-systemd-unit.mjs'), '--unit', unitPath],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unit hardening: MemoryDenyWriteExecute=1 is not allowed/);
    assert.doesNotMatch(result.stderr, /systemd-analyze verify/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports an extra list assignment that would widen the sandbox', () => {
  const required = { ReadWritePaths: '/reviewed/a /reviewed/b' };
  const split = serviceUnit([
    'ReadWritePaths=/reviewed/a',
    'ReadWritePaths=/reviewed/b',
  ]);

  assert.deepEqual(hardeningProblems(split, required, {}), [
    'ReadWritePaths is set 2 times (expected one reviewed line)',
  ]);

  const widened = serviceUnit([
    'ReadWritePaths=/tmp/extra',
    'ReadWritePaths=/reviewed/a /reviewed/b',
  ]);

  assert.deepEqual(hardeningProblems(widened, required, {}), [
    'ReadWritePaths is set 2 times (expected one reviewed line)',
  ]);

  assert.deepEqual(
    hardeningProblems(serviceUnit([required.ReadWritePaths].map((value) => `ReadWritePaths=${value}`)), required, {}),
    [],
  );
});

test('reports duplicate list directives even when they are not reviewed yet', () => {
  const unit = serviceUnit([
    ...hardenedLines,
    'ReadOnlyPaths=/reviewed/a',
    'ReadOnlyPaths=/reviewed/b',
  ]);

  assert.deepEqual(hardeningProblems(unit), [
    'ReadOnlyPaths is set 2 times (list directives must be one line)',
  ]);
});

test('list directives accumulate in file order', () => {
  const assignments = serviceAssignments(
    serviceUnit(['ReadWritePaths=/a', 'ReadWritePaths=/b', 'ProtectSystem=full']),
  );

  assert.deepEqual(assignments.get('ReadWritePaths'), ['/a', '/b']);
  assert.equal(effectiveDirectiveValue(assignments, 'ReadWritePaths'), '/a /b');
  assert.equal(effectiveDirectiveValue(assignments, 'ProtectSystem'), 'full');
  assert.equal(effectiveDirectiveValue(assignments, 'ProtectHome'), undefined);
});

test('ignores directives outside [Service] and in comments', () => {
  const unit = serviceUnit(hardenedLines.filter((line) => !line.startsWith('UMask='))).replace(
    '[Install]',
    '# UMask=0077\n[Install]\nUMask=0077',
  );

  assert.deepEqual(hardeningProblems(unit), ['missing UMask=0077']);
});

test('the last [Service] assignment wins', () => {
  assert.deepEqual(
    hardeningProblems(serviceUnit([...hardenedLines, 'UMask=0022', 'UMask=0077'])),
    [],
  );
  assert.deepEqual(
    hardeningProblems(serviceUnit([...hardenedLines, 'UMask=0077', 'UMask=0022'])),
    ['UMask=0022 (expected 0077)'],
  );
});

test('an empty value counts as set for capability directives', () => {
  const problems = hardeningProblems(serviceUnit(hardenedLines));

  assert.deepEqual(problems, []);
  assert.equal(
    problems.some((problem) => problem.includes('CapabilityBoundingSet')),
    false,
  );
});

test('parses the systemd major version', () => {
  assert.equal(systemdVersion('systemd 259 (259.9-0ubuntu0.1)\n+PAM +AUDIT'), 259);
  assert.equal(systemdVersion('systemd 249 (249.11-0ubuntu3.12)'), 249);
  assert.equal(systemdVersion('not a version'), null);
  assert.equal(systemdVersion(''), null);
});
