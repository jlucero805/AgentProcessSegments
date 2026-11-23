/** The bundled stdio MCP server's config key and handshake identity. */
export const MCP_SERVER_KEY = 'aps';

/** Claude's MCP tool namespace for the bundled server. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_KEY}__`;

/** One allow-list entry for a tool the bundled MCP server exposes. */
export function mcpTool(name: string): string {
  return `${MCP_TOOL_PREFIX}${name}`;
}
