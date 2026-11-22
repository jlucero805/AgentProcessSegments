# Agent handoff

You are picking up a rebuild of the Sandbox Harness brain. Read this file first, then
`docs/01-system-spec.md`. Code beats docs when they disagree; when code is wrong against
the spec, say so rather than silently following either.

## What this is

A local Node/TS service that drives headless agent sessions through
Intake → Plan → Implement → Review → Finalize. The agent substrate is swappable
(`SBOX_HARNESS=claude` is the default; `opencode` is supported). One port serves
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
9. `docs/09-backlog.md` holds scoped but unbuilt work (token/cost tracking).
10. `docs/10-error-log.md` is the error-only log contract: path, format, rotation, sites.
11. `docs/11-skills.md` is slash-command/skill discovery and invocation in chats.
12. `docs/12-terminals.md` is the server-owned PTY lifecycle, session list, and API.
13. `docs/13-cell-wizard.md` is the cell creation chat and policy setup workflow.

## State at handoff

- `main` is deployed to the remote; every unit below was committed as it passed.
- 240 vitest cases: 158 server across 19 files and 82 web across 16 files, all green.
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
  a first-class Cell master detail with prompts/activity/chat, a cell creation flow that
  defines the policy up front with an editable setup chat, per-cell concurrency caps and
  model/effort defaults, an optional single-worker Merge step with per-segment caps, an
  in-app Help docs viewer, a desktop-only maximizable PTY terminal independent of agent
  sessions, bounded turn/MCP waits with stderr diagnostics, a systemd user
  unit for a VPS, a harness seam with `claude` and `opencode` adapters, OpenCode plugin
  parity (skills and slash commands), chat slash-menu skill discovery with per-request
  target-repo skills, and a GitHub Actions CI workflow template in
  `deploy/ci-workflow.yml`. User MCP servers are merged into request sessions for both.
  OpenCode and Claude are both verified end to end (turn, MCP tools, resume across a
  brain restart); Claude runs against a local mock API, OpenCode against its live CLI.
- Not built: token/cost tracking per cell (scoped in `docs/09-backlog.md`), KB
  embeddings. Review/finalize automation is configurable per cell but finalize remains
  human-gated; the CI workflow is not published yet and needs the `workflow` token scope.

## Commands

```bash
npm install
npm run typecheck              # server then web, must print nothing
npm test                       # 158 server + 82 web
npm run e2e                    # build + isolated API workflow (mock agent, dedicated E2E cell)
npm run build                  # vite into src/web/dist, then tsc into src/server/dist
npm run dev                    # brain plus the Vite dev server (proxies /api and /ws)
SBOX_HARNESS=opencode SBOX_DB=/tmp/sbox.sqlite node src/server/dist/app.js
./scripts/smoke.sh             # health, create, list, 400, 404 over a real socket
node scripts/mcp-smoke.mjs     # tools over stdio, persisted into SQLite
node scripts/claude-mock-smoke.mjs  # real claude binary + mock Anthropic API
node scripts/ui-smoke.mjs      # optional: needs `npm i --no-save puppeteer`
UI_MOBILE=1 node scripts/ui-smoke.mjs  # same smoke at 390x844
# on a VPS, the brain runs as a systemd user unit:
systemctl --user restart sandbox-harness
journalctl --user -u sandbox-harness -n 50 --no-pager
```

## Environment facts that will bite

- **No live Anthropic account here.** `opencode` is authenticated, and a cached Claude
  Code binary can be supplied with `SBOX_CLAUDE_BIN`.
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
  `$XDG_CONFIG_HOME/sandbox-harness/config.json` (`SBOX_CONFIG`), and process segments
  live in `process.json` (`SBOX_PROCESS`). Both are zod-validated and written atomically.
  Invalid files fall back to defaults until saved; env still owns paths, ports, and the
  harness.
- **Errors are the only persisted logs.** `$XDG_STATE_HOME/sandbox-harness/errors.log`
  (`SBOX_ERROR_LOG`, `SBOX_ERROR_LOG_MAX_BYTES`) is NDJSON, size-rotated to `.1`, and
  written only by explicit error paths. Never add routine logging to it.
- **The browser terminal is a real PTY.** `SBOX_TERMINAL=0` disables creation;
  `SBOX_TERMINAL_CWD` sets its starting directory. Sessions are server-owned and listed
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
2. **`__kb__` and `__master__` are sentinel session ids with no rows.** A cell master
   uses `__master__:<cellId>`; the bare id is the global/unassigned chat. Routes
   special-case them before touching the request repository. All reserved sessions are
   read-only; the master scope gets board read tools in addition to the KB tools.
