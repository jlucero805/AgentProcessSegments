#!/usr/bin/env node
// Reclaim temp dirs left behind by killed or crashed test runs. Normal runs
// delete their own per-file root (src/server/test/setup.ts); this only looks at
// direct children of the OS temp dir whose names look like mkdtemp output.
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = /^(?:aps|sbox)-[a-z0-9][a-z0-9-]*-[A-Za-z0-9]{6}$/;
const DEFAULT_OLDER_THAN_MINUTES = 60;

function usage() {
  console.log(`Usage: node scripts/clean-test-tmp.mjs [--older-than <minutes>] [--apply]

Lists test temp dirs in ${os.tmpdir()} matching aps-* / sbox-* mkdtemp names.
Dry-run by default; --apply removes them. --older-than defaults to ${DEFAULT_OLDER_THAN_MINUTES}.`);
}

function fail(message) {
  console.error(`clean-test-tmp: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  let apply = false;
  let olderThan = DEFAULT_OLDER_THAN_MINUTES;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--older-than') {
      const raw = argv[index + 1];
      index += 1;
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        fail('--older-than needs a non-negative number of minutes');
      }
      olderThan = value;
    } else {
      fail(`unknown argument: ${arg ?? ''}`);
    }
  }

  return { apply, olderThan, help };
}

const { apply, olderThan, help } = parseArgs(process.argv.slice(2));
if (help) {
  usage();
  process.exit(0);
}

const tmp = os.tmpdir();
const cutoff = Date.now() - olderThan * 60_000;
const candidates = [];

for (const entry of readdirSync(tmp, { withFileTypes: true })) {
  if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
  const dir = path.join(tmp, entry.name);
  try {
    const stats = lstatSync(dir);
    if (stats.mtimeMs <= cutoff) {
      candidates.push({ dir, ageMinutes: Math.floor((Date.now() - stats.mtimeMs) / 60_000) });
    }
  } catch {
    // The directory vanished between readdir and lstat; nothing to do.
  }
}

candidates.sort((left, right) => left.dir.localeCompare(right.dir));

if (!apply) {
  console.log(`would remove ${candidates.length} temp dir(s) older than ${olderThan} min in ${tmp}`);
  for (const candidate of candidates) console.log(`  ${candidate.dir} (${candidate.ageMinutes}m)`);
  if (candidates.length === 0) console.log('nothing to prune');
  process.exit(0);
}

let removed = 0;
for (const candidate of candidates) {
  rmSync(candidate.dir, { recursive: true, force: true });
  removed += 1;
}
console.log(`removed ${removed} temp dir(s) older than ${olderThan} min in ${tmp}`);
