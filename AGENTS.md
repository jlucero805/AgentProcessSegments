# Agent handoff

Formerly Sandbox Harness.

You are picking up a rebuild of the Agent Process Segments brain. Read this file first,
then `docs/01-system-spec.md`. Code beats docs when they disagree; when code is wrong
against the spec, say so rather than silently following either.

## What this is

A local Node/TS service that drives headless agent sessions through
Intake → Plan → Implement → Review → Finalize. The agent substrate is swappable
(`APS_HARNESS=claude` is the default; `opencode` is supported). One port serves
`/api`, `/ws`, and the built SPA. Requests live in SQLite, one persistent agent session
per request, one git worktree per request, and a knowledge base fed by human-approved
digests.

## Ground truth

1. `src/server/src/**` is the system.
2. `docs/01-system-spec.md` is the governing contract.
3. `docs/02-status.md` is built versus not built, and it goes stale fast. Check it
   against `git log`.
4. `docs/03-decisions.md` explains choices that look arbitrary until you read them.
5. `docs/04-design-liberties.md` lists the autonomous choices made after the handoff,
   with alternatives, for operator review.
6. `docs/06-refactor-audit.md` records the duplication/bug audit, what was fixed, and
   what was deliberately deferred.
7. `docs/07-process-segments.md` is the process.json contract and automation semantics.
8. `docs/08-user-workflows.md` is the operator workflow: cells, process choices, master
   observation, requests, review, and finalize.
9. `docs/09-backlog.md` holds scoped but unbuilt work (hard budget caps and pricing
   maintenance at scale). Usage rollups, budget alerts, and estimated pricing are built.
10. `docs/10-error-log.md` is the error-only log contract: path, format, rotation, sites.
11. `docs/11-skills.md` is slash-command/skill discovery and invocation in chats.
12. `docs/12-terminals.md` is the server-owned PTY lifecycle, session list, and API.
13. `docs/13-cell-wizard.md` is the cell creation chat and policy setup workflow.

## State at handoff

- `main` is deployed to the remote; every unit below was committed as it passed.
- 481 vitest cases: 332 server across 30 files and 149 web across 22 files, all green.
- Four proof scripts: `scripts/smoke.sh` (built brain over a socket),
  `scripts/mcp-smoke.mjs` (built brain plus built MCP server over real stdio),
  `scripts/claude-mock-smoke.mjs` (real Claude binary against a mock Anthropic API), and
  `scripts/e2e.mjs` (built brain + deterministic mock Claude, isolated DB, dedicated E2E
  cell, no KB indexing).
- Built: db and migrations, domain, request/cells/KB repositories, HTTP surface with
  NDJSON streams, engine with reattach and resume, stream parsers, worktrees, MCP server,
  plugin manager, models with fallback, the SPA (board, drawer, chat, cells, skills,
  knowledge base), a mobile shell, durable chat with URL route restore, queued messages
  and stop/interject, one thread across workflow segments, a Config page with XDG
  settings and a structured process editor, configurable global and per-cell process
  segments with per-cell tickers, follow-up callouts, event log, per-cell master chats,
  a first-class Cell master detail with prompts/activity/chat, configurable per-cell
  scorecards over a trailing window (persisted reports, read-only summary session,
  polling scheduler with catch-up and backoff), a cell creation flow that
  defines the policy up front with an editable setup chat, per-cell concurrency caps,
  model/effort defaults, auto-compaction thresholds, advisory overall/per-cell spend
  budgets with durable alerts, an in-app banner, and opt-in signed webhook delivery, an optional single-worker Merge step
  with per-segment caps, an in-app Help docs viewer, a desktop-only maximizable PTY
  terminal independent of agent sessions, bounded turn/MCP waits with stderr diagnostics,
  a systemd user unit for a VPS, a harness seam with `claude` and `opencode` adapters, OpenCode plugin
  parity (skills and slash commands), chat slash-menu skill discovery with per-request
  target-repo skills, per-turn token/cost usage tracking with a Usage dashboard and
  request-level card, effective-dated operator-maintained model pricing with
  reported-versus-estimated cost accounting, and a GitHub Actions CI workflow template in
  `deploy/ci-workflow.yml`. User MCP servers are merged into request sessions for both.
  OpenCode and Claude are both verified end to end (turn, MCP tools, resume across a
  brain restart); Claude runs against a local mock API, OpenCode against its live CLI.
