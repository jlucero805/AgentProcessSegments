# Rebuild decisions

Rationale for choices made while rebuilding from `docs/01-system-spec.md`. Each entry
records the context, the choice, and what it costs. The original design's D1 to D41 are
not reproduced; this file covers only decisions this rebuild made.

## D1. better-sqlite3 v11 instead of the v9 pin

**Context.** The spec pins v9 because v11 required Node 22 and a newer glibc on the
original build machine. This machine runs Node 22.7.

**Decision.** Use v11 and verify it before writing any source, by opening `:memory:`
and running a query.

**Cost.** If the brain is later deployed onto an older Node, the pin has to come back.
The data model and SQL are unchanged either way.

## D2. Fastify 5 with its current plugin majors

**Context.** The spec names `fastify`, `@fastify/static`, and `@fastify/websocket` but no
versions.

**Decision.** Fastify 5, static v8, websocket v11.

**Cost.** Route code is written against v5 types. A v4 deployment would need the error
handler and websocket registration revisited.

## D3. An `AgentTransport` seam instead of calling `spawn` from the engine

**Context.** No `claude` binary exists on this machine, so an engine that spawns
directly cannot be tested at all.

**Decision.** The engine takes an `AgentTransport`. Production uses
`ClaudeCliTransport`; tests use `FakeTransport`, which records spawn options and lets a
test emit stream-json lines and exits by hand.

**Cost.** One extra indirection. In exchange the turn lifecycle, idempotency, status
transitions, resume, and error paths are all covered without the CLI.

## D4. The stream parser is pure

**Context.** The wire contract is the highest-risk part of the system and the hardest to
observe when the CLI is missing.

**Decision.** `TurnParser` consumes one line, mutates only its own state, and returns
events. No process, no disk, no clock beyond `Date.now()` on transcript entries.

**Cost.** The engine has to route lines and persist transcripts itself. The parser is
now covered against fixtures for deltas, duplicate text, tool cards, capped output, and
errors.

## D5. HTTP tests use a real socket, not `app.inject()`

**Context.** On Node 22.7, `light-my-request` (behind `inject`) does `require()` on
ESM-only `cookie` v2 and throws. Node 22.12 added `require(esm)`.

**Decision.** Tests `listen({port: 0})` and use `fetch`.

**Cost.** Slightly slower tests, and one NDJSON test that has to parse a raw body. In
exchange the tests exercise the same path production does.

## D6. Buffered turns that drop on completion

**Context.** The SPA reattaches to `/clarify/stream` on mount, and the spec requires
replay without a post-completion replay.

**Decision.** `LiveTurn` buffers every event and broadcasts to subscribers. `attach()`
replays the buffer, then subscribes. The turn is deleted from the map when it finishes,
so `hasLive()` is false and `attach()` returns false afterwards.

**Cost.** A client that mounts after a turn ends gets nothing from the stream and must
read the snapshot. That is the documented behavior, not an accident.

## D7. Worktrees per request, scratch fallback, branch kept on removal

**Context.** Two requests must never write the same tree, but a request without a target
repo still needs a cwd.

**Decision.** `ensureWorktree` returns an isolated checkout on `sbox/<id>` when it can,
and the scratch workdir when there is no repo or git fails. `removeWorktree` removes the
checkout and keeps the branch.

**Cost.** The branch and its commits outlive the request by design. Cleanup is manual.

## D8. The user turn is pushed into the parser's transcript

**Context.** Found while writing tests. The parser is seeded from disk before the turn's
user message is appended, so the final saved transcript dropped the human's message.

**Decision.** After appending the user message to disk, the engine also pushes it onto
the parser's in-memory transcript.

**Cost.** Two writes of the same fact. The test asserts both text messages survive, so a
regression shows up.

## D9. Plugin sources accept a local path

**Context.** The spec allows only `http(s)`, `git`, and `ssh`. Tests need a real clone,
and local plugin development is the common case.

**Decision.** Also accept an existing local directory. The source is always one argv
element to `git clone`, a leading dash is refused so it cannot be read as an option, and
newlines are refused. Installed names must match a slug pattern.

**Cost.** A local path can name any directory the user can read. It still cannot escape
the plugin root on install, because `subdir` is resolved and checked against the clone.

## D10. `index_to_kb` stores, it does not finish

**Context.** The spec lists `index_to_kb` as a request tool but also makes finalize a
human action through `POST /index`.

**Decision.** The tool resolves the request title and writes a KB entry. It never
transitions state.

**Cost.** The agent cannot finish its own request. That is the conservative reading of
the workflow, where "Index and finalize" belongs to the human.

## D11. User MCP servers are not merged into the generated config yet

**Context.** The spec says request sessions get the user's MCP servers and also passes
`--strict-mcp-config` with a generated file containing only `harness`. Those two claims
conflict, and the exact CLI contract for reading a user's server definitions cannot be
verified without the CLI installed.

**Decision.** Ship the allowlist side only (`parseMcpListServers` is implemented and
unused) and leave the merge for when a real binary is available.

**Cost.** A request session cannot call the user's own MCP tools. Documented in
`docs/02-status.md`. This is the next unit.

## D12. Infrastructure names generalized before publishing

**Context.** The repo is public, and the spec names internal agent builds, auth
providers, a tunnel domain, and a pipeline product.

**Decision.** Commit a scrubbed spec. Replace those with neutral descriptions and keep
every technical contract intact.

**Cost.** The public spec no longer says exactly which internal build the author used.
Anyone with the original can diff.

## D13. Shutdown force-closes connections

**Context.** Found by the stdio smoke script: after the MCP client closed, the brain
stayed alive on SIGTERM because a keep-alive socket pinned `app.close()`. The same would
happen to Ctrl-C with an open SPA websocket.

**Decision.** On shutdown, start `app.close()`, call `server.closeAllConnections()`, and
arm a three-second unref'd timer that exits regardless. The smoke script now asserts the
process exits on SIGTERM.

**Cost.** An in-flight NDJSON turn is cut at shutdown rather than drained. Shutdown is
already the end of service, and the transcript on disk is what survives.
