import type { HarnessId } from '../../domain/harness.js';
import type { ErrorSink } from '../../logging/errors.js';
import { warnOnce } from '../../util/warn-once.js';

/** A user config file the harness could not read or interpret. */
export interface McpConfigIssue {
  /** Absolute path to the file that was skipped. */
  path: string;
  /**
   * Short category such as `invalid JSON` or `mcpServers is not an object`.
   * Never file contents, environment values, or raw parser text: Node's JSON
   * errors quote the input, which can contain MCP tokens.
   */
  reason: string;
}

/**
 * Report unreadable user config files once per file for the life of the process.
 *
 * Preparation runs every turn, so a persistent problem must not repeat. The
 * stderr warning and the error-log record share one warn-once key.
 */
export function reportMcpConfigIssues(
  harness: HarnessId,
  issues: readonly McpConfigIssue[],
  errors?: ErrorSink,
): void {
  for (const issue of issues) {
    const message =
      `ignoring unreadable ${harness} user config at ${issue.path}: ${issue.reason}; ` +
      'user MCP servers from it will not load';
    if (!warnOnce(`mcp-config:${issue.path}`, message)) continue;
    errors?.error('harness.mcpConfig', new Error(issue.reason), {
      harness,
      path: issue.path,
      reason: issue.reason,
    });
  }
}
