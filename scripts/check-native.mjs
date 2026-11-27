#!/usr/bin/env node
// Check that the two native dependencies load, and that the C/C++ toolchain a
// fresh Linux install needs is present. `better-sqlite3` ships N-API prebuilds,
// but npm's implicit gyp pass and `node-pty`'s Linux source build still need
// `make`, `g++`, and `python3`. Python 3.14 needs a node-gyp with gyp-next
// 0.20.5 or newer, which npm bundles from 11.7.0 on.
//
// Usage:
//   node scripts/check-native.mjs [--root <dir>] [--json] [--toolchain-only]
//
// Exit codes: 0 means both native modules load; 1 means at least one does not;
// 2 means the arguments are wrong. Toolchain problems are warnings, because a
// module that already loaded does not need a compiler.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const NATIVE_MODULES = ['better-sqlite3', 'node-pty'];

// npm 11.7.0 is the first release that bundles node-gyp 12.x; node-gyp 11.5.0
// (gyp-next 0.20.5) is the first that understands Python 3.14.
export const MIN_NPM_FOR_PYTHON_314 = '11.7.0';

const TOOLCHAIN = [
  { name: 'make', command: 'make', args: ['--version'] },
  { name: 'g++', command: 'g++', args: ['--version'], fallback: 'c++' },
  { name: 'python3', command: 'python3', args: ['-V'] },
  { name: 'npm', command: 'npm', args: ['--version'] },
];

const USAGE = [
  'Usage: node scripts/check-native.mjs [--root <dir>] [--json] [--toolchain-only]',
  '',
  'Exit codes: 0 = both native modules load;',
  '1 = at least one native module failed to load;',
  '2 = bad arguments.',
].join('\n');

export class UsageError extends Error {}

function failUsage(message) {
  throw new UsageError(message);
}

export function parseArgs(argv) {
  const options = { root: repoRoot, json: false, toolchainOnly: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || value === '') failUsage('--root needs a directory');
      options.root = path.resolve(value);
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (value === '') failUsage('--root needs a directory');
      options.root = path.resolve(value);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--toolchain-only') {
      options.toolchainOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      failUsage(`unknown option: ${arg}`);
    } else {
      failUsage(`unexpected argument: ${arg}`);
    }
  }

  if (!options.help) {
    try {
      if (!statSync(options.root).isDirectory()) failUsage(`root is not a directory: ${options.root}`);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      failUsage(`root does not exist: ${options.root}`);
    }
  }

  return options;
}

/** First `major.minor[.patch]` in a version banner, or null. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

export function formatVersion(parsed) {
  return parsed === null ? null : `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/** Numeric comparison of two `major.minor[.patch]` strings; unknown input fails. */
export function versionAtLeast(version, minimum) {
  const left = typeof version === 'string' ? parseVersion(version) : version;
  const right = typeof minimum === 'string' ? parseVersion(minimum) : minimum;
  if (left === null || right === null) return false;
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  return left.patch >= right.patch;
}

