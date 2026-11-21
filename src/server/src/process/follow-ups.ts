/** Pull `FOLLOW-UP: title` lines out of the final agent text. */
export function parseFollowUps(text: string, marker: string, limit = 10): string[] {
  const prefix = marker.trim().toLowerCase();
  if (prefix === '') return [];

  const titles = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim();
    if (!line.toLowerCase().startsWith(prefix)) continue;
    const title = line
      .slice(prefix.length)
      .trim()
      .replace(/^[—–:-]\s*/, '')
      .trim();
    if (title !== '') titles.add(title.slice(0, 200));
    if (titles.size >= limit) break;
  }
  return [...titles];
}
