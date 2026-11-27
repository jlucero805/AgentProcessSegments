#!/usr/bin/env node
// Live-exercise probe for the brain's systemd sandbox.
//
// Boots the built brain in a transient `systemd-run --user` unit with the
// reviewed `[Service]` sandbox block plus one candidate directive, then drives
// the real product surfaces: `/health`, a PTY session, clarify turns with each
// available harness, and git worktrees inside and outside the fake home. Each
// check records PASS, FAIL, or SKIP and the journal/log line that decided it.
//
// The probe is manual on purpose: it needs a user manager, the built tree, agent
// CLI binaries, and network auth, so it is never part of `npm run lint` or CI.
// Every writable path is derived from `--root` and `%h` is substituted with
// `<root>/home`, so a run cannot touch a live install. See deploy/vps.md and
// D113 in docs/03-decisions.md.
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildPinnedEnv,
  buildProbePins,
  probeLayout,
  probePinProblems,
} from './e2e/env.mjs';
import {
  effectiveDirectiveValue,
  HARDENING_REQUIRED,
  LIST_DIRECTIVES,
  serviceAssignments,
  systemdVersion,
} from './verify-systemd-unit.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const requireFromRepo = createRequire(path.join(repoRoot, 'src/server/package.json'));
const DEFAULT_UNIT = 'deploy/agent-process-segments.service';
const DEFAULT_ROOT = path.join(os.homedir(), '.cache', 'aps-sandbox-probe');
const MARKER = '__APS_PROBE_DONE__';
// systemd-run/systemctl must reach the user manager, but must not carry the
// host's harness settings or credentials into the transient unit's spawn env.
const MANAGER_ENV = buildPinnedEnv(process.env, {});
const MAX_JOURNAL_LINES = 40;
const MIN_SYSTEMD = 250;

export const PROBE_READ_WRITE_PATHS = Object.freeze([
  '%h/agent-process-segments',
  '%h/.agent-process-segments',
  '%h/.config/agent-process-segments',
  '%h/.local/state/agent-process-segments',
  '%h/.local/share/agent-process-segments',
  '%h/.cache',
  '-%h/.npm',
  '-%h/.config/opencode',
  '-%h/.local/share/opencode',
  '-%h/.local/state/opencode',
  '-%h/.cache/opencode',
  '-%h/.claude',
  '-%h/.claude.json',
]);

const ALL_CHECKS = Object.freeze([
  'boot',
  'terminal',
  'repair',
  'namespace',
  'upgrade-detach',
  'turn:opencode',
  'turn:claude',
  'worktree:home',
  'worktree:srv',
]);

/** Candidate directives, in evaluation order; each lists only the checks it can affect. */
export const PROBE_CANDIDATES = Object.freeze([
  {
    id: 'private-devices',
    directives: [['PrivateDevices', 'yes']],
    checks: ['boot', 'terminal', 'turn:opencode'],
  },
  {
    id: 'protect-proc',
    directives: [['ProtectProc', 'invisible']],
    checks: ['boot', 'terminal', 'turn:opencode'],
  },
  {
    id: 'proc-subset',
    directives: [['ProcSubset', 'pid']],
    checks: ['boot', 'terminal', 'turn:opencode'],
  },
  {
    id: 'restrict-namespaces',
    directives: [['RestrictNamespaces', '~user']],
    checks: ['boot', 'namespace', 'turn:opencode', 'turn:claude'],
  },
  {
    id: 'syscall-filter',
    directives: [['SystemCallFilter', '@system-service']],
    checks: [
      'boot',
      'terminal',
      'repair',
      'worktree:home',
      'turn:opencode',
      'turn:claude',
    ],
  },
  {
    id: 'protect-home',
    directives: [
      ['ProtectHome', 'read-only'],
      ['ReadWritePaths', PROBE_READ_WRITE_PATHS.join(' ')],
    ],
    checks: [
      'boot',
      'terminal',
      'repair',
      'worktree:home',
      'worktree:srv',
      'turn:opencode',
      'turn:claude',
      'upgrade-detach',
    ],
  },
  {
    id: 'protect-system',
    directives: [
      ['ProtectSystem', 'strict'],
      ['ReadWritePaths', PROBE_READ_WRITE_PATHS.join(' ')],
    ],
    checks: [
      'boot',
      'terminal',
      'repair',
      'worktree:home',
      'worktree:srv',
      'turn:opencode',
      'turn:claude',
      'upgrade-detach',
    ],
  },
]);

export const USAGE = `Usage: node scripts/systemd-sandbox-probe.mjs [options]

Boots the built brain under a transient systemd user unit with the shipped
sandbox block and one candidate directive, then exercises health, a PTY, both
agent harnesses, git worktrees, and the repair dry-run. Prints a check table
and one ADOPT/REJECT/DEFER suggestion per candidate.

Options:
  --root DIR            Probe base directory. Default: ${DEFAULT_ROOT}
                        Must be inside the real home and outside tmp/run/shm.
  --srv-root DIR        Writable directory outside the home for the outside-repo
                        check. Default: /srv when writable, otherwise skipped.
  --harness NAME        claude, opencode, or both. Default: both.
  --candidate ID        Run one candidate id (repeatable). Default: control + all.
  --directive KEY=VALUE Candidate directive for an ad-hoc run (repeatable).
  --report FILE         Also write the Markdown report to FILE.
  --claude-bin PATH     Claude Code binary. Default: claude on PATH.
  --opencode-bin PATH   OpenCode binary. Default: opencode on PATH.
  --timeout SECONDS     Per-step timeout. Default: 300.
  --keep                Keep each run directory for inspection.
  --help                Show this text.

Exit: 0 all checks passed or skipped, 1 a check failed, 2 usage, 3 host or build
preflight failed.`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function usageFail(message) {
  throw new UsageError(message);
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    usageFail(`${flag} needs a value`);
  }
  return value;
}