function defaultRun(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

/**
 * Probe one build tool. `run` is injectable so the tests do not need a real
 * compiler; the fallback command covers `g++` being installed as `c++` only.
 */
export function probeTool(tool, run = defaultRun) {
  const attempts = [tool.command, ...(tool.fallback === undefined ? [] : [tool.fallback])];

  for (const command of attempts) {
    const result = run(command, tool.args);
    if (result.error !== null && result.error !== undefined) continue;
    if (result.status !== 0) continue;

    const banner = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return { name: tool.name, ok: true, version: formatVersion(parseVersion(banner)) };
  }

  return { name: tool.name, ok: false, version: null };
}

export function probeToolchain({ platform = process.platform, run = defaultRun } = {}) {
  if (platform === 'win32') {
    return { skipped: true, tools: [], warnings: [] };
  }

  const tools = TOOLCHAIN.map((tool) => probeTool(tool, run));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const warnings = [];

  for (const tool of tools) {
    if (!tool.ok) {
      warnings.push(
        `missing ${tool.name}; install make, g++, and python3 ` +
          '(Debian/Ubuntu: sudo apt-get install -y make g++ python3)',
      );
    }
  }

  const python = byName.get('python3');
  const npm = byName.get('npm');
  if (
    python?.ok === true &&
    npm?.ok === true &&
    versionAtLeast(python.version, '3.14.0') &&
    !versionAtLeast(npm.version, MIN_NPM_FOR_PYTHON_314)
  ) {
    warnings.push(
      `python3 ${python.version} needs npm >= ${MIN_NPM_FOR_PYTHON_314} ` +
        '(bundled node-gyp >= 12); run `npm install -g npm@latest`',
    );
  }

  return { skipped: false, tools, warnings };
}

function readPackageVersion(root, name) {
  const candidate = path.join(root, 'node_modules', name, 'package.json');
  try {
    return JSON.parse(readFileSync(candidate, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Load each native module from `root` and exercise it enough to prove the
 * binary is present. A failure is captured per module so one broken package
 * never hides the other's result.
 */
export function probeModules(root) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const modules = [];

  const checkBetterSqlite3 = () => {
    const Database = requireFromRoot('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.prepare('select sqlite_version() as v').get();
    } finally {
      db.close();
    }
  };

  const checkNodePty = () => {
    const pty = requireFromRoot('node-pty');
    if (typeof pty.spawn !== 'function') throw new Error('node-pty has no spawn() export');
  };

  const checks = {
    'better-sqlite3': checkBetterSqlite3,
    'node-pty': checkNodePty,
  };

  for (const name of NATIVE_MODULES) {
    const entry = { name, version: readPackageVersion(root, name), ok: true, error: null };
    try {
      checks[name]();
    } catch (error) {
      entry.ok = false;
      const line = String(error?.message ?? error)
        .split(/\r?\n/)
        .find((text) => text.trim() !== '');
      entry.error = line === undefined ? 'unknown error' : line.trim();
    }
    modules.push(entry);
  }

  return modules;
}

export function formatHuman(result) {
  const lines = [`check-native: ${result.root}`, 'Native modules'];
  if (result.modules.length === 0) {
    lines.push('  SKIP (--toolchain-only)');
  }
  for (const module of result.modules) {
    const version = module.version === null ? '' : ` ${module.version}`;
    lines.push(
      module.ok
        ? `  PASS ${module.name}${version}`
        : `  FAIL ${module.name}${version}: ${module.error}`,
    );
  }

  lines.push('Install toolchain');
  if (result.toolchain.skipped) {
    lines.push('  SKIP (Windows uses node-pty prebuilds)');
  } else {
    for (const tool of [
      result.toolchain.make,
      result.toolchain.gxx,
      result.toolchain.python,
      result.toolchain.npm,
    ]) {
      if (tool === null) continue;
      const version = tool.version === null ? '' : ` ${tool.version}`;
      lines.push(tool.ok ? `  PASS ${tool.name}${version}` : `  WARN ${tool.name} not found`);
    }
    for (const warning of result.toolchain.warnings) lines.push(`  WARN ${warning}`);
  }

  if (result.ok) {
    lines.push('OK: native modules load.');
    return lines.join('\n');
  }

  const failed = result.modules.filter((module) => !module.ok).length;
  lines.push(`FAIL: ${failed} native module${failed === 1 ? '' : 's'} failed to load.`);
  lines.push('  rm -rf node_modules && npm ci --include=dev');
  lines.push('  npm rebuild node-pty --foreground-scripts   # the only package built from source');
  lines.push('  sudo apt-get install -y make g++ python3');
  lines.push(
    `  Python 3.14 needs npm >= ${MIN_NPM_FOR_PYTHON_314} (bundled node-gyp >= 12); ` +
      'upgrade with `npm install -g npm@latest`.',
  );
  lines.push(
    '  If the install failed with a gyp `write`/`ENOSPC` error, free disk space before retrying.',
  );
  return lines.join('\n');
}

export function run(options) {
  const modules = options.toolchainOnly ? [] : probeModules(options.root);
  const toolchain = probeToolchain();
  const ok = modules.every((module) => module.ok);
  const byName = new Map(toolchain.tools.map((tool) => [tool.name, tool]));

  return {
    root: options.root,
    ok,
    modules,
    toolchain: {
      skipped: toolchain.skipped,
      make: byName.get('make') ?? null,
      gxx: byName.get('g++') ?? null,
      python: byName.get('python3') ?? null,
      npm: byName.get('npm') ?? null,
      warnings: toolchain.warnings,
    },
    exitCode: ok ? 0 : 1,
  };
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`check-native: ${error.message}`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const result = run(options);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(formatHuman(result));
  }
  return result.exitCode;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  process.exitCode = main(process.argv.slice(2));
}
