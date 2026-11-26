import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ensurePrivateFile } from './util/files.js';

export type Db = Database.Database;

const BUDGET_DELIVERY_SNAPSHOT_COLUMNS = [
  'scope',
  'scope_id',
  'threshold',
  'alert_at_percent',
  'budget_usd',
  'spend_usd',
  'unknown_cost_turns',
  'alert_period_start',
  'alert_created_at',
  'alert_acknowledged_at',
] as const;

const BUDGET_DELIVERIES_DDL = `CREATE TABLE IF NOT EXISTS budget_alert_deliveries (
  id                    TEXT PRIMARY KEY,
  alert_id              TEXT NOT NULL,
  scope                 TEXT NOT NULL CHECK (scope IN ('overall', 'cell')),
  scope_id              TEXT NOT NULL,
  threshold             TEXT NOT NULL CHECK (threshold IN ('warning', 'exceeded')),
  alert_at_percent      INTEGER NOT NULL,
  budget_usd            REAL NOT NULL,
  spend_usd             REAL NOT NULL,
  unknown_cost_turns    INTEGER NOT NULL DEFAULT 0,
  alert_period_start    INTEGER NOT NULL,
  alert_created_at      INTEGER NOT NULL,
  alert_acknowledged_at INTEGER,
  channel               TEXT NOT NULL,
  destination_id        TEXT NOT NULL,
  format                TEXT NOT NULL,
  destination_hash      TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'skipped')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       INTEGER NOT NULL,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  delivered_at          INTEGER,
  UNIQUE(alert_id, destination_id)
)`;

const NOTIFICATION_EVENT_DELIVERIES_DDL = `CREATE TABLE IF NOT EXISTS notification_event_deliveries (
  id               TEXT PRIMARY KEY,
  dedupe_key       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('turn.failed', 'master.error', 'summary.failed')),
  channel          TEXT NOT NULL,
  format           TEXT NOT NULL,
  destination_hash TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'skipped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  delivered_at     INTEGER,
  UNIQUE(dedupe_key, channel)
)`;

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
  monthly_budget_usd       REAL,
  pause_on_exceeded        INTEGER NOT NULL DEFAULT 0,
  pause_on_unknown_cost    INTEGER NOT NULL DEFAULT 0,
  autocompact_percent      INTEGER NOT NULL DEFAULT 80,
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
  harness             TEXT,
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

