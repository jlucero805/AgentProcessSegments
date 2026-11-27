/**
 * MIME types the in-app Help asset route serves.
 *
 * Keys are lowercase file extensions. `DocsService.asset` uses this table to
 * choose a response type, and the documentation link gate uses it to reject a
 * served page that references a screenshot Help would 404. Keep this module
 * free of Node-only imports: the web workspace type-checks it through the
 * docs-gate test.
 */
export const SCREENSHOT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
});