function parsePositiveSeconds(value, flag) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) usageFail(`${flag} needs a positive number`);
  return Math.round(seconds * 1000);
}

/**
 * Parse probe arguments. Repeatable options append; unknown or valueless
 * options throw UsageError so the caller exits 2.
 */
export function parseProbeArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    srvRoot: null,
    harness: 'both',
    candidates: [],
    directives: [],
    report: null,
    claudeBin: null,
    opencodeBin: null,
    timeoutMs: 300_000,
    keep: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--root') {
      options.root = requireValue(argv, index, '--root');
      index += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--srv-root') {
      options.srvRoot = requireValue(argv, index, '--srv-root');
      index += 1;
    } else if (arg.startsWith('--srv-root=')) {
      options.srvRoot = arg.slice('--srv-root='.length);
    } else if (arg === '--harness') {
      options.harness = requireValue(argv, index, '--harness');
      index += 1;
    } else if (arg.startsWith('--harness=')) {
      options.harness = arg.slice('--harness='.length);
    } else if (arg === '--candidate') {
      options.candidates.push(requireValue(argv, index, '--candidate'));
      index += 1;
    } else if (arg.startsWith('--candidate=')) {
      options.candidates.push(arg.slice('--candidate='.length));
    } else if (arg === '--directive') {
      options.directives.push(requireValue(argv, index, '--directive'));
      index += 1;
    } else if (arg.startsWith('--directive=')) {
      options.directives.push(arg.slice('--directive='.length));
    } else if (arg === '--report') {
      options.report = requireValue(argv, index, '--report');
      index += 1;
    } else if (arg.startsWith('--report=')) {
      options.report = arg.slice('--report='.length);
    } else if (arg === '--claude-bin') {
      options.claudeBin = requireValue(argv, index, '--claude-bin');
      index += 1;
    } else if (arg.startsWith('--claude-bin=')) {
      options.claudeBin = arg.slice('--claude-bin='.length);
    } else if (arg === '--opencode-bin') {
      options.opencodeBin = requireValue(argv, index, '--opencode-bin');
      index += 1;
    } else if (arg.startsWith('--opencode-bin=')) {
      options.opencodeBin = arg.slice('--opencode-bin='.length);
    } else if (arg === '--timeout') {
      options.timeoutMs = parsePositiveSeconds(requireValue(argv, index, '--timeout'), '--timeout');
      index += 1;
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = parsePositiveSeconds(arg.slice('--timeout='.length), '--timeout');
    } else if (arg.startsWith('-')) {
      usageFail(`unknown argument: ${arg}`);
    } else {
      usageFail(`unexpected argument: ${arg}`);
    }
  }

  if (!['both', 'claude', 'opencode'].includes(options.harness)) {
    usageFail('--harness must be claude, opencode, or both');
  }
  if (!path.isAbsolute(options.root)) usageFail('--root must be an absolute path');
  if (options.srvRoot !== null && !path.isAbsolute(options.srvRoot)) {
    usageFail('--srv-root must be an absolute path');
  }
  for (const directive of options.directives) {
    if (!/^[A-Za-z][A-Za-z0-9]*=.*/.test(directive)) {
      usageFail(`--directive needs Key=Value: ${directive}`);
    }
  }
  for (const id of options.candidates) {
    if (id !== 'control' && !PROBE_CANDIDATES.some((candidate) => candidate.id === id)) {
      usageFail(`unknown candidate: ${id}`);
    }
  }

  return options;
}

/** Replace every systemd `%h` with the probe's fake home. */
export function substituteHome(value, home) {
  return value.split('%h').join(home);
}

/** Space-joined ReadWritePaths value from the reviewed path list. */
export function renderReadWritePaths(paths) {
  return paths.join(' ');
}

/** Suggested verdict for one candidate from its check rows. */
export function suggestedVerdict(rows) {
  if (rows.some((row) => row.status === 'FAIL')) return 'REJECT';
  if (rows.some((row) => row.status === 'SKIP')) return 'DEFER';
  return 'ADOPT';
}

/** Bounded journal/log excerpt around the first failure-looking line. */
export function journalExcerpt(text, maxLines = MAX_JOURNAL_LINES) {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length <= maxLines) return lines;
  const interesting = /read-only|permission denied|operation not permitted|seccomp|sigsys|no such file|cannot|failed|error|denied|not found/i;
  const first = lines.findIndex((line) => interesting.test(line));
  if (first === -1) return lines.slice(-maxLines);
  const start = Math.max(0, first - Math.floor(maxLines / 2));
  return lines.slice(start, start + maxLines);
}

/** Markdown table for check rows. */
export function renderCheckTable(rows) {
  const lines = ['| Check | Status | Detail |', '| --- | --- | --- |'];
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.status} | ${String(row.detail ?? '').replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n');
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    cwd: options.cwd,
    env: options.env,
  });
}

