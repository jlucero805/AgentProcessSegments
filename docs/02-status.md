# Status: phase 1 with the SPA

Rebuilt from the system spec (`f849fed` plus the `db.ts` index-ordering fix). Phase 1
covers everything that runs and can be verified without the `claude` CLI. The SPA is
built and vended by the brain; real-CLI verification is still pending.

## Built

- `db.ts`: schema, WAL, `foreign_keys=ON`, additive column guards, indexes created
  after `cell_id` is added, the stale `working` to `idle` boot reconcile, and owner-only
  `0600` database/WAL/SHM sidecars repaired on every open.
- Domain: seven states including the optional Merge step, the transition table as data,
  terminal states, agent statuses,
  effort levels, `isIntake`, and the transcript and NDJSON event types.
- `RequestRepository`: create, get, list (intake view, state, cell), edit with
  boolean/array encoding, guarded transitions (`ILLEGAL_TRANSITION`, `NOT_FOUND`),
  run ids, agent status, unchecked, branch.
- `CellRepository`: list, get, create, rename, delete in a transaction that detaches
  requests instead of deleting them, removes summaries and non-followup activity, and
  keeps follow-up markers, plus `master_enabled`, `master_interval_minutes`, and the
  per-cell process snapshot. The delete route then discards the cell’s reserved
  `__master__` and `__summary__` session directories.
- Cell masters: the scheduler keeps one timer per enabled cell (cell interval or the
  global default), and evaluates the configured process segments from right to left so
  finishing work runs before more planning. Requests without a cell have no master and
  stay manual. A cell never dispatches two cycles at once: a tick that lands during an
  active cycle is skipped and retried on the next interval. Each cycle selects at most
  the cell’s spare concurrency, latest segments first and oldest request first inside a
  segment, so it does not read or note the whole board. It starts or
  prods that bounded set concurrently (up to the cell/segment caps), returns without
  waiting for the turns, then settles each completion in the background, recording
  `start`/`prod`/`advance`/`review`/`followup`/`cycle`/`skip` events and advancing on
  exact markers through legal transitions. A segment can also create follow-up requests
  from `FOLLOW-UP:` callouts; those children inherit the source request’s cell, harness
  override, and target repo. The `spawn_request` MCP tool applies the same inheritance,
  except that naming a different cell skips the harness/repo copy. Each cell has its own
  master chat; manual run, status, and event history are cell-scoped. The Config page
  edits the global schedule/template, and the Cell master drawer shows the selected
  cell’s status, prompts, activity, and chat.
  Both Activity lists cap at 20rem and scroll internally; the drawer's master chat stays
  in reach even when activity is busy.
- Process configuration lives in `$XDG_CONFIG_HOME/agent-process-segments/process.json`
  (`APS_PROCESS` override): six ordered segments with purpose, enabled, idle minutes,
  per-cycle cap, per-segment concurrency, prompt, ready marker, advance target, and
  follow-up policy. It is zod-validated and written atomically. Five-segment files are
  upgraded by inserting Merge, and missing `maxConcurrent` fields default to null.
  Missing/invalid files still fall back to the legacy implement-only policy derived
  from `config.json`.
- Per-cell process policies: creating a cell opens a process editor seeded from the
  global default plus a transient **Setup assistant** chat that can read and update the
  draft (segments, prompts, markers, limits). The saved
  policy is stored on the cell (`cells.process_json`) and its master uses it instead of
  the global template. Existing cells without a policy inherit the global default.
  A cell can enable the optional Merge segment, which defaults to one worker
  (`maxConcurrent: 1`) so rebases are serialized.
- Per-cell masters: the scheduler keeps a separate timer per cell (`masterIntervalMinutes`
  or the global interval). Each cell has its own reserved master chat
  (`__master__:<cellId>`); notes and chat do not mix between cells. Unassigned requests
  have no master chat and stay manual until assigned. Segment
  caps are enforced in addition to the cell cap. Cells also
  store a max-concurrency cap (default 3, pauses new work while that many requests are
  `working`), default model/effort (a request’s own values win), and an auto-compaction
  threshold. The Cell master drawer shows the selected cell’s ticker, policy, activity,
  and chat.
