import { requestsDir } from '../config.js';
import {
  repairPrivateTree,
  type RepairDeps,
  type RepairResult,
} from './private-path-repair.js';

export {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  formatMode,
} from './private-path-repair.js';
export type {
  RepairAction,
  RepairDeps,
  RepairEntry,
  RepairResult,
} from './private-path-repair.js';

const SESSION_CHILDREN = [
  { name: 'cwd', kind: 'dir' },
  {
    name: 'opencode',
    kind: 'dir',
    children: [{ name: 'opencode.json', kind: 'file' }],
  },
  { name: 'session.json', kind: 'file' },
  { name: 'transcript.json', kind: 'file' },
  { name: 'mcp-config.json', kind: 'file' },
] as const;

/**
 * Tighten every existing request/session workdir to the owner-only layout from
 * D58. This never recurses into `cwd/` checkouts and never creates paths.
 */
export function repairPermissions(
  dataDir: string,
  options: { apply: boolean } & RepairDeps,
): RepairResult {
  return repairPrivateTree(
    requestsDir(dataDir),
    {
      // D121 preserves D74's statSync root behavior. A symlinked requests/ root
      // is handled separately in follow-up e182d9b9-2bb9-4829-8cdd-0e445c7932e6.
      rootSymlinks: 'follow',
      // A session can disappear while retention is running, so a missing direct
      // child is a skip rather than a silent absent artifact.
      child: { kind: 'dir', missing: 'skip', children: SESSION_CHILDREN },
    },
    options,
  );
}
