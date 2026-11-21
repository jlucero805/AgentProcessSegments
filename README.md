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
```

## API

All JSON except the NDJSON streams. See `docs/02-status.md` for the route list and
what is not built yet.

## Tests

`npm test` runs 46 vitest cases: state machine, migrations (including the index
ordering fix on a legacy database), repositories, stream parser, engine turns over a
fake transport, worktree isolation against a real git repo, and the HTTP API over a
real socket.
