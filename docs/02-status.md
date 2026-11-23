# Status: phase 1 with the SPA

Rebuilt from the system spec (`f849fed` plus the `db.ts` index-ordering fix). Phase 1
covers everything that runs and can be verified without the `claude` CLI. The SPA is
built and vended by the brain; real-CLI verification is still pending.

## Built

- `db.ts`: schema, WAL, `foreign_keys=ON`, additive column guards, indexes created
  after `cell_id` is added, and the stale `working` to `idle` boot reconcile.
- Domain: seven states including the optional Merge step, the transition table as data,
  terminal states, agent statuses,
  effort levels, `isIntake`, and the transcript and NDJSON event types.
- `RequestRepository`: create, get, list (intake view, state, cell), edit with
  boolean/array encoding, guarded transitions (`ILLEGAL_TRANSITION`, `NOT_FOUND`),
  run ids, agent status, unchecked, branch.
- `CellRepository`: list, get, create, rename, delete in a transaction that detaches
  requests instead of deleting them, plus `master_enabled`, `master_interval_minutes`,
  and the per-cell process snapshot.
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
  from `FOLLOW-UP:` callouts. Each cell has its own master chat; manual run, status, and
  event history are cell-scoped. The Config page edits the global schedule/template, and
  the Cell master drawer shows the selected cell’s status, prompts, activity, and chat.
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
  finishes with `done`. Early exits and timeouts include capped child stderr. The turn
  model falls back to `APS_DEFAULT_MODEL`; OpenCode defaults to
  `opencode-go/deepseek-v4.1-flash` instead of its slower free default.
- Usage tracking: both parsers normalize token counts and harness-reported cost into a
  `TurnUsage`; the engine writes one `usage_events` row per completed turn for request,
  master, KB, and setup sessions. `GET /api/usage` returns reported, estimated, and total
  cost plus UTC bucket series and model/cell/request groups. Older history is preserved
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
  tool_result, result) with ordered transcript, duplicate-text protection, and capped
  tool output.
- Worktrees: `aps/<id>` branch per request (legacy `sbox/<id>` reused when it is the
  only ref), reuse of an existing checkout, branch kept on removal, scratch fallback
  when git is unavailable.
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
  `mcp__<server>__*` allow rules; OpenCode merges `mcp` entries from its config and runs
  with `--auto`. Read-only KB sessions exclude user servers and plugins.
- Installed plugins reach OpenCode too: `commands/**/*.md` become `commands` templates
  and `skills/*/SKILL.md` become skill paths in the generated config, with plugin-prefixed
  names that match `/api/commands`. Verified end to end (`/demo-plugin:hello` →
  PLUGINOK, skill invocation → GREETOK).
- OpenCode verified end to end on this host: 44 probed models, a 50 s clarify turn with
  tool cards and `tools.harness.*` MCP calls, a 20-message persisted transcript, session
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
- Chat controls: composing while a turn runs queues the message in localStorage per
  request and drains in order when the turn ends. Stop calls `POST /clarify/stop`, kills
  the child, saves the partial transcript, keeps the saved session for the next message,
  and clears the queue so the human can interject.
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
  schedule/prompt. See `docs/08-user-workflows.md`.
- Master chat: the reserved `__master__` session gets a read-only board/KB tool set. The
  scheduler appends start, prod, advance, follow-up, cycle, and skip notes to its
  transcript without a model turn. The Config page and the Cell master drawer embed the
  chat. Verified live: the master answered, a prod posted notes, and a request moved to
  Review.
- Refactor audit (`docs/06-refactor-audit.md`): the SPA now type-imports the pure server
  contract instead of mirroring it; sentinel routing, MCP board tools, and plugin
  markdown/fs helpers have one implementation; the drawer's form mapping and terminal
  transcript are extracted. Fixed: dispose-while-live promise leak, board drags waiting
  on a full turn, illegal drag jumps, orphan cell ids, double-slash commands, KB
  backslash search, drawer edits overwritten on turn completion, touch-invisible cell
  actions, and the fixed-width KB sidebar on phones.
