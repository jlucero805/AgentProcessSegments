import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string | null = null;

/** This test file's temp root; created on first use and removed after the file. */
export function tmpRoot(): string {
  root ??= mkdtempSync(path.join(os.tmpdir(), 'sbox-tests-'));
  return root;
}

/** A fresh work directory for one fixture, inside this test file's temp root. */
export function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpRoot(), `${prefix}-`));
}

/** Remove the whole root. Called by test/setup.ts in `afterAll`; safe to repeat. */
export function cleanupTmpDirs(): void {
  if (root === null) return;
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  root = null;
}
