// Group-leader supervisor for one scripts/web-stress.mjs suite iteration.
//
// The runner spawns this file as a detached child and passes its own pid:
//
//   node scripts/web-stress/suite-supervisor.mjs --parent-pid <pid> -- <npm argv...>
//
// `detached` makes this process the session and process-group leader, and the
// npm child plus every process npm starts inherit that group. If the runner
// disappears - including after SIGKILL, where no handler in the runner can run
// - the watchdog below SIGKILLs the whole group, so npm, its shell, and the
// Vitest workers cannot outlive the run. The runner still owns the normal
// timeout and interrupt paths; this file only covers the case it cannot.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WATCHDOG_INTERVAL_MS = 200;

export class SupervisorUsageError extends Error {}

/**
 * Parse `--parent-pid <pid> -- <command> [args...]`.
 *
 * Pure so the entry can reject a malformed invocation before it spawns
 * anything. The runner pid comes from argv, not from a first `process.ppid`
 * read, so a runner killed between fork and this file's first line is still
 * observed as gone.
 */
export function parseSupervisorArgs(argv) {
  if (argv.length < 4 || argv[0] !== '--parent-pid') {
    throw new SupervisorUsageError('expected --parent-pid <pid> -- <command> [args...]');
  }
  if (!/^\d+$/.test(argv[1])) {
    throw new SupervisorUsageError('--parent-pid needs a positive integer');
  }
  const parentPid = Number(argv[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new SupervisorUsageError('--parent-pid needs a positive integer');
  }
  if (argv[2] !== '--') {
    throw new SupervisorUsageError('expected -- before the command');
  }
  const [command, ...args] = argv.slice(3);
  if (!command) {
    throw new SupervisorUsageError('expected a command after --');
  }
  return { parentPid, command, args };
}

/**
 * Run `command` in this process's group and exit with its status.
 *
 * `spawn`, `kill`, `ownPid`, `ppid`, `exit`, and `log` are injectable so tests
 * do not need real processes. The watchdog is the SIGKILL-safe layer: when
 * the runner is gone, `process.ppid` no longer matches, and signalling the
 * negative own pid takes down the whole suite group plus this leader.
 */
export function supervise({
  parentPid,
  command,
  args,
  spawn: spawnChild = spawn,
  kill = (pid, signal) => process.kill(-pid, signal),
  intervalMs = WATCHDOG_INTERVAL_MS,
  ownPid = process.pid,
  ppid = () => process.ppid,
  exit = (code) => process.exit(code),
  log = (message) => console.error(message),
  signals = process,
} = {}) {
  const child = spawnChild(command, args, { stdio: 'inherit' });
  let watchdog;
  let settled = false;

  const finish = (code) => {
    if (settled) return;
    settled = true;
    if (watchdog !== undefined) clearInterval(watchdog);
    exit(code);
  };

  // The runner signals the whole group on a timeout or interrupt. npm must
  // receive that SIGTERM, but this leader has to stay alive long enough to
  // observe npm's exit; the runner's SIGKILL escalation is still the backstop.
  const ignore = () => {};
  signals.on?.('SIGTERM', ignore);
  signals.on?.('SIGINT', ignore);

  watchdog = setInterval(() => {
    if (ppid() === parentPid) return;
    // The runner is gone. Signal our own group so npm, the shell, and the
    // Vitest workers die with this leader. Fall back to the direct child if
    // this process was somehow not made a group leader.
    try {
      kill(ownPid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // The child is already gone.
      }
    }
  }, intervalMs);

  child.on?.('error', (error) => {
    log(`web-stress: suite supervisor: could not start ${command}: ${error.message}`);
    finish(1);
  });
  child.on?.('exit', (code) => {
    finish(code ?? 1);
  });

  return child;
}

function main() {
  let parsed;
  try {
    parsed = parseSupervisorArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`web-stress: suite supervisor: ${error.message}`);
    process.exit(2);
  }
  supervise(parsed);
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main();
