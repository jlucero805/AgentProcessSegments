/** Reserved chat sessions that have no request row. */
export const KB_SESSION_ID = '__kb__';
export const MASTER_SESSION_ID = '__master__';
export const SETUP_SESSION_PREFIX = '__setup__:';

/** One transient wizard chat; it has no request row and is discarded on close. */
export function setupSessionId(draftId: string): string {
  return `${SETUP_SESSION_PREFIX}${draftId}`;
}

export function isSetupSession(id: string): boolean {
  return id.startsWith(SETUP_SESSION_PREFIX);
}

export function setupDraftId(id: string): string | null {
  if (!id.startsWith(SETUP_SESSION_PREFIX)) return null;
  const draftId = id.slice(SETUP_SESSION_PREFIX.length);
  return draftId === '' ? null : draftId;
}

/** One master chat per cell. Unassigned work has no master and therefore no session. */
export function masterSessionId(cellId: string): string {
  return `${MASTER_SESSION_ID}:${cellId}`;
}

export function isMasterSession(id: string): boolean {
  return masterCellId(id) !== null;
}

export function masterCellId(id: string): string | null {
  if (!id.startsWith(`${MASTER_SESSION_ID}:`)) return null;
  const cellId = id.slice(MASTER_SESSION_ID.length + 1);
  return cellId === '' ? null : cellId;
}

export function isVirtualSessionId(id: string): boolean {
  return id === KB_SESSION_ID || isMasterSession(id) || isSetupSession(id);
}
