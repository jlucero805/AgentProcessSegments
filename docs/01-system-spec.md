# Agent Process Segments: System Spec

The governing document for this rebuild. It describes the system as it existed at
extraction (`f849fed` plus the uncommitted `db.ts` index-ordering fix), with
infrastructure-specific names generalized for public distribution. It is the *what*,
not the *why*. Rationale for choices made during this rebuild lives in
`docs/03-decisions.md`.

---

## 1. What it is

A client-agnostic "brain": a local Node/TS service that orchestrates headless Claude
Code or OpenCode agent sessions through an ISA-95-style request workflow (Intake → Plan →
Implement → Review → Finalize), with a streaming chat per request, a knowledge base,
installable skill/command plugins, and named "cells" (floors). A web SPA is one
front-end over its HTTP API; the design goal is that any client (for example a
terminal editor plugin) can drive the same API.

### Hard external dependencies (must be installed)

- **`claude` CLI** on `PATH`, the agent substrate. The brain shells out to it; it is
  not vendored.
- **`git`** for per-request worktrees.
- Nothing else. No cloud SDK, prompt router, or pipeline calls in the logic. The brain
  only assumes that a `claude` CLI exists and speaks stream-json.
- **Dormant:** `src/server/hc/` in the original was a generated client from an earlier
  design. It was imported nowhere and unused at runtime; the engine drives `claude`
  directly. It is not reproduced here.

### Remote access (operational, not in code)

The brain binds loopback `127.0.0.1:7391` only. Remote or mobile use is an external
tunnel or reverse proxy in front of that port. Not part of the brain; any tunnel
substitutes.

### Single-origin principle

The brain serves its own built SPA from the same process and port as `/api` and `/ws`.
SPA (`/`), API (`/api`), and websocket (`/ws`) are one origin on one port, which is the
point: one port is all that gets tunnelled, and the SPA uses relative, same-origin fetch
paths, so there is no CORS and no second service.

- **Prod:** `tsc` and `vite build` into `src/web/dist`; the brain vends it via
  `@fastify/static` when `webDir` exists. SPA client-side routes fall back to
  `index.html`.
- **Dev:** the Vite dev server hosts the SPA and proxies `/api` and `/ws` to the brain,
  so the same relative paths work. Run both with `npm run dev`.

A new client is just another consumer of this one loopback origin.

### Security defaults

Bind defaults to `127.0.0.1` even though `APS_HOST` can override it. Never widen the
bind. The audience gate is the tunnel, not the process. Before sharing a tunnel, verify
that anonymous requests to `/` and `/api` hit the SSO redirect. The agent child is
non-interactive and auto-approves exactly the tools in its `--allowedTools` allowlist,
plus the user's MCP servers. That allowlist is the agent's permission boundary.

---

## 2. Tech stack

- **Server** (`src/server`, ESM, Node 20+): `fastify`, `@fastify/static`,
  `@fastify/websocket`, `better-sqlite3`, `zod`, `@modelcontextprotocol/sdk`. Tests:
  `vitest`. Build: `tsc`.
- **Web** (`src/web`, Vite, React 18, TS): `@assistant-ui/react` for chat,
  `react-markdown`, `mermaid` (lazy-loaded for Help diagrams), `diff`, `clsx`,
  `tailwind-merge`; Tailwind v3 with preflight on, `darkMode: 'class'`, dark by default,
  plus a hand-rolled shadcn-style kit (`ui.tsx`).
- **Monorepo:** npm workspaces (`src/server`, `src/web`). Root scripts: `build` (web
  then server), `typecheck`, `test` (server + web + the e2e env guard), `lint` (eslint over
  `src`, zero warnings), `dev` (both).

---

## 3. Process layout and config

- **Entry:** `src/server/app.ts` opens the database, constructs `RequestRepository`,
  `KbRepository`, `CellRepository`, `PluginManager`, and the engine, builds the server,
  and listens. Loopback only; no in-process auth, because the tunnel is the gate.
- **Config** (`src/server/src/config.ts`, every value env-overridable):
  - `host` = `APS_HOST` ?? `127.0.0.1`; `port` = `APS_PORT` ?? `7391`
  - `dbPath` = `APS_DB` ?? `agent-process-segments.sqlite`
  - `webDir` = `APS_WEB_DIR` ?? `<cwd>/src/web/dist`
  - `dataDir` = `APS_DATA_DIR` ?? `~/.agent-process-segments` (per-request workdirs)
  - `pluginsDir` = `APS_PLUGINS_DIR` ?? `~/.agent-process-segments/plugins`
  - `brainUrl` = `APS_BRAIN_URL` ?? `http://127.0.0.1:<port>`, used by the MCP proxy
  - `harness` = `APS_HARNESS` ?? `claude`; must be `claude` or `opencode`
  - `harnessBins.claude` = `APS_CLAUDE_BIN` ?? `claude`;
    `harnessBins.opencode` = `APS_OPENCODE_BIN` ?? `opencode`.
    `APS_HARNESS_BIN` is the legacy fallback for the adapter selected by `APS_HARNESS`
    only; the adapter-specific value wins when both are set.
  - `defaultModels` = one fallback per adapter. `APS_DEFAULT_MODEL` overrides the
    process-default harness; OpenCode otherwise gets
    `opencode-go/deepseek-v4.1-flash`, Claude gets null.
  - `configPath` / `processPath` = `APS_CONFIG` / `APS_PROCESS` ??
    `$XDG_CONFIG_HOME/agent-process-segments/{config,process}.json`
  - `errorLogPath` = `APS_ERROR_LOG` ??
    `$XDG_STATE_HOME/agent-process-segments/errors.log`
  - Every `APS_*` name also accepts the legacy `SBOX_*` alias; `APS_*` wins when both
    are set. Path defaults prefer an existing `agent-process-segments` location, then
    an existing `sandbox-harness` one, then the new location. `app.ts` warns when a
    legacy default is still in use and points at `npm run migrate:paths`.
- **Run:** `node src/server/dist/app.js` with `APS_DB` set. The original had no process
  supervisor; it ran as a backgrounded process and had to be restarted manually.