- Not built: KB embeddings, hard budget caps, email/native-chat alert delivery, delivery
  history/resend, and pricing maintenance at scale such as bulk import, tiers, or non-USD
  currencies (scoped in `docs/09-backlog.md`).
  Usage retention with daily rollups is built.
  Review/finalize automation is configurable per cell but finalize remains human-gated;
  the CI workflow is not published yet and needs the
  `workflow` token scope.

## Commands

```bash
npm install
npm run typecheck              # server then web, must print nothing
npm test                       # 332 server + 149 web
npm run e2e                    # build + isolated API workflow (mock agent, dedicated E2E cell)
npm run build                  # vite into src/web/dist, then tsc into src/server/dist
npm run dev                    # brain plus the Vite dev server (proxies /api and /ws)
APS_HARNESS=opencode APS_DB=/tmp/sbox.sqlite node src/server/dist/app.js
./scripts/smoke.sh             # health, create, list, 400, 404 over a real socket
node scripts/mcp-smoke.mjs     # tools over stdio, persisted into SQLite
node scripts/claude-mock-smoke.mjs  # real claude binary + mock Anthropic API
node scripts/ui-smoke.mjs      # optional: needs `npm i --no-save puppeteer`
UI_MOBILE=1 node scripts/ui-smoke.mjs  # same smoke at 390x844
node scripts/screenshots.mjs   # refresh README/Help screenshots; needs a built SPA
                               # and optional Puppeteer
# on a VPS, the brain runs as a systemd user unit:
systemctl --user restart agent-process-segments
journalctl --user -u agent-process-segments -n 50 --no-pager
```

## Environment facts that will bite

- **No live Anthropic account here.** `opencode` is authenticated, and a cached Claude
  Code binary can be supplied with `APS_CLAUDE_BIN`.
  `scripts/claude-mock-smoke.mjs` verifies the Claude harness against a local mock
  Anthropic API (stream, MCP tool, `--resume`, model probe) and skips when no binary is
  found. Do not infer live Claude model behavior from the mock.
- **OpenCode is one-shot per message.** The adapter starts
  `opencode run --format json --auto --standalone` per turn, carries the `ses_…` session
  id, and maps `text`, `tool_use`, `step_finish`, and `error` events. MCP tools surface
  as `execute` code calling `tools.<server>.<tool>()`. Do not add a persistent-child
  assumption to this harness.
- **Claude allow rules support MCP wildcards.** User servers merged from
  `~/.claude.json` and `<cwd>/.mcp.json` are allowed with `mcp__<server>__*`, alongside
  the explicit harness tools.
- **Pin a child's `PWD` to its cwd.** OpenCode resolves its project root from `PWD`; an
  inherited value points it at the brain's directory and breaks per-request config and
  commands. Both harness adapters set it on spawn.
- **App settings are not env config.** Scheduler policy lives in
  `$XDG_CONFIG_HOME/agent-process-segments/config.json` (`APS_CONFIG`), and process segments
  live in `process.json` (`APS_PROCESS`). Both are zod-validated and written atomically.
  Invalid files fall back to defaults until saved; env still owns paths, ports, and the
  harness.
- **APS is canonical, SBOX is legacy.** Read every runtime variable through
  `readEnv()` in `src/server/src/env.ts`: `APS_*` wins when defined (including an empty
  string), then the old `SBOX_*` alias. Resolve default paths through `loadConfig`; it
  prefers an existing `agent-process-segments` location and falls back to an existing
  `sandbox-harness` one. Do not add a fresh `process.env.SBOX_*` read or a new hardcoded
  default outside `config.ts`. Operators move data with `npm run migrate:paths`.
- **Errors are the only persisted logs.** `$XDG_STATE_HOME/agent-process-segments/errors.log`
  (`APS_ERROR_LOG`, `APS_ERROR_LOG_MAX_BYTES`) is NDJSON, size-rotated to `.1`, and
  written only by explicit error paths. Never add routine logging to it.
