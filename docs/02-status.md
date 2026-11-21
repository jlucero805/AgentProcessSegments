# Status: phase 1 with the SPA

Rebuilt from the system spec (`f849fed` plus the `db.ts` index-ordering fix). Phase 1
covers everything that runs and can be verified without the `claude` CLI. The SPA is
built and vended by the brain; real-CLI verification is still pending.

## Built

- `db.ts`: schema, WAL, `foreign_keys=ON`, additive column guards, indexes created
  after `cell_id` is added, and the stale `working` to `idle` boot reconcile.
- Domain: six states, the transition table as data, terminal states, agent statuses,
  effort levels, `isIntake`, and the transcript and NDJSON event types.
- `RequestRepository`: create, get, list (intake view, state, cell), edit with
  boolean/array encoding, guarded transitions (`ILLEGAL_TRANSITION`, `NOT_FOUND`),
  run ids, agent status, unchecked, branch.
- `CellRepository`: list, get, create, rename, delete in a transaction that detaches
  requests instead of deleting them, plus `master_enabled`, `master_interval_minutes`,
  and the per-cell process snapshot.
- Cell masters: the scheduler keeps one timer per enabled cell (cell interval or the
  global default) plus one for unassigned work, and walks the configured process
  segments. It starts or prods due work, records
  `start`/`prod`/`advance`/`review`/`followup`/`cycle`/`skip` events, and advances on
  exact markers through legal transitions. A segment can also create follow-up requests
  from `FOLLOW-UP:` callouts. Each cell has its own master chat; manual run, status, and
  event history are cell-scoped. The Config page edits the global schedule/template, and
  the Cell master drawer shows the selected cell’s status, prompts, activity, and chat.
- Process configuration lives in `$XDG_CONFIG_HOME/sandbox-harness/process.json`
  (`SBOX_PROCESS` override): five ordered segments with purpose, enabled, idle minutes,
  per-cycle cap, prompt, ready marker, advance target, and follow-up policy. It is
  zod-validated and written atomically. Missing/invalid files fall back to the legacy
  implement-only policy derived from `config.json`.
- Per-cell process policies: creating a cell opens a process editor seeded from the
  global default; the saved policy is stored on the cell (`cells.process_json`) and its
  master uses it instead of the global template. Existing cells without a policy inherit
  the global default.
- Per-cell masters: the scheduler keeps a separate timer per cell (`masterIntervalMinutes`
  or the global interval) plus one for unassigned work. Each cell has its own reserved
  master chat (`__master__:<cellId>`); notes and chat do not mix between cells. The Cell
  master drawer shows the selected cell’s ticker, policy, filtered activity, and chat.
- Live master verification: a stalled dispatch request was prodded by the real OpenCode
  agent (`MASTERPROD` / `READY FOR REVIEW`), moved to Review in about 3 s, and logged
  prod, review, and cycle events.
