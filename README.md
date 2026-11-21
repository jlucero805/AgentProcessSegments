# Sandbox Harness

A local Node/TypeScript brain that drives headless Claude Code sessions through a
request workflow. One origin serves the API, an optional SPA, and the websocket, so a
single port is all a tunnel needs.

This repository is a rebuild from the system spec at commit `f849fed`. It targets the
same data model, state machine, HTTP surface, and wire contracts.

## Requirements

- Node 20 or newer
- `git` for per-request worktrees
- `claude` on `PATH` to run real agent turns. The core (database, workflows, HTTP,
  stream parsing) runs and is tested without it.

## Quick start

```bash
npm install
npm test
npm run build
SBOX_DB=$PWD/sandbox-harness.sqlite node src/server/dist/app.js
```

The brain binds `127.0.0.1:7391` unless `SBOX_HOST` / `SBOX_PORT` say otherwise. Do not
widen the bind. A tunnel is the audience gate, not the process.

`./scripts/smoke.sh` boots the built server on a throwaway database and exercises the
main routes over a real socket.

## Docs

- `docs/01-system-spec.md` the governing contract
- `docs/02-status.md` built versus not built, route list, deviations
- `docs/03-decisions.md` why this rebuild chose what it chose
- `deploy/vps.md` systemd unit and VPS runbook
- `AGENTS.md` handoff: environment traps, invariants, extension recipes, next units

## Layout

```
src/server/src
  app.ts              entry: open db, build repos + engine, listen
  config.ts           every path and port, env-overridable
  db.ts               schema, idempotent column migrations, boot reconcile
  domain/request.ts   states, transition table, entities, transcript types
  requests/           RequestRepository: CRUD, edit, guarded transitions
  cells/              CellRepository: delete detaches requests, never deletes them
  kb/                 KbRepository: one entry per request, literal LIKE search
  http/server.ts      Fastify routes, zod validation, NDJSON streaming, SPA vend
  clarify/engine.ts   one persistent session per request, buffered live turns
  clarify/stream.ts   pure stream-json parser (no process, no disk)
  clarify/transport.ts Claude CLI transport + scripted fake for tests
  clarify/prompts.ts  seed, dispatch, finalize, and KB briefs
  clarify/worktree.ts per-request git worktree on branch sbox/<id>
  clarify/models.ts   CLI probe with cached fallback list
  mcp/server.ts       stdio MCP server exposing harness tools, proxied to the API
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
  src/ui.tsx          hand-rolled shadcn-style kit
deploy
  sandbox-harness.service  systemd user unit for the brain
  vps.md                   install, tunnel, update, and restart runbook
```

## API

All JSON except the NDJSON streams. See `docs/02-status.md` for the route list and
what is not built yet.

## Tests

`npm test` runs 95 vitest cases: 61 server cases (state machine, migrations including
the index ordering fix on a legacy database, repositories, stream parser, engine turns
over a fake transport, worktree isolation against a real git repo, the MCP tool surface,
the plugin manager against real git clones, and the HTTP API over a real socket) and 34
web cases (domain mirror, NDJSON client, chat folding, board, create modal, composer,
cell bar, and the app shell with the drawer and chat mounted under jsdom).

`node scripts/mcp-smoke.mjs` is the stronger check: it boots the built brain, spawns
the built MCP server over stdio, and proves a tool call persists through the API into
SQLite.
