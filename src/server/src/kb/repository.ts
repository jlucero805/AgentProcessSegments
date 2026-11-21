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

  search(query: string, limit = 20): KbEntry[] {
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM kb_entries
         WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(like, like, limit) as KbRow[];
    return rows.map(toEntry);
  }
}