---

## 4. Data model

SQLite with WAL and `foreign_keys=ON`. `db.ts` creates tables and runs idempotent
additive migrations, with an `addColumn` guard per column. Boot reconcile sets
`agent_status='idle'` where it was persisted as `working`, because no child survives a
restart.

### `requests`

`id` (uuid PK), `title`, `body`, `state`, `groomed` (0/1), `clarify_started` (0/1),
`model`, `effort`, `target_repo`, `acceptance_criteria`, `context`, `skills` (JSON
array), `kb_digest` (0/1, default 1), `digest`, `agent_status`
(`none|idle|working|blocked|error`, default `none`), `unchecked` (0/1), `hc_run_ids`
(JSON array), `branch`, `cr_url`, `cell_id`, `harness` (null inherits the cell, then
the process default), `created_at`, `updated_at`.

Indexes: `idx_requests_state`, `idx_requests_cell`, the second created **after** the
`cell_id` addColumn, because an index on a missing column fails on an older database.

### `cells`

`id` (uuid PK), `name`, `master_enabled`, `master_interval_minutes`, `max_concurrent`
(default 3), `harness` (null inherits the process default), `model`, `effort`, nullable
`monthly_budget_usd`, `pause_on_exceeded` (default 0), `autocompact_percent` (default 80,
range 1–99), `process_json`, `created_at`. A request inherits its cell's harness unless it
sets its own `requests.harness`; a cell master and summary use its cell's harness.
`monthly_budget_usd` is the monthly spend budget in USD; NULL means no cell budget.
`pause_on_exceeded` makes that budget a hard cap for the cell. See the budget contract
below.

### `budget_alerts`

`id` (uuid PK), `scope` (`overall|cell`), `scope_id` (empty for overall), `period_start`
(UTC month start), `threshold` (`warning|exceeded`), `alert_at_percent`, `budget_usd`,
`spend_usd`, `unknown_cost_turns`, `created_at`, `acknowledged_at`. The unique identity is
`(scope, scope_id, period_start, threshold, budget_usd, alert_at_percent)` so changing the
budget or warning percentage starts a new alert generation without deleting acknowledged
history. Indexes: the identity index, `created_at`, and `acknowledged_at`.

### `budget_alert_deliveries`

`id` (uuid PK), `alert_id` (FK to `budget_alerts`, `ON DELETE CASCADE`), `channel`
(`webhook|email|slack|discord`), `destination_id`, `format` (`json|slack|discord|email|chat`),
`destination_hash`, `status` (`pending|delivering|delivered|failed|skipped`), `attempts`,
`next_attempt_at`, `last_error`, `created_at`, `updated_at`, `delivered_at`.
`UNIQUE(alert_id, destination_id)` is the delivery idempotency key. Webhook and email
rows use their channel as `destination_id`; chat rows use `<provider>:<channelId>`.
`idx_budget_alert_deliveries_due` covers `(status, next_attempt_at)`. `destination_hash`
is a SHA-256 of the destination route (URL/format/secret, host/port/TLS/from/recipients/
credentials, or provider/channel/token), never logged or returned, so a configuration
change cannot send an old alert with new credentials. Deliveries older than 400 days are
pruned on notifier start. An older table with `UNIQUE(alert_id, channel)` is rebuilt on
migration and existing rows keep `destination_id = channel`.

### Spend budgets

`src/server/src/domain/budget.ts` is pure and re-exported by the SPA. `config.json` carries
`budget: { monthlyUsd: number|null, alertAtPercent: 1..100, pauseOnExceeded: boolean }`;
the default is no overall budget, an 80% warning, and enforcement off. Budget periods are
UTC calendar months `[start, end)`. `notifications.webhook` defaults to
`{ enabled: false, url: null, format: "json", secret: null }`; `enabled` requires an https
URL (http is accepted only for loopback hosts), `format` is `json|slack|discord`, and a
16–256 character secret signs JSON payloads. `notifications.email` defaults to
`{ enabled: false, host: null, port: 587, secure: false, username: null, password: null,
from: null, to: [] }`; enabling it requires a host, a `from` address (plain or
`Display Name <addr>`), and 1–10 unique plain recipients. `secure: true` uses implicit TLS
(usually 465); otherwise STARTTLS is required for every non-loopback host. Username and
password are either both set or both null. `to` is replaced whole on patch, and an omitted
password keeps the saved one while `null` clears it.

`notifications.slack` and `notifications.discord` default to
`{ enabled: false, botToken: null, destinations: [], defaultChannelId: null, routes: [] }`.
Each destination is `{ channelId, label }`; each route is `{ cellId, channelId }`.
Enabling a provider requires a 16–512 character token, at least one destination, and
either a default destination or a route. Slack channel IDs are uppercase alphanumerics;
Discord channel IDs are numeric snowflakes. Destinations, routes, and the default are
validated against each other, and arrays replace whole on patch. The overall budget uses
`defaultChannelId`; a cell uses its route when present and otherwise the default. Omitted
`botToken` keeps the saved one and `null` clears it. The API returns the webhook with
`secret: null`/`secretSet`, email with `password: null`/`passwordSet`, and chat providers
with `botToken: null`/`botTokenSet`.

`BudgetService` reads aggregate totals directly from `UsageRepository.totals`; the early
budget usage reader adapter was removed once the ledger landed. Advisory alert spend is the
sum of known `cost_usd`; a NULL cost is unpriced, never zero or estimated. If every turn in
the period is unpriced the status is `unknown` and no alert fires. Mixed data alerts against
a known lower bound and the UI labels it "at least". The service evaluates on start, every
60 seconds, and when settings or cells change; a failed evaluation goes to the error sink as
`usage.budgets` and never affects a turn.

A scope with `pauseOnExceeded`/`pause_on_exceeded` is a **hard cap**. Its cap spend is
reported plus estimated cost; `capSpendIsLowerBound` is true when any turn has neither.
The cap pauses when cap spend is greater than or equal to the budget. Warning thresholds
never pause, and a scope whose spend is unknowable fails open rather than blocking work.
An overall pause refuses every new agent turn (request, master, summary, KB, setup); a
cell pause refuses only that cell's request, master, and summary turns. Acknowledgement
does not clear a pause. Raising or clearing the budget, disabling the option, or the next
UTC month resumes. Admission is checked before any turn side effect; in-flight turns
finish and there are no spend reservations.