- **The browser terminal is a real PTY.** `APS_TERMINAL=0` disables creation;
  `APS_TERMINAL_CWD` sets its starting directory. Sessions are server-owned and listed
  in the UI; hiding the panel only detaches, closing a session tab kills it. It is
  desktop-only in the UI, but the session API is live. Never expose the brain beyond
  loopback without auth/proxy controls, because the terminal is a direct shell.
- **Puppeteer is not a project dependency.** `scripts/ui-smoke.mjs` skips without it.
  A headless Chromium on this host needs the usual shared libraries (`libnss3`,
  `libnspr4`, `libatk*`, `libgbm1`, `libasound2`, …).
- **Node 22.7.** `app.inject()` throws because `light-my-request` requires ESM-only
  `cookie` v2. Tests listen on port 0 and use `fetch`. Do not "fix" this by pinning
  `cookie`.
- **better-sqlite3 v11 is deliberate** (D1). The spec's v9 pin assumed an older Node.
  On Node 24 there is no v11 prebuild here, so `npm install` compiles it and needs
  `make`, `g++`, and `python3`. Provision those on a fresh box or CI image.
- **systemd user units need a user manager.** In a non-login shell set
  `XDG_RUNTIME_DIR=/run/user/<uid>` before `systemctl --user`. Linger starts the user
  manager at boot; the brain's unit is in `deploy/`.
- **macOS temp paths differ**: `os.tmpdir()` returns `/var/...` while `git rev-parse`
  returns `/private/var/...`. Compare real paths or existence, never strings, in
  worktree code.
- **The remote is public.** Anything you commit is published. Do not add internal host
  names, auth providers, or account identifiers. `AGENTS.md`, docs, and code comments
  are all public.

## Invariants

1. **Transition table is data.** Add states in `domain/request.ts`; never branch on
   state elsewhere without going through `canTransition`.
2. **`__kb__`, `__master__:<cellId>`, and `__summary__:<cellId>` are sentinel session
   ids with no rows.** A cell master uses `__master__:<cellId>`; the bare `__master__`
   is not a session and unassigned work has no master. The internal
   `__summary__:<cellId>` generator writes scorecards and is not exposed as a chat.
   Routes special-case them before touching the request repository. All reserved
   sessions are read-only; the master scope gets board read tools in addition to the KB
   tools.
3. **MCP tool names must match the harness allowlist.** Registering a tool does not
   grant it. Build the string with `mcpTool()` from `mcp/identity.ts`, add it to
   `REQUEST_TOOLS`, `KB_TOOLS`, `MASTER_TOOLS`, or `SETUP_TOOLS` in
   `clarify/harness.ts`, or the Claude agent cannot call it under auto-approve. OpenCode
   request sessions use `--auto`; its read-only/setup sessions use explicit deny
   permissions. The bundled server key is `aps`; "harness" is the agent adapter.
4. **One turn at a time per id.** `start`/`send`/`dispatch`/`finalize` return the
   existing `LiveTurn` while one is in flight. Do not start a second.
5. **A finished turn is dropped.** `attach()` returns false after completion; clients
   fall back to `GET /clarify`.
6. **Agent status is independent of state.** `working` on turn start, `idle` plus
   `unchecked` on finish, cleared by `/seen`.
7. **Terminal transitions dispose.** `done` and `dropped` must call `engine.dispose(id)`,
   which kills the child and removes the worktree but keeps the branch.
8. **Plugins contribute skills and commands only.** `install` strips `hooks`,
   `mcpServers`, `hooks/`, and `.mcp.json`. Never re-add them.
9. **Guards at the boundary.** zod validates HTTP and MCP input. Repositories trust
   their arguments. No route reads `request.body` without a schema. A non-null `cellId`
   is checked against `CellRepository` before it is written.
10. **The SPA imports the pure server contract.** `src/web/src/types.ts` re-exports
    `domain/request`, `domain/sessions`, `master/types`, `plugins/types`, and
    `clarify/models`. Keep those modules free of Node imports so Vite can bundle them; do
    not restate workflow tables, session ids, or request shapes in the SPA.