- Spend budgets: an advisory overall monthly budget and warning percentage live in
  `config.json`; each cell can store `monthly_budget_usd`. Budgets use the UTC calendar
  month and only harness-reported cost. `budget_alerts` stores durable warning/exceeded
  rows keyed by scope, month, threshold, budget, and warning percentage; `GET
  /api/budgets` exposes status and unacknowledged alerts, and `POST
  /api/budgets/alerts/:id/ack` dismisses one. The Config page edits the overall budget and
  threshold, the cell editor edits a cell budget, the Usage page shows the same monthly
  progress, and an app-wide banner surfaces active alerts. Unpriced turns are reported as
  unknown or a lower bound, never guessed. The layer reads `UsageRepository.totals` and
  never stops work.
- Settings: `$XDG_CONFIG_HOME/agent-process-segments/config.json` (or `APS_CONFIG`) holds
  the master switch, interval, the scorecard policy (`enabled`, `intervalMinutes`,
  `windowMinutes`, `prompt`), usage retention (`retentionDays`), and spend budget
  (`monthlyUsd`, `alertAtPercent`), validated with zod and written atomically. Older files
  with only `master` keep their values and gain the default summary, usage, and budget
  blocks. `GET/PATCH /api/config` expose all blocks. `process.json` is the global process
  template; each cell snapshots it into `cells.process_json` and the master uses the
  cell policy when present. The legacy `idleMinutes`, `autoReview`, and `prompt` values
  remain only to derive process defaults when `process.json` is absent. See
  `docs/07-process-segments.md`. The files on this host are still at
  `/root/.config/sandbox-harness/config.json` and `process.json` until the VPS cutover
  runs `npm run migrate:paths`; the brain keeps using that legacy location automatically.
- Usage retention and rollups: `usage.retentionDays` (default 90, `0` keeps raw history
  forever) is edited on the Config page and stored in `config.json`. A startup + hourly
  job rolls raw days into `usage_daily` in 31-day chunks, advances the
  `usage_rollup_state` watermark, then deletes raw rows before the UTC-day-aligned cutoff
  in 1000-row batches. Queries merge daily and raw rows around the watermark, so all-time
  totals and monthly budgets survive pruning. It records `usage.rollup`/`usage.prune`
  failures, joins overlapping runs, and stops during shutdown.
- Error log: explicit failure paths append NDJSON to
  `$XDG_STATE_HOME/agent-process-segments/errors.log` (`APS_ERROR_LOG`,
  `APS_ERROR_LOG_MAX_BYTES`), size-rotated to `.1`. Covered: startup, invalid settings/
  process files, unexpected HTTP 5xx, engine turn/exit/timeout failures, master
  turn/cycle failures, and PTY open failures. Normal logs and expected 4xx responses are
  not persisted. See `docs/10-error-log.md`.
