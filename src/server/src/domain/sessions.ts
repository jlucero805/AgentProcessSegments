/** Reserved chat sessions that have no request row. */
export const KB_SESSION_ID = '__kb__';
export const MASTER_SESSION_ID = '__master__';
export const SETUP_SESSION_PREFIX = '__setup__:';
export const SUMMARY_SESSION_PREFIX = '__summary__:';

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

/** One master chat per cell; the global id is used for unassigned work. */
export function masterSessionId(cellId: string | null | undefined): string {
  return cellId ? `${MASTER_SESSION_ID}:${cellId}` : MASTER_SESSION_ID;
}

export function isMasterSession(id: string): boolean {
  return id === MASTER_SESSION_ID || id.startsWith(`${MASTER_SESSION_ID}:`);
}

export function masterCellId(id: string): string | null {
  if (!id.startsWith(`${MASTER_SESSION_ID}:`)) return null;
  const cellId = id.slice(MASTER_SESSION_ID.length + 1);
  return cellId === '' ? null : cellId;
}

/** One internal scorecard generator per cell; never exposed as a chat. */
export function summarySessionId(cellId: string): string {
  return `${SUMMARY_SESSION_PREFIX}${cellId}`;
}

export function isSummarySession(id: string): boolean {
  return id.startsWith(SUMMARY_SESSION_PREFIX);
}

export function summaryCellId(id: string): string | null {
  if (!id.startsWith(SUMMARY_SESSION_PREFIX)) return null;
  const cellId = id.slice(SUMMARY_SESSION_PREFIX.length);
  return cellId === '' ? null : cellId;
}

export function isVirtualSessionId(id: string): boolean {
  return id === KB_SESSION_ID || isMasterSession(id) || isSetupSession(id);
}
