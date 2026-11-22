import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cells (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  master_enabled           INTEGER NOT NULL DEFAULT 1,
  master_interval_minutes  INTEGER,
  max_concurrent           INTEGER NOT NULL DEFAULT 3,
  harness                  TEXT,
  model                    TEXT,
  effort                   TEXT,
  process_json             TEXT,
  created_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL DEFAULT 'clarify',
  groomed             INTEGER NOT NULL DEFAULT 0,
  clarify_started     INTEGER NOT NULL DEFAULT 0,
  model               TEXT,
  effort              TEXT,
  target_repo         TEXT,
  acceptance_criteria TEXT,
  context             TEXT,
  skills              TEXT NOT NULL DEFAULT '[]',
  kb_digest           INTEGER NOT NULL DEFAULT 1,
  digest              TEXT,
  agent_status        TEXT NOT NULL DEFAULT 'none',
  unchecked           INTEGER NOT NULL DEFAULT 0,
  hc_run_ids          TEXT NOT NULL DEFAULT '[]',
  branch              TEXT,
  cr_url              TEXT,
  cell_id             TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_entries (
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS master_events (
  id         TEXT PRIMARY KEY,
  cell_id    TEXT,
  request_id TEXT,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cell_summaries (
  id             TEXT PRIMARY KEY,
  cell_id        TEXT NOT NULL,
  window_start   INTEGER NOT NULL,
  window_end     INTEGER NOT NULL,
  window_minutes INTEGER NOT NULL,
  content        TEXT NOT NULL,
  stats_json     TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id                 TEXT PRIMARY KEY,
  turn_id            TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  scope              TEXT NOT NULL,
  cell_id            TEXT,
  request_id         TEXT,
  model              TEXT,
  effort             TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_pricing (
  id                       TEXT PRIMARY KEY,
  model                    TEXT NOT NULL,
  effective_from           INTEGER NOT NULL,
  input_usd_per_mtok       REAL NOT NULL,
  output_usd_per_mtok      REAL NOT NULL,
  cache_read_usd_per_mtok  REAL NOT NULL,
  cache_write_usd_per_mtok REAL NOT NULL,
  reasoning_usd_per_mtok   REAL NOT NULL,
  source                   TEXT NOT NULL,
  note                     TEXT,
  created_at               INTEGER NOT NULL
);
`;

/**
 * Additive migrations. CREATE TABLE IF NOT EXISTS already carries every column
 * on a fresh database, so each guard is a no-op there and the only work happens
 * on databases created by an older build.
 */
const COLUMNS: ReadonlyArray<readonly [table: string, column: string, ddl: string]> = [
  ['requests', 'body', "TEXT NOT NULL DEFAULT ''"],
  ['requests', 'groomed', 'INTEGER NOT NULL DEFAULT 0'],
  ['requests', 'clarify_started', 'INTEGER NOT NULL DEFAULT 0'],
  ['requests', 'model', 'TEXT'],
  ['requests', 'effort', 'TEXT'],
  ['requests', 'target_repo', 'TEXT'],
  ['requests', 'acceptance_criteria', 'TEXT'],
  ['requests', 'context', 'TEXT'],
  ['requests', 'skills', "TEXT NOT NULL DEFAULT '[]'"],
  ['requests', 'kb_digest', 'INTEGER NOT NULL DEFAULT 1'],
  ['requests', 'digest', 'TEXT'],
  ['requests', 'agent_status', "TEXT NOT NULL DEFAULT 'none'"],
  ['requests', 'unchecked', 'INTEGER NOT NULL DEFAULT 0'],
  ['requests', 'hc_run_ids', "TEXT NOT NULL DEFAULT '[]'"],
  ['requests', 'branch', 'TEXT'],
  ['requests', 'cr_url', 'TEXT'],
  ['requests', 'cell_id', 'TEXT'],
  ['cells', 'master_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['cells', 'master_interval_minutes', 'INTEGER'],
  ['cells', 'max_concurrent', 'INTEGER NOT NULL DEFAULT 3'],
  ['cells', 'harness', 'TEXT'],
  ['cells', 'model', 'TEXT'],
  ['cells', 'effort', 'TEXT'],
  ['cells', 'process_json', 'TEXT'],
];

function addColumn(db: Db, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function migrate(db: Db): void {
  db.exec(BASE_SCHEMA);
  for (const [table, column, ddl] of COLUMNS) addColumn(db, table, column, ddl);

  // Indexes come after the cell_id migration: an index on a column that does
  // not exist yet fails on databases written by an older build.
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_state ON requests(state)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_cell ON requests(cell_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_kb_entries_request ON kb_entries(request_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_master_events_created ON master_events(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_master_events_request ON master_events(request_id)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_cell_summaries_cell_created ON cell_summaries(cell_id, created_at)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_usage_events_cell_created ON usage_events(cell_id, created_at)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_usage_events_request_created ON usage_events(request_id, created_at)',
  );
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_turn ON usage_events(turn_id)');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_model_pricing_model_effective ON model_pricing(model, effective_from)',
  );
}

/** A persisted `working` cannot survive a restart, because no child does. */
export function reconcile(db: Db): number {
  const result = db
    .prepare("UPDATE requests SET agent_status = 'idle' WHERE agent_status = 'working'")
    .run();
  return result.changes;
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  reconcile(db);
  return db;
}
