# Sandbox Harness

A local Node/TypeScript brain that drives headless Claude Code sessions through a
request workflow. One origin serves the API, an optional SPA, and the websocket, so a
single port is all a tunnel needs.

This repository is a rebuild from the system spec at commit `f849fed`. It targets the
same data model, state machine, HTTP surface, and wire contracts.

## Requirements

- Node 20 or newer
- `git` for per-request worktrees
- `claude` (default) or `opencode` on `PATH` to run real agent turns; choose with
  `SBOX_HARNESS`. The core (database, workflows, HTTP, stream parsing) runs and is
  tested without an agent CLI.

## Quick start

```bash
npm install
npm test
npm run e2e
npm run build
SBOX_DB=$PWD/sandbox-harness.sqlite node src/server/dist/app.js
```

The brain binds `127.0.0.1:7391` unless `SBOX_HOST` / `SBOX_PORT` say otherwise. Do not
widen the bind. A tunnel is the audience gate, not the process.

`SBOX_HARNESS=opencode` swaps the agent substrate; `SBOX_HARNESS_BIN` overrides the
binary. The default is `claude`.

`./scripts/smoke.sh` boots the built server on a throwaway database and exercises the
main routes over a real socket.

## Docs

- `docs/01-system-spec.md` the governing contract
- `docs/02-status.md` built versus not built, route list, deviations
- `docs/03-decisions.md` why this rebuild chose what it chose
- `docs/04-design-liberties.md` autonomous choices to review
- `docs/05-plan.md` current feature plan and task list
- `docs/06-refactor-audit.md` duplication/bug audit and deferred cleanup
- `docs/07-process-segments.md` process.json contract and automation rules
- `docs/08-user-workflows.md` end-to-end operator workflows
- `docs/09-backlog.md` scoped but unbuilt work (token/cost tracking)
- `docs/10-error-log.md` error-only NDJSON log: path, format, rotation, sites
- `deploy/vps.md` systemd unit and VPS runbook
- `AGENTS.md` handoff: environment traps, invariants, extension recipes, next units

## Layout

```
src/server/src
  app.ts              entry: open db, build repos + engine, listen
  config.ts           every path and port, env-overridable
  db.ts               schema, idempotent column migrations, boot reconcile
  domain/request.ts   states, transition table, entities, transcript types
  domain/sessions.ts  reserved KB/master session ids, per-cell master sessions
  requests/           RequestRepository: CRUD, edit, guarded transitions
  cells/              CellRepository: delete detaches requests, per-cell process policy,
                      interval, concurrency cap, and model/effort defaults
  kb/                 KbRepository: one entry per request, ranked literal search
  http/server.ts      Fastify routes, zod validation, NDJSON streaming, SPA vend
  clarify/engine.ts   one persistent agent session per request, buffered live turns
  clarify/harness.ts  harness seam: session prep, spawn, parser, model probe
  clarify/harnesses/claude.ts    claude CLI, merged MCP config, allowlist
  clarify/harnesses/opencode.ts  opencode CLI, per-turn runs, session resume
  clarify/harnesses/plugin-assets.ts  plugin skills/commands -> OpenCode config
  clarify/stream.ts   pure claude stream-json parser (no process, no disk)
  clarify/transport.ts  the AgentProcess interface harnesses implement
  clarify/prompts.ts  seed, dispatch, finalize, and KB briefs
  clarify/worktree.ts per-request git worktree on branch sbox/<id>
  clarify/models.ts   model catalog with a cached probe and harness fallback
  settings.ts         XDG scheduler settings, zod validation, atomic write
  process/            process.json definition, defaults, store, follow-up parser
  master/events.ts    master event log (start, prod, advance, followup, cycle, skip)
  master/service.ts   one master bucket: segments, follow-ups, advancement, cell chat
  master/scheduler.ts per-cell timers, unassigned timer, manual run, coalesced cycles
  mcp/server.ts       stdio MCP server exposing harness tools, proxied to the API
  logging/errors.ts   structured error-only NDJSON log with size rotation
  terminal/service.ts desktop browser terminal: one node-pty shell per socket
  plugins/manager.ts  install, strip hooks/mcp, list, remove, slash-command discovery
src/web
  vite.config.ts      dev server, proxying /api and /ws to the brain
  src/main.tsx        mounts the app and turns on the dark class
  src/App.tsx         shell: nav, cell bar, board, detail drawer, pages
  src/Board.tsx       five columns, drag-to-advance, agent badges
  src/RequestDetail.tsx  edit fields, guarded transitions, kickoff streams, digest
  src/ClarifyChat.tsx    per-request chat, reattach on mount
  src/Thread.tsx      assistant-ui primitives, markdown, tool cards
  src/runtime.ts      useExternalStoreRuntime over React-owned messages
  src/Composer.tsx    custom input with slash-command autocomplete
  src/ConfigPage.tsx  scheduler + global process editor + cell policy entry points
  src/ProcessEditor.tsx structured per-segment controls
  src/CellModal.tsx   cell creation/edit flow with a process snapshot
  src/MasterDetail.tsx first-class master drawer: status, prompts, activity, chat
  src/TerminalPanel.tsx desktop-only maximizable xterm/PTY drawer
  src/ui.tsx          hand-rolled shadcn-style kit
deploy
  sandbox-harness.service  systemd user unit for the brain
  vps.md                   install, tunnel, update, and restart runbook
  ci-workflow.yml          ready GitHub Actions workflow (needs workflow scope)
```