11. **Process segments are data.** `process.json` is the global template. A cell can
    store its own snapshot in `cells.process_json` and an optional
    `master_interval_minutes`; its master uses that policy and ticker, or the global
    template and interval when absent. The master evaluates enabled segments from the
    right of the pipeline to the left (`finalize` first, `intake` last), uses the segment
    prompt, and advances only on the exact marker through `canTransition`. Do
    not hardcode a prod/review rule in a route or UI.
12. **Master chats and notes are per cell.** `masterSessionId(cellId)` returns
    `__master__:<cellId>`. Unassigned requests have no master and no chat; notes from a
    cell cycle go only to that cell’s session.
13. **Stop keeps the session.** `Engine.cancel` kills the child, resolves the turn, and
    finishes with the partial transcript; it does not clear `session.json`, so the next
    message resumes. Stop clears the client queue; normal completion drains it in order.
14. **Dispose ends a live turn.** `Engine.dispose` kills the child, marks the turn
    cancelled, and resolves it so `finishTurn` can save the partial transcript; never
    delete a live turn's maps without resolving its promise.
15. **Finalize stays human-gated.** `intake` and `finalize` cannot auto-advance; indexing
    into the KB is a human action. The Finalize column's **Index all** is an explicit
    human bulk action: keep it scoped to `finalize` and skip working requests or requests
    with no digest instead of closing them silently. Do not add an automatic finalize
    transition without an explicit indexing path.
16. **Follow-ups are deduplicated.** A `FOLLOW-UP:` line creates one request per source
    request/title; the `followup` event is the dedupe key.
17. **Terminal sessions are server-owned and visible.** A WebSocket attaches/detaches; it
    must never kill the PTY on close. Hide detaches, an explicit close kills, and
    `GET /api/terminals` lists every session. Keep scrollback bounded and the UI
    desktop-only; `APS_TERMINAL=0` disables creation.
18. **Concurrency is per cell, and cycles are bounded.** The master counts `working`
    requests in the cell and stops starting turns at `max_concurrent` (default 3). Each
    cycle selects at most that spare capacity, latest segments first and oldest request
    first inside a segment; it must not scan or note every queue. Unassigned requests
    are manual-only and never enter a bucket.
19. **Cell model/effort are fallbacks.** A turn uses the request’s model/effort first,
    then the cell defaults; persist cell changes on the cell, not in memory.
20. **Usage is recorded after completion; reported cost wins; retention and budgets are
    advisory.** Parsers expose a normalized `TurnUsage`; the engine writes one
    `usage_events` row only when the harness emitted a final event and reported usage.
    Cancelled, timed-out, and usage-less turns write nothing. `usage_events.cost_usd` is
    harness-reported only and is never rewritten. An unreported turn may be estimated at
    query time from the exact model's latest `model_pricing` row with
    `effective_from <= created_at`; prices are explicit USD-per-million rows with a
    source, and an unmatched model stays unpriced, never zero. Claude reports cumulative
    usage on resumed sessions, so persist the last cumulative totals in `session.json`
    and record per-turn deltas. `usage.retentionDays` (default 90, `0` = keep raw forever)
    drives the startup/hourly retention job. That job first rolls raw days into
    `usage_daily` in bounded UTC-day chunks, advances the `usage_rollup_state` watermark
    atomically with each chunk, and only then deletes raw rows strictly before the
    day-aligned cutoff; delete usage rows only through that job. Queries read raw rows at
    or after the watermark and daily rows before it, so all-time totals never double count
    or lose history. Daily estimates are
    frozen at rollup time; raw days keep query-time estimates. Budget status reads
    `UsageRepository.totals` (the same merged view), compares reported cost only, never
    estimates missing cost, and never pauses or blocks work. Do not add guessed prices or
    partial usage writes. Hard caps, external delivery, and pricing maintenance at scale
    follow `docs/09-backlog.md`.
21. **Merge is serialized.** The optional `merge` state defaults to `maxConcurrent: 1`;
    the master must check segment caps in addition to the cell cap. Its prompt rebases,
    tests, and pushes one request at a time before advancing to Finalize.