function isExecutable(file) {
  try {
    return statSync(file).isFile() && (accessSync(file, constants.X_OK), true);
  } catch {
    return false;
  }
}

function resolveBinary(name, explicit) {
  if (explicit !== null) {
    if (!path.isAbsolute(explicit) || !isExecutable(explicit)) {
      throw new Error(`${name} binary is not an executable file: ${explicit}`);
    }
    return explicit;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.resolve(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`timed out waiting for ${label}${suffix}`);
}

function initializeRepo(dir, name) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nSandbox probe fixture.\n`, {
    mode: 0o600,
  });
  const git = (args) => {
    const result = run('git', ['-C', dir, ...args]);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
  };
  git(['init', '--quiet']);
  git(['config', 'user.email', 'probe@example.invalid']);
  git(['config', 'user.name', 'Sandbox Probe']);
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'probe fixture']);
}

/**
 * Copy the invoking user's local harness state into the fake home so a real
 * agent turn can authenticate. Without this the CLI starts but reports an
 * unavailable model, which is a setup failure rather than sandbox evidence.
 * OpenCode keeps its credentials in opencode.db, so use SQLite's backup API for
 * a consistent copy; Claude keeps them in ~/.claude/.credentials.json.
 */
async function seedHarnessState(context) {
  const realHome = os.homedir();
  const seeded = { opencode: false, claude: false };

  if (context.harnesses.opencode) {
    const source = path.join(realHome, '.local', 'share', 'opencode', 'opencode.db');
    const dest = path.join(context.layout.xdgData, 'opencode', 'opencode.db');
    if (existsSync(source)) {
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      try {
        const Database = requireFromRepo('better-sqlite3');
        const db = new Database(source, { readonly: true, fileMustExist: true });
        await db.backup(dest);
        db.close();
        chmodSync(dest, 0o600);
        seeded.opencode = true;
      } catch (error) {
        context.seedErrors.push(
          `opencode state copy failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  if (context.harnesses.claude) {
    const home = context.layout.home;
    const candidates = [
      [path.join(realHome, '.claude.json'), path.join(home, '.claude.json')],
      [
        path.join(realHome, '.claude', '.credentials.json'),
        path.join(home, '.claude', '.credentials.json'),
      ],
    ];
    for (const [source, dest] of candidates) {
      if (!existsSync(source)) continue;
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      try {
        copyFileSync(source, dest);
        chmodSync(dest, 0o600);
        seeded.claude = true;
      } catch (error) {
        context.seedErrors.push(
          `claude state copy failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  context.turnSeeded = seeded;
}

function prepareRunLayout(layout, context) {
  const dirs = [
    layout.workdir,
    layout.dataDir,
    layout.pluginsDir,
    path.dirname(layout.configPath),
    path.dirname(layout.errorLogPath),
    layout.xdgConfig,
    layout.xdgState,
    layout.xdgData,
    layout.xdgCache,
    layout.opencodeConfig,
    path.join(layout.home, '.npm'),
    path.join(layout.home, '.local', 'share', 'opencode'),
    path.join(layout.home, '.local', 'state', 'opencode'),
    path.join(layout.home, '.cache', 'opencode'),
    layout.homeRepo,
  ];
  if (context.claudeBin !== null) {
    dirs.push(path.join(layout.home, '.claude'));
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
  initializeRepo(layout.homeRepo, 'home repo');
}

function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

function terminalScript(context) {
  const { layout, repo, srvRepo } = context;
  const lines = [
    'set +e',
    'out="$APS_DATA_DIR/terminal-probe.txt"',
    ': > "$out"',
    '{',
    '  echo "pwd=$PWD"',
    '  git status --short; echo "git_status=$?"',
    '  ps aux >/dev/null 2>&1; echo "ps=$?"',
    '  ps -ef >/dev/null 2>&1; echo "ps_ef=$?"',
    '  free >/dev/null 2>&1; echo "free=$?"',
    '  top -b -n 1 >/dev/null 2>&1; echo "top=$?"',
    '  cat /proc/self/status >/dev/null 2>&1; echo "proc_self=$?"',
    '  nproc >/dev/null 2>&1; echo "nproc=$?"',
    '  systemctl --user show-environment >/dev/null 2>&1; echo "systemctl=$?"',
    `  touch ${shellQuote(path.join(layout.home, 'aps-terminal-touch'))} 2>&1; echo "touch_home=$?"`,
    '  touch /tmp/aps-terminal-touch 2>&1; echo "touch_tmp=$?"',
    '  touch "$APS_DATA_DIR/aps-terminal-touch" 2>&1; echo "touch_data=$?"',
  ];
  if (srvRepo !== null) {
    lines.push(`  touch ${shellQuote(path.join(srvRepo, 'aps-terminal-touch'))} 2>&1; echo "touch_srv=$?"`);
  } else {
    lines.push('  echo "touch_srv=skip"');
  }
  lines.push(
    `  ( cd ${shellQuote(repo)} && npm run repair:permissions -- --dry-run >/dev/null 2>&1 ); echo "repair=$?"`,
    '  unshare -U true >/dev/null 2>&1; echo "unshare_user=$?"',
    '  unshare -m true >/dev/null 2>&1; echo "unshare_mount=$?"',
    `  systemd-run --user --unit=${shellQuote(`aps-probe-inner-${process.pid}`)} --wait --collect /bin/true >/dev/null 2>&1; echo "detach=$?"`,
    '} >> "$out" 2>&1',
    `printf '__APS_%s__\\n' PROBE_DONE`,
  );
  return `${lines.join('\n')}\n`;
}

function parseResults(text) {
  const values = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    if (!/^[a-z_]+$/.test(key)) continue;
    values.set(key, line.slice(equals + 1));
  }
  return values;
}

function resultStatus(values, key) {
  const value = values.get(key);
  if (value === undefined) return { status: 'FAIL', detail: `missing ${key}` };
  if (value === 'skip') return { status: 'SKIP', detail: `${key} skipped` };
  return Number(value) === 0
    ? { status: 'PASS', detail: `${key}=0` }
    : { status: 'FAIL', detail: `${key}=${value}` };
}

function combineResults(parts) {
  const failed = parts.filter((part) => part.status === 'FAIL');
  if (failed.length > 0) {
    return { status: 'FAIL', detail: failed.map((part) => part.detail).join('; ') };
  }
  const skipped = parts.filter((part) => part.status === 'SKIP');
  if (skipped.length > 0) {
    return { status: 'SKIP', detail: skipped.map((part) => part.detail).join('; ') };
  }
  return { status: 'PASS', detail: parts.map((part) => part.detail).join('; ') };
}

class TerminalClient {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = '';
    this.closed = false;
    this.waiters = new Set();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('terminal websocket open timed out')), this.timeoutMs);
      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.t === 'data') this.buffer += message.data;
        if (message.t === 'ready') {
          clearTimeout(timer);
          resolve();
        }
        if (message.t === 'error') {
          clearTimeout(timer);
          reject(new Error(message.message ?? 'terminal error'));
        }
        if (message.t === 'exit' || message.t === 'closed') this.closed = true;
        for (const waiter of [...this.waiters]) waiter();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('terminal websocket failed'));
      });
      socket.addEventListener('close', () => {
        this.closed = true;
        clearTimeout(timer);
        for (const waiter of [...this.waiters]) waiter();
      });
    });
  }

  write(data) {
    this.socket.send(JSON.stringify({ type: 'input', data }));
  }

  resize(cols, rows) {
    this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  waitForText(text, timeoutMs = this.timeoutMs) {
    const start = this.buffer.length;
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const recent = this.buffer.slice(start);
        if (recent.includes(text)) {
          clearInterval(timer);
          this.waiters.delete(check);
          resolve();
          return;
        }
        if (this.closed) {
          clearInterval(timer);
          this.waiters.delete(check);
          reject(new Error('terminal closed before the marker'));
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          this.waiters.delete(check);
          reject(new Error(`terminal marker timed out: ${text}`));
        }
      };
      const timer = setInterval(check, 100);
      this.waiters.add(check);
      check();
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
  }
}

async function apiCall(context, method, route, body) {
  const response = await fetch(`${context.base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 400)}`);
  }
  return text === '' ? null : JSON.parse(text);
}

function readErrorSources(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line).source];
      } catch {
        return [];
      }
    });
}

async function runTerminal(context) {
  const scriptFile = path.join(context.layout.root, 'terminal-probe.sh');
  writeFileSync(scriptFile, terminalScript(context), { mode: 0o700 });
  const info = await apiCall(context, 'POST', '/api/terminals', { cols: 120, rows: 40 });
  const client = new TerminalClient(
    `ws://127.0.0.1:${context.port}/ws/terminal?sessionId=${encodeURIComponent(info.id)}`,
    context.timeoutMs,
  );
  try {
    await client.connect();
    client.resize(132, 43);
    client.write(`bash ${shellQuote(scriptFile)}\n`);
    await client.waitForText(MARKER);
    const results = parseResults(readFileSync(path.join(context.layout.dataDir, 'terminal-probe.txt'), 'utf8'));
    return results;
  } finally {
    client.close();
    try {
      await apiCall(context, 'DELETE', `/api/terminals/${encodeURIComponent(info.id)}`);
    } catch {
      // The session may already be gone.
    }
  }
}

function namespaceExpectation(context) {
  const candidate = context.candidate;
  const restrict = candidate.directives.find(([key]) => key === 'RestrictNamespaces');
  const blocksUser = restrict !== undefined && restrict[1].split(/\s+/).includes('~user');
  return blocksUser ? 'blocked' : 'allowed';
}

async function runTurn(context, harness) {
  if (!context.harnesses[harness]) {
    return { status: 'SKIP', detail: `${harness} binary not found` };
  }
  if (!context.turnSeeded[harness]) {
    return { status: 'SKIP', detail: `${harness} has no local state to seed a turn` };
  }
  const text = 'Automated sandbox probe. Reply with exactly PROBE-OK and do not call tools or modify files.';
  let request = null;
  try {
    request = await apiCall(context, 'POST', '/api/requests', {
      title: `Sandbox probe ${harness} turn`,
      body: text,
      harness,
    });
    await apiCall(context, 'POST', `/api/requests/${request.id}/clarify/send?detach=1`, { text });
    try {
      await waitFor(
        async () => {
          const current = await apiCall(context, 'GET', `/api/requests/${request.id}`);
          const clarify = await apiCall(context, 'GET', `/api/requests/${request.id}/clarify`);
          return current.agentStatus === 'idle' && clarify.active === false;
        },
        `${harness} turn`,
        context.turnTimeoutMs,
      );
    } catch (error) {
      await apiCall(context, 'POST', `/api/requests/${request.id}/clarify/stop`).catch(() => {});
      throw error;
    }
    const clarify = await apiCall(context, 'GET', `/api/requests/${request.id}/clarify`);
    const answer = (clarify.transcript ?? []).find(
      (message) => message.role === 'agent' && message.kind === 'text' && message.text.trim() !== '',
    );
    if (!answer) {
      return { status: 'FAIL', detail: `${harness} turn produced no agent text` };
    }
    const engineErrors = readErrorSources(context.layout.errorLogPath).filter((source) =>
      String(source).startsWith('engine.'),
    );
    if (engineErrors.length > 0) {
      return { status: 'FAIL', detail: `${harness} turn logged ${engineErrors.join(', ')}` };
    }
    return { status: 'PASS', detail: `${harness} turn answered` };
  } finally {
    if (request !== null) {
      await apiCall(context, 'POST', `/api/requests/${request.id}/drop`).catch(() => {});
    }
  }
}

async function runWorktree(context, target) {
  const targetRepo = target === 'home' ? context.layout.homeRepo : context.srvRepo;
  if (targetRepo === null) {
    return { status: 'SKIP', detail: 'no writable --srv-root for the outside repo' };
  }
  let request = null;
  const dir = (id) => path.join(context.layout.dataDir, 'worktrees', id);
  try {
    request = await apiCall(context, 'POST', '/api/requests', {
      title: `Sandbox probe ${target} worktree`,
      body: 'Automated sandbox probe: reply with PROBE-OK.',
      targetRepo,
      harness: 'opencode',
    });
    await apiCall(context, 'POST', `/api/requests/${request.id}/clarify/send?detach=1`, {
      text: 'Automated sandbox probe. Reply with exactly PROBE-OK.',
    });
    try {
      await waitFor(() => existsSync(dir(request.id)), `${target} worktree`, context.turnTimeoutMs);
    } catch {
      await apiCall(context, 'POST', `/api/requests/${request.id}/clarify/stop`).catch(() => {});
      return { status: 'FAIL', detail: `${target} worktree missing (scratch fallback)` };
    }
    const branch = run('git', ['-C', dir(request.id), 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch.status !== 0 || branch.stdout.trim() !== `aps/${request.id}`) {
      return {
        status: 'FAIL',
        detail: `${target} worktree branch ${branch.stdout.trim() || branch.stderr.trim()}`,
      };
    }
    const commit = run('git', [
      '-C',
      dir(request.id),
      '-c',
      'user.email=probe@example.invalid',
      '-c',
      'user.name=Sandbox Probe',
      'commit',
      '--allow-empty',
      '-m',
      'probe commit',
    ]);
    if (commit.status !== 0) {
      return { status: 'FAIL', detail: `${target} worktree commit failed: ${commit.stderr.trim()}` };
    }
    const droppedId = request.id;
    await apiCall(context, 'POST', `/api/requests/${droppedId}/drop`);
    request = null;
    await waitFor(() => !existsSync(dir(droppedId)), `${target} worktree removal`, 15_000).catch(
      () => {},
    );
    if (existsSync(dir(droppedId))) {
      return { status: 'FAIL', detail: `${target} worktree was not removed` };
    }
    return { status: 'PASS', detail: `${target} worktree created, committed, removed` };
  } finally {
    if (request !== null) {
      await apiCall(context, 'POST', `/api/requests/${request.id}/drop`).catch(() => {});
    }
  }
}

async function ensureTerminal(context) {
  if (context.terminalResults === undefined) {
    context.terminalResults = await runTerminal(context);
  }
  return context.terminalResults;
}

async function runCheck(context, id) {
  if (id === 'boot') {
    const health = await apiCall(context, 'GET', '/health');
    if (health?.ok !== true) return { status: 'FAIL', detail: 'health was not ok' };
    await apiCall(context, 'GET', '/api/process');
    const home = await fetch(`${context.base}/`, { signal: AbortSignal.timeout(10_000) });
    if (!home.ok) return { status: 'FAIL', detail: `SPA / -> ${home.status}` };
    return { status: 'PASS', detail: 'health, process, and SPA answered' };
  }
  if (id === 'terminal') {
    const values = await ensureTerminal(context);
    const checks = [
      'git_status',
      'ps',
      'free',
      'proc_self',
      'nproc',
      'systemctl',
      'touch_home',
      'touch_tmp',
      'touch_data',
      'repair',
    ];
    const parts = checks.map((key) => resultStatus(values, key));
    parts.push(resultStatus(values, 'ps_ef'));
    if (values.has('touch_srv')) parts.push(resultStatus(values, 'touch_srv'));
    const top = values.get('top');
    if (top === '127') parts.push({ status: 'SKIP', detail: 'top not installed' });
    else parts.push(resultStatus(values, 'top'));
    const combined = combineResults(parts);
    context.terminalFailed = combined.status === 'FAIL';
    return combined;
  }
  if (id === 'repair') {
    await ensureTerminal(context);
    if (context.terminalFailed) return { status: 'SKIP', detail: 'terminal check failed' };
    return resultStatus(context.terminalResults, 'repair');
  }
  if (id === 'namespace') {
    await ensureTerminal(context);
    if (context.terminalFailed) return { status: 'SKIP', detail: 'terminal check failed' };
    const user = context.terminalResults.get('unshare_user');
    const mount = context.terminalResults.get('unshare_mount');
    if (user === '127' || mount === '127') return { status: 'SKIP', detail: 'unshare not installed' };
    const expected = namespaceExpectation(context);
    const userOk = expected === 'blocked' ? Number(user) !== 0 : Number(user) === 0;
    if (!userOk) {
      return {
        status: 'FAIL',
        detail: `unshare -U returned ${user} (expected ${expected})`,
      };
    }
    // The shipped CapabilityBoundingSet= already removes CAP_SYS_ADMIN, so mount
    // namespaces fail in the control too; record the value but do not gate on it.
    return {
      status: 'PASS',
      detail: `user namespaces ${expected}; unshare -m=${mount} (informational)`,
    };
  }
  if (id === 'upgrade-detach') {
    await ensureTerminal(context);
    if (context.terminalFailed) return { status: 'SKIP', detail: 'terminal check failed' };
    return resultStatus(context.terminalResults, 'detach');
  }
  if (id === 'turn:opencode' || id === 'turn:claude') {
    return runTurn(context, id.slice('turn:'.length));
  }
  if (id === 'worktree:home' || id === 'worktree:srv') {
    return runWorktree(context, id.slice('worktree:'.length));
  }
  return { status: 'FAIL', detail: `unknown check ${id}` };
}

function sandboxProperties(context) {
  const assignments = context.assignments;
  const overrides = new Set(context.candidate.directives.map(([key]) => key));
  const properties = [];
  for (const key of Object.keys(HARDENING_REQUIRED)) {
    if (overrides.has(key)) continue;
    const value = effectiveDirectiveValue(assignments, key) ?? HARDENING_REQUIRED[key];
    properties.push([key, value]);
  }
  for (const key of LIST_DIRECTIVES) {
    if (overrides.has(key)) continue;
    const value = effectiveDirectiveValue(assignments, key);
    if (value !== undefined) properties.push([key, value]);
  }
  for (const [key, value] of context.candidate.directives) properties.push([key, value]);
  return properties.map(([key, value]) => [key, substituteHome(value, context.layout.home)]);
}

function startUnit(context, properties = sandboxProperties(context)) {
  const logFile = path.join(context.layout.root, 'brain.log');
  const errorFile = path.join(context.layout.root, 'brain.err');
  const args = [
    '--user',
    `--unit=${context.unit}`,
    '--collect',
    `--working-directory=${context.layout.workdir}`,
    '-p',
    'Type=simple',
    '-p',
    'Restart=no',
    '-p',
    'KillMode=mixed',
    '-p',
    'TimeoutStopSec=10',
    '-p',
    `StandardOutput=file:${logFile}`,
    '-p',
    `StandardError=file:${errorFile}`,
  ];
  for (const [key, value] of Object.entries(context.pins)) {
    args.push(`--setenv=${key}=${value}`);
  }
  for (const [key, value] of properties) {
    args.push('-p', value === '' ? `${key}=` : `${key}=${value}`);
  }
  args.push(process.execPath, path.join(context.repo, 'src/server/dist/app.js'));
  const result = run('systemd-run', args, { env: MANAGER_ENV, timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`systemd-run failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return { logFile, errorFile };
}

function stopUnit(unit) {
  run('systemctl', ['--user', 'stop', unit], { env: MANAGER_ENV, timeout: 30_000 });
  run('systemctl', ['--user', 'reset-failed', unit], { env: MANAGER_ENV, timeout: 15_000 });
}

function journalFor(unit) {
  const result = run('journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager'], {
    env: MANAGER_ENV,
    timeout: 30_000,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function appLogs(context) {
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return [read(path.join(context.layout.root, 'brain.err')), read(path.join(context.layout.root, 'brain.log'))]
    .filter((text) => text.trim() !== '')
    .join('\n');
}

// Kept synchronous on purpose: the caller has already stopped the unit.
const SYSTEMD_NOISE = /^(Running as unit|Started |Stopping |Stopped |Finished with result|Main processes terminated|Service runtime|CPU time consumed|Memory peak)\b/;

function collectEvidence(context, unit) {
  const text = [journalFor(unit), appLogs(context)]
    .filter((part) => part.trim() !== '')
    .join('\n');
  const informative = text
    .split('\n')
    .filter((line) => line.trim() !== '' && !SYSTEMD_NOISE.test(line.trim()));
  context.evidence = journalExcerpt(informative.join('\n')).join('\n');
}

function hostFacts(harnesses) {
  const systemd = run('systemd-analyze', ['--version'], { timeout: 15_000 });
  const version = systemdVersion(`${systemd.stdout ?? ''}${systemd.stderr ?? ''}`);
  const kernel = run('uname', ['-r']);
  const harnessFacts = Object.entries(harnesses).map(([name, bin]) => {
    const result = run(bin, ['--version'], { timeout: 15_000 });
    const first = (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
    return `${name}=${bin}${first === '' ? '' : ` (${first})`}`;
  });
  return {
    platform: process.platform,
    systemd: version ?? 'unknown',
    kernel: kernel.stdout.trim(),
    node: process.version,
    arch: process.arch,
    harnesses: harnessFacts,
  };
}

async function runCandidate(options, candidate, index, contextBase) {
  const baseRoot = options.root;
  mkdirSync(baseRoot, { recursive: true, mode: 0o700 });
  const runRoot = mkdtempSync(path.join(baseRoot, `${candidate.id}-`));
  const layout = probeLayout(runRoot);
  const unit = `aps-sandbox-probe-${process.pid}-${index}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const pins = buildProbePins({
    root: runRoot,
    repo: repoRoot,
    port,
    base,
    harness: contextBase.harness,
    claudeBin: contextBase.claudeBin,
    opencodeBin: contextBase.opencodeBin,
    turnTimeoutMs: options.timeoutMs,
    pathValue: process.env.PATH,
  });
  const problems = probePinProblems({ root: runRoot, realHome: os.homedir(), pins });
  if (problems.length > 0) {
    throw new Error(`unsafe probe pins: ${problems.join('; ')}`);
  }

  const context = {
    ...contextBase,
    candidate,
    layout,
    unit,
    port,
    base,
    pins,
    timeoutMs: options.timeoutMs,
    turnTimeoutMs: options.timeoutMs,
    srvRepo: contextBase.srvRepo,
    evidence: '',
    terminalResults: undefined,
    harnesses: contextBase.harnesses,
    turnSeeded: { claude: false, opencode: false },
    seedErrors: [],
  };
  prepareRunLayout(layout, context);
  if (candidate.checks.some((id) => id.startsWith('turn:'))) {
    await seedHarnessState(context);
  }
  let services = null;
  const rows = [];
  const properties = sandboxProperties(context);
  try {
    services = startUnit(context, properties);
    await waitFor(
      async () => {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
      },
      'brain health',
      options.timeoutMs,
    );
    let terminalFailed = false;
    for (const id of candidate.checks) {
      if (terminalFailed && (id.startsWith('turn:') || id.startsWith('worktree:'))) {
        rows.push({ id, status: 'SKIP', detail: 'skipped after a terminal failure' });
        continue;
      }
      let row;
      try {
        row = await runCheck(context, id);
      } catch (error) {
        row = { status: 'FAIL', detail: error instanceof Error ? error.message : String(error) };
      }
      rows.push({ id, ...row });
      if (row.status === 'FAIL') {
        if (id === 'terminal') terminalFailed = true;
        else break;
      }
    }
    if (rows.some((row) => row.status === 'FAIL') && context.evidence === '') {
      collectEvidence(context, unit);
    }
  } finally {
    if (services !== null) stopUnit(unit);
    if (context.evidence === '') collectEvidence(context, unit);
    if (!options.keep) rmSync(runRoot, { recursive: true, force: true });
  }

  return {
    candidate,
    rows,
    verdict: suggestedVerdict(rows),
    evidence: context.evidence,
    properties,
    services,
    runRoot: options.keep ? runRoot : null,
  };
}

function selectedCandidates(options) {
  if (options.directives.length > 0) {
    const directives = options.directives.map((value) => {
      const equals = value.indexOf('=');
      return [value.slice(0, equals), value.slice(equals + 1)];
    });
    return [
      {
        id: 'custom',
        directives,
        checks: [...ALL_CHECKS],
      },
    ];
  }
  if (options.candidates.length === 0) return [...PROBE_CANDIDATES];
  return PROBE_CANDIDATES.filter((candidate) => options.candidates.includes(candidate.id));
}

function unionChecks(candidates) {
  const checks = new Set();
  for (const candidate of candidates) {
    for (const id of candidate.checks) checks.add(id);
  }
  return ALL_CHECKS.filter((id) => checks.has(id));
}

function makeReport({ facts, results, control, options }) {
  const lines = [
    '# systemd sandbox probe report',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Host: ${facts.platform} ${facts.arch}, kernel ${facts.kernel}`,
    `- systemd: ${facts.systemd}`,
    `- Node: ${facts.node}`,
    `- Harness: ${options.harness}`,
    `- Harness binaries: ${facts.harnesses.length > 0 ? facts.harnesses.join('; ') : 'none'}`,
    `- Root base: ${options.root}`,
    `- Outside repo: ${options.srvRoot ?? 'auto (/srv when writable)'}`,
    '',
    '## Control (shipped sandbox block)',
    '',
    renderCheckTable(control.rows),
    '',
    '## Candidates',
    '',
  ];
  for (const result of results) {
    lines.push(`### ${result.candidate.id}`, '');
    for (const [key, value] of result.candidate.directives) {
      lines.push(`- \`${key}=${value}\``);
    }
    lines.push(
      '',
      'Effective sandbox properties (after `%h` substitution):',
      '',
      '```ini',
      ...result.properties.map(([key, value]) => `${key}=${value}`),
      '```',
      '',
      renderCheckTable(result.rows),
      '',
      `Suggested verdict: **${result.verdict}**`,
      '',
    );
    if (result.evidence !== '') {
      lines.push('```', result.evidence, '```', '');
    }
  }
  lines.push(
    '## Decision rule',
    '',
    'ADOPT when every declared check passes, REJECT when one fails with evidence, DEFER when a required check skips.',
    '',
  );
  return lines.join('\n');
}

async function preflight(options) {
  if (process.platform !== 'linux') {
    throw new Error('SKIPPED: the sandbox probe requires Linux and systemd');
  }
  const version = run('systemd-analyze', ['--version'], { timeout: 15_000 });
  if (version.error) throw new Error('systemd-analyze is not installed');
  const major = systemdVersion(`${version.stdout ?? ''}${version.stderr ?? ''}`);
  if (major === null || major < MIN_SYSTEMD) {
    throw new Error(`systemd ${MIN_SYSTEMD} or newer is required; found ${major ?? 'unknown'}`);
  }
  const manager = run('systemctl', ['--user', 'show-environment'], {
    env: MANAGER_ENV,
    timeout: 15_000,
  });
  if (manager.status !== 0) throw new Error('the systemd user manager is not available');
  if (run('systemd-run', ['--version'], { timeout: 15_000 }).error) {
    throw new Error('systemd-run is not installed');
  }
  const app = path.join(repoRoot, 'src/server/dist/app.js');
  const web = path.join(repoRoot, 'src/web/dist');
  if (!existsSync(app)) throw new Error(`built brain missing: ${app} (run npm run build)`);
  if (!existsSync(web)) throw new Error(`built SPA missing: ${web} (run npm run build)`);
  if (typeof WebSocket !== 'function') {
    throw new Error('the probe needs the global WebSocket (Node 22 or newer)');
  }
  try {
    requireFromRepo.resolve('node-pty');
  } catch {
    throw new Error('node-pty is not installed (run npm ci --include=dev)');
  }

  const harnesses = {};
  if (options.harness !== 'opencode') {
    const claude = resolveBinary('claude', options.claudeBin);
    if (claude !== null) harnesses.claude = claude;
  }
  if (options.harness !== 'claude') {
    const opencode = resolveBinary('opencode', options.opencodeBin);
    if (opencode !== null) harnesses.opencode = opencode;
  }
  if (Object.keys(harnesses).length === 0) {
    throw new Error('no agent CLI found (install claude or opencode, or pass --claude-bin/--opencode-bin)');
  }
  return harnesses;
}

function resolveSrvRoot(options) {
  if (options.srvRoot !== null) {
    try {
      mkdirSync(options.srvRoot, { recursive: true, mode: 0o700 });
      accessSync(options.srvRoot, constants.W_OK);
      return path.join(options.srvRoot, `aps-sandbox-probe-${process.pid}`);
    } catch {
      return null;
    }
  }
  try {
    accessSync('/srv', constants.W_OK);
    return path.join('/srv', `aps-sandbox-probe-${process.pid}`);
  } catch {
    return null;
  }
}

function prepareSrvRepo(srvBase) {
  if (srvBase === null) return null;
  const repo = path.join(srvBase, 'repo');
  try {
    initializeRepo(repo, 'outside repo');
    return repo;
  } catch {
    return null;
  }
}

async function main(argv) {
  let options;
  try {
    options = parseProbeArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`systemd-sandbox-probe: ${error.message}`);
      console.error('systemd-sandbox-probe: run with --help for usage');
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let harnesses;
  try {
    harnesses = await preflight(options);
  } catch (error) {
    console.error(`systemd-sandbox-probe: ${error instanceof Error ? error.message : error}`);
    return 3;
  }

  const shipped = readFileSync(path.join(repoRoot, DEFAULT_UNIT), 'utf8');
  const assignments = serviceAssignments(shipped);
  const srvBase = resolveSrvRoot(options);
  const srvRepo = prepareSrvRepo(srvBase);
  const selected = selectedCandidates(options);
  const controlCandidate = {
    id: 'control',
    directives: [],
    checks: unionChecks(selected.length > 0 ? selected : PROBE_CANDIDATES),
  };
  if (!selected.some((candidate) => candidate.id === 'control')) {
    selected.unshift(controlCandidate);
  }

  const facts = hostFacts(harnesses);
  const results = [];
  const contextBase = {
    repo: repoRoot,
    assignments,
    harnesses,
    srvRepo,
    claudeBin: harnesses.claude ?? null,
    opencodeBin: harnesses.opencode ?? null,
    harness: harnesses.opencode ? 'opencode' : 'claude',
  };

  let failed = false;
  try {
    for (const [index, candidate] of selected.entries()) {
      let result;
      try {
        result = await runCandidate(options, candidate, index, contextBase);
      } catch (error) {
        failed = true;
        console.error(
          `systemd-sandbox-probe: ${candidate.id} could not run: ${error instanceof Error ? error.message : error}`,
        );
        continue;
      }
      results.push(result);
      if (candidate.id === 'control' && result.rows.some((row) => row.status === 'FAIL')) {
        failed = true;
        console.error('systemd-sandbox-probe: control run failed; candidate results are not attributable');
        break;
      }
      if (result.rows.some((row) => row.status === 'FAIL')) failed = true;
      const summary = result.rows.map((row) => `${row.id}=${row.status}`).join(' ');
      console.log(`\n[${candidate.id}] ${summary}`);
      if (candidate.id === 'control') {
        console.log(`[control] ${result.rows.some((row) => row.status === 'FAIL') ? 'FAIL' : 'PASS'}`);
      } else {
        console.log(`[${candidate.id}] suggested verdict: ${result.verdict}`);
      }
      if (result.evidence !== '') console.log(result.evidence);
      if (result.runRoot !== null) console.log(`[${candidate.id}] kept: ${result.runRoot}`);
    }
  } finally {
    if (srvBase !== null) rmSync(srvBase, { recursive: true, force: true });
  }

  const control = results.find((result) => result.candidate.id === 'control') ?? {
    rows: [],
  };
  const report = makeReport({
    facts,
    results: results.filter((result) => result.candidate.id !== 'control'),
    control,
    options,
  });
  if (options.report !== null) {
    writeFileSync(path.resolve(options.report), `${report}\n`, { mode: 0o600 });
    console.log(`\nreport: ${path.resolve(options.report)}`);
  }
  console.log(`\n${report}`);

  return failed ? 1 : 0;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
