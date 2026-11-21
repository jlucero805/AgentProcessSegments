/** One message for a thrown unknown, used by HTTP, MCP, and the engine. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