- Per-cell auto-compaction: `cells.autocompact_percent` defaults to 80 and accepts 1–99.
  Every request session passes it to the harness: OpenCode gets `compaction.auto` plus a
  percentage `buffer`, and Claude gets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` plus
  `autoCompactEnabled`. Unassigned requests use 80; KB, master, setup, and summary
  sessions keep the harness/global behavior. No brain-side transcript summarization or
  token accounting is involved.
- Desktop terminal: a sidebar **Terminal** action attaches to a server-owned PTY
  (`node-pty`) in `APS_TERMINAL_CWD`, independent of every agent session. Hiding the
  panel only detaches; sessions stay listed with a status dot, the sidebar shows a session
  count, and reopening replays scrollback. An explicit tab close kills the shell. Up to
  four sessions; `APS_TERMINAL=0` disables it. The UI hides the action below `md`, but the
  session API is live, so the brain must stay behind a trusted boundary.
- Live master verification: a stalled dispatch request was prodded by the real OpenCode
  agent (`MASTERPROD` / `READY FOR REVIEW`), moved to Review in about 3 s, and logged
  prod, review, and cycle events.
- `KbRepository`: one entry per request (store replaces), list, get by request, and a
  multi-term literal LIKE search (`%`, `_`, and `\` escaped) ranked by title/body term
  hits and recency.
- HTTP: health, request CRUD, patch, transition, drop, seen, clarify start/send/stream,
  clarify snapshot, dispatch, finalize, index, index-all, models, usage, pricing, KB,
  cells, config, budgets, docs, websocket echo, and optional SPA vend with an `index.html`
  fallback. Clarify start/send, dispatch, and finalize accept `?detach=1` to start a turn
  and return immediately.
- In-app Help: a sidebar **Help** row opens a full-height documentation overlay, grouped
  by manifest order from `GET /api/docs`, with an article, sticky “On this page” anchors,
  “Copy as Markdown”, in-app doc links, external links in a new tab, and screenshots via
  `GET /api/docs/assets/*`. Mermaid fences render as lazy-loaded, dark-theme SVG diagrams;
  the original fenced source still powers Copy as Markdown and appears as the fallback
  when Mermaid fails. `?help=<slug>` deep-links a page and back/forward move between
  pages. The manifest is an explicit code list; docs are read from `APS_DOCS_DIR`
  (default `<cwd>/docs`) and traversal is rejected. A GitHub icon beside the Help row
  opens the public source repository in a new tab.
- Engine: one persistent child per request, buffered live turns with reattach,
  transcript and session persistence, `--resume` on later spawns, agent status
  transitions, `done`/`error` events, KB session with read-only tools, dispose on
  terminal transitions. Every turn has an `APS_TURN_TIMEOUT_MS` watchdog (default 10
  minutes) that emits an error, kills a silent child, records `engine.timeout`, and
  finishes with `done`. Early exits and timeouts include capped child stderr. A
  harness-reported error result fails the turn once: one `error` event, one persisted
  `⚠` line, and one `engine.result` log entry; a parser-emitted error is never dropped
  from the saved transcript. The turn model falls back to `APS_DEFAULT_MODEL`; OpenCode
  defaults to `opencode-go/deepseek-v4.1-flash` instead of its slower free default.
- Usage tracking: both parsers normalize token counts and harness-reported cost into a
  `TurnUsage`; the engine writes one `usage_events` row per completed turn for request,
  master, KB, and setup sessions. `GET /api/usage` returns reported, estimated, and total
  cost plus UTC bucket series, model/cell/request groups, and `coverage` with the
  raw/rollup boundary and the live retention window. Older history is preserved
  as daily rollups before raw pruning, so all-time totals survive pruning. The
  **Usage** page shows the overall and per-cell timeline with reported-versus-estimated
  chart segments, the raw/rollup boundary, and the retention window; the request drawer
  shows a compact per-request card. Unknown cost stays null and renders as unknown, never
  zero.
- Model pricing: an operator-maintained `model_pricing` table stores effective-dated USD
  rates for input, output, cache read, cache write, and reasoning tokens. The Config page
  lists, adds, and removes rows with a source citation; `GET/POST /api/pricing` and
  `DELETE /api/pricing/:id` expose the same data. Estimates apply only to harness-
  unreported turns whose exact model has an effective row, so reported cost always wins.
- Cell wizard failure handling: draft sync shows an inline error with Retry after 5 s
  instead of an endless “Starting setup chat…” spinner. Chat transport errors get an
  inline retry that remounts the setup chat without closing the wizard.
- Stream parser: the full claude stream-json mapping (init, deltas, tool_use,
  tool_result, result) with ordered transcript, duplicate-text protection, capped tool
  output, and error-result detection (`is_error` or an `error*` subtype) that emits one
  `error` event. OpenCode error events follow the same engine path.
- Worktrees: `aps/<id>` branch per request (legacy `sbox/<id>` reused when it is the
  only ref), reuse of an existing checkout, branch kept on removal, scratch fallback
  when git is unavailable. A terminal transition retires a legacy `sbox/<id>` after the
  checkout is removed; a startup/hourly sweep catches older terminal rows. Both rename
  a lone legacy ref, delete one already contained in `aps/<id>`, repair a stored branch
  whose legacy ref is gone, and never touch live, checked-out, or diverged branches.
  `npm run migrate:branches` remains the dry-run/manual recovery command. With
  `--prune-orphans` it also archives orphan `sbox/*` refs under `refs/sbox-pruned/`
  before deleting them; checked-out orphans are skipped.
- Request workdirs: `npm run repair:permissions` tightens existing `requests/` dirs to
  `0700` and session/transcript/harness config files to `0600` (dry run by default;
  `--apply` to change). It never recurses into `cwd/` checkouts. A missing state file is
  empty; an unreadable or invalid one is reported and moved to
  `<name>.unreadable-<timestamp>-<random>` (`0600`) before the next write.
- MCP server (`src/server/src/mcp/server.ts`): stdio server keyed and registered as
  `aps`, scoped by `APS_REQUEST_ID`, proxying to the loopback API. Request sessions get
  `update_request`, `get_request`, `list_requests`, `spawn_request`, `index_to_kb`; the
  KB session gets `search_kb` and `list_kb`. `GET /api/kb?q=…&limit=…` backs the search
  tool. Brain calls have an `APS_MCP_TIMEOUT_MS` ceiling (default 15 s) and return an MCP
  `isError` result, so a stalled loopback call cannot hold the agent forever.
- Harness seam (`clarify/harness.ts`): per-session config prep, spawn, parser, and model
  probe behind one interface, with a cached registry of `claude` and `opencode` adapters.
  `APS_HARNESS` (legacy `SBOX_HARNESS`) sets the process default; each cell can store
  its own `harness`, and a request can override its cell. Resolution is request, then
  cell, then the process default. Cell masters and summary sessions use their cell;
  setup, KB, and unassigned sessions use the default. Claude runs one
  long-lived `claude -p` stream-json child; OpenCode runs
  `opencode run --format json --auto --standalone` per turn, injects config through
  `OPENCODE_CONFIG_DIR`, resumes with `--session`, and probes `opencode models`. Session
  ids are pinned to their adapter in `session.json`; model catalogs are per harness.
- User MCP servers are merged into request sessions: Claude reads user/local/project
  definitions from `~/.claude.json` and `<cwd>/.mcp.json` and adds
  `mcp__<server>__*` allow rules, merging in the CLI's local > project > user precedence
  with the winning entry used whole; OpenCode merges `mcp` entries from its config and
  runs with `--auto`. Read-only KB sessions exclude user servers and plugins. The bundled
  `aps` key is reserved: a user entry with that name is replaced by the bundled server,
  with a one-time warning naming its config file. A missing config file stays silent;
  one that exists but is unreadable or malformed is named once on stderr and in the
  `harness.mcpConfig` error-log record, and the session continues without those servers.
- Installed plugins reach OpenCode too: `commands/**/*.md` become `commands` templates
  and `skills/*/SKILL.md` become skill paths in the generated config, with plugin-prefixed
  names that match `/api/commands`. Verified end to end (`/demo-plugin:hello` →
  PLUGINOK, skill invocation → GREETOK).
- OpenCode verified end to end on this host: 44 probed models, a 50 s clarify turn with
  tool cards and `tools.aps.*` MCP calls, a 20-message persisted transcript, session
  resume after a brain restart with correct recall, a KB turn with read-only
  permissions, plugin command/skill mapping, a merged user MCP server
  (`tools.userserver.list_kb`), and a target-repo worktree write that stayed off the
  main checkout.
- Plugin manager: shallow clone, optional monorepo subdir, manifest verification,
  hook and MCP stripping, replace-on-reinstall, slug-guarded removal, and slash-command
  discovery from `commands/**/*.md` and `skills/*/SKILL.md`. Local directory sources are
  accepted in addition to `http(s)`, `git`, and `ssh` (D9).
- SPA (`src/web`): Vite + React 18 + Tailwind v3, dark by default. Five board columns
  with drag-to-advance, a cell bar with inline create/rename/delete, a create modal, a
  Finalize-column **Index all** control with a four-second two-click confirm, a
  right-side request drawer with editable fields and two-step confirms, assistant-ui
  chat with markdown and tool cards, slash-command autocomplete from `/api/commands`,
  a skills page, and a knowledge-base page with the `__kb__` chat. Single-origin vend
  was verified against the built server: `/` and client-side routes serve `index.html`,
  `/api` still returns JSON, and hashed assets are served. Headless Chromium runs
  (`scripts/ui-smoke.mjs`, `UI_MOBILE=1` for a 390 px viewport, optional Puppeteer)
  create a request, open the drawer and chat, visit the KB page, and open the Config page
  with no page or console errors.
- Mobile shell: the sidebar is off-canvas with a hamburger below `md`, board columns
  scroll horizontally with snap, and the drawer fills the screen. A 390 px Chromium run
  verified the menu, board scroll, and full-width drawer.
- Durable chat: `?page=`, `?cell=`, and `?request=` restore the view on reload;
  `GET /clarify` reports `active`; the chat hydrates the snapshot and reattaches to a
  live turn, showing a working indicator and streaming text. Verified by reloading
  Chromium mid-turn and seeing the same turn continue.
- Chat controls: composing while a turn runs queues the message under the per-request
  `aps-queue:<requestId>` localStorage key and drains in order when the turn ends. A
  restored queue waits for `GET /clarify` to report whether a turn is live, so a reload
  mid-turn does not push it into the running turn; `POST /clarify/send` refuses with
  `409 turn_active` while a turn runs and the client requeues the text. A
  queue left under the pre-rename `sbox-queue:<id>` key is migrated on first load and the
  legacy key is removed. Stop calls `POST /clarify/stop`, kills the child, saves the
  partial transcript, keeps the saved session for the next message, and clears the queue
  so the human can interject.
- One thread across segments: the drawer renders the same chat for clarify, dispatch,
  review, and finalize (terminal states stay read-only), so the human can interject at
  any point in the workflow.
- Cell master detail: a `Cell master` button above `+ New request` opens a dedicated
  drawer with status, last/next run, the enabled cron loop and prompts, activity, and the
  master chat. `?master=1` restores it. **Configure** in that drawer opens the cell editor
  with the cell's saved policy (falling back to the global template only when the cell has
  none).
- Cell scorecards: a configurable summary cron writes a persisted markdown report per
  cell over a trailing window (default every 6 hours over 6 hours). The scheduler scans
  every 30 seconds, catches up a missing/overdue report once, serializes generations, and
  backs off a failed cell for `min(interval, 30 min)`. Facts are gathered before the
  model call: request counts by state/status, created/updated/completed/dropped, stalled
  work, `master_events` activity, follow-up titles, skip reasons, and the prior window.
  Each cell has an internal read-only `__summary__:<cellId>` session, separate from the
  master chat. Reports are stored in `cell_summaries`; the Cell master drawer shows the
  latest scorecard, history, and **Run scorecard now**, and the Config page edits the
  schedule/prompt. `retention.cellSummariesDays` prunes old reports while always keeping
  the newest per cell. See `docs/08-user-workflows.md`.
- Master chat: the reserved `__master__` session gets a read-only board/KB tool set. The
  scheduler appends start, prod, advance, follow-up, cycle, and skip notes to its
  transcript without a model turn. The Config page and the Cell master drawer embed the
  chat. Verified live: the master answered, a prod posted notes, and a request moved to
  Review.
- Refactor audit (`docs/06-refactor-audit.md`): the SPA now type-imports the pure server
  contract instead of mirroring it; sentinel routing, MCP board tools, and plugin
  markdown/fs helpers have one implementation; the drawer's form mapping and terminal
  transcript are extracted. Fixed: dispose-while-live promise leak, engine-exception
  turn-promise leak, board drags waiting on a full turn, illegal drag jumps, orphan cell
  ids, double-slash commands, KB backslash search, drawer edits overwritten on turn
  completion, touch-invisible cell actions, and the fixed-width KB sidebar on phones.
- Spend budgets: an overall monthly budget, warning percentage, and opt-in
  `pauseOnExceeded`/`pauseOnUnknownCost` live in `config.json`; each cell can store
  `monthly_budget_usd`, `pause_on_exceeded`, and `pause_on_unknown_cost`. Budgets use the
  UTC calendar month. Advisory alerts use harness-reported cost; hard caps use reported
  plus estimated cost and return `409 spend_cap` before a new turn. A strict cap also
  refuses work while any current-month turn is unpriced, with `reason: "unknown_cost"` and
  a pricing/clear/disable remedy; a reached cap reports `reason: "cap_reached"`.
  `budget_alerts` stores durable warning/exceeded rows keyed
  by scope, month, threshold, budget, and warning percentage; `GET /api/budgets` exposes
  status, unacknowledged alerts, active `pauses`, and active `overrides`; `POST
  /api/budgets/alerts/:id/ack` dismisses an alert without overriding a cap. A paused scope
  can be snoozed for 15 minutes through the rest of the UTC month with `POST
  /api/budgets/overrides`; `DELETE /api/budgets/overrides/:id` ends it early. Overrides
  live in `spend_cap_overrides`, an overall override admits every scope, a cell override
  admits only its cell, and neither changes `paused`, alerts, or the budget. The Config
  page edits the overall policy, the cell editor edits a cell policy, the Usage page shows
  the same monthly progress, and an app-wide banner surfaces alerts, pauses, and override
  controls. The Usage card and banner share one poll; the card keeps its last good status
  when a refresh fails and offers Retry when budget status cannot be loaded. Unpriced turns
  are reported as unknown or a lower bound, never guessed. Overall pauses block all new
  agent turns and stop every live one; cell pauses are cell-scoped for both. A cap stop
  saves the partial transcript with a `⏸` line, emits `paused` before `done`, keeps the
  harness session for a later resume, and records harness-reported usage. A snooze
  suppresses admission and the in-flight stop for its scope without changing the budget,
  pause reason, or alerts. Revoking a snooze re-evaluates immediately, so the cap refuses
  new turns and stops live turns at once; an expiry is enforced by the next evaluation
  (within 60 seconds). Master/summary schedulers skip paused cells without backoff; a
  stopped summary is not a failure.
- Alert delivery: an opt-in HTTPS webhook in `notifications.webhook` sends each
  unacknowledged current-month alert once, in JSON (HMAC-SHA256 signed), Slack, or
  Discord text format. An independent SMTP channel in `notifications.email` sends the
  same alerts to up to ten recipients with implicit TLS or required STARTTLS, optional
  credentials, a redacted password, and a plain-text body. Native bot channels in
  `notifications.slack` and `notifications.discord` post to one default channel per
  provider plus optional per-cell routes, using the same outbox and retry policy.
  `budget_alert_deliveries` is a durable outbox keyed by `(alert_id, destination_id)`;
  it snapshots the alert's scope, threshold, budget, spend, unknown-cost count, and
  timestamps at enqueue, so delivery history survives budget/threshold/cell changes and
  month rollover even after the alert row is deleted. It retries transient failures per
  destination, honors `Retry-After` and Discord `retry_after`, skips
  acknowledged/prior-month/deleted-alert/stale-destination rows, and prunes terminal rows
  under `retention.budgetAlertsDays` (default 400; `0` = forever). The current UTC month
  is always kept, pending/in-flight rows are never pruned, and an expired acknowledged
  alert leaves its snapshotted delivery history until the delivery row itself expires. The
  Config page edits and tests all four channels, and
  `GET /api/notifications/status` reports per-channel and per-destination queue state. A
  **Delivery history** card lists recent budget and event attempts with type/channel/status
  filters, pagination, sanitized errors, and a guarded Resend; delivered rows are
  immutable, a chat row is resendable only while its destination still matches, a budget
  row whose alert was deleted is history-only and returns `alert_deleted`, and an event
  row requires its kind/channel route to remain enabled (`event_disabled`). Budget and
  event rows are merged newest-first; event rows expose only the safe classification
  fields, never the payload. Resend and history never return a destination or payload.
  An opt-in **Event notifications** card routes failed request turns, master turn/cycle
  errors, and scorecard generation failures to the same webhook/email channels, per event
  kind and channel; `notification_event_deliveries` dedupes by a one-hour signature,
  sends classification-only payloads, and shares the retry/signing/prune rules. A
  cap-stopped scorecard, the already-running guard, and a deleted cell do not notify.
  Delivery is advisory and never blocks budgets, turns, master cycles, scorecards, or the
  in-app banner.
- Settings: `$XDG_CONFIG_HOME/agent-process-segments/config.json` (or `APS_CONFIG`) holds
  the master switch, interval, the scorecard policy (`enabled`, `intervalMinutes`,
  `windowMinutes`, `prompt`), usage retention (`retentionDays`), master activity
  retention (`masterEventsDays`), scorecard retention (`cellSummariesDays`), budget
  alert retention (`budgetAlertsDays`), request
  artifact retention (`requestArtifactsDays`), spend budget (`monthlyUsd`,
  `alertAtPercent`, `pauseOnExceeded`, `pauseOnUnknownCost`), webhook delivery (`enabled`, `url`, `format`,
  `secret`), email delivery (`enabled`, `host`, `port`, `secure`, `username`, `password`,
  `from`, `to`), Slack/Discord bot delivery (`enabled`, `botToken`, `destinations`,
  `defaultChannelId`, `routes`), and event routes (`failedTurns`/`masterErrors` with
  `webhook`/`email` booleans), validated with zod and written atomically. Each saved
  block is merged over defaults on load, including older files written before a block
  existed. Each block and notification channel also validates on its own: one invalid
  unit falls back to that unit's defaults, is reported as `settings.invalid` with its
  `block` name, and leaves the rest of the file intact; only an unreadable or non-JSON
  file falls back to all defaults. Loading never rewrites the file. Before the first save
  after an unusable load, the raw file is copied to a sibling `config.json.invalid-<UTC>`
  (owner-only, never overwriting an earlier copy); a failed copy refuses the save and
  reports `settings.backupFailed`. `GET/PATCH
  /api/config` expose all blocks and redact the signing secret as `secret: null` with
  `secretSet`, the SMTP password as `password: null` with `passwordSet`, and bot tokens as
  `botToken: null` with `botTokenSet`.
  `process.json` is the global process
  template; each cell snapshots it into `cells.process_json` and the master uses the
  cell policy when present. The legacy `idleMinutes`, `autoReview`, and `prompt` values
  remain only to derive process defaults when `process.json` is absent. See
  `docs/07-process-segments.md`. This host runs `agent-process-segments.service` from
  `$HOME/agent-process-segments`; its `config.json` and `process.json` live at
  `$HOME/.config/agent-process-segments/`.
- Usage retention and rollups: `usage.retentionDays` (default 90, `0` keeps raw history
  forever) is edited on the Config page and stored in `config.json`. A startup + hourly
  job rolls raw days into `usage_daily` in 31-day chunks, advances the
  `usage_rollup_state` watermark, then deletes raw rows before the UTC-day-aligned cutoff
  in 1000-row batches. Queries merge daily and raw rows around the watermark, so all-time
  totals and monthly budgets survive pruning. It records `usage.rollup`/`usage.prune`
  failures, joins overlapping runs, and stops during shutdown. Every completed pass
  persists its reference time and deleted-row count in `usage_prune_state`; `/api/usage`
  and the Usage page report the latest pass so operators can see the job is running.
- Master activity retention: `retention.masterEventsDays` (default 90, `0` keeps activity
  forever) is edited on its own Config card and stored in `config.json`. A startup + hourly
  job deletes `master_events` older than the window in 1000-row batches. Activity is not
  rolled up; scorecards keep their own `cell_summaries` reports. Rows with
  `action = 'followup'` are never pruned, because they are the deduplication key for
  `FOLLOW-UP:` titles. It records only `retention.prune` failures and joins overlapping
  runs. Deleting a cell removes its non-followup activity immediately; its reserved master
  and summary session directories are discarded too, and a failed removal records
  `cells.cleanup` without failing the delete. Retention windows are independent settings
  with independent save actions.
- Scorecard retention: `retention.cellSummariesDays` (default 90, `0` keeps scorecard
  history forever) is edited on its own Config card and stored in `config.json`. The same
  startup + hourly job deletes old `cell_summaries` report rows in 1000-row batches, but
  always keeps the newest row per cell so `latest()`/the drawer and the scheduler's
  due-ness stay intact. History is not rolled up; a failed table reports one
  `retention.prune` record without blocking the other table.
- Request artifact retention: `retention.requestArtifactsDays` (default 30, `0` keeps
  request artifacts forever) is edited on its own Config card. A startup + hourly job
  deletes the whole `requests/<id>/` workdir (transcripts, session id, generated config,
  scratch cwd) and leftover `worktrees/<id>` checkouts for terminal requests older than
  the window, plus checkouts with no request row. Non-terminal requests, live turns,
  reserved `__kb__`/`__master__`/`__summary__`/`__setup__` sessions, and unknown folders
  are never touched. Git branches are kept. It records `retention.artifacts` failures
  with counts and the cutoff only and joins overlapping runs.
- Error log: explicit failure paths append NDJSON to
  `$XDG_STATE_HOME/agent-process-segments/errors.log` (`APS_ERROR_LOG`,
  `APS_ERROR_LOG_MAX_BYTES`), size-rotated to `.1`. Covered: startup, invalid settings
  blocks (per block) and process files, unexpected HTTP 5xx, engine turn/exit/timeout
  failures, master turn/cycle failures, PTY open failures, and hard-cap enforcement
  bugs. Normal logs,
  expected 4xx responses, spend-cap refusals, and cap stops are not persisted. See
  `docs/10-error-log.md`.
- Chat slash menu: combines installed plugin commands/skills with skills discovered from
  `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, and project
  `.opencode`/`.claude`/`.agents` skill directories. Request chats also discover skills
  from the request worktree or target repo. Selecting a skill sends a plain instruction
  (`Use the <name> skill now…`), which works for both harnesses; plugin commands still
  send as slash commands. See `docs/11-skills.md`.
- 1026 vitest cases, all passing: 811 server across 49 files (one environmental root-skip) and 215 web across 24 files,
  plus `scripts/smoke.sh` (built brain), `scripts/mcp-smoke.mjs` (built brain plus built
  MCP server over real stdio), `scripts/claude-mock-smoke.mjs` (real Claude Code binary
  against a local mock Anthropic API, chosen from `--claude-bin`/`CLAUDE_MOCK_SMOKE_BIN`/
  `PATH` and validated by its `--version` output), and `scripts/e2e.mjs` (built brain +
  deterministic
  mock Claude in an isolated temp DB, all work inside a dedicated `E2E` cell).
- Claude verified against the real 2.1.330 CLI via `scripts/claude-mock-smoke.mjs`: a
  streamed turn with an `mcp__aps__*` tool call, merged `aps` plus user MCP config,
  `--resume` after a brain restart, and a model probe returning `source: "probe"`. No
  Anthropic account was needed; the mock API answered the Messages stream and the
  `StructuredOutput` probe tool.
- Deployment: the systemd user unit in `deploy/agent-process-segments.service`, the VPS
  runbook in `deploy/vps.md`, the reviewed `deploy/cutover-vps.sh` (`npm run
  cutover:vps`) for a live self-hosted migration that must survive its own service stop,
  with automatic bounded retention of `~/.aps-cutover/runs/` and
  `--keep-runs`/`--keep-days`/`--no-prune`, and `deploy/upgrade-vps.sh` (`npm run
  upgrade:vps`) for upgrading an already migrated host. The upgrade detaches, drains
  turns, snapshots the database and build, installs
  dependencies only when the lockfile moved, rebuilds, restarts, verifies the new build,
  and rolls back in place; each run leaves evidence under `~/.aps-cutover/upgrades/`.
  This host runs `agent-process-segments.service` from `$HOME/agent-process-segments`
  with APS paths, bound to `127.0.0.1:7391`; SPA and API are served with `/api` winning
  over the SPA fallback. The legacy `sandbox-harness.service` is disabled and its
  unit/drop-ins are backed up under `~/.aps-cutover`. `loginctl enable-linger` is set so
  the user manager starts at boot.
- E2E API workflow: `npm run e2e` boots the built brain with a temp DB and deterministic
  mock Claude CLI, creates a dedicated `E2E` cell, and covers clarify, dispatch,
  master prod/review, follow-up creation, per-cell master chat, finalize, and the
  concurrency cap. It never indexes into the KB and asserts the KB stays empty. The
  JavaScript proof scripts build their child env through `scripts/e2e/env.mjs`
  (`scrubEnv` + `buildPinnedEnv`): host `APS_*`/`SBOX_*` settings and API credentials are
  dropped, then paths, ports, harness, and the mock binary are pinned. The Claude and MCP
  smokes keep deliberate `SBOX_*` pins for legacy-alias coverage, and `mcp-smoke` now
  fails when a tool round trip does not persist. The MCP smoke's brain also pins
  `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `OPENCODE_CONFIG_DIR` under its temp dir, so
  its skill catalog cannot read host config. `npm run test:e2e-env` guards the
  builders, their call sites, and the screenshot script's missing-Puppeteer policy. CI
  runs the E2E and MCP stdio smoke steps with the same hostile `SBOX_*`/`APS_*`
  overrides (including `APS_REQUEST_ID`/`SBOX_REQUEST_ID`) exported, so a regression
  that leaks the host env into either proof fails the build;
  `src/server/test/ci-workflow.test.ts` fails if the two blocks drift.
- CI: a ready workflow at `deploy/ci-workflow.yml` runs `npm ci`, lint, typecheck, the
  full test suite, the build, the E2E workflow, `scripts/smoke.sh`, and
  `scripts/mcp-smoke.mjs` on pushes and pull requests. It also re-runs the web suite
  with `NODE_ENV=production` to exercise the inherited-production React resolution. It
  is not active on the remote:
  publishing a workflow needs a credential with the `workflow` scope. Copy it to
  `.github/workflows/ci.yml` once that is available.

## Deviations from the spec

- `better-sqlite3` is v11, not the spec's v9 pin. The rebuild targeted Node 22.7, where
  v9 has no prebuilt binary; this host runs Node 24, where v11 compiles from source and
  needs `make`, `g++`, and `python3`.
- `@fastify/static` v10, `@fastify/websocket` v11, Fastify v5, zod v4. The spec named the
  plugins, not versions. Static v10 clears the path-traversal route-guard advisories;
  zod 4 clears the oversized-collection memory advisory and needed only the `ZodType`
  generic update in `settings.ts`.
- HTTP tests use a real listening socket instead of `app.inject()`. On Node 22.7,
  `light-my-request` does `require()` of an ESM-only `cookie` v2 and throws. That is a
  test-harness incompatibility, not a production path: `listen()` works.
- The SPA uses `@assistant-ui/react` 0.15.38 (the `useExternalStoreRuntime` era) with
  React 18, as the spec names. The 0.15 line still supports the external-store API and
  clears the transitive `nanoid` advisories. Tailwind stays v3, with PostCSS and
  autoprefixer wired through `postcss.config.js`. Vite 8 and Vitest 5 run in the web
  workspace; the server keeps Vitest 2.
- The OpenCode adapter runs one process per turn instead of one long-lived child: the
  CLI is one-shot per message. `--session` carries continuity, `--standalone` isolates
  each turn's config, `--archived` keeps brain sessions out of the user's list, and
  `--auto` is the request-session permission posture (the KB session gets explicit deny
  rules).
- `APS_HARNESS` selects the process-default substrate; `APS_CLAUDE_BIN` and
  `APS_OPENCODE_BIN` point at each adapter. `APS_HARNESS_BIN` is the legacy fallback for
  the default adapter only. Startup logs one warning naming any `SBOX_*` variables still
  set (names only, never values); `APS_*` wins when both are present.
- `GET /api/models` adds `harness`, `supportsEffort`, and `defaultModel` alongside the
  spec's `models`/`source`/`effortLevels`, and accepts `harness`, `cellId`, or
  `requestId`, so the SPA can resolve the right catalog and tell when effort is inert.
- `GET /clarify` adds `active` alongside `started`/`transcript` so a reconnecting client
  knows whether a live turn can be reattached.
- `POST /clarify/send` marks the request started when it is the first message, even if
  `/clarify/start` was skipped.
- Sessions carry a scope (`request`, `kb`, or `master`) to the bundled `aps` MCP server via
  `APS_SESSION_SCOPE`. `__kb__` and `__master__` are reserved sessions with no request
  row; both are read-only, and the master gets board read tools. The internal
  `__summary__:<cellId>` generator also uses the read-only master scope but is not
  exposed as a chat.
- App settings live in an XDG config file, separate from the environment path config. The
  file is created on the first save; environment values still win for paths and ports.

## Not built yet

- Automatic finalize/index: the human still approves KB indexing. Per-cell review
  prompts can create draft CRs, but there is no hardcoded forger integration.
- No embeddings over the KB: search is literal terms ranked locally, with no semantic
  recall.
- Pricing maintenance at scale (bulk import, context tiers, non-USD currencies,
  per-turn applied-price audit). Advisory budget alerts, webhook/email/chat delivery,
  effective-dated estimates, daily usage rollups, and hard-cap cancellation are built.
- Automatic replay of a cap-stopped prompt. Admission, in-flight cancellation, strict
  unknown-cost enforcement, and time-boxed operator snoozes are built.
- Fan-out to multiple Slack/Discord destinations per scope, per-scope routing for the
  webhook/email channels, interactive acknowledgement, and configurable event
  coalescing windows. Webhook, email, and native Slack/Discord bot channels with per-cell
  routing, delivery history/resend, and failed-turn/master-error/scorecard-failure events
  are built.
- The CI workflow template still needs a `workflow`-scoped credential to publish.

## Route list

```
GET    /health
GET    /api/docs
GET    /api/docs/:slug
GET    /api/docs/assets/*                 docs/screenshots only
GET    /api/requests?view=intake|state=…[&cellId=…]
GET    /api/requests/:id
POST   /api/requests
PATCH  /api/requests/:id
POST   /api/requests/:id/transition      {to}
POST   /api/requests/:id/drop
POST   /api/requests/:id/seen
POST   /api/requests/:id/clarify/start[?detach=1]        NDJSON or {started}
POST   /api/requests/:id/clarify/send     {text}[?detach=1] NDJSON or {started}
POST   /api/requests/:id/clarify/stop                    {stopped}
GET    /api/requests/:id/clarify/stream                 NDJSON or {active:false}
GET    /api/requests/:id/clarify
POST   /api/requests/:id/dispatch[?detach=1]             NDJSON or {started}
POST   /api/requests/:id/finalize[?detach=1]             NDJSON or {started}
POST   /api/requests/:id/index            {digest?,index?}
POST   /api/requests/index-all            {cellId?}
GET    /api/models?refresh=1
GET    /api/kb[?q=…&limit=…]
POST   /api/kb                            {requestId,title,content}
GET    /api/cells
GET    /api/cells/:id
GET    /api/cell-drafts/:id
PUT    /api/cell-drafts/:id
PATCH  /api/cell-drafts/:id
DELETE /api/cell-drafts/:id
POST   /api/cells                         {name, process?, masterIntervalMinutes?, maxConcurrent?, harness?, model?, effort?, monthlyBudgetUsd?, pauseOnExceeded?, pauseOnUnknownCost?}
PATCH  /api/cells/:id                     {name?, masterEnabled?, masterIntervalMinutes?, maxConcurrent?, harness?, model?, effort?, monthlyBudgetUsd?, pauseOnExceeded?, pauseOnUnknownCost?, process?}
DELETE /api/cells/:id
GET    /api/plugins
POST   /api/plugins                       {url,subdir?,name?}
DELETE /api/plugins/:name
GET    /api/commands
GET    /api/skills[?requestId=…]
GET    /api/config
PATCH  /api/config                        {master?, summary?, usage?, retention?, budget?, notifications?:{webhook?,email?,slack?,discord?,events?}}
GET    /api/budgets                       statuses + unacknowledged alerts + active pauses + active overrides
POST   /api/budgets/alerts/:id/ack
POST   /api/budgets/overrides             {scope, cellId?, minutes, note?}
DELETE /api/budgets/overrides/:id
GET    /api/notifications/status          per-channel/per-destination and per-event-kind queue/last-delivery state
GET    /api/notifications/deliveries      merged budget+event audit; source/kind/channel/status filters, limit/offset, canResend
POST   /api/notifications/deliveries/:id/resend  guarded resend for failed/skipped budget or event rows
POST   /api/notifications/webhook/test    synthetic test event; 400 without a URL, 502 on rejection
POST   /api/notifications/email/test      synthetic test email; 400 unconfigured, 502 on rejection
POST   /api/notifications/slack/test      synthetic chat test; optional channelId, 400/502
POST   /api/notifications/discord/test    synthetic chat test; optional channelId, 400/502
GET    /api/process
PATCH  /api/process                       {segments:[…]}
GET    /api/master/status[?cellId=…]
POST   /api/master/run?cellId=…
GET    /api/master/events?cellId=…&limit=…
GET    /api/summaries[?cellId=…&limit=…]
GET    /api/summaries/latest?cellId=…
POST   /api/summaries/run?cellId=…
GET    /api/summaries/status[?cellId=…]
GET    /api/usage[?cellId=…][&requestId=…][&from=…][&to=…][&bucket=hour|day][&limit=…]
GET    /api/pricing
POST   /api/pricing                       {model,effectiveFrom,rates,source,note?}
DELETE /api/pricing/:id
GET    /api/terminal
GET    /api/terminals
POST   /api/terminals                     {cols?, rows?}
DELETE /api/terminals/:id
GET    /ws/terminal?sessionId=…           PTY attach over WebSocket
GET    /ws
```

`__kb__` (knowledge base) and `__master__` (cell master) use the same clarify routes as
reserved sessions with no request row.
