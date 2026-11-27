import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

/** The permission bits of `target`, ignoring the file-type bits. */
export function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

/** Create (or reuse) a directory and force its mode. */
export function dir(target: string, mode = 0o755): void {
  mkdirSync(target, { recursive: true });
  chmodSync(target, mode);
}

/** Create a file (and its parents) with a known body and mode. */
export function file(target: string, mode = 0o644, body = '{}'): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  chmodSync(target, mode);
}

/** Silence the CLI output a repair command prints during a test. */
export function silenceConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
