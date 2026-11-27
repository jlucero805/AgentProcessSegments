import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

/** The permission bits of `target` (owner, group, and other). */
export function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

/** Create `target` recursively and force its mode. */
export function dir(target: string, mode = 0o755): void {
  mkdirSync(target, { recursive: true });
  chmodSync(target, mode);
}

/** Write `body` to `target` through a created parent and force its mode. */
export function file(target: string, mode = 0o644, body = '{}'): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  chmodSync(target, mode);
}

/** Silence the CLI report while a test drives a repair `main()`. */
export function silenceConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