3. **MCP tool names must match the harness allowlist.** Registering a tool does not
   grant it. Add it to `REQUEST_TOOLS`, `KB_TOOLS`, `MASTER_TOOLS`, or `SETUP_TOOLS` in
   `clarify/harness.ts` or the Claude agent cannot call it under auto-approve. OpenCode
   request sessions use `--auto`; its read-only/setup sessions use explicit deny
   permissions.
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
    template and interval when absent. The master walks enabled segments in order, uses
    the segment prompt, and advances only on the exact marker through `canTransition`. Do
    not hardcode a prod/review rule in a route or UI.
12. **Master chats and notes are per cell.** `masterSessionId(cellId)` returns
    `__master__:<cellId>`; unassigned work uses `__master__`. Notes from a cell cycle go
    only to that cell’s session.
13. **Stop keeps the session.** `Engine.cancel` kills the child, resolves the turn, and
    finishes with the partial transcript; it does not clear `session.json`, so the next
    message resumes. Stop clears the client queue; normal completion drains it in order.
14. **Dispose ends a live turn.** `Engine.dispose` kills the child, marks the turn
    cancelled, and resolves it so `finishTurn` can save the partial transcript; never
    delete a live turn's maps without resolving its promise.
15. **Finalize stays human-gated.** `intake` and `finalize` cannot auto-advance; indexing
    into the KB is a human action. Do not add an automatic finalize transition without an
    explicit indexing path.
16. **Follow-ups are deduplicated.** A `FOLLOW-UP:` line creates one request per source
    request/title; the `followup` event is the dedupe key.
17. **Terminal sessions are server-owned and visible.** A WebSocket attaches/detaches; it
    must never kill the PTY on close. Hide detaches, an explicit close kills, and
    `GET /api/terminals` lists every session. Keep scrollback bounded and the UI
    desktop-only; `SBOX_TERMINAL=0` disables creation.
18. **Concurrency is per cell.** The master counts `working` requests in the cell and
    stops starting turns at `max_concurrent` (default 3). Unassigned work uses 3.
19. **Cell model/effort are fallbacks.** A turn uses the request’s model/effort first,
    then the cell defaults; persist cell changes on the cell, not in memory.
20. **Token/cost tracking is backlog.** Do not add guessed pricing or partial usage
    writes; follow `docs/09-backlog.md` when it is built.
21. **Merge is serialized.** The optional `merge` state defaults to `maxConcurrent: 1`;
    the master must check segment caps in addition to the cell cap. Its prompt rebases,
    tests, and pushes one request at a time before advancing to Finalize.
22. **Wizard chat can edit its draft.** `__setup__:<draftId>` has no request row; setup
    scope gets only `Read` plus `get_cell_draft`/`update_cell_draft`, not board/KB tools.
    The harness MCP server uses `codemode: false` so calls are visible tool cards. The
    prompt and tool errors carry `SEGMENT_FLOW_GUIDE`; prefer one `segmentUpdates` update
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
29. **Model defaults are brain-level.** `SBOX_DEFAULT_MODEL` applies when neither the
    request nor its cell names a model. OpenCode defaults to
    `opencode-go/deepseek-v4.1-flash`; do not silently fall back to its slower free tier.
    Expose the default through `GET /api/models` so the wizard can show it.

## Extension recipes

**Add an HTTP route.** Schema in `http/server.ts` next to its neighbours, handler that
calls a repository, then a test in `test/http.test.ts` over the socket. Error mapping is
central; throw `RequestError`, `CellNotFoundError`, or `PluginError` rather than sending
status codes by hand.

**Add an MCP tool.** Register it in `src/mcp/server.ts` with a zod raw shape and an
annotation, add the `mcp__harness__<name>` string to the engine allowlist, then a test in
`test/mcp.test.ts` asserting the recorded HTTP method, path, and body.

**Add a column.** Add it to `BASE_SCHEMA` and to `COLUMNS` in `db.ts`. Indexes go after
the migrations. Add a legacy-database test in `test/db.test.ts`, because that ordering is
where it broke before.

**Change the agent contract.** Extend each harness parser with a fixture test, then
route the new event through `Engine.broadcast`. Nothing in a parser may touch a process
or disk.

**Add a harness.** Implement `AgentHarness` in `clarify/harnesses/<id>.ts` (`prepare`,
`spawn`, `createParser`, `probeModels`, `fallbackModels`), register it in
`clarify/harnesses/index.ts` behind `SBOX_HARNESS`, and add prepare plus parser tests in
`test/harness.test.ts` and a stream test. Keep per-session files inside `session.dir`.

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