`GET /api/budgets` returns the current period, statuses (including `pauseOnExceeded`,
`capSpendUsd`, `capSpendIsLowerBound`, `unpricedTurns`, and `paused`), unacknowledged
current-month alerts, and a `pauses` array for active hard caps. A manual turn start or
`POST /api/master/run` / `POST /api/summaries/run` while paused returns `409` with
`error: "spend_cap"` and the scope, spend, budget, and period. `POST
/api/budgets/alerts/:id/ack` is idempotent. Global budget writes use `PATCH /api/config`;
cell budget and pause writes use `PATCH /api/cells/:id`. The Config page, Usage page, and
app banner show the same current-month status.

### `master_events`

`id` (uuid PK), `cell_id`, `request_id`, `action`
(`cycle|start|prod|review|advance|followup|skip`), `detail`, `created_at`. Indexes:
`idx_master_events_created` and `idx_master_events_request`. One row is written per
scheduler cycle, prod, review, advance, skip, and created follow-up.

`retention.masterEventsDays` in `config.json` (editable from the Config page) bounds the
table: default 90 days, `0` keeps activity forever. A job runs shortly after startup, then
hourly, and immediately when the setting changes. It deletes rows whose `created_at` is
strictly before `now - masterEventsDays`, in batches of 1000 with an event-loop yield
between batches, relying on `idx_master_events_created`. Rows with
`action = 'followup'` are never deleted, because `hasEvent` uses them as the permanent
deduplication key for `FOLLOW-UP:` titles. Activity is not rolled up; scorecard history
lives in `cell_summaries`. The job never runs `VACUUM`; SQLite reuses freed pages.

### Request artifact retention

`retention.requestArtifactsDays` in `config.json` (editable from the Config page) bounds
the filesystem footprint of finished work: default 30 days, `0` keeps artifacts forever.
A job runs shortly after startup, then hourly, and immediately when the setting changes.
It deletes `dataDir/requests/<id>/` for `done`/`dropped` requests whose last activity
(the request row's `updated_at`, the directory mtime, or the mtime of `transcript.json`
or `session.json`) is strictly before `now - requestArtifactsDays`. It also removes
`dataDir/worktrees/<id>` when the request is terminal, the row is gone, or the request
has no target repo, using `git worktree remove --force` and `git worktree prune`; the
branch is kept. Non-terminal requests, live turns, and reserved session ids
(`__kb__`, `__master__:*`, `__summary__:*`, `__setup__:*`) are never touched. Sweeps
yield between batches, join overlapping runs, and report one `retention.artifacts` error
record with counts and the cutoff only. There is no rollup and no `VACUUM`; deleting a
terminal workdir also drops its chat history and adapter session id.

`BudgetService` hands each evaluation's unacknowledged alerts to `BudgetNotifier`.
`BudgetNotifier` owns a 60-second `unref()`'d timer and enqueues one delivery row per
enabled alert/destination, deduped by `(alert_id, destination_id)`. Webhook attempts post
JSON as the v1 event (alert fields plus `periodEnd` and `text`), or the text-only
Slack/Discord bodies. Email attempts send a plain-text message whose subject names the
scope and threshold and whose body carries the alert sentence, UTC period, and alert id,
with alert/delivery headers and a stable `Message-ID`; one nodemailer transport is opened
per send, TLS verification stays on, and it is closed on success, failure, or abort. Slack
and Discord attempts post a text-only body to `chat.postMessage` and the channel message
endpoint with the bot token; Slack sets `mrkdwn: false` and disables unfurls, and Discord
disables mention parsing. Chat bodies include the alert sentence, threshold, UTC period,
unpriced-turn count, and a Usage link only for a non-loopback `APS_BRAIN_URL`.

Each attempt has a 10-second timeout and uses at most five attempts at 0 s, 60 s, 5 min,
30 min, and 2 h. Webhook `2xx` delivers, `4xx` except `408`/`429` fails permanently, and
`5xx`/`408`/`429`/network/timeout retries with `Retry-After` honored up to one hour. Email
maps auth/envelope/message/protocol codes to permanent failures and connection, socket,
DNS-temporary, timeout, and unknown errors to retries. Slack HTTP 200 `{ok:true}` delivers;
HTTP 200 `{ok:false,error}` is failure, with rate-limit/internal/transient codes retried and
auth/permission/channel/format codes permanent. Discord `2xx` delivers, `429` retries with
`retry_after` (body or header), `408`/`5xx` retry, and other `4xx`/`3xx` fail. Redirects are
never followed. Acknowledged alerts, prior months, removed/rotated destinations, and rows
for another route are marked `skipped` per destination; disabling one channel never skips
another. Failures go to the error sink as `budget.notify` with ids, channel, attempt, and a
short reason only. A disabled or unreachable destination never affects budgets, turns, or
the banner.

`GET /api/notifications/status` reports per-channel enabled/configured, pending, failed,
and the latest delivery (webhook also reports format). Slack and Discord add a
`destinations` array with each configured channel/label and its own counts and latest
status. `POST /api/notifications/webhook/test`, `/email/test`, `/slack/test`, and
`/discord/test` send synthetic `budget.test` events through the same timeout and
transport paths; chat tests accept an optional `channelId` and otherwise use the default.
They require a configured destination, write no alert or delivery rows, and return `200`
or `502`.

### `kb_entries`

`id` (uuid PK), `request_id`, `title`, `content`, `created_at`; index
`idx_kb_entries_request`. Re-indexing a request replaces its prior entry.

### `usage_events`

