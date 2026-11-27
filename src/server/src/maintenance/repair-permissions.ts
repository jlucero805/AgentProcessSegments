import { readdirSync } from 'node:fs';
import path from 'node:path';
import { requestsDir } from '../config.js';
import {
  PermissionRepair,
  type RepairDeps,
  type RepairResult,
} from './permission-repair.js';

const SESSION_FILES = ['session.json', 'transcript.json', 'mcp-config.json'] as const;

function scanSession(scan: PermissionRepair, sessionDir: string): void {
  // A session dir listed by readdir can vanish before the lstat; D74 records
  // that as a skip rather than silently dropping it.
  if (!scan.dir(sessionDir, { missing: 'skip' })) return;

  scan.dir(path.join(sessionDir, 'cwd'));
  const opencode = path.join(sessionDir, 'opencode');
  if (scan.dir(opencode)) {
    scan.file(path.join(opencode, 'opencode.json'));
  }
  for (const name of SESSION_FILES) {
    scan.file(path.join(sessionDir, name));
  }
}

/**
 * Tighten every existing request/session workdir to the owner-only layout from
 * D58. This never recurses into `cwd/` checkouts and never creates paths.
 */
export function repairPermissions(
  dataDir: string,
  options: { apply: boolean } & RepairDeps,
): RepairResult {
  const scan = new PermissionRepair(options);
  const root = requestsDir(dataDir);

  const rootState = scan.root(root, { symlinks: 'follow' });
  if (rootState !== 'ok') return scan.result(rootState === 'missing');

  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch (error) {
    scan.error(root, 'dir', error);
    return scan.result(false);
  }

  for (const name of names) {
    scanSession(scan, path.join(root, name));
  }

  return scan.result(false);
}
