# Sandbox Harness

A local Node/TypeScript brain that drives headless Claude Code sessions through a
request workflow. One origin serves the API, an optional SPA, and the websocket, so a
single port is all a tunnel needs.

This repository is a rebuild from the system spec at commit `f849fed`. It targets the
same data model, state machine, HTTP surface, and wire contracts.

## Intended deployment and user flow

The intended setup is one always-on Linux VPS running the headless brain and agent
processes, with the SPA exposed only through a Tailscale tailnet. A phone or laptop joins
the tailnet, opens the SPA, and sends manual prompts while the VPS keeps working. The
brain binds loopback; Tailscale Serve is the audience gate. On the VPS,
`sudo tailscale serve --bg 7391` publishes the loopback port to the tailnet; only devices
on that tailnet can reach it.

```mermaid
flowchart TB
  subgraph Devices["Operator devices on the tailnet"]
    Phone["Phone<br/>manual prompts, queue + stop"]
    Laptop["Laptop<br/>board, drawers, terminal"]
  end

  subgraph Tailnet["Tailscale tailnet"]
    Serve["Tailscale Serve<br/>HTTPS on the tailnet"]
  end

  subgraph VPS["Always-on Linux VPS"]
    Unit["systemd user unit<br/>sandbox-harness + linger"]
    subgraph Brain["Brain process"]
      HTTP["Fastify<br/>SPA + REST + NDJSON + WebSocket"]
      Masters["Cell masters<br/>one ticker per cell"]
      Engine["Engine<br/>persistent agent sessions"]
    end
    DB[("SQLite<br/>requests, cells, KB, events")]
    Work["Git worktrees<br/>transcripts + sessions"]
    Agents["Headless claude / opencode<br/>child processes"]
  end

  Phone -->|Tailscale VPN| Serve
  Laptop -->|Tailscale VPN| Serve
  Serve -->|loopback 127.0.0.1:7391| HTTP
  Unit --> HTTP
  HTTP --> DB
  HTTP --> Masters
  Masters --> Engine
  Engine --> Agents
  Engine --> Work
```

Typical session flow:

```mermaid
sequenceDiagram
  autonumber
  actor User as Phone or laptop
  participant TS as Tailscale Serve
  participant API as Brain HTTP/WS
  participant Cron as Per-cell master
  participant Agent as Headless agent session
  participant Store as SQLite + disk

  User->>TS: Open the SPA over the tailnet
  TS->>API: Proxy to 127.0.0.1:7391
  API-->>User: Board, chat, and current state
  User->>API: Manual prompt, queue another, or Stop
  API->>Agent: Start or resume the request session
  Agent-->>API: NDJSON text and tool events
  API-->>User: Live stream
  Cron->>Store: Read cell policy and due work
  Cron->>Agent: Start, prod, or advance a process segment
  Agent-->>Cron: Final text with the ready marker
  Cron->>Store: Transition, event, and per-cell master note
  User->>API: Return after sleep or reload
  API-->>User: Rehydrate snapshot, reattach if a turn is live
```

The phone is a controller, not the worker. It can disconnect, reload, or queue a prompt;
the VPS keeps the session and the per-cell masters keep running. A request moves through:

```mermaid
flowchart LR
  Intake["Requests<br/>intake"] --> Plan["Plan"]
  Plan --> Implement["Implement"]
  Implement --> Review["Review"]
  Review --> Merge["Merge (optional, 1 worker)"]
  Merge --> Finalize["Finalize"]
  Review -.->|skip merge| Finalize
  Finalize --> Done["Done"]
  Review -.->|needs changes| Implement
  Plan -.->|needs rework| Intake
```

The deployment runbook is in [`deploy/vps.md`](deploy/vps.md); the operator workflow is
in [`docs/08-user-workflows.md`](docs/08-user-workflows.md).

## Screens

The board is the main loop: five process segments, cell filters, agent status, and
unchecked-work markers. The drawer is the selected cell’s master: ticker, cron loop,
prompts, activity, and chat.

These screenshots use a staged demo board in an isolated temp database, not live data.

![Sandbox Harness board with staged tasks across Requests, Plan, Implement, Review, and Finalize](docs/screenshots/board.png)

![Cell master drawer showing status, cron loop, activity, and chat](docs/screenshots/master.png)

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

The sidebar **Help** row renders the operator docs in-app from the same origin, including
the screenshots, with grouped navigation and `?help=<slug>` deep links. The brain reads
them from `SBOX_DOCS_DIR` (default `<cwd>/docs`), so ship the `docs/` directory beside the
build.

Agent turns are bounded by `SBOX_TURN_TIMEOUT_MS` (default ten minutes); a live but silent
child is killed and produces a visible error, and its recent stderr goes to the error log.
Harness MCP calls time out after `SBOX_MCP_TIMEOUT_MS` (default 15 seconds).

`SBOX_HARNESS=opencode` swaps the agent substrate; `SBOX_HARNESS_BIN` overrides the
binary. The default is `claude`. `SBOX_DEFAULT_MODEL` sets the brain fallback model; with
OpenCode it defaults to `opencode-go/deepseek-v4.1-flash`.

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
- `docs/11-skills.md` chat slash-command and skill discovery
- `docs/12-terminals.md` server-owned PTY sessions, reattach, and close
- `docs/13-cell-wizard.md` cell creation chat and policy setup
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
  cells/              CellRepository + in-memory cell wizard drafts; per-cell policy,
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
  docs/service.ts     explicit Help manifest, Markdown reads, screenshot assets
  process/            six segment definitions (incl. Merge), defaults, store, follow-up parser
  master/events.ts    master event log (start, prod, advance, followup, cycle, skip)
  master/service.ts   one master bucket: segments, follow-ups, advancement, cell chat
  master/scheduler.ts per-cell timers, per-cell manual run, coalesced cycles
  mcp/server.ts       stdio MCP server exposing harness tools, proxied to the API
  skills/catalog.ts   OpenCode/Claude skill discovery, global + project + request repo
  logging/errors.ts   structured error-only NDJSON log with size rotation
  terminal/service.ts server-owned PTY sessions with scrollback + attach/detach
  plugins/manager.ts  install, strip hooks/mcp, list, remove, slash-command discovery
src/web
  vite.config.ts      dev server, proxying /api and /ws to the brain
  src/main.tsx        mounts the app and turns on the dark class
  src/App.tsx         shell: nav, cell bar, board, detail drawer, pages, Help route
  src/HelpPanel.tsx   full-height docs overlay: nav rail, markdown, on-this-page
  src/docs.ts         help slugs, relative link/image rewriting, heading anchors
  src/Board.tsx       six columns, drag-to-advance, agent badges
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

`npm test` runs 247 vitest cases: 164 server cases (state machine, migrations including
the index ordering fix on a legacy database, repositories, both stream parsers, engine
turns over a fake harness, worktree isolation against a real git repo, the MCP tool
surface, harness config/MCP/plugin mapping, model probing, the plugin manager against
real git clones, process definitions/store/follow-ups, per-cell policies/tickers/limits,
the generic master pipeline, segment caps and merge, turn watchdogs/stderr, docs
manifest/traversal/HTTP, error-log format/rotation, skill discovery, terminal session
lifecycle, and the HTTP API
over a real socket) and 83 web cases (shared contract re-exports, NDJSON client, chat
folding, slash/skill resolution, request-form mapping, docs helpers and Help overlay,
board, create modal, composer, cell bar, cell creation, config/process editor, master
detail, and the app shell with the drawer and chat mounted under jsdom).

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
