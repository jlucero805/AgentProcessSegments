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
- SPA (`src/web`): Vite + React 18 + Tailwind v3, dark by default. Five board columns
  with drag-to-advance, a cell bar with inline create/rename/delete, a create modal, a
  right-side request drawer with editable fields and two-step confirms, assistant-ui
  chat with markdown and tool cards, slash-command autocomplete from `/api/commands`,
  a skills page, and a knowledge-base page with the `__kb__` chat. Single-origin vend
  was verified against the built server: `/` and client-side routes serve `index.html`,
  `/api` still returns JSON, and hashed assets are served.
- 93 vitest cases, all passing: 61 server across 10 files and 32 web across 7 files,
  plus `scripts/smoke.sh` (built brain) and `scripts/mcp-smoke.mjs` (built brain plus
  built MCP server over real stdio).
- Deployment: a systemd user unit in `deploy/sandbox-harness.service` and a VPS runbook
  in `deploy/vps.md`. Verified on this host: enabled and active, bound to
  `127.0.0.1:7391`, SPA and API served with `/api` winning over the SPA fallback, a
  `kill -9` of the main process triggered `Restart=on-failure`, and a clean restart kept
  serving. `loginctl enable-linger` is set so the user manager starts at boot.

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
- The SPA pins `@assistant-ui/react` 0.10 (the `useExternalStoreRuntime` era) with
  React 18, as the spec names. The registry now ships 0.15, which moved the primitives.
  Tailwind stays v3, with PostCSS and autoprefixer wired through `postcss.config.js`.
  Vite 8 and Vitest 5 run in the web workspace; the server keeps Vitest 2.

## Not built yet

- The model probe is implemented but unverified, because `claude` is not installed
  here. `GET /api/models` returns `source: "fallback"` in this environment.
- User MCP servers are not merged into the generated `mcp-config.json` and
  `parseMcpListServers` is not wired in.
- No CI/pipeline integration, no embeddings over the KB.

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
