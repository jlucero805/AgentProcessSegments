import assert from 'node:assert/strict';
import test from 'node:test';
import { unitDiagnostics } from './verify-systemd-unit.mjs';

const UNIT = '/tmp/unit.service';

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
