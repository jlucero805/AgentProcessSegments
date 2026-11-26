#!/usr/bin/env node
// Fail root dev commands with an actionable hint when npm omitted devDependencies.
// The check is path-based: a global binary, PATH shim, or NODE_PATH fallback must
// not satisfy it, because the root scripts run the project-local tools.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

const CHECKS = {
  typecheck: [
    { tool: 'tsc', workspace: 'src/server' },
    { tool: 'tsc', workspace: 'src/web' },
  ],
  test: [
    { tool: 'vitest', workspace: 'src/server' },
    { tool: 'vitest', workspace: 'src/web' },
  ],
  lint: [
    { tool: 'eslint', workspace: null },
    { tool: 'markdownlint-cli2', workspace: null },
  ],
  'lint-js': [{ tool: 'eslint', workspace: null }],
  build: [
    { tool: 'tsc', workspace: 'src/server' },
    { tool: 'vite', workspace: 'src/web' },
  ],
  dev: [
    { tool: 'concurrently', workspace: null },
    { tool: 'tsx', workspace: 'src/server' },
    { tool: 'vite', workspace: 'src/web' },
  ],
  e2e: [
    { tool: 'tsc', workspace: 'src/server' },
    { tool: 'vite', workspace: 'src/web' },
  ],
};

const USAGE =
  'Usage: node scripts/check-dev-deps.mjs <typecheck|test|lint|lint-js|build|dev|e2e> [--root <dir>]';

function failUsage(message) {
  console.error(`check-dev-deps: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  let mode = null;
  let root = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === '') failUsage('--root needs a directory');
      root = value;
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (value === '') failUsage('--root needs a directory');
      root = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('-')) {
      failUsage(`unknown option: ${arg}`);
    } else if (mode === null) {
      mode = arg;
    } else {
      failUsage(`unexpected argument: ${arg}`);
    }
  }

  if (mode === null) failUsage('missing mode');
  if (!Object.hasOwn(CHECKS, mode)) failUsage(`unknown mode: ${mode}`);

  const resolvedRoot = path.resolve(root ?? repoRoot);
  try {
    if (!statSync(resolvedRoot).isDirectory()) {
      failUsage(`root is not a directory: ${resolvedRoot}`);
    }
  } catch {
    failUsage(`root does not exist: ${resolvedRoot}`);
  }

  return { mode, root: resolvedRoot };
}

function binaryCandidates(root, workspace, tool) {
  const dirs = [];
  if (workspace !== null) {
    dirs.push(path.join(root, workspace, 'node_modules', '.bin'));
  }
  dirs.push(path.join(root, 'node_modules', '.bin'));

  const paths = [];
  for (const dir of dirs) {
    for (const name of [tool, `${tool}.cmd`]) {
      paths.push(path.join(dir, name));
    }
  }
  return paths;
}

const { mode, root } = parseArgs(process.argv.slice(2));
const missing = [];

for (const check of CHECKS[mode]) {
  const candidates = binaryCandidates(root, check.workspace, check.tool);
  if (!candidates.some((candidate) => existsSync(candidate)) && !missing.includes(check.tool)) {
    missing.push(check.tool);
  }
}

if (missing.length === 0) {
  process.exit(0);
}

console.error(
  `${mode}: missing devDependencies (${missing.join(', ')}).\n` +
    'Run `npm ci --include=dev` to install them (or `NODE_ENV=development npm ci`).\n' +
    'An inherited NODE_ENV=production makes npm omit devDependencies; ' +
    '`npm config get omit` prints `dev` when that is the cause.',
);
process.exit(1);
