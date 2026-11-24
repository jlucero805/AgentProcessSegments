// Claude Code identity probe for the mock smoke.
//
// The smoke resolves its subject binary from `--claude-bin`, `CLAUDE_MOCK_SMOKE_BIN`,
// or PATH (see `resolveClaudeBin` in env.mjs). This module answers the next
// question: is the chosen file actually Claude Code? A path that points at
// `/bin/false` or another CLI must not run the Claude proof. The probe runs
// `<bin> --version` with a short timeout and looks for the product name.
//
// `identifiesAsClaude` is the `isClaude` predicate `resolveClaudeBin` accepts;
// `looksLikeClaude` is pure so its matrix is tested without spawning anything.
import { spawnSync } from 'node:child_process';

export const PROBE_TIMEOUT_MS = 5_000;

/** Whether the version output identifies Claude Code (case-insensitive). */
export function looksLikeClaude(output) {
  return typeof output === 'string' && /claude/i.test(output);
}

/**
 * Run `<bin> --version` and return its combined output. Throws on a spawn
 * error (including a timeout) or a non-zero exit, so a broken binary never
 * looks like Claude Code.
 */
export function probeClaudeVersion(bin) {
  const result = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`--version exited ${result.status ?? 'without a status'}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** The identity check for a resolved binary; throws when the probe fails. */
export function identifiesAsClaude(bin) {
  return looksLikeClaude(probeClaudeVersion(bin));
}
