import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { KbEntry } from '../domain/request.js';

interface KbRow {
  id: string;
  request_id: string;
  title: string;
  content: string;
  created_at: number;
}

function toEntry(row: KbRow): KbEntry {
  return {
    id: row.id,
    requestId: row.request_id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  };
}

export interface StoreInput {
  requestId: string;
  title: string;
  content: string;
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

/** Title hits are worth more than body hits; a full phrase in the title more still. */
function relevance(row: KbRow, terms: string[], phrase: string): number {
  const title = row.title.toLowerCase();
  const content = row.content.toLowerCase();
  let score = title.includes(phrase) ? 6 : 0;
  for (const term of terms) {
    score += occurrences(title, term) * 3 + occurrences(content, term);
  }
  return score;
}

export class KbRepository {
  constructor(private readonly db: Db) {}

  /** One entry per request. Storing again replaces the previous digest. */
  store(input: StoreInput): KbEntry {
    const id = randomUUID();
    const now = Date.now();
    const write = this.db.transaction(() => {
      this.db.prepare('DELETE FROM kb_entries WHERE request_id = ?').run(input.requestId);
      this.db
        .prepare(
          'INSERT INTO kb_entries (id, request_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, input.requestId, input.title, input.content, now);
    });
    write();
    return { id, requestId: input.requestId, title: input.title, content: input.content, createdAt: now };
  }

  list(): KbEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_entries ORDER BY created_at DESC')
      .all() as KbRow[];
    return rows.map(toEntry);
  }

  getByRequest(requestId: string): KbEntry | null {
    const row = this.db
      .prepare('SELECT * FROM kb_entries WHERE request_id = ?')
      .get(requestId) as KbRow | undefined;
    return row ? toEntry(row) : null;
  }

  /**
   * Every whitespace-separated term must appear (literal LIKE, `%` and `_` escaped).
   * Results are ranked by title/body term hits and phrase hits, then recency.
   */
  search(query: string, limit = 20): KbEntry[] {
    const terms = query.trim().split(/\s+/).filter((term) => term !== '');
    if (terms.length === 0) return this.list().slice(0, limit);

    const clauses = terms.map(
      () => "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')",
    );
    const params = terms.flatMap((term) => {
      const like = `%${escapeLike(term)}%`;
      return [like, like];
    });

    const rows = this.db
      .prepare(
        `SELECT * FROM kb_entries WHERE ${clauses.join(' AND ')} LIMIT 1000`,
      )
      .all(...params) as KbRow[];

    const lowered = terms.map((term) => term.toLowerCase());
    const phrase = query.trim().toLowerCase();
    return rows
      .map((row) => ({ row, score: relevance(row, lowered, phrase) }))
      .sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at)
      .slice(0, limit)
      .map((entry) => toEntry(entry.row));
  }
}