CREATE TABLE IF NOT EXISTS usage_daily (
  day_start            INTEGER NOT NULL,
  scope                TEXT NOT NULL,
  cell_id              TEXT NOT NULL DEFAULT '',
  request_id           TEXT NOT NULL DEFAULT '',
  model                TEXT NOT NULL DEFAULT '',
  turns                INTEGER NOT NULL,
  input_tokens         INTEGER NOT NULL,
  output_tokens        INTEGER NOT NULL,
  cache_read_tokens    INTEGER NOT NULL,
  cache_write_tokens   INTEGER NOT NULL,
  reasoning_tokens     INTEGER NOT NULL,
  reported_cost_usd    REAL,
  reported_cost_turns  INTEGER NOT NULL,
  estimated_cost_usd   REAL,
  estimated_cost_turns INTEGER NOT NULL,
  PRIMARY KEY (day_start, scope, cell_id, request_id, model)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_rollup_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  rolled_through INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_prune_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at       INTEGER NOT NULL,
  last_deleted_rows INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_alerts (
  id                 TEXT PRIMARY KEY,
  scope              TEXT NOT NULL CHECK (scope IN ('overall', 'cell')),
  scope_id           TEXT NOT NULL,
  period_start       INTEGER NOT NULL,
  threshold          TEXT NOT NULL CHECK (threshold IN ('warning', 'exceeded')),
  alert_at_percent   INTEGER NOT NULL,
  budget_usd         REAL NOT NULL,
  spend_usd          REAL NOT NULL,
  unknown_cost_turns INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  acknowledged_at    INTEGER
);

${BUDGET_DELIVERIES_DDL};

${NOTIFICATION_EVENT_DELIVERIES_DDL};

CREATE TABLE IF NOT EXISTS spend_cap_overrides (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('overall', 'cell')),
  scope_id     TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  revoked_at   INTEGER
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
  ['requests', 'harness', 'TEXT'],
  ['cells', 'master_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['cells', 'master_interval_minutes', 'INTEGER'],
  ['cells', 'max_concurrent', 'INTEGER NOT NULL DEFAULT 3'],
  ['cells', 'harness', 'TEXT'],
  ['cells', 'model', 'TEXT'],
  ['cells', 'effort', 'TEXT'],
  ['cells', 'monthly_budget_usd', 'REAL'],
  ['cells', 'pause_on_exceeded', 'INTEGER NOT NULL DEFAULT 0'],
  ['cells', 'pause_on_unknown_cost', 'INTEGER NOT NULL DEFAULT 0'],
  ['cells', 'autocompact_percent', 'INTEGER NOT NULL DEFAULT 80'],
  ['cells', 'process_json', 'TEXT'],
];

function addColumn(db: Db, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * The delivery table now snapshots alert fields and has no alert foreign key, so
 * older tables need a rebuild. SQLite cannot drop a table-level foreign key or
 * the old `UNIQUE(alert_id, channel)` in place. Both legacy shapes are handled:
 * the original table without `destination_id`, and the later table with
 * `destination_id` plus `ON DELETE CASCADE`.
 */
function migrateBudgetDeliveries(db: Db): void {
  const columns = db
    .prepare('PRAGMA table_info(budget_alert_deliveries)')
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  const names = new Set(columns.map((column) => column.name));
  const foreignKeys = db
    .prepare('PRAGMA foreign_key_list(budget_alert_deliveries)')
    .all() as Array<{ table: string }>;
  const hasSnapshot = BUDGET_DELIVERY_SNAPSHOT_COLUMNS.every((column) =>
    names.has(column),
  );
  if (hasSnapshot && names.has('destination_id') && foreignKeys.length === 0) return;

  // Prefer a value already snapshotted by a partial build, then the alert row,
  // then a safe default for the rare row whose alert is already gone.
  const source = (column: string, fallback: string): string =>
    names.has(column) ? `d.${column}` : fallback;
  const snapshot = (column: string, alertColumn: string, fallback: string): string =>
    `COALESCE(${source(column, 'NULL')}, a.${alertColumn}, ${fallback})`;
  const acknowledged = names.has('alert_acknowledged_at')
    ? 'COALESCE(d.alert_acknowledged_at, a.acknowledged_at)'
    : 'a.acknowledged_at';

  db.transaction(() => {
    db.exec('ALTER TABLE budget_alert_deliveries RENAME TO budget_alert_deliveries_legacy');
    db.exec(BUDGET_DELIVERIES_DDL);
    db.exec(
      `INSERT INTO budget_alert_deliveries
         (id, alert_id, scope, scope_id, threshold, alert_at_percent, budget_usd,
          spend_usd, unknown_cost_turns, alert_period_start, alert_created_at,
          alert_acknowledged_at, channel, destination_id, format, destination_hash,
          status, attempts, next_attempt_at, last_error, created_at, updated_at, delivered_at)
       SELECT d.id,
              d.alert_id,
              ${snapshot('scope', 'scope', "'overall'")},
              ${snapshot('scope_id', 'scope_id', "''")},
              ${snapshot('threshold', 'threshold', "'warning'")},
              ${snapshot('alert_at_percent', 'alert_at_percent', '0')},
              ${snapshot('budget_usd', 'budget_usd', '0')},
              ${snapshot('spend_usd', 'spend_usd', '0')},
              ${snapshot('unknown_cost_turns', 'unknown_cost_turns', '0')},
              ${snapshot('alert_period_start', 'period_start', 'd.created_at')},
              ${snapshot('alert_created_at', 'created_at', 'd.created_at')},
              ${acknowledged},
              d.channel,
              ${source('destination_id', 'd.channel')},
              d.format,
              d.destination_hash,
              d.status,
              d.attempts,
              d.next_attempt_at,
              d.last_error,
              d.created_at,
              d.updated_at,
              d.delivered_at
         FROM budget_alert_deliveries_legacy d
         LEFT JOIN budget_alerts a ON a.id = d.alert_id`,
    );
    db.exec('DROP TABLE budget_alert_deliveries_legacy');
  })();
}

/**
 * SQLite cannot alter the event-kind CHECK in place. Rebuild a two-kind table
 * once so `summary.failed` can be enqueued, preserving every delivery row.
 */
function migrateNotificationEventDeliveries(db: Db): void {
  const table = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_event_deliveries'",
    )
    .get() as { sql: string } | undefined;
  if (!table || table.sql.includes("'summary.failed'")) return;

  db.transaction(() => {
    db.exec(
      'ALTER TABLE notification_event_deliveries RENAME TO notification_event_deliveries_legacy',
    );
    db.exec(NOTIFICATION_EVENT_DELIVERIES_DDL);
    db.exec(
      `INSERT INTO notification_event_deliveries
         (id, dedupe_key, kind, channel, format, destination_hash, payload_json,
          status, attempts, next_attempt_at, last_error, created_at, updated_at, delivered_at)
       SELECT id, dedupe_key, kind, channel, format, destination_hash, payload_json,
              status, attempts, next_attempt_at, last_error, created_at, updated_at, delivered_at
         FROM notification_event_deliveries_legacy`,
    );
    db.exec('DROP TABLE notification_event_deliveries_legacy');
  })();
}

export function migrate(db: Db): void {
  db.exec(BASE_SCHEMA);
  migrateBudgetDeliveries(db);
  migrateNotificationEventDeliveries(db);
  for (const [table, column, ddl] of COLUMNS) addColumn(db, table, column, ddl);
  db.prepare(
    'INSERT OR IGNORE INTO usage_rollup_state (id, rolled_through) VALUES (1, 0)',
  ).run();

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
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_cell_summaries_created ON cell_summaries(created_at)',
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
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_alerts_identity
       ON budget_alerts(scope, scope_id, period_start, threshold, budget_usd, alert_at_percent)`,
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_budget_alerts_created ON budget_alerts(created_at)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_budget_alerts_acknowledged ON budget_alerts(acknowledged_at)',
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_budget_alert_deliveries_due
       ON budget_alert_deliveries(status, next_attempt_at)`,
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_budget_alert_deliveries_created ON budget_alert_deliveries(created_at)',
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_budget_alert_deliveries_alert
       ON budget_alert_deliveries(alert_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notification_event_deliveries_due
       ON notification_event_deliveries(status, next_attempt_at)`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_cap_overrides_active
       ON spend_cap_overrides(scope, scope_id, period_start)
       WHERE revoked_at IS NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_spend_cap_overrides_period
       ON spend_cap_overrides(period_start, expires_at)`,
  );
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
  const inMemory = dbPath === ':memory:';
  if (!inMemory) {
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    // Tighten the database before SQLite opens it so new -wal/-shm sidecars
    // inherit its mode; the second pass repairs sidecars already on disk.
    ensurePrivateFile(dbPath);
  }
  const db = new Database(dbPath);
  if (!inMemory) ensurePrivateFile(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (!inMemory) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      ensurePrivateFile(`${dbPath}${suffix}`);
    }
  }
  migrate(db);
  reconcile(db);
  return db;
}
