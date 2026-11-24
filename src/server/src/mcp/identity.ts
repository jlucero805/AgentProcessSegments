/** The bundled stdio MCP server's config key and handshake identity. */
export const MCP_SERVER_KEY = 'aps';

/**
 * Handshake version reported by the bundled stdio MCP server. This is a
 * deliberate identity value, not the workspace package version; change it
 * only with the bundled server's MCP contract.
 */
export const MCP_SERVER_VERSION = '0.1.0';

/** Claude's MCP tool namespace for the bundled server. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_KEY}__`;

/** One allow-list entry for a tool the bundled MCP server exposes. */
export function mcpTool(name: string): string {
  return `${MCP_TOOL_PREFIX}${name}`;
}
