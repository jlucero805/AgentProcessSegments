# Status: phase 1

Rebuilt from the system spec (`f849fed` plus the `db.ts` index-ordering fix). Phase 1
covers everything that runs and can be verified without the `claude` CLI.

## Built

- `db.ts`: schema, WAL, `foreign_keys=ON`, additive column guards, indexes created
  after `cell_id` is added, and the stale `working` to `idle` boot reconcile.
- Domain: six states, the transition table as data, terminal states, agent statuses,
  effort levels, `isIntake`, and the transcript and NDJSON event types.
- `RequestRepository`: create, get, list (intake view, state, cell), edit with
  boolean/array encoding, guarded transitions (`ILLEGAL_TRANSITION`, `NOT_FOUND`),
  run ids, agent status, unchecked, branch.
- `CellRepository`: list, get, create, rename, delete in a transaction that detaches
  requests instead of deleting them.
- `KbRepository`: one entry per request (store replaces), list, get by request, LIKE
  search with literal `%` and `_`.
- HTTP: health, request CRUD, patch, transition, drop, seen, clarify start/send/stream,
  clarify snapshot, dispatch, finalize, index, models, KB, cells, websocket echo, and
  optional SPA vend with an `index.html` fallback.
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
- Plugin manager: shallow clone, optional monorepo subdir, manifest verification,
  hook and MCP stripping, replace-on-reinstall, slug-guarded removal, and slash-command
  discovery from `commands/**/*.md` and `skills/*/SKILL.md`. Local directory sources are
  accepted in addition to `http(s)`, `git`, and `ssh` (D9).
- 61 vitest cases, all passing, plus `scripts/smoke.sh` (built brain) and
  `scripts/mcp-smoke.mjs` (built brain plus built MCP server over real stdio).

## Deviations from the spec

- `better-sqlite3` is v11, not the spec's v9 pin. That pin existed because v11 needed
  Node 22 on the original machine; this machine runs Node 22.7, where v9 has no
  prebuilt binary. v11 loads from a prebuild and was verified before any code was
  written.
- `@fastify/static` v8, `@fastify/websocket` v11, Fastify v5. The spec named the
  plugins, not versions.
- HTTP tests use a real listening socket instead of `app.inject()`. On Node 22.7,
  `light-my-request` does `require()` of an ESM-only `cookie` v2 and throws. That is a
  test-harness incompatibility, not a production path: `listen()` works.

## Not built yet

- The web SPA and the `src/web` workspace. `webDir` is wired and the server vends
  `index.html` when the directory exists, but nothing builds into it.
- The model probe is implemented but unverified, because `claude` is not installed
  here. `GET /api/models` returns `source: "fallback"` in this environment.
- User MCP servers are not merged into the generated `mcp-config.json` and
  `parseMcpListServers` is not wired in.
- No process supervisor, no CI/pipeline integration, no embeddings over the KB.

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
POST   /api/requests/:id/clarify/start                  NDJSON
POST   /api/requests/:id/clarify/send     {text}         NDJSON
GET    /api/requests/:id/clarify/stream                 NDJSON or {active:false}
GET    /api/requests/:id/clarify
POST   /api/requests/:id/dispatch                       NDJSON
POST   /api/requests/:id/finalize                       NDJSON
POST   /api/requests/:id/index            {digest?,index?}
GET    /api/models?refresh=1
GET    /api/kb[?q=…&limit=…]
POST   /api/kb                            {requestId,title,content}
GET    /api/cells
POST   /api/cells                         {name}
PATCH  /api/cells/:id                     {name}
DELETE /api/cells/:id
GET    /api/plugins
POST   /api/plugins                       {url,subdir?,name?}
DELETE /api/plugins/:name
GET    /api/commands
GET    /ws
```
