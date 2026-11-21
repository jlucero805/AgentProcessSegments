# Agent handoff

You are picking up a rebuild of the Sandbox Harness brain. Read this file first, then
`docs/01-system-spec.md`. Code beats docs when they disagree; when code is wrong against
the spec, say so rather than silently following either.

## What this is

A local Node/TS service that drives headless Claude Code sessions through
Intake → Plan → Implement → Review → Finalize. One port serves `/api`, `/ws`, and
the built SPA. Requests live in SQLite, one persistent agent session per request,
one git worktree per request, and a knowledge base fed by human-approved digests.

## Ground truth

1. `src/server/src/**` is the system.
2. `docs/01-system-spec.md` is the governing contract.
3. `docs/02-status.md` is built versus not built, and it goes stale fast. Check it
   against `git log`.
4. `docs/03-decisions.md` explains choices that look arbitrary until you read them.

## State at handoff

- `main` is deployed to the remote; every unit below was committed as it passed.
- 95 vitest cases: 61 server across 10 files and 34 web across 8 files, all green.
- Two proof scripts: `scripts/smoke.sh` (built brain over a socket) and
  `scripts/mcp-smoke.mjs` (built brain plus built MCP server over real stdio).
- Built: db and migrations, domain, request/cells/KB repositories, HTTP surface with
  NDJSON streams, engine with reattach and resume, stream parser, worktrees, MCP server,
  plugin manager, models with fallback, the SPA (board, drawer, chat, cells, skills,
  knowledge base), and a systemd user unit for a VPS.
- Not built: user MCP server merge, real-CLI verification.

## Commands

```bash
npm install
npm run typecheck              # server then web, must print nothing
npm test                       # 61 server + 34 web
npm run build                  # vite into src/web/dist, then tsc into src/server/dist
npm run dev                    # brain plus the Vite dev server (proxies /api and /ws)
./scripts/smoke.sh             # health, create, list, 400, 404 over a real socket
node scripts/mcp-smoke.mjs     # tools over stdio, persisted into SQLite
# on a VPS, the brain runs as a systemd user unit:
systemctl --user restart sandbox-harness
journalctl --user -u sandbox-harness -n 50 --no-pager
```

## Environment facts that will bite

- **No `claude` binary here.** Real turns, `--resume` behavior, the model probe, and
  partial-message parsing are unverified against the actual CLI. Do not claim otherwise.
  `GET /api/models` reports `source: "fallback"`.
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
2. **`__kb__` is a sentinel request id with no row.** Routes special-case it before
   touching the request repository. Its session is read-only.
3. **MCP tool names must match the engine allowlist.** Registering a tool does not grant
   it. Add it to `REQUEST_TOOLS` or `KB_TOOLS` in `clarify/engine.ts` or the agent
   cannot call it under auto-approve.
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
   their arguments. No route reads `request.body` without a schema.

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

**Change the agent contract.** Extend `TurnParser` first with a fixture test, then route
the new event through `Engine.broadcast`. Nothing in the parser may touch a process or
disk.

## Next units, in order

1. **Merge user MCP servers into `mcp-config.json`** (D11). Verify `claude mcp list` and
   whatever command exposes server definitions on the installed CLI version. Add the
   names to the allowlist and the definitions to the generated config. Acceptance: a
   fake transport test shows both `harness` and a user server in the written config.
2. **Real-CLI verification.** Install `claude`, run one request end to end, confirm
   `--resume` across a brain restart, confirm the model probe returns `source: "probe"`,
   and confirm tool cards survive. Update `docs/02-status.md` with what you saw.

## Conventions

- ESM, `NodeNext` resolution, and `.js` suffixes on relative imports in source.
- Repositories own SQL. Handlers own validation. The engine owns process and disk.
- Tests assert behavior a client can observe, not internal calls, except MCP where the
  HTTP request is the behavior.
- Commit each green unit. Message shape: `type(scope): subject`.
- Update `docs/02-status.md` in the same commit that changes what is built.