- `KbRepository`: one entry per request (store replaces), list, get by request, and a
  multi-term literal LIKE search (`%`, `_`, and `\` escaped) ranked by title/body term
  hits and recency.
- HTTP: health, request CRUD, patch, transition, drop, seen, clarify start/send/stream,
  clarify snapshot, dispatch, finalize, index, models, KB, cells, websocket echo, and
  optional SPA vend with an `index.html` fallback. Clarify start/send, dispatch, and
  finalize accept `?detach=1` to start a turn and return immediately.
- Engine: one persistent child per request, buffered live turns with reattach,
  transcript and session persistence, `--resume` on later spawns, agent status
  transitions, `done`/`error` events, KB session with read-only tools, dispose on
  terminal transitions.
- Stream parser: the full claude stream-json mapping (init, deltas, tool_use,
  tool_result, result) with ordered transcript, duplicate-text protection, and capped
  tool output.
- Worktrees: `sbox/<id>` branch per request, reuse of an existing checkout, branch kept
  on removal, scratch fallback when git is unavailable.
- MCP server (`src/mcp/server.ts`): stdio server scoped by `SBOX_REQUEST_ID`, proxying
  to the loopback API. Request sessions get `update_request`, `get_request`,
  `list_requests`, `spawn_request`, `index_to_kb`; the KB session gets `search_kb` and
  `list_kb`. `GET /api/kb?q=…&limit=…` backs the search tool.
- Harness seam (`clarify/harness.ts`): per-session config prep, spawn, parser, and model
  probe behind one interface. `claude` is the default; `SBOX_HARNESS=opencode` selects
  the OpenCode adapter, which runs `opencode run --format json --auto --standalone` per
  turn, injects config through `OPENCODE_CONFIG_DIR`, resumes with `--session`, and
  probes `opencode models`.
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
  master chat. `?master=1` restores it.
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
- Settings: `$XDG_CONFIG_HOME/sandbox-harness/config.json` (or `SBOX_CONFIG`) holds the
  scheduler switch, interval, and unassigned-work flag, validated with zod and written
  atomically. `GET/PATCH /api/config` expose it. `process.json` is the global process
  template; each cell snapshots it into `cells.process_json` and the master uses the
  cell policy when present. The legacy `idleMinutes`, `autoReview`, and `prompt` values
  remain only to derive process defaults when `process.json` is absent. See
  `docs/07-process-segments.md`. The files on this host are
  `/root/.config/sandbox-harness/config.json` and `process.json`.
- 189 vitest cases, all passing: 127 server across 15 files and 62 web across 13 files,
  plus `scripts/smoke.sh` (built brain), `scripts/mcp-smoke.mjs` (built brain plus built
  MCP server over real stdio), and `scripts/claude-mock-smoke.mjs` (real Claude Code
  binary against a local mock Anthropic API).
- Claude verified against the real 2.1.330 CLI via `scripts/claude-mock-smoke.mjs`: a
  streamed turn with an `mcp__harness__*` tool call, merged harness plus user MCP config,
  `--resume` after a brain restart, and a model probe returning `source: "probe"`. No
  Anthropic account was needed; the mock API answered the Messages stream and the
  `StructuredOutput` probe tool.
- Deployment: a systemd user unit in `deploy/sandbox-harness.service` and a VPS runbook
  in `deploy/vps.md`. Verified on this host: enabled and active, bound to
  `127.0.0.1:7391`, SPA and API served with `/api` winning over the SPA fallback, a
  `kill -9` of the main process triggered `Restart=on-failure`, and a clean restart kept
  serving. `loginctl enable-linger` is set so the user manager starts at boot.
- CI: a ready workflow at `deploy/ci-workflow.yml` runs `npm ci`, typecheck, the full
  test suite, the build, `scripts/smoke.sh`, and `scripts/mcp-smoke.mjs` on pushes and
  pull requests. It is not active on the remote: publishing a workflow needs a credential
  with the `workflow` scope. Copy it to `.github/workflows/ci.yml` once that is available.

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
- `SBOX_HARNESS` selects the substrate; `SBOX_HARNESS_BIN` overrides the binary.
  `SBOX_CLAUDE_BIN` remains the Claude-specific override.
- `GET /api/models` adds `harness` and `supportsEffort` alongside the spec's
  `models`/`source`/`effortLevels`, so the SPA can tell when effort is inert (OpenCode).
- `GET /clarify` adds `active` alongside `started`/`transcript` so a reconnecting client
  knows whether a live turn can be reattached.
- `POST /clarify/send` marks the request started when it is the first message, even if
  `/clarify/start` was skipped.
- Sessions carry a scope (`request`, `kb`, or `master`) to the harness MCP server via
  `SBOX_SESSION_SCOPE`. `__kb__` and `__master__` are reserved sessions with no request
  row; both are read-only, and the master gets board read tools.
- App settings live in an XDG config file, separate from the environment path config. The
  file is created on the first save; environment values still win for paths and ports.

## Not built yet

- Automatic finalize/index: the human still approves KB indexing. Per-cell review
  prompts can create draft CRs, but there is no hardcoded forger integration.
- No embeddings over the KB: search is literal terms ranked locally, with no semantic
  recall.
- The CI workflow template still needs a `workflow`-scoped credential to publish.

## Route list

```
GET    /health
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
GET    /api/models?refresh=1
GET    /api/kb[?q=…&limit=…]
POST   /api/kb                            {requestId,title,content}
GET    /api/cells
GET    /api/cells/:id
POST   /api/cells                         {name, process?, masterIntervalMinutes?}
PATCH  /api/cells/:id                     {name?, masterEnabled?, masterIntervalMinutes?, process?}
DELETE /api/cells/:id
GET    /api/plugins
POST   /api/plugins                       {url,subdir?,name?}
DELETE /api/plugins/:name
GET    /api/commands
GET    /api/config
PATCH  /api/config                        {master:{…}}
GET    /api/process
PATCH  /api/process                       {segments:[…]}
GET    /api/master/status[?cellId=…]
POST   /api/master/run[?cellId=…]
GET    /api/master/events?cellId=…&limit=…
GET    /ws
```

`__kb__` (knowledge base) and `__master__` (cell master) use the same clarify routes as
reserved sessions with no request row.
