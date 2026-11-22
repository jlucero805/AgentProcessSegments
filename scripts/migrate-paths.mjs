#!/usr/bin/env node
// One-time move from the legacy Sandbox Harness runtime names to Agent Process
// Segments. The brain never runs this automatically: moving a live data directory
// can break git worktree metadata, so an operator runs it while the service is
// stopped. Re-running is safe; existing destinations are never overwritten.
import { existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function usage() {
  return [
    'Usage: node scripts/migrate-paths.mjs [--dry-run] [--home DIR] [--cwd DIR]',
    '',
    'Moves the default legacy locations to the APS names:',
    '  ~/.sandbox-harness                 -> ~/.agent-process-segments',
    '  $XDG_CONFIG_HOME/sandbox-harness   -> $XDG_CONFIG_HOME/agent-process-segments',
    '  $XDG_STATE_HOME/sandbox-harness    -> $XDG_STATE_HOME/agent-process-segments',
    '  <cwd>/sandbox-harness.sqlite       -> <cwd>/agent-process-segments.sqlite',
    '',
    'Explicit APS_* / SBOX_* path overrides are not inspected or moved.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    home: os.homedir(),
    cwd: process.cwd(),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--home' || arg === '--cwd') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a directory`);
      options[arg === '--home' ? 'home' : 'cwd'] = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function moveCommand(from, to) {
  return `mv ${shellQuote(from)} ${shellQuote(to)}`;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(options.home, '.config');
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(options.home, '.local', 'state');

  const overrides = [
    'APS_DATA_DIR',
    'SBOX_DATA_DIR',
    'APS_CONFIG',
    'SBOX_CONFIG',
    'APS_PROCESS',
    'SBOX_PROCESS',
    'APS_ERROR_LOG',
    'SBOX_ERROR_LOG',
    'APS_DB',
    'SBOX_DB',
  ].filter((name) => process.env[name] !== undefined);
  if (overrides.length > 0) {
    console.warn(`note: explicit path overrides are not migrated: ${overrides.join(', ')}`);
  }

  const planned = [];
  const skipped = [];

  const directories = [
    {
      label: 'data directory',
      from: path.join(options.home, '.sandbox-harness'),
      to: path.join(options.home, '.agent-process-segments'),
    },
    {
      label: 'config directory',
      from: path.join(configHome, 'sandbox-harness'),
      to: path.join(configHome, 'agent-process-segments'),
    },
    {
      label: 'state directory',
      from: path.join(stateHome, 'sandbox-harness'),
      to: path.join(stateHome, 'agent-process-segments'),
    },
  ];

  for (const item of directories) {
    if (!existsSync(item.from)) continue;
    if (existsSync(item.to)) {
      skipped.push(item);
      continue;
    }
    planned.push(item);
  }

  const dbFrom = path.join(options.cwd, 'sandbox-harness.sqlite');
  const dbTo = path.join(options.cwd, 'agent-process-segments.sqlite');
  if (existsSync(dbFrom)) {
    if (existsSync(dbTo)) {
      skipped.push({ label: 'database', from: dbFrom, to: dbTo });
    } else {
      for (const suffix of ['', '-wal', '-shm']) {
        const from = `${dbFrom}${suffix}`;
        const to = `${dbTo}${suffix}`;
        if (!existsSync(from)) continue;
        if (existsSync(to)) {
          skipped.push({ label: `database${suffix}`, from, to });
          continue;
        }
        planned.push({ label: `database${suffix}`, from, to });
      }
    }
  }

  for (const item of skipped) {
    console.warn(`skip ${item.label}: ${item.to} already exists; leaving ${item.from} alone`);
  }

  if (planned.length === 0) {
    console.log('nothing to migrate');
    return;
  }

  if (options.dryRun) {
    for (const item of planned) {
      console.log(`would move ${item.label}: ${item.from} -> ${item.to}`);
    }
    console.log('dry run: no files were changed');
    return;
  }

  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index];
    try {
      renameSync(item.from, item.to);
      console.log(`moved ${item.label}: ${item.from} -> ${item.to}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`could not move ${item.label}: ${message}`);
      console.error('run these commands manually, then retry:');
      for (const remaining of planned.slice(index)) {
        console.error(`  ${moveCommand(remaining.from, remaining.to)}`);
      }
      process.exitCode = 1;
      return;
    }
  }

  if (planned.some((item) => item.label === 'data directory')) {
    console.log(
      'note: existing worktrees moved with the data directory; if git reports them at the',
    );
    console.log('old path, run `git worktree repair` in the target repo or remove and recreate them.');
  }
  console.log('migration complete');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