22. **Wizard chat can edit its draft.** `__setup__:<draftId>` has no request row; setup
    scope gets only `Read` plus `get_cell_draft`/`update_cell_draft`, not board/KB tools.
    The bundled `aps` MCP server uses `codemode: false` so calls are visible tool cards.
    The prompt and tool errors carry `SEGMENT_FLOW_GUIDE`; prefer one `segmentUpdates` update
    per segment. The chat refreshes the form after each successful update. The draft is
    server-backed, validated, deleted on close, and any live turn is stopped. An enabled
    intake prompt is included in the first clarification turn.
23. **Errors go through the error sink.** Use the injected `ErrorSink` on genuine failure
    paths; it appends NDJSON to the XDG state log and must never throw. Keep context to
    ids/method/URL, never prompts, bodies, transcripts, tokens, or secrets. Expected 4xx
    responses stay out of the file.
24. **Skills are prompt instructions, not CLI slashes.** Discover them from the standard
    OpenCode/Claude directories (`docs/11-skills.md`). The composer may show `/name`, but
    sending it must translate to `Use the <name> skill now…`; only plugin commands may be
    sent as raw slash commands.
25. **Help docs are manifest-only.** Add pages to `src/server/src/docs/service.ts`; never
    join a user slug onto a filesystem path. Assets are limited to `docs/screenshots/**`,
    and an empty docs directory must render the unavailable state, not an error.
26. **Brain agent runs are non-interactive.** Never allow a harness to wait for a UI
    question. OpenCode's `question` tool is denied in every scope; prompts must ask in
    plain text. The setup chat answers simple messages directly instead of touring tools.
27. **Waits are bounded.** Every turn has `config.turnTimeoutMs`; a timeout must emit
    `error`, finish with `done`, kill the child, and log `engine.timeout`. Harness MCP
    calls must time out with an `isError` result. Wizard draft sync failures belong inline
    in the modal, not only in the page-level banner.
28. **NDJSON POSTs must declare JSON.** `streamNdjson` sets
    `content-type: application/json` whenever it sends a body. A browser string body
    otherwise becomes `text/plain` and Fastify rejects the chat action validation.
29. **Model defaults are brain-level.** `APS_DEFAULT_MODEL` applies when neither the
    request nor its cell names a model. OpenCode defaults to
    `opencode-go/deepseek-v4.1-flash`; do not silently fall back to its slower free tier.
    Expose the default through `GET /api/models` so the wizard can show it.
30. **The master starts a batch and returns.** `runBucket` selects up to the cell’s spare
    concurrency, counts already-selected candidates against segment caps, starts the batch
    with `Promise.all`, records the prods, and returns. Completion handling (transcript,
    follow-ups, marker advancement) runs in background promises and mutates the cycle
    result/events. Do not block the cycle on `turn.promise`; per-cell scheduler
    coalescing still prevents overlapping dispatch cycles. A tick that lands during an
    active cell cycle is skipped and retried on the next interval.
31. **Scorecards are observational and separate from the master.** The summary service
    gathers facts, writes one `cell_summaries` row, and never transitions requests or
    writes to `__master__:<cellId>`. Generation uses `__summary__:<cellId>` with the
    read-only master tool scope. Keep the schedule in `summary` settings, throttle
    generations to one at a time, and back off failures instead of scanning every 30 s.
32. **Harness choice is per cell or request and pinned per session.** A request session
    uses `requests.harness`, then its cell's `cells.harness`, then `config.harness`.
    Cell masters and summary sessions use their cell; setup, KB, and unassigned
    sessions use the process default. `session.json` stores the harness with the session
    id and usage, and an id from another adapter is never resumed. A cross-harness
    request skips the cell's model and effort defaults, and a patch that changes the
    effective harness clears a stale request model unless a replacement is supplied.