`id` (uuid PK), `turn_id` (unique engine turn id), `session_id`, `scope`
(`request|master|kb|setup`), `cell_id`, `request_id`, `model`, `effort`,
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `cost_usd` (nullable harness-reported cost), `created_at`.
One row is written after a completed turn that reported usage; cancelled, timed-out,
and usage-less turns write nothing. Unknown cost stays null, never zero. Indexes:
`idx_usage_events_created`, `idx_usage_events_cell_created`,
`idx_usage_events_request_created`, and unique `idx_usage_events_turn`.

`usage.retentionDays` in the app settings file (`config.json`, editable from the Config
page) bounds raw history: default 90 days, `0` keeps raw rows forever. A job runs once
shortly after startup, then hourly, and immediately when the setting changes. The
effective cutoff is the UTC start of `now - retentionDays`; rows strictly before it are
eligible. The job never runs `VACUUM`; SQLite reuses freed pages.

Before deleting anything, the job rolls eligible raw days into UTC-day aggregates in
`usage_daily`, in chunks of at most 31 days per transaction with an event-loop yield
between chunks. Each chunk replaces `usage_daily` rows in its range, aggregates
`usage_events` in that range with the same effective-dated price rules as live queries,
then advances the exclusive `usage_rollup_state.rolled_through` watermark in the same
transaction. Only after the chunks through the cutoff commit does it delete raw rows
strictly before the watermark, in batches of 1000. The first chunk starts at the earliest
raw day, never epoch 0. A failed chunk leaves earlier chunks committed and deletes
nothing; a failed delete leaves the watermark and daily rows committed, so the next run
retries. Lowering the window prunes more; raising it cannot restore raw detail that was
already rolled up and deleted.

### `usage_daily`

`day_start` (UTC midnight epoch ms), `scope`, `cell_id`, `request_id`, `model` (empty
strings stand in for null ids/models), `turns`, the five token sums, and separate
`reported_cost_usd`/`reported_cost_turns` plus `estimated_cost_usd`/
`estimated_cost_turns`. Primary key `(day_start, scope, cell_id, request_id, model)`;
the table is `WITHOUT ROWID`. One row covers a whole UTC day and grouping dimension, not
a turn. Estimated cost is computed at rollup time and frozen once the raw rows are
deleted, so later `model_pricing` corrections apply only to days still in the raw window.

### `usage_rollup_state`

Singleton row `id = 1`, `rolled_through` (epoch ms, exclusive). Raw rows at or after this
boundary are authoritative; `usage_daily` rows before it are authoritative. Queries are a
union of the two sources, so retention cannot double count or lose history. The state row
starts at `0` and only moves forward.

`GET /api/usage` reports `coverage.rolledThrough` (null before the first rollup) and
`coverage.retentionDays` (the current `usage.retentionDays`, read per request) so the SPA
can say which part of history is daily and how far back raw turns are kept without a
second settings request. A rolled-up day that overlaps a requested
`from`/`to` is included in full; day-aligned ranges such as all-time and UTC budget months
are exact. Hourly buckets read raw rows only; totals still include daily rows.

### `model_pricing`

`id` (uuid PK), `model` (exact resolved model id), `effective_from` (epoch ms),
`input_usd_per_mtok`, `output_usd_per_mtok`, `cache_read_usd_per_mtok`,
`cache_write_usd_per_mtok`, `reasoning_usd_per_mtok`, `source` (URL or citation),
`note`, `created_at`. Unique index `idx_model_pricing_model_effective` on
`(model, effective_from)`. Rows are append-only for normal price changes; operators add
a new effective date instead of editing history. `DELETE` exists only for an entry
created by mistake.

A turn keeps its harness-reported cost. When that cost is null and the exact model has a
row with `effective_from <= usage_events.created_at`, usage aggregation adds an estimate
computed from all five token categories. For raw rows the estimate is computed at query
time, so it is never written into `usage_events` and a historical correction applies
immediately. When a day is rolled into `usage_daily`, that day's estimate is frozen in the
aggregate, and later price corrections do not revalue it. An unmatched or future-only
price stays unknown, never zero.

### Domain (`src/server/domain/request.ts`)

- `STATES = clarify | dispatch | review | finalize | done | dropped`.
  `TERMINAL_STATES = done, dropped`.
- `TRANSITIONS`, enforced by the repository:
  - `clarify → dispatch, dropped`
  - `dispatch → review, clarify, dropped`
  - `review → finalize, clarify, dispatch, dropped`
  - `finalize → done, dropped`
  - `done` and `dropped` have none.
- `AGENT_STATUSES = none | idle | working | blocked | error`, normalized agent
  liveness, independent of `state`. Today the clarify child only sets `working` and
  `idle`.
- `isIntake(r) = state === 'clarify' && !clarifyStarted`. Intake is a view, not a state.

### Repositories

- `requests/repository.ts`: `create`, `get`, `list(filter)`, `setClarifyStarted`,
  `edit(fields)` with a partial PATCH of all editable fields, `transition(to)` which
  validates through `canTransition` and throws
  `RequestError('ILLEGAL_TRANSITION'|'NOT_FOUND')`, `addRun`, and agent-status, seen,
  and branch setters. `RequestError` maps to HTTP 404 or 409.
- `cells/repository.ts`: `list` by name, `get`, `create`, `rename`, `delete` in a
  transaction that nulls requests' `cell_id` before deleting the cell, plus policy,
  harness, model/effort, monthly budget, and auto-compaction percentage updates. No
  cascade delete of requests. Deleting a cell also reconciles its unacknowledged budget
  alerts away.
- `kb/repository.ts`: `store({requestId,title,content})` replaces the prior entry for
  that request, plus `list`, `getByRequest`, and a literal LIKE `search`.
- `usage/repository.ts`: `record(input)` writes one event per completed turn and
  `query(filter)` returns totals, UTC bucket series, and model/cell/request groups.
  Reported cost stays separate; an unreported turn uses the effective price row when one
  exists and otherwise remains unpriced.
- `pricing/repository.ts`: `list`, `create`, and `remove` effective-dated price rows,
  plus `getEffective(model, at)` for the latest row at or before a timestamp. Duplicate
  `(model, effective_from)` pairs are rejected.

---

## 5. HTTP API

All JSON unless marked **NDJSON**, which is chunked `reply.hijack()` with one JSON
object per line.

