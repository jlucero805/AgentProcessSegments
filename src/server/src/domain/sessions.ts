/** Reserved chat sessions that have no request row. */
export const KB_SESSION_ID = '__kb__';
export const MASTER_SESSION_ID = '__master__';

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

export function isVirtualSessionId(id: string): boolean {
  return id === KB_SESSION_ID || isMasterSession(id);
}