33. **Auto-compaction is harness-native and per cell.** A request session compacts at
    its cell’s `autocompactPercent` (default 80, range 1–99); unassigned requests use 80.
    Pass it into OpenCode as `compaction.buffer: "<100 - percent>%"` with `auto: true`,
    and into Claude as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` plus
    `autoCompactEnabled: true`. Note that Claude cannot raise its built-in threshold.
    KB, master, setup, and summary sessions keep the harness/global behavior.
34. **Webhook alert delivery is advisory, idempotent, and signed.** One
    `budget_alert_deliveries` row per `(alert_id, channel)` is the dedupe record; never
    send a delivered alert twice. Rows carry the `destination_hash` they were enqueued
    under so a URL/format/secret change skips pending rows instead of sending them with
    new credentials. Delivery retries are bounded, failures go to `budget.notify` with
    ids only, and a notifier failure must never throw into budget evaluation, an HTTP
    handler, or a turn. Tests inject the sender; no external network traffic.

## Extension recipes

**Add an HTTP route.** Schema in `http/server.ts` next to its neighbours, handler that
calls a repository, then a test in `test/http.test.ts` over the socket. Error mapping is
central; throw `RequestError`, `CellNotFoundError`, or `PluginError` rather than sending
status codes by hand.

**Add an MCP tool.** Register it in `src/mcp/server.ts` with a zod raw shape and an
annotation, add `mcpTool('<name>')` from `src/mcp/identity.ts` to the engine allowlist,
then a test in `test/mcp.test.ts` asserting the recorded HTTP method, path, and body.

**Add a column.** Add it to `BASE_SCHEMA` and to `COLUMNS` in `db.ts`. Indexes go after
the migrations. Add a legacy-database test in `test/db.test.ts`, because that ordering is
where it broke before.

**Add a notification channel.** Reuse `budget_alert_deliveries` rather than a second
outbox: add the channel value, a destination identity, and a sender with the same
timeout/retry/error classification. Redact credentials from `redactSettings`, never log a
URL or secret, and inject the transport in tests.

**Add a scorecard fact.** Extend `SummaryStats` in `summary/types.ts`, fill it in
`collectSummaryStats`, and assert it in `test/summary.test.ts`. The prompt already points
the model at the snapshot; do not let it invent a number that is not in the JSON. If the
fact needs history the database does not have, scope a durable activity log instead of
reading transcripts.

**Change the agent contract.** Extend each harness parser with a fixture test, then
route the new event through `Engine.broadcast`. Nothing in a parser may touch a process
or disk.

**Add a harness.** Implement `AgentHarness` in `clarify/harnesses/<id>.ts` (`prepare`,
`spawn`, `createParser`, `probeModels`, `fallbackModels`), add it to `HARNESS_IDS` in
`domain/harness.ts`, register it in the cached registry in `clarify/harnesses/index.ts`
behind `APS_HARNESS` (legacy `SBOX_HARNESS` alias), and add prepare plus parser tests in
`test/harness.test.ts` and a stream test. Keep per-session files inside `session.dir`,
and pin `session.json` to the adapter id so a harness switch cannot resume the wrong
session.

**Add or change a process segment.** Update `process/definition.ts`, `process/defaults.ts`
(defaults plus prompt), the UI labels, and `test/process.test.ts`. Advancement must be a
legal `canTransition` from the segment’s state; `intake` and `finalize` stay manual. A
cell policy is a snapshot: edit `cells.process_json` through `PATCH /api/cells/:id`, not
by mutating the global file.

## Next units, in order

1. **Activate CI.** Copy `deploy/ci-workflow.yml` to `.github/workflows/ci.yml` and push
   it with a token that has the `workflow` scope.
2. **Optional chaining.** A segment can advance a request but the next segment waits for
   its idle window; add a `chain` flag only if operators want same-cycle handoff.
3. **KB embeddings.** Search is now ranked literal terms (`GET /api/kb?q=`); semantic
   recall still needs an embedding provider.

## Conventions

- ESM, `NodeNext` resolution, and `.js` suffixes on relative imports in source.
- Repositories own SQL. Handlers own validation. The engine owns process and disk.
- Tests assert behavior a client can observe, not internal calls, except MCP where the
  HTTP request is the behavior.
- Commit each green unit. Message shape: `type(scope): subject`.
- Update `docs/02-status.md` in the same commit that changes what is built.
