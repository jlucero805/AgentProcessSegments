import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { identifiesAsClaude, looksLikeClaude, probeClaudeVersion } from './claude-bin.mjs';

const posixOnly = { skip: process.platform === 'win32' };
let dir;

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aps-claude-probe-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeBinary(name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

test('Claude detection is case-insensitive and tolerates noise', () => {
  assert.equal(looksLikeClaude('2.1.330 (Claude Code)\n'), true);
  assert.equal(looksLikeClaude('noise\n2.1.330 (claude code)\nmore noise'), true);
  assert.equal(looksLikeClaude('opencode 1.2.3'), false);
  assert.equal(looksLikeClaude(''), false);
  assert.equal(looksLikeClaude(undefined), false);
  assert.equal(looksLikeClaude(null), false);
});

test('probeClaudeVersion returns combined stdout and stderr', posixOnly, () => {
  const bin = fakeBinary('claude-ok', 'echo "noise" >&2; echo "2.1.330 (Claude Code)"');
  const output = probeClaudeVersion(bin);
  assert.match(output, /noise/);
  assert.match(output, /2\.1\.330 \(Claude Code\)/);
});

test('probeClaudeVersion fails on a non-zero exit', posixOnly, () => {
  const bin = fakeBinary('claude-broken', 'echo "not for me" >&2; exit 1');
  assert.throws(() => probeClaudeVersion(bin), /--version exited 1/);
});

test('probeClaudeVersion fails when the binary is missing', () => {
  assert.throws(() => probeClaudeVersion(path.join(dir, 'does-not-exist')));
});

test('identifiesAsClaude accepts Claude Code and rejects other CLIs', posixOnly, () => {
  assert.equal(identifiesAsClaude(fakeBinary('claude-real', 'echo "2.1.330 (Claude Code)"')), true);
  assert.equal(identifiesAsClaude(fakeBinary('opencode', 'echo "opencode 1.2.3"')), false);
});