- Chat slash menu: combines installed plugin commands/skills with skills discovered from
  `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, and project
  `.opencode`/`.claude`/`.agents` skill directories. Request chats also discover skills
  from the request worktree or target repo. Selecting a skill sends a plain instruction
  (`Use the <name> skill now…`), which works for both harnesses; plugin commands still
  send as slash commands. See `docs/11-skills.md`.
- 432 vitest cases, all passing: 290 server across 28 files and 142 web across 22 files,
  plus `scripts/smoke.sh` (built brain), `scripts/mcp-smoke.mjs` (built brain plus built
  MCP server over real stdio), `scripts/claude-mock-smoke.mjs` (real Claude Code binary
  against a local mock Anthropic API), and `scripts/e2e.mjs` (built brain + deterministic
  mock Claude in an isolated temp DB, all work inside a dedicated `E2E` cell).
- Claude verified against the real 2.1.330 CLI via `scripts/claude-mock-smoke.mjs`: a
  streamed turn with an `mcp__aps__*` tool call, merged `aps` plus user MCP config,
  `--resume` after a brain restart, and a model probe returning `source: "probe"`. No
  Anthropic account was needed; the mock API answered the Messages stream and the
  `StructuredOutput` probe tool.
- Deployment: a systemd user unit in `deploy/agent-process-segments.service` and a VPS runbook
  in `deploy/vps.md`. Verified on this host: enabled and active, bound to
  `127.0.0.1:7391`, SPA and API served with `/api` winning over the SPA fallback, a
  `kill -9` of the main process triggered `Restart=on-failure`, and a clean restart kept
  serving. `loginctl enable-linger` is set so the user manager starts at boot.
- E2E API workflow: `npm run e2e` boots the built brain with a temp DB and deterministic
  mock Claude CLI, creates a dedicated `E2E` cell, and covers clarify, dispatch,
  master prod/review, follow-up creation, per-cell master chat, finalize, and the
  concurrency cap. It never indexes into the KB and asserts the KB stays empty.
- CI: a ready workflow at `deploy/ci-workflow.yml` runs `npm ci`, typecheck, the full
  test suite, the build, the E2E workflow, `scripts/smoke.sh`, and
  `scripts/mcp-smoke.mjs` on pushes and pull requests. It is not active on the remote:
  publishing a workflow needs a credential with the `workflow` scope. Copy it to
  `.github/workflows/ci.yml` once that is available.

## Deviations from the spec

- `better-sqlite3` is v11, not the spec's v9 pin. The rebuild targeted Node 22.7, where
  v9 has no prebuilt binary; this host runs Node 24, where v11 compiles from source and
  needs `make`, `g++`, and `python3`.
- `@fastify/static` v8, `@fastify/websocket` v11, Fastify v5. The spec named the
  plugins, not versions.
- HTTP tests use a real listening socket instead of `app.inject()`. On Node 22.7,
  `light-my-request` does `require()` of an ESM-only `cookie` v2 and throws. That is a
  test-harness incompatibility, not a production path: `listen()` works.
- The SPA pins `@assistant-ui/react` 0.10 (the `useExternalStoreRuntime` era) with
  React 18, as the spec names. The registry now ships 0.15, which moved the primitives.
  Tailwind stays v3, with PostCSS and autoprefixer wired through `postcss.config.js`.
  Vite 8 and Vitest 5 run in the web workspace; the server keeps Vitest 2.
- The OpenCode adapter runs one process per turn instead of one long-lived child: the
  CLI is one-shot per message. `--session` carries continuity, `--standalone` isolates
  each turn's config, `--archived` keeps brain sessions out of the user's list, and
  `--auto` is the request-session permission posture (the KB session gets explicit deny
  rules).
- `APS_HARNESS` selects the process-default substrate; `APS_CLAUDE_BIN` and
  `APS_OPENCODE_BIN` point at each adapter. `APS_HARNESS_BIN` is the legacy fallback for
  the default adapter only.
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
  per-turn applied-price audit). Advisory budget alerts, effective-dated estimates, and
  daily usage rollups are built.
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
POST   /api/cells                         {name, process?, masterIntervalMinutes?, maxConcurrent?, harness?, model?, effort?, monthlyBudgetUsd?}
PATCH  /api/cells/:id                     {name?, masterEnabled?, masterIntervalMinutes?, maxConcurrent?, harness?, model?, effort?, monthlyBudgetUsd?, process?}
DELETE /api/cells/:id
GET    /api/plugins
POST   /api/plugins                       {url,subdir?,name?}
DELETE /api/plugins/:name
GET    /api/commands
GET    /api/skills[?requestId=…]
GET    /api/config
PATCH  /api/config                        {master?:{…}, summary?:{…}, budget?:{monthlyUsd?, alertAtPercent?}}
GET    /api/budgets                       statuses + unacknowledged current-month alerts
POST   /api/budgets/alerts/:id/ack
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