### Requests CRUD and lifecycle

- `GET /health`
- `GET /api/requests` with `?view=intake`, `?state=…`, or `?cellId=…`
- `GET /api/requests/:id`, `POST /api/requests {title, body?, targetRepo?, cellId?}`
- `PATCH /api/requests/:id` with all editable fields optional and nullable: title,
  body, targetRepo, acceptanceCriteria, context, skills[], groomed, model, effort,
  kbDigest, digest, cellId
- `POST /api/requests/:id/transition {to}`
- `POST /api/requests/:id/drop`, `POST /api/requests/:id/seen` (clears `unchecked`)
- Terminal transitions and `/drop` call `engine.dispose(id)`, which kills the session
  and removes the worktree.

### Agent and chat (NDJSON streams)

- `POST /api/requests/:id/clarify/start`, `POST /api/requests/:id/clarify/send {text}`
- `POST /api/requests/:id/dispatch` (review kickoff: `clarify → dispatch` plus a "start
  building" turn)
- `POST /api/requests/:id/finalize` (`review → finalize` plus a "propose KB digest" turn)
- `GET /api/requests/:id/clarify/stream` reattaches to an in-flight turn: it replays the
  event buffer, then streams live events, or returns `{active:false}` when idle
- `GET /api/requests/:id/clarify` returns `{started, transcript[]}`
- `POST /api/requests/:id/index {digest?, index?}` stores the digest to the KB when
  `index && kbDigest`, then transitions `finalize → done`
- `POST /api/requests/index-all {cellId?}` is the Finalize column's bulk close. It
  considers only `finalize` requests in the optional cell (omitted means all cells),
  skips requests that are still working or expect a KB digest but have none, closes
  `kbDigest = false` requests without a KB entry, and returns
  `{indexed, closed, skipped[], failed[]}`. Per-request failures do not abort the batch.
  The action remains human-triggered.
- **KB chat** is a reserved session on these same routes under id `__kb__`. It has no
  database row.

### Models, KB, plugins, cells

- `GET /api/models[?refresh=1][&harness=<id>|&cellId=<id>|&requestId=<id>]` returns
  `{models[], source:'probe'|'fallback', effortLevels, harness, supportsEffort,
  defaultModel}`. `harness`, `cellId`, and `requestId` are mutually exclusive; a request
  resolves its override, then its cell, then the process default.
- `GET /api/kb`, `GET /api/kb?q=…&limit=…`, `POST /api/kb {requestId,title,content}`
- `GET /api/plugins`, `POST /api/plugins {url, subdir?, name?}`,
  `DELETE /api/plugins/:name`
- `GET /api/commands` returns installed plugins' slash commands and skills as
  `[{command, description, plugin}]`
- `GET /api/cells`, `POST /api/cells {name, harness?, model?, effort?, process?}`,
  `PATCH /api/cells/:id {…}`, `DELETE /api/cells/:id`. Cell writes also accept
  `autocompactPercent`, an integer 1–99.
- `GET /ws` is a websocket skeleton (echo plus hello), reserved for an event bridge and
  unused.
- When `webDir` exists, `@fastify/static` serves the SPA at `/` with an `index.html`
  fallback for non-`/api`, non-`/ws` GETs.

### Usage

- `GET /api/usage?cellId=…&requestId=…&from=…&to=…&bucket=hour|day&limit=…`
  returns `{range, totals, series[], byModel[], byCell[], byRequest[], coverage}`.
  `coverage.rolledThrough` is the exclusive raw/daily boundary, or null before the first
  rollup. `coverage.retentionDays` is the current raw retention window (`0` keeps raw
  turns forever) and is read per request, so the dashboard's coverage note never depends
  on a config fetch. Bounds are epoch milliseconds (`from` inclusive, `to` exclusive);
  raw rows are one millisecond wide and daily rows one UTC day, so a range overlapping a
  rolled day includes that day in full. Series buckets are UTC-aligned and zero-filled
  when both bounds are supplied; hourly series read raw rows only. A bounded request over
  10,000 buckets is rejected with 400. Totals separate reported `costUsd`, `estimatedCostUsd`,
  and `totalCostUsd`, with `reportedCostTurns`, `estimatedCostTurns`, `unpricedTurns`, and
  the legacy `unknownCostTurns` counts. An unreported turn with no effective model price
  is unpriced, not zero. Request groups include the request's current cell as
  `cellId`/`cellLabel`.

### Pricing

- `GET /api/pricing` returns `{prices:[{id,model,effectiveFrom,inputUsdPerMtok,…,
  source,note,createdAt}]}`, newest effective row first within each model.
- `POST /api/pricing` creates one row. Model, source, effective date, and all five
  non-negative USD-per-million rates are required. A duplicate `(model,effectiveFrom)`
  returns 409.
- `DELETE /api/pricing/:id` removes an entry created by mistake and returns 204, or 404
  when it does not exist.

### NDJSON event shape

`{t:'text', text}` · `{t:'tool', id, name, input}` ·
`{t:'tool_result', id, text, isError}` · `{t:'done', request|null, transcript}` ·
`{t:'error', message}`.

---

## 6. The agent engine

One persistent child per request, carried across all workflow steps and resumed across
restarts. The adapter is chosen per session: a request resolves its own
`requests.harness`, then its cell (`cells.harness`, then `APS_HARNESS`; legacy
`SBOX_HARNESS` still works), while a cell master or summary uses its cell and setup, KB,
and unassigned sessions use the process default. The same resolved adapter creates the
parser and spawns the child. A cross-harness request skips the cell's model and effort
defaults.

- **Spawn:** Claude runs `claude -p --input-format stream-json --output-format
  stream-json --include-partial-messages --verbose --mcp-config <generated>
  --strict-mcp-config --allowedTools <…> [--model …] [--effort …] [--resume <sid>]`,
  with `cwd` set to the request's worktree and
  `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` in the environment. OpenCode runs
  `opencode run --format json --auto --standalone --archived [--model …] [--session …]`.
  The `session_id` from the adapter's init event is captured to `session.json` with the
  harness id, then reused only by that adapter on later spawns. An in-flight turn keeps
  its adapter; changing a cell's or request's effective harness discards the cached child
  and session id before the next turn.
- **Allowed tools:** request sessions get `Write, Read, Edit, Bash, Skill, Glob, Grep`,
  the bundled `aps` MCP tools, and the user's own MCP servers (Claude reads
  `~/.claude.json`/`.mcp.json`; OpenCode reads its config). The KB session (`__kb__`) is
  read-only: `Read` plus the KB MCP tools, no plugins, no user servers, no request scope.
