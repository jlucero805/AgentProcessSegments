// CPU hog lifecycle for scripts/web-stress.mjs.
//
// A hog is a Node process running a tight loop. It is not a `while :` shell
// loop: the marker keeps a leaked hog findable in `ps`, and the ppid check lets
// the hog exit by itself when this process disappears, including after SIGKILL,
// which no handler in the parent can catch.
import { spawn as nodeSpawn } from 'node:child_process';

export const HOG_MARKER = 'aps-web-stress-hog';

/** Busy-loop source for one hog. */
export function hogSource() {
  return `
// ${HOG_MARKER}
const parent = process.ppid;
let tick = 0;
for (;;) {
  if (++tick >= 1000000) {
    tick = 0;
    if (process.ppid !== parent) process.exit(0);
  }
}
`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start `count` hogs. `spawn`/`execPath` are injectable so tests can use fake
 * children and never burn a real core.
 */
export function startHogs({ count, spawn = nodeSpawn, execPath = process.execPath } = {}) {
  const children = [];
  const errors = new Map();
  for (let index = 0; index < count; index += 1) {
    const child = spawn(execPath, ['-e', hogSource()], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.on?.('error', (error) => errors.set(child, error));
    // Drain stderr so a crashed hog can never block on a full pipe.
    child.stderr?.on?.('data', () => {});
    children.push(child);
  }
  return { children, errors, stopped: false };
}

function describeExit(child) {
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  if (child.exitCode !== null) return `exit code ${child.exitCode}`;
  return 'an unknown state';
}

/**
 * Fail when any hog is gone: a run without the requested load is not a stress
 * proof. A spawn error (for example a missing `node`) is reported too.
 */
export function checkHogs(hogs) {
  for (const [index, child] of hogs.children.entries()) {
    const spawnError = hogs.errors?.get(child);
    if (spawnError) {
      throw new Error(`hog ${index + 1} could not start: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`hog ${index + 1} (pid ${child.pid}) exited early with ${describeExit(child)}`);
    }
  }
}

/**
 * Stop every live hog: SIGTERM, wait up to `graceMs`, then SIGKILL. Idempotent,
 * so the normal path, the failure path, and both signal paths can all use it.
 */
export async function stopHogs(
  hogs,
  { kill = process.kill, graceMs = 2000, pollMs = 25, sleep: wait = sleep } = {},
) {
  if (!hogs || hogs.stopped) return;
  hogs.stopped = true;

  const live = () =>
    hogs.children.filter((child) => child.exitCode === null && child.signalCode === null);

  for (const child of live()) safeKill(kill, child.pid, 'SIGTERM');
  await waitUntil(() => live().length === 0, graceMs, pollMs, wait);

  for (const child of live()) safeKill(kill, child.pid, 'SIGKILL');
  await waitUntil(() => live().length === 0, 1000, pollMs, wait);
}

function safeKill(kill, pid, signal) {
  if (typeof pid !== 'number') return;
  try {
    kill(pid, signal);
  } catch {
    // The hog (or its pid) is already gone.
  }
}

async function waitUntil(check, timeoutMs, pollMs, wait) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return;
    await wait(pollMs);
  }
}
