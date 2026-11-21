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
  permissions, and plugin command/skill mapping.
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
- 113 vitest cases, all passing: 79 server across 12 files and 34 web across 8 files,
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

## Not built yet

- Pipeline/review automation: the review step is human-driven by design; agents are told
  not to push or open change requests.
- No embeddings over the KB (literal LIKE search only).
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