- **Live turns and reattach:** a turn is decoupled from the originating HTTP request.
  `beginTurn` creates a `LiveTurn` with an event buffer, subscribers, a done flag, and a
  promise. Events are buffered and broadcast to every subscriber. `attach(id, emit)`
  replays the buffer, then streams the rest. `hasLive(id)` is false once done, and the
  turn is dropped immediately so a post-completion mount does not replay it.
  `start`, `send`, `dispatch`, and `finalize` all run through `beginTurn` and are
  idempotent; a second caller attaches.
- **Turn parsing:** reads stream-json lines, accumulates text deltas and tool cards
  (input plus capped output), persists an ordered `transcript.json`, and resolves on the
  `result` event. A `result` with `is_error: true` or an `error*` subtype, and any
  parser-emitted `error` event (for example OpenCode's `error`), fails the turn once:
  the engine broadcasts one `{t:'error'}`, persists one `⚠` transcript line, logs one
  `engine.result` entry, and then finishes with `done`. The failure text is the CLI
  result text, capped; an empty result uses a generic message. There is no in-turn retry.
- **Prompts:** fresh sessions fold a role brief into the first message. `seedPrompt`
  grooms and tells the agent to maintain the ticket through `update_request`.
  `dispatchPrompt` says stop clarifying and build on an isolated branch, do not push,
  do not open a change request. `finalizePrompt` asks for a KB digest. `kbSeedPrompt`
  answers from the KB through `search_kb` and `list_kb`.
- **Auto-compaction:** request sessions compact at the cell's `autocompactPercent`
  (default 80). OpenCode gets `compaction.auto: true` and
  `compaction.buffer: "<100 - percent>%"`; Claude gets
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `autoCompactEnabled: true`. Claude cannot raise
  its built-in threshold, so higher cell values fall back to Claude's default. KB,
  master, setup, and summary sessions keep their own compaction behavior.
- **Agent status:** `working` on turn start, `idle` on end, `unchecked` when a turn
  finishes, cleared by `/seen`. Boot reconciles a stale `working` to `idle`.
- **Per-request git worktree:** `agentCwd` resolves the session cwd to a worktree off
  the target repo on branch `aps/<requestId>`, or a legacy `sbox/<requestId>` when
  that is the only ref that exists, via `ensureWorktree`,
  `removeWorktree`, and `branchName`. It falls back to the scratch workdir when there is
  no target repo or git fails. Transcript, session, and MCP config stay in the scratch
  workdir, out of the repo. `dispose(id)` kills the child and removes the worktree on
  terminal transitions. `retention.requestArtifactsDays` later sweeps leftover checkouts
  for terminal or row-less requests; it never touches a non-terminal request and keeps
  the branch. Once a request is terminal, `npm run migrate:branches` retires its legacy
  `sbox/<id>` ref (`src/server/src/maintenance/legacy-branches.ts`).
- **Workdirs:** `~/.agent-process-segments/requests/<id>/` holds `transcript.json`,
  `session.json` (`{harness, sessionId}`), and the harness-specific config
  (`mcp-config.json` or `opencode/opencode.json`). The `requests/` parent and each
  `<id>` workdir are created `0700`; `transcript.json` and `session.json` are written
  atomically with mode `0600`. A loose workdir or file left by an older version is
  repaired on the next write. Terminal workdirs older than
  `retention.requestArtifactsDays` are deleted whole; see **Request artifact retention**
  below. An existing legacy
  `~/.sandbox-harness` workdir is used until `npm run migrate:paths` moves it. That
  script refuses to run while `agent-process-segments.service` or
  `sandbox-harness.service` is active; `--allow-running` is the unsafe override.

### Models

`EFFORT_LEVELS = low|medium|high|xhigh|max`. Each harness has its own model catalog and
ten-minute cache: Claude probes the CLI (there is no `claude models` command) and falls
back to `HARDCODED_MODELS`; OpenCode probes `opencode models` and has no offline fallback.
`GET /api/models?harness=<id>` or `?cellId=<id>` returns that adapter's list,
`supportsEffort` (Claude only), and its default model. No query uses the process default;
passing both parameters or an unknown harness is a 400.

### Model and effort guidance

**Source of truth is runtime, not this table.** `GET /api/models` returns the live list.
The snapshot below is a default to override, and should be re-verified as models ship.
Model and effort are per-request (`--model`, `--effort`; null means the brain default,
then the CLI default) and apply to that request's one persistent session across every
step. `APS_DEFAULT_MODEL` sets the process-default harness's fallback; per-cell model
overrides win. OpenCode otherwise defaults to `opencode-go/deepseek-v4.1-flash`; Claude
otherwise has no model default.

**Current family** (id, tier, when to pick it, first-party USD per million in and out):

| Model id | Tier | $/1M | Pick for |
|---|---|---|---|
| `claude-fable-5-2` | Most capable | 8 → 40 | Hardest reasoning and long-horizon agentic work; only when Opus is not enough |
| `claude-opus-5-5` | Flagship | 4 → 20 | Default for correctness-sensitive work: implementation, verification, tricky planning |
| `claude-sonnet-5-5` | Balanced | 2 → 10 | Everyday coding, interactive grooming, digests |
| `claude-haiku-5-5` | Fast and cheap | 0.10 → 0.50 | High-volume, mechanical, latency-sensitive steps |

Older point versions stay selectable; prefer the current generation unless pinning.

**Effort.** Higher means deeper reasoning and more tokens. Defaults differ. Opus 5.5
defaults to `medium` when set explicitly; most others default to `high`. Coding and
agentic work repays `high` or `xhigh`; chat, classification, and bulk work do well at
`low` or `medium`.

**Recommended default per workflow segment** (tune on real traffic):

| Segment | Model | Effort | Why |
|---|---|---|---|
| Auto-research and follow-up questions | haiku | low to medium | Mechanical, high volume, fast |
| Plan and clarify | sonnet | medium | Interactive; judgment, not correctness |
| Implement | opus | high or xhigh | Correctness matters; agentic coding |
| Verify and write tests | opus | high | Catching real failures |
| Finalize digest | sonnet | medium | Summarization |
| KB chat | haiku | low to medium | Retrieval plus answer, latency-sensitive |
| Exceptionally hard or stuck | fable | high | Escalation only, because of cost |

Pricing varies by platform and contract. The relative capability and cost ordering is
what this guidance keys on.

### Bundled MCP server (`aps`)

A stdio MCP server the engine launches per session through `--mcp-config`, scoped by
env `APS_REQUEST_ID` and `APS_BRAIN_URL`, proxying to the loopback REST API. It is keyed
and registered as `aps`; "harness" remains the name of the agent-substrate seam, not the
MCP server. Tools: `update_request`, `get_request`, `spawn_request`, `list_requests`,
`index_to_kb` for request sessions; `search_kb`, `list_kb` for the KB session. Namespaced
`mcp__aps__*` and allow-listed so the agent can call them under auto-approve.
`spawn_request` defaults the new request's cell, harness override, and target repo to the
calling request's values; explicit arguments win, and a different `cellId` opts out of
the harness/repo copy. If the calling request cannot be read, the tool returns an error
instead of creating an unassigned request.

### Wire contracts

**Claude stream-json events the engine consumes**, one JSON per line on child stdout,
mapped to our NDJSON:

- `{type:'system', subtype:'init', session_id}` captures the session id for `--resume`.
- `{type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta', text}}}` becomes `{t:'text', text}`.
- `{type:'assistant', message:{content:[{type:'tool_use', id, name, input}]}}` becomes `{t:'tool', id, name, input}`.
- `{type:'user', message:{content:[{type:'tool_result', tool_use_id, content, is_error}]}}` becomes `{t:'tool_result', id, text, isError}`.
- `{type:'result'}` completes the turn; the engine then emits `{t:'done', …}`.

Input to the child is written to stdin as
`{type:'user', message:{role:'user', content:[{type:'text', text}]}}` plus a newline.

**Generated `mcp-config.json`**, per-request workdir, passed with
`--mcp-config … --strict-mcp-config`:

```json
{ "mcpServers": { "aps": {
  "command": "<node>", "args": ["<dist>/mcp/server.js"],
  "env": { "APS_BRAIN_URL": "http://127.0.0.1:7391", "APS_REQUEST_ID": "<id or ''>" } } } }
```

`APS_REQUEST_ID` is empty for the `__kb__` session.

**TranscriptMsg**, persisted to `transcript.json`, returned by `GET /clarify`, and
carried in the `done` event:
`{role:'you'|'agent', kind:'text'|'tool', text, toolId?, toolName?, toolInput?, toolResult?, toolError?, ts}`.

**HTTP error mapping:** `ZodError` becomes 400 `{error:'invalid',issues}`;
`RequestError` becomes 404 for `NOT_FOUND` and 409 otherwise; anything else becomes 500
`{error:'internal',message}`.

---

## 7. Plugins, skills, slash commands

`PluginManager(pluginsDir)`:

- `install({url, subdir?, name?})` shallow-clones, optionally into a monorepo subdir,
  verifies `plugin.json`, copies into `pluginsDir/<name>`, and **strips** plugin
  `hooks` and `mcpServers`, plus the `hooks/` directory and `.mcp.json`, so a plugin
  contributes only skills, commands, and subagents.
- `list()`, `remove(name)` with a slug guard, `installedPluginDirs(dir)` returning child
  dirs that have a `plugin.json` (the engine passes one `--plugin-dir` each on request
  spawns), and `listCommands()` which walks `commands/*.md` recursively with
  `:`-namespaced names, adds `skills/*/SKILL.md`, and reads descriptions from
  frontmatter.
- URL validation: only `http(s)`, `git`, and `ssh` transports.

---

## 8. Web SPA

- `main.tsx` adds `.dark` to `<html>`. `App.tsx` is the shell: a left nav (Floor, board
  columns, Knowledge base, Skills), a `CellBar` to switch cells, a stacked-table board,
  a right-side request detail drawer that can maximize, and a create modal.
- **Board:** columns labelled Requests (intake), Plan (clarify), Implement (dispatch),
  Review, and Finalize. `done` leaves the board. `columnOf` and `STATE_LABELS` map state
  to label; `types.ts` mirrors the server state machine. The Finalize header has a small
  white **Index all** button. It is scoped to the current cell filter, requires a second
  click within four seconds, and shows a status line with indexed/closed/skipped counts
  after the batch.
- **RequestDetail:** editable fields, model and effort pickers, transition buttons with
  a two-step drop confirm, the dispatch and finalize kickoff streams, and the finalize
  digest box with "Index and finalize". The board's bulk action uses the saved digest;
  use the drawer when a digest needs review or editing.
- **Chat:** `ClarifyChat` plus `runtime.ts` using `useExternalStoreRuntime`; React owns
  messages and running state and probes `/clarify/stream` to reattach on mount.
  `Thread.tsx` holds assistant-ui primitives, markdown, tool cards, and code diffs.
  `Composer.tsx` is a custom input with a `/` slash-command autocomplete from
  `/api/commands`, disabled for the KB chat. KB chat is `ClarifyChat` against `__kb__`.
- **SkillsPage** installs, lists, and removes plugins. **CellBar** creates, switches,
  renames, and deletes cells, filtering the board by `cellId`.
- **Config and budgets:** `ConfigPage` edits the scheduler, process template, and overall
  monthly budget/warning percentage, plus the overall pause-on-exceeded option; it also
  shows the current UTC-month status for the overall and per-cell budgets. Its **Alert
  delivery** card edits the webhook URL, format, and signing secret, its **Email
  delivery** card edits the SMTP host, port, TLS mode, optional credentials, From address,
  and recipients, and the **Slack alerts**/**Discord alerts** cards edit bot tokens,
  channel destinations, a default destination, and per-cell routes. Every card shows
  queue/failure/last-delivery state, can send a test, and saves independently; chat cards
  test a single destination and never render a saved token or password back. `CellModal`
  carries the
  optional per-cell budget and pause option. `BudgetBanner` polls `GET /api/budgets` every 60
  seconds, shows dismissible warning/exceeded alerts above the page, and shows
  non-dismissible hard-cap pause notices, with lower-bound copy for unpriced turns.
- `api.ts` is the typed client (fetch plus NDJSON readers). `ui.tsx` is the component
  kit. The bundle is vended by the brain at `/`.

---

## 9. Build, run, test

```bash
npm install                 # workspaces
npm run build               # web (vite) then server (tsc) into src/*/dist
npm run typecheck           # tsc --noEmit for both
npm test                    # vitest: server + web, plus the e2e env guard
npm run lint                # eslint over src, zero warnings
APS_DB=/abs/agent-process-segments.sqlite node src/server/dist/app.js
```

The original test suite covered the request repo and state machine, the cells repo,
the KB repo, models, MCP grants parsing, worktree isolation, and an HTTP server test.

---

## 9a. Canonical data shapes

The server is the source of truth; the SPA mirrors these by hand.

### Domain entities

```ts
type State = 'clarify' | 'dispatch' | 'review' | 'finalize' | 'done' | 'dropped';
type AgentStatus = 'none' | 'idle' | 'working' | 'blocked' | 'error';
type HarnessId = 'claude' | 'opencode';

interface Request {
  id: string; title: string; body: string;
  state: State;
  groomed: boolean; clarifyStarted: boolean;
  targetRepo: string | null;
  model: string | null;          // claude --model id, null means the CLI default
  effort: string | null;         // low|medium|high|xhigh|max, null means default
  acceptanceCriteria: string | null;
  context: string | null;
  skills: string[];
  kbDigest: boolean;             // index into the KB on finalize? default true
  digest: string | null;         // human-approved KB digest text
  agentStatus: AgentStatus;
  unchecked: boolean;            // agent finished, human has not opened it since
  hcRunIds: string[];            // provenance (dormant)
  branch: string | null;         // aps/<id>; legacy sbox/<id> until migrate:branches
  crUrl: string | null;
  cellId: string | null;         // at most one cell; null means the unfiltered floor
  harness: HarnessId | null;     // explicit override; null inherits cell then brain
  createdAt: number; updatedAt: number;
}

interface Cell {
  id: string; name: string; masterEnabled: boolean;
  masterIntervalMinutes: number | null; maxConcurrent: number;
  harness: HarnessId | null; model: string | null; effort: string | null;
  monthlyBudgetUsd: number | null;
  pauseOnExceeded: boolean; // hard cap; default false
  autocompactPercent: number; // 1–99, default 80
  createdAt: number;
}

interface KbEntry {
  id: string; requestId: string; title: string; content: string; createdAt: number;
}
```

### HTTP DTOs

```ts
interface CreateInput { title: string; body?: string; targetRepo?: string | null; cellId?: string | null; harness?: HarnessId | null; }

interface EditInput {
  title?: string; body?: string; targetRepo?: string | null;
  acceptanceCriteria?: string | null; context?: string | null;
  skills?: string[]; groomed?: boolean;
  model?: string | null; effort?: 'low'|'medium'|'high'|'xhigh'|'max' | null;
  kbDigest?: boolean; digest?: string | null; cellId?: string | null;
  harness?: HarnessId | null;
}

// POST /api/requests/:id/transition   { to: State }
// POST /api/requests/:id/index        { digest?: string | null; index?: boolean }
// POST /api/kb                        { requestId: string; title: string; content: string }
// POST /api/plugins                   { url: string; subdir?: string; name?: string }
// POST /api/cells {name, harness?, model?, effort?, autocompactPercent?}
// PATCH /api/cells/:id {…}

interface ModelOption { id: string; label: string; }
interface ModelsResult { models: ModelOption[]; source: 'probe' | 'fallback'; effortLevels: string[];
  harness: 'claude' | 'opencode'; supportsEffort: boolean; defaultModel: string | null; }

interface PluginInfo  { name: string; description: string; dir: string; }
interface CommandInfo { command: string; description: string; plugin: string; }
```

### Chat and streams

```ts
interface TranscriptMsg {
  role: 'you' | 'agent'; kind: 'text' | 'tool'; text: string;
  toolId?: string; toolName?: string; toolInput?: string;
  toolResult?: string; toolError?: boolean; ts: number;
}
interface ClarifyState { started: boolean; transcript: TranscriptMsg[]; }

type ClarifyEvent =
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; name: string; input: string }
  | { t: 'tool_result'; id: string; text: string; isError: boolean }
  | { t: 'done'; request: Request | null; transcript: TranscriptMsg[] }
  | { t: 'error'; message: string };
```

### Persistence note

Row columns are `snake_case` (`clarify_started`, `kb_digest`, `cell_id`); JSON array
fields are stored as JSON text; booleans as `0/1`. Repositories map rows to the
camelCase domain types.

---

## 10. Status at extraction

- **Implemented:** request CRUD and state machine, clarify/implement/finalize streaming
  with reattach, per-request sessions with resume, `aps` MCP plus user MCP servers,
  per-request git worktrees, KB store and KB chat, plugins with slash menu, cells,
  agent-status and unchecked indicators, SPA, single-origin vend plus an SSO tunnel.
- **Not built:** no process supervisor (manual restarts), no CI pipeline integration
  (the review step is human-driven and agents are told not to push or open change
  requests), the KB is a verbatim store with no embeddings or semantic retrieval, the
  dormant `hc` scaffolding, and the data-defined "factory workflow plus mentor" vision,
  which is design-stage.

The rebuild's own status is tracked separately in `docs/02-status.md`.