## API

All JSON except the NDJSON streams. See `docs/02-status.md` for the route list and
what is not built yet.

## Tests

`npm test` runs 197 vitest cases: 135 server cases (state machine, migrations including
the index ordering fix on a legacy database, repositories, both stream parsers, engine
turns over a fake harness, worktree isolation against a real git repo, the MCP tool
surface, harness config/MCP/plugin mapping, model probing, the plugin manager against
real git clones, process definitions/store/follow-ups, per-cell policies/tickers/limits,
the generic master pipeline, error-log format/rotation, terminal PTY service, and the
HTTP API over a real socket) and 62 web cases (shared contract re-exports, NDJSON client,
chat folding, request-form mapping, board, create modal, composer, cell bar, cell
creation, config/process editor, master detail, and the app shell with the drawer and
chat mounted under jsdom).

`node scripts/mcp-smoke.mjs` is the stronger check: it boots the built brain, spawns
the built MCP server over stdio, and proves a tool call persists through the API into
SQLite.

`node scripts/claude-mock-smoke.mjs` verifies the real Claude Code binary against a local
mock Anthropic API: a streamed turn, an MCP tool round-trip, resumed session, and a
probed model catalog. It skips when no `claude` binary is available.

`npm run e2e` boots the built brain on a temp DB with a deterministic mock Claude CLI,
creates a dedicated `E2E` cell, and exercises clarify → dispatch → master prod/review →
follow-up creation → per-cell master chat → concurrency cap → finalize. It never indexes
into the KB; the suite asserts the KB stays empty. It uses no live data and cleans up the
temp directory.

`node scripts/ui-smoke.mjs` is an optional real-browser check. Install Puppeteer first
(`npm install --no-save puppeteer && npx puppeteer browsers install chrome`), point
`UI_BASE` at a running brain, then run it. It creates and drops a request, opens the
drawer/chat, visits the KB and Config pages, and fails on page errors. `UI_MOBILE=1`
runs the same flow at 390×844 with the off-canvas menu checks. It skips when Puppeteer
is absent.

CI (`deploy/ci-workflow.yml`) runs typecheck, the full test suite, the build, the E2E
API workflow, and the HTTP/MCP smoke scripts on pushes and pull requests. Copy it to
`.github/workflows/ci.yml` with a credential that has the `workflow` scope to activate
it.
