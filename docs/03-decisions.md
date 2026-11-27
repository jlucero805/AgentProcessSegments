# Rebuild decisions

Rationale for choices made while rebuilding from `docs/01-system-spec.md`. Each entry
records the context, the choice, and what it costs. The original design's D1 to D41 are
not reproduced; this file covers only decisions this rebuild made.

## D1. better-sqlite3 v11 instead of the v9 pin (superseded by v13)

**Context.** The spec pins v9 because v11 required Node 22 and a newer glibc on the
original build machine. This machine runs Node 22.7.

**Decision.** Use v11 and verify it before writing any source, by opening `:memory:`
and running a query.

**Cost.** If the brain is later deployed onto an older Node, the pin has to come back.
The data model and SQL are unchanged either way.

**Superseded (v13).** v11 has no Node 24 prebuild and `prebuild-install` is deprecated, so
every install on a current host downloaded nothing and compiled through `node-gyp`; on a
Python 3.14 host that only works with node-gyp 11.5 or newer. v13 is the N-API line: it
publishes prebuilds for the supported platforms inside the npm tarball and needs no
install script. The cost is a Node 22 floor (`engines.node: ">=22"`, matching this repo's
22.13 requirement), SQLite 3.54, and one wrinkle: `npm ci` still runs npm's implicit
`node-gyp rebuild` for it because the lock-derived manifest lacks `gypfile: false`, so the
Linux build toolchain stays a prerequisite and `npm run check:native` checks it.

## D2. Fastify 5 with its current plugin majors

**Context.** The spec names `fastify`, `@fastify/static`, and `@fastify/websocket` but no
versions.

**Decision.** Fastify 5, static v10, websocket v11.

**Cost.** Route code is written against v5 types. A v4 deployment would need the error
handler and websocket registration revisited. Static v10 is the first major that clears
the path-traversal and route-guard advisories; the `root` plus `sendFile` usage here is
unchanged.

## D3. An `AgentHarness` seam instead of calling `spawn` from the engine

**Context.** No `claude` binary existed on the rebuild machine, and the operator wants
the agent substrate swappable, so an engine that spawns one CLI directly is both
untestable and closed.

**Decision.** The engine takes an `AgentHarness`: prepare a session config, spawn a
process, create its parser, and probe its models. Production registers `claude`
(default) and `opencode`; tests use `FakeHarness`, which records session prep and lets a
test emit lines and exits by hand.

**Cost.** One indirection and a harness-specific parser. In exchange the turn lifecycle,
idempotency, status transitions, resume, and error paths are covered without a real CLI,
and a new substrate is a single adapter.

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

**Decision.** `ensureWorktree` returns an isolated checkout on `aps/<id>` when it can,
and the scratch workdir when there is no repo or git fails. When only a legacy
`sbox/<id>` branch exists, it reuses that branch unchanged instead of creating the new
prefix, and an existing checkout reports the branch it is actually on. `removeWorktree`
removes the checkout and keeps the branch.

**Cost.** The branch and its commits outlive the request by design. Legacy
`sbox/<id>` branches may coexist with new `aps/<id>` branches until the request becomes
terminal. A terminal transition then retires the legacy ref after `dispose` removes the
worktree, and a startup/hourly sweep catches older terminal rows; `npm run
migrate:branches` remains the dry-run/manual recovery command. Both paths rename a lone
legacy ref, delete it only when it is already contained in `aps/<id>`, and rewrite the
terminal request's stored branch without touching `updated_at` (which would reorder
history and reset the master's idle clock). Non-terminal requests, checked-out branches,
and diverged pairs are always skipped. Orphan `sbox/*` refs are reported but kept by
default; `--prune-orphans` archives their tips under `refs/sbox-pruned/` and then deletes
the branch, and a ref whose id still has any request row is never treated as an orphan.
A human resolves a diverged pair because committing to either disposition could
lose work.

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

## D11. User MCP servers are merged into the generated session config

**Context.** The spec says request sessions get the user's MCP servers, but the engine
passes `--strict-mcp-config` with a generated file. The merge was deferred until the CLI
contract could be read.

**Decision.** Merge definitions into every request session, never the read-only KB
session. Claude reads user and local scopes from `~/.claude.json` plus project
`<cwd>/.mcp.json`, adds them to `mcp-config.json`, and allows each server with
`mcp__<server>__*` (the CLI's wildcard rule). Scope precedence is local > project >
user, as the CLI documents it: the highest-precedence entry replaces the others whole,
and the reserved-key warning names the winning file and scope (`user`, `project`, or
`local`). OpenCode reads both `opencode.json` and `opencode.jsonc` from the global config
directory as JSONC (comments, trailing commas, and a leading BOM are accepted) and merges
their `mcp` entries into the generated `OPENCODE_CONFIG_DIR/opencode.json`; `--auto`
makes them callable. Project and ancestor config files are disabled with
`OPENCODE_CONFIG_PROJECT_DISABLE=1`, so a checked-in `opencode.json(c)` or `.opencode`
file cannot replace the reserved `aps` server or add servers, plugins, skills, agents, or
permissions. A project config found at the session cwd or an ancestor is named once on
stderr by path only when it is ignored. JSON5 syntax is not accepted, and the generated
file stays strict JSON.

**Cost.** Claude's definition files are private storage, not a documented API, so a CLI
change can break the read. The wildcard rules are verified from the CLI's own strings
but not yet from a live Claude turn; OpenCode's path is verified end to end.

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

## D14. The SPA uses assistant-ui 0.15.38 with React 18

**Context.** The spec names React 18 and `useExternalStoreRuntime`. An earlier pass
pinned the 0.10 line while 0.15 was new. The 0.10 line also pulled a vulnerable
`nanoid` range; 0.15.38 resolves `nanoid` 6.

**Decision.** Use `@assistant-ui/react` 0.15.38 with React 18. The external-store
runtime and primitives used by `runtime.ts` and `Thread.tsx` still compile and the web
suite passes, and 0.15 ships zod 4. Keep Tailwind v3 with PostCSS and autoprefixer;
Vite 8 and Vitest 5 run in the web workspace while the server keeps Vitest 2.

**Cost.** Two Vitest majors live in the repo. React 19 remains deferred.

## D15. A systemd user unit on the VPS

**Context.** The spec ran the brain as a background process with manual restarts. The
operator wants it on a VPS as a systemd service, on a host that already uses
herdr-core for interactive terminals.

**Decision.** Ship a systemd user unit (`deploy/agent-process-segments.service`) and a runbook
(`deploy/vps.md`), with `loginctl enable-linger` for boot. A user unit keeps the
`claude` login, git config, and ssh keys of the account that owns the clone, and keeps
the brain in its own cgroup instead of inside a herdr pane. The system-wide variant is
documented for multi-user hosts.

**Cost.** A fresh machine needs the linger step and a reachable user manager; a host
without systemd (a plain container) runs the foreground command instead. The unit binds
loopback only, so remote access still needs the tunnel.

## D16. The OpenCode adapter is one-shot per turn

**Context.** `claude -p` accepts a stream-json conversation on stdin, but
`opencode run` takes one message per invocation.

**Decision.** Spawn `opencode run --format json --auto --standalone --archived` per turn.
Parse `text`, `tool_use`, `step_finish`, and `error`; capture the `ses_…` id and pass
`--session` next turn. `--standalone` gives each turn a private server.
`OPENCODE_CONFIG_DIR` points at the generated per-request config, and the child sets
`OPENCODE_CONFIG_PROJECT_DISABLE=1`, so OpenCode does not load project or ancestor
`opencode.json(c)`/`.opencode` config above it; user settings come from the global config
directory the harness merges. The child environment strips `OPENCODE_CONFIG` and
`OPENCODE_CONFIG_CONTENT` before spawn: OpenCode layers both above that generated config,
where an inline value could replace the bundled `aps` server or a read-only deny rule. A
non-empty variable is named once on stderr and ignored, without its value. A project or
ancestor config found at the session cwd is also named once on stderr by path only.
`PWD` is pinned to the session cwd because OpenCode resolves the project root from it.
`--archived` keeps brain sessions out of the user's session list, and resume still works.
KB sessions get explicit deny permissions instead of a tool allowlist.

**Cost.** A server start per turn (roughly a second) and no long-lived child. Session
continuity still survives a brain restart because the session id lives in `session.json`
and on OpenCode's disk.

## D17. Plugin assets are mapped into OpenCode's config

**Context.** Plugins install Claude-style `commands/**/*.md` and `skills/*/SKILL.md`.
Claude consumes them with `--plugin-dir`; OpenCode has no equivalent flag but does have
`commands` templates and `skills` paths in its config.

**Decision.** On request sessions, read installed plugin dirs and add each command body
as an OpenCode `commands` template (plugin-prefixed name) and each skill folder to
`skills`. Skills also get a thin command template so the SPA slash menu works. KB
sessions exclude plugins.

**Cost.** Plugin content is copied into the generated config on every session (small, and
it keeps a request reproducible), and a malformed command markdown is skipped rather than
reported. Command keys keep `plugin:name`, matching `/api/commands`.

## D18. The model endpoint reports harness capabilities

**Context.** Effort is a Claude CLI flag; OpenCode has no equivalent, and the SPA was
offering a control that did nothing.

**Decision.** Add `harness` and `supportsEffort` to `/api/models` (additive), show the
harness in the drawer, and render Effort as inert with a hint when unsupported.

**Cost.** Two additive fields beyond the spec DTO; clients that ignore them are
unchanged.

## D19. KB search ranks literal term matches

**Context.** The KB has no embeddings; search was one LIKE, ordered by recency, so a
query with several words required the exact phrase.

**Decision.** Split the query on whitespace and require every term with escaped `LIKE`
(`%` and `_` stay literal). Rank the matches locally: a phrase hit in the title scores
6, a title term hit 3, body hits 1, and recency breaks ties. Candidate rows are capped
at 1000.

**Cost.** No semantic recall, and a space-separated query is now AND of terms rather
than one phrase. No new dependency or index.

## D20. Mobile shell, URL route state, and live-turn snapshots

**Context.** The SPA is mobile-first, a reload used to lose the open request, and a live
turn had to be reattached without a second turn.

**Decision.** Below `md`, the sidebar is off-canvas behind a hamburger and the board is a
horizontal snap scroller. The page, cell, and open request live in the query string and
are written with `replaceState`. `GET /clarify` returns `active` beside the transcript;
the chat always hydrates the snapshot, attaches when active, shows a working indicator,
and streams text. The first `send` marks a request started.

**Cost.** Query-string state is per tab and does not create back-button history; the
drawer is not deep-linked across tools. The `active` field and `send` behavior are
additive.

## D21. App settings live in XDG, not the repository

**Context.** The master cadence, thresholds, and prompt must be operator-editable, while
`config.ts` is environment-driven and owns paths, ports, and the harness.

**Decision.** Store app settings in
`$XDG_CONFIG_HOME/agent-process-segments/config.json` (override `APS_CONFIG`). Validate with a
zod schema, strip unknown keys, write atomically, fall back to defaults with a warning
for invalid files, and expose `GET/PATCH /api/config` plus a Config page. The file is
created on the first save. On load, each present block is merged field-wise over its
defaults, so an older or partial block keeps its saved fields and gains new defaults;
only invalid values trigger the full-default fallback.

**Cost.** A second configuration surface. Invalid files silently use defaults until an
operator saves a valid patch; the path is shown on the page so it is discoverable.

## D22. Cell masters are a deterministic, marker-based scheduler

**Context.** The operator wants each cell reviewed on a cadence, with stalled
implementation sessions prodded to record decisions and keep moving, and completed work
moved to Review.

**Decision.** A server-side scheduler runs a master cycle (default every 5 minutes).
Each enabled cell's selected queue is filtered to idle requests older than the idle
threshold and not prodded within the interval. Requests without a cell have no master.
The
prod is an ordinary `engine.send` turn using the configured prompt. If the reply contains
`READY FOR REVIEW` and auto-review is on, the request moves `dispatch → review`. Every
prod/review/cycle/skip is stored in `master_events`; status, history, and a manual run are
exposed, and the Config page owns the policy and per-cell switches.

**Cost.** Turns run inside the cell’s concurrency budget, so a hung turn can still hold
one slot until it finishes. D27 later made cadence and policy per cell, D41 made the
selected batch concurrent, and D42 removed unassigned work from the master entirely. The
review move relies on the marker rather than an LLM judgment. Prods are ordinary agent
turns, so they cost tokens.

## D23. Chat queue is client-side; stop keeps the session

**Context.** A turn can take minutes. The operator wants to compose while it runs, cut it
short deliberately, and interject without losing the conversation.

**Decision.** Queue messages in the SPA per request under `aps-queue:<requestId>` and
drain them in order when the turn ends. A queue written before the rename under
`sbox-queue:<requestId>` is adopted once on load, copied to the new key, then deleted; the
new key is authoritative whenever it exists (even when malformed), so a drained or
stopped queue cannot resurrect from the legacy key. `POST /clarify/stop` marks the turn
cancelled, kills the child (SIGTERM then SIGKILL), lets `finishTurn` save the partial
transcript, and leaves `session.json` alone so the next message resumes. Stop clears the
queue; the client shows "Stopped. You can interject."

A queue restored from storage is held until `GET /clarify` reports whether a turn is
live. If one is, the queue waits for that turn's `done` and then drains; if the snapshot
fails, the queue stays queued and persisted until a later snapshot succeeds. A send that
races a turn already running is refused by `POST /clarify/send` with
`409 turn_active`; the client puts the text back at the front of the queue, reattaches,
and retries after `done` instead of dropping it.

Two tabs can see the same queue, so a drain claims an item before sending it: the client
removes the first entry from `aps-queue:<id>` inside an exclusive Web Lock named
`aps-queue-lock:<id>`, and only the tab that claimed it sends. Appends, front requeues,
and clears take the same lock, and every tab mirrors the queue through `storage` events.
The guarantee needs Web Locks, which browsers expose only in a secure context (localhost
or HTTPS); without it the queue still drains inside one tab but two tabs can deliver the
same item twice. Storage failures are not fatal: the tab keeps its in-memory queue and
keeps draining it.

A claim is journaled so a tab crash does not lose the message. Every outbound message is
journaled under `aps-queue-inflight:<id>` before its POST starts. A queue drain writes
`{id, text, claimedAt, kind: "queue"}` before removing the head from `aps-queue:<id>`,
inside the same lock. A direct composer send writes
`{id, text, claimedAt, kind: "direct"}` without touching the queue and without waiting
for a snapshot. Records written before the discriminator existed are read as queue
claims. The marker is cleared when the send is proven accepted (the first NDJSON event
or a completed stream), when `409 turn_active` puts the text back at the front, when
another definitive 4xx rejects it, and when Stop, Clear, or a spend-cap pause empties the
queue; a transport error or 5xx before acceptance keeps it for retry. On mount the client
reconciles leftovers against `GET /clarify`: a persisted `you` text entry with the same
text and `ts >= claimedAt` proves delivery, otherwise the text is prepended in claim
order and drained normally. Queue claims settle first, then direct claims are prepended
ahead of them. When the snapshot reports a live turn, proven claims are dropped at once
and the rest wait for `done`; draining stays paused until reconciliation finishes. A
marker whose text is still at the queue head never completed its removal, so it is
dropped instead of queued twice. Claims for a send this tab is still POSTing are skipped,
so a stray `done` or a hydrate racing an early send cannot requeue a live message.
Reconciliation is best-effort: a tab that mounts in the brief window between another
tab's marker write and its POST can requeue the same text, and the `ts` comparison
assumes the browser and server clocks are close. When delivery cannot be proven the
client prefers a duplicate over losing the message. Markers use the same in-memory
fallback as the queue, so a browser that cannot write localStorage has no crash
recovery.

**Cost.** The queue is per browser — shared by its tabs, but not visible to other clients
or the server. A stop
is best-effort: the process can take a moment to die, and the transcript is whatever the
parser had flushed. Migration is best-effort too: a tab still running the old bundle can
recreate the legacy key after migration, and that queue is adopted again only when the
new key is absent.

## D24. One thread across segments; a scoped master chat

**Context.** The drawer only chatted during clarify, while the operator wants one thread
to interject at any workflow step and also wants to talk to the cell master.

**Decision.** Render the same `ClarifyChat` for every non-terminal state; terminal states
show a read-only transcript. Add a session `scope` (`request`, `kb`, `master`) to the
harness contract and pass it to the MCP server as `APS_SESSION_SCOPE`. The master is a
reserved `__master__` session with `MASTER_TOOLS` (board and KB reads only). The
scheduler appends prod/review/cycle/skip notes to that transcript without a model turn,
and the Config page embeds the chat under the activity log.

**Cost.** The master chat is advisory: it cannot prod, transition, or write config. Notes
are agent-role transcript rows and can interleave with a live master reply. The scope
env is one more wire detail in both harness adapters.

## D25. The SPA imports the pure server contract

**Context.** The web duplicated the workflow table, request/master/plugin shapes, and
event types; the state-machine test called itself a mirror of the server table.

**Decision.** Move master/plugin shapes into pure server modules and have
`src/web/src/types.ts` type-import those modules plus `domain/request` and
`clarify/models`. Keep the server modules free of Node imports so Vite can bundle them.
`settings.ts` checks its zod schema against the shared `MasterConfig`.

**Cost.** The SPA build now includes a few server source files, and the server modules
are constrained to stay pure. A shared workspace package is the cleaner packaging if a
third consumer appears.

## D26. Detached workflow kicks

**Context.** Dragging a board card to Plan/Implement/Finalize awaited the NDJSON turn
before refreshing the board, so a long turn froze the interaction.

**Decision.** `POST /clarify/start`, `/dispatch`, and `/finalize` accept `?detach=1`:
they create the turn and return `{started:true}` immediately. The board uses that path
and the chat reattaches through `GET /clarify` plus `/clarify/stream`.

**Cost.** A detached kick does not surface agent text in the workflow card; the unified
thread is the place to watch it. Callers that want the stream keep the default route.

## D27. Process segments are persisted data

**Context.** The master only knew how to prod stalled implementation work. Operators
want to configure every segment and expand the cron loop to start planning, implement,
review, create follow-ups, and advance on rules.

**Decision.** Store six ordered segments in
`$XDG_CONFIG_HOME/agent-process-segments/process.json` (`APS_PROCESS` overrides) as the global
default. A cell can store a full copy of the same shape in `cells.process_json`; its
master uses that policy, while cells without one inherit the global default. Each cell
also has `master_interval_minutes` (null inherits the global cadence), its own timer, and
its own reserved chat session (`__master__:<cellId>`). Each segment has a label, purpose,
enabled flag, idle threshold, per-cycle cap, prompt, exact ready marker, legal target
state, and follow-up marker. The master evaluates enabled schedulable segments by
pipeline position from right to left (`merge` first, `intake` last), not in stored array
order, so finishing work is not starved by a backlog of planning. Finalize is manual-only
and never scheduled, whatever its stored `enabled` flag says. `intake` uses
`engine.start`; other segments use `engine.send` with the configured prompt. A marker
advances only through a legal transition. `intake` and `finalize` cannot auto-advance.
Follow-up lines create requests in the same cell and are deduplicated per source request
in `master_events`.

**Cost.** A missing global file falls back to a policy derived from the legacy master
fields. Cell policies are snapshots, so changing the global template does not rewrite
existing cells. Each enabled cell has its own timer and cycle; a cell has at most one
dispatch cycle in flight, and a tick during an active cycle is skipped and retried on
the next cadence. Background turns from a completed dispatch may still be running.
Prompts cost tokens when segments are enabled.

## D28. The cell master has its own detail

**Context.** The master was a section inside Config. The operator wants to watch what
the cron is doing, see the prompt it uses, and chat with it as a first-class object.

**Decision.** Add a `Cell master` button above `+ New request`. It opens a dedicated
drawer with status, the cell’s own ticker/last/next run, the enabled segment loop and
prompts, filtered activity, and the cell’s `__master__:<cellId>` chat. The control is
only available when a cell is selected; `?master=1` restores the drawer only with a
`cell` query. Config remains the editor; the drawer is the observability surface.

**Cost.** The drawer polls status and events every 10 seconds while open. Each cell’s
chat is separate; there is no global chat for unassigned work. The chat remains
read-only/advisory. D42 later removed the no-cell view.

## D29. The desktop terminal is a direct PTY

**Context.** The operator does not want to switch apps for occasional shell work. The
browser terminal must not share state, cwd, or the process with a harness agent session.

**Decision.** Add a desktop-only **Terminal** action. A server-owned `node-pty` session
runs in `APS_TERMINAL_CWD` (default: the brain’s cwd), with xterm.js in the SPA. Hiding
the panel or closing the WebSocket **detaches**; the shell and up to 200 KB of scrollback
remain and are reattached on reopen. The session strip lists every shell with a status
dot and an explicit close that kills it. Up to four sessions exist at once.
`APS_TERMINAL=0` disables creation and `APS_TERMINAL_CWD` moves the start directory.

**Cost.** A direct shell is more powerful than the agent tools. The route has no auth of
its own, so the brain must stay loopback-only or behind an authenticated tunnel. The UI
hides the action below `md`, but the session API remains reachable.

## D30. Per-cell concurrency and model defaults

**Context.** Prodding every stalled request in a cell can start too many agent processes
and exhaust memory. Operators also want a cell-level model/difficulty policy rather than
setting it on every request.

**Decision.** Cells store `max_concurrent` (default 3), `model`, and `effort`. The master
counts requests in `working` state for the cell and stops starting new turns once the cap
is reached; it records a `skip`/cycle event and a master-chat note. The engine resolves a
turn’s model/effort from the request first, then the cell defaults. A per-cell master
chat also inherits the cell defaults.

**Cost.** Concurrency is per cell; unassigned requests have no master and consume no
master slot. Changing a cell model affects the next spawned turn, not a child that is
already running. Usage tracking records the resolved model on each completed turn; see
`docs/09-backlog.md` for retention, budget, and pricing-maintenance follow-ups.

## D31. Persist only errors, through one sink

**Context.** Debugging needs durable failure context, but retaining every log/transcript
wastes space and can capture sensitive content.

**Decision.** Add an error-only `ErrorLogger` that appends one JSON record per explicit
failure to `$XDG_STATE_HOME/agent-process-segments/errors.log` (`APS_ERROR_LOG`,
`APS_ERROR_LOG_MAX_BYTES`), size-rotated to `.1`. Inject it as `ErrorSink` into startup,
stores, engine, master service/scheduler, HTTP 5xx handling, and terminal open. Expected
4xx responses, normal lifecycle logs, prompts, transcripts, bodies, and tokens are not
written. The logger swallows its own failures so logging can never break a request.

**Cost.** Only one rotated backup and a small context schema. Debugging relies on stable
`source` names (`engine.turn`, `master.cycle`, etc.); adding a new persistent log line
requires an explicit error path and the documented context rules.

## D32. Slash skills are discovered and invoked as prompt text

**Context.** The chat slash menu only listed installed plugin commands. Operators expect
`/` to show available agent skills (for example `poteto-mode`), not just plugin commands.

**Decision.** Add `SkillCatalog`, which scans the standard OpenCode/Claude compatibility
directories plus project ancestors, and per-request target repos/worktrees via
`GET /api/skills?requestId=…`. The SPA merges skills into `/api/commands` with a `skill`
badge. Sending a skill label translates to `Use the <name> skill now and follow its
instructions.` because skills are model-invoked, not CLI commands; plugin commands remain
raw slash commands.

**Cost.** Discovery is a directory walk on each fetch; no cache yet. A skill that is only
visible inside a request’s target repo appears in that request’s chat, not the global KB
or master chat menu.

## D33. Optional Merge segment and per-segment concurrency

**Context.** Cells sometimes need a step after Review that cannot safely run in parallel:
a single merger rebases, tests, and pushes one request at a time to avoid conflicts. The
cell creation wizard also needs a way to build that policy conversationally.

**Decision.** Add a built-in `merge` state and optional segment between Review and
Finalize, plus `maxConcurrent` on every segment. The master enforces the cell cap first,
then a segment cap for working requests in that state. Merge defaults to
`maxConcurrent: 1`, `maxPerCycle: 10`, `READY TO FINALIZE`, and advances to Finalize.
The wizard keeps a server-side draft per modal. Its `__setup__:<draftId>` chat gets
draft read/update plus `Read`, so the agent can edit segments, prompts, markers, and
limits without touring the board/KB; the form refreshes on turn completion and the draft
is discarded on close.

**Cost.** Existing five-segment process files are upgraded by inserting a disabled Merge
segment, and missing `maxConcurrent` fields default to null. The board now has a Merge
column even when no cell enables it; it is empty by default. Segment limits are additive
to the cell cap, not a replacement.

## D34. Help docs are a manifest over the repo

**Context.** The SPA ships beside `docs/`, but a phone on the tailnet had to open GitHub to
read a guide. Hand-copying the Markdown into the bundle would drift immediately.

**Decision.** Serve the repo files through an explicit manifest in
`src/server/src/docs/manifest.ts`, read by `src/server/src/docs/service.ts`. The
`GET /api/docs` route returns the ordered manifest, `GET /api/docs/:slug` reads one entry,
and `GET /api/docs/assets/*` serves only `docs/screenshots/**`. Slugs never become
filesystem paths; unknown or traversal-shaped slugs are 404s. The SPA renders Markdown
with the existing `react-markdown` dependency and rewrites in-repo links to `?help=<slug>`
deep links.

**Cost.** Adding a page takes a manifest line and a restart. The overlay reads files at
request time, so a missing `docs/` directory yields an empty manifest and a graceful
unavailable state. `APS_DOCS_DIR` must point at the clone's docs on deploy.

## D35. Turn and tool waits are bounded

**Context.** A harness child can stay alive while producing no stdout, and a setup turn
can call the brain through MCP with no deadline. Both look like an eternal “Agent is
working…” in the wizard, and neither writes an error because nothing has failed yet.

**Decision.** Apply three bounded waits. The engine arms a per-turn watchdog
(`APS_TURN_TIMEOUT_MS`, default ten minutes) that emits an error, kills the child, writes
`engine.timeout`, and finishes with `done` even if the harness is still inside
`prepare()`. The MCP client races every brain call against `APS_MCP_TIMEOUT_MS`
(default 15 seconds) and returns an `isError` tool result. The cell wizard gives draft
sync five seconds and renders an inline error with Retry instead of an indefinite
spinner; chat transport errors also get an inline retry.

**Cost.** A genuinely slow turn must raise the timeout; the default is intentionally
long. Captured stderr is capped to the last 20 lines and included in the exit/timeout
error and its log context. A timed-out turn is marked cancelled so the stream does not
receive the same error twice.

## D36. Setup chat must not interview through an interactive tool

**Context.** The first setup seed read like a task list: “Ask about the repository, risk
posture, review/merge policy, concurrency, and follow-ups.” On OpenCode the model obeyed
by calling the interactive `question` tool and then touring the board/KB. `opencode run`
is non-interactive; the question has no client, so the turn stalls or spends minutes
gathering context while the operator sees no reply.

**Decision.** Two changes. The seed now says the chat is non-interactive, answers simple
messages directly, asks at most one or two plain-text questions only when the answer
changes the configuration, and uses draft tools only when it needs the draft. The OpenCode
adapter denies `question` in every brain session, including request sessions, so the
non-interactive tool cannot be selected regardless of the harness prompt.

**Cost.** The setup assistant will sometimes make a reasonable assumption instead of
asking a follow-up, and the operator may need to correct it. That is preferable to a
chat that appears dead. An interactive question UI would need a separate client protocol
and is not part of this harness.

## D37. NDJSON POST bodies are JSON at the transport layer

**Context.** Streaming chat actions use `streamNdjson` rather than the ordinary JSON
request helper. It forwarded `body` without a `content-type` header. Browsers send a
string body as `text/plain`; Fastify parsed it as a string and rejected every chat send
with `Expected object, received string`. The setup chat therefore never got a message
into the engine, and the retry button replayed exactly the same invalid request.

**Decision.** `streamNdjson` adds `content-type: application/json` whenever a body is
present, unless the caller already set a content type. The API test asserts the header.

**Cost.** None; it matches the ordinary JSON client. Chat and control streams now share
the same validation path instead of hiding a browser-only content-type mismatch.

## D38. Give the setup model the flow contract, not a puzzle

**Context.** A setup request burned ten minutes replaying invalid `intake.advanceTo`
guesses. The validator correctly rejected `plan` and `clarify`, but the model had no
compact statement of the special cases, so it probed different targets. The intake prompt
was also silently ignored by the master, which made a simple “repo identity” request
look unsolvable.

**Decision.** Export a short `SEGMENT_FLOW_GUIDE` and include it in the setup seed prompt
and in the `update_cell_draft` tool description. If the draft update is rejected, the MCP
tool returns the same guide alongside the validation error. Setup sessions now expose only
`get_cell_draft` and `update_cell_draft` (plus `Read`) and no board/KB tools. A new
`segmentUpdates` patch lets the model send only the segments it changes; the server merges
and validates the full process. An enabled intake segment passes its prompt into the first
clarification turn.

**Cost.** The setup prompt is longer, and intake prompts now affect the first turn instead
of being ignored. That is the intended behavior: operators can put repo identity and
standing autonomy instructions there. The safe flow guide omits rarely used state-machine
edges such as Review→Clarify; those remain valid for hand editing but are not advertised
to the setup model.

## D39. Setup is direct, incremental, and uses the fast default model

**Context.** OpenCode fell back to its slow free default, and every harness call went
through the opaque Code Mode `execute` tool. A simple setup turn could take minutes with
no visible intermediate work.

**Decision.** Add a brain-level `APS_DEFAULT_MODEL`; when the harness is OpenCode it
defaults to `opencode-go/deepseek-v4.1-flash`. Requests and cells still override it, and
`GET /api/models` exposes the default so the wizard can show it. Set `codemode: false` on
the bundled `aps` MCP server so tools are called directly and appear as tool cards. The setup
prompt asks for one segment per update, and the chat refreshes the structured form after
every successful `update_cell_draft` tool result. The running bar shows elapsed seconds
and the last tool.

**Cost.** Setup may make several small model/tool round trips instead of one large update,
but each is visible and the form changes as it goes. A missing default model id must be
overridden with `APS_DEFAULT_MODEL` or an empty string on other providers.

## D40. Bounded master selection instead of whole-board cycles

**Context.** A cycle enumerated every request in every enabled segment, then skipped most
of them. A real run logged `28 queued, 27 skipped` for one turn, and the same material was
posted into the cell-master chat, growing its context without adding useful decisions.

**Decision.** Select candidates before running turns. A cell uses its spare concurrency
(`maxConcurrent` minus working requests) as the cycle budget, fills it from the latest
segment backwards, and takes the oldest request by `created_at` inside each segment. Only
the selected requests are prodded and noted. `dispatch` now means “selected this cycle”,
and the UI labels it that way. Per-segment `maxPerCycle` and `maxConcurrent` still apply
while selecting.

**Cost.** A tick no longer drains the whole board; work beyond the budget waits for the
next tick. A cell with many ineligible oldest requests may still scan past them to fill
its budget, but nothing beyond the budget is run or posted. The deterministic scheduler
remains the promotion owner; no MCP promotion tool was added, because the master chat is
advisory and does not call tools to prod.

## D41. Cell master prods the selected batch concurrently

**Context.** The master selected up to the cell’s spare concurrency but then awaited each
turn sequentially. A slow turn delayed every other selected request in the same cycle,
even though the cell had capacity for them.

**Decision.** `runBucket` starts all selected candidates with `Promise.all`, records the
prod immediately, and returns without waiting for the turns. Completion handling —
transcript read, follow-ups, and marker advancement — runs in a background promise per
candidate and mutates the cycle’s result/event history as it finishes. Selection already
bounds the batch by the cell’s spare concurrency and each segment’s
`maxPerCycle`/`maxConcurrent`; segment selection counts candidates already chosen for the
batch, so a merge segment capped at one worker contributes only one request. Different
cells remain independent scheduler keys; manual runs are per cell.

**Cost.** The scheduler’s “running” flag now means “dispatching”, not “waiting for agents”.
Several model turns can be live at once, using more provider throughput and tokens; the
next tick refills only the capacity reported by `countWorking`. Background completion
failures are logged and recorded as skip events, but the original cycle response has
already returned. A segment cap of one still serializes merge work as intended.

## D42. Scorecards use a dedicated read-only session and derived facts

**Context.** Operators need a periodic report of what happened on a cell without reading
every ticket or transcript. Reusing `__master__:<cellId>` for generation would let a
six-hourly model turn collide with a human message in the master chat, and it would mix
long reports into the scheduler's activity notes. The database has request timestamps
and `master_events`, but no general transition history, so some terminal timing must be
approximated.

**Decision.** Add a global `summary` policy (default every 6 hours over 6 hours) and a
30-second polling scheduler. It gathers a deterministic JSON snapshot first and asks a
dedicated internal `__summary__:<cellId>` session for the markdown narrative. That
session uses the existing read-only master tool scope and the cell's model/effort
defaults, and it is never exposed as a chat. Reports are stored in `cell_summaries`, so
the UI reads a row instead of re-running a model turn. Generations are serialized and
coalesced per cell; a failure backs off for `min(interval, 30 min)`. "Completed" and
"dropped" in a window are derived from `state` plus `updated_at`, and every report says
so.

**Cost.** A scorecard costs one model turn per cell per interval, and a failed harness
is retried with backoff rather than every scan. The report cannot replay a request that
moved through a state and back; a durable activity log is scoped separately. The global
policy cannot yet vary per cell, and unassigned work has no scorecard, both deliberate
follow-ups.

## D43. Unassigned work has no master

**Context.** The scheduler treated unassigned requests as a pseudo-cell, giving them a
global ticker, the global process template, a `__master__` chat, and a fallback
concurrency cap. That made "no cell" a second automation scope and let a global run
compete with the cell that actually owned a request.

**Decision.** Masters exist only for real cells. Remove `includeUnassigned`, the empty
scheduler key, `runUnassigned`, the global `runOnce` batch, the bare `__master__` session,
and the no-cell master drawer. `POST /api/master/run` requires a `cellId`. Unassigned
requests stay on the board and remain manually editable/chat-able; assigning one to a
cell opts it into that cell's master. Before each start/prod, the service re-reads the
request and skips it if it is missing, live, or no longer in the bucket's cell.

**Cost.** New requests are created unassigned, so they no longer get intake automation
until someone assigns a cell. Troubleshooting scripts that called the global run endpoint
must name a cell. Historical `master_events` with a null cell id stay readable and render
as "Unassigned".

## D44. The agent harness is a per-cell setting

**Context.** Both the Claude Code and OpenCode adapters existed, but `APS_HARNESS`
selected one process-wide. An operator who uses Claude at work and OpenCode at home could
not run both kinds of workspace against one brain, and every model/effort readout assumed
a single adapter.

**Decision.** `cells.harness` is nullable; NULL inherits `APS_HARNESS` (legacy
`SBOX_HARNESS` still works). Request, cell master, and summary sessions resolve their
adapter through their cell, while setup, KB, and unassigned sessions use the process
default. A cached `HarnessRegistry` owns one adapter per id. `session.json` stores
`{harness, sessionId, usage}`, and an id from another adapter is treated as absent, so a
harness switch starts fresh without losing the transcript or usage baseline. The engine
tracks the harness on each cached child; changing the cell kills the old child and spawns
the new adapter. Model catalogs are per harness, and `GET /api/models?harness=` /
`?cellId=` reports that adapter's list, `supportsEffort`, and default model.
`APS_DEFAULT_MODEL` applies to the process-default harness only; the non-default adapter
keeps its implicit default. `PATCH /api/cells/:id` clears `model` and `effort` on a
harness change, then reapplies any values supplied in the same request.

**Cost.** A brain can hold two live child-process shapes and two model caches, and the
operator has one more per-cell field to understand. In exchange, mixed Claude/OpenCode
workspaces share one board, scheduler, KB, and process policy, and no cross-adapter
session id or model id leaks through a harness switch.

## D45. Usage retention is a configurable raw-row prune

**Context.** The usage ledger grows once per completed agent turn. Without a bound it
outlives the dashboards that read it and bloats the brain database. The dashboards need a
predictable answer for "all time", and operators need a way to opt out of automatic
deletion.

**Decision.** `usage.retentionDays` lives in `config.json` and on the Config page,
default 90 days, `0` keeps history forever. A `UsageRetention` job runs after startup,
hourly, and when the setting changes. It deletes raw `usage_events` rows strictly older
than the cutoff in 1000-row batches with a `setImmediate` yield between batches, uses the
ledger's `created_at` index, joins an in-flight pass rather than starting a second one,
and reports one `usage.prune` error through the error sink on failure. It never runs
`VACUUM` or writes rollups.

**Cost.** "All time" totals cover the retained window; the UI and docs say so. Preserving
long-range totals requires daily rollups, which are deferred. A very large first prune
takes several short statements rather than one long transaction, but still completes in
one run. `VACUUM` is left to an operator who can stop the brain first. D52 later adds
daily rollups and a UTC-day-aligned cutoff; the rest of this decision still applies.

## D46. APS names are canonical, SBOX names stay as aliases

**Context.** The product renamed from Sandbox Harness to Agent Process Segments. Runtime
identifiers (environment variables, XDG directories, the SQLite filename, and the systemd
unit) still carried the old name, but a live install already had data, sessions, and
worktrees under those paths.

**Decision.** `APS_*` is canonical and `SBOX_*` remains a deprecated alias. `readEnv`
returns `APS_<name>` whenever it is defined (including an empty string) and only then
falls back to `SBOX_<name>`. Default paths use the new names, but choose an existing
`agent-process-segments` location first, then an existing legacy `sandbox-harness` one,
then the new location; explicit env paths always win. Startup never moves data. An
operator-invoked `npm run migrate:paths` moves the default data, config, and state
directories and the SQLite file (with WAL/SHM), never overwrites an existing destination,
and is idempotent. It refuses to run while a known brain unit is active, while a
visible process still has the planned paths open, while a brain answers its health
endpoint, or while an opt-in brain lock is fresh. On Linux it checks `/proc` for open
file descriptors and cwds, so foreground/dev and custom-unit brains are caught when
visible; it also probes
`http://127.0.0.1:<APS_PORT|SBOX_PORT|7391>/health` and accepts `--brain-url` for a
container, tunnel, or another host. With `APS_BRAIN_LOCK=1` the brain writes
`<dataDir>/brain.lock` every 10 s, and the migration treats a file younger than 60 s as
live even when no port is reachable (D100). `--allow-running` bypasses all four guards;
moving under a live brain can corrupt the database and sessions. A brain that did not
opt in, a shared database whose data directory is not shared, a non-HTTP or non-file
holder, or a process hidden by permissions is not detected. The unit template moves to
`deploy/agent-process-segments.service`.
Startup logs one warning naming every `SBOX_*` variable that is still set, with names
only and never values; renaming them to `APS_*` clears it.

**Cost.** Two names exist for one release, and a partial upgrade can keep using legacy
paths until the operator migrates. Moving a data directory also moves git worktrees,
whose metadata may need `git worktree repair`; the script warns instead of guessing. A
rollback to an older binary needs a unit or drop-in that passes the migrated paths under
the `SBOX_*` names. The startup warning stays for at least the next release after it
ships; removing `SBOX_*` support requires that warning plus updated upgrade and rollback
notes in this file, `README.md`, and `deploy/vps.md`.

## D47. Budgets are advisory, monthly, and read the usage ledger

**Context.** Operators need to see whether a cell or the whole brain is approaching its
spend budget. The usage dashboard already records one `usage_events` row per completed
turn, but budgets are a separate policy: a budget crossing must not change workflow.

**Decision.** Add a pure `domain/budget.ts` contract, an overall budget in `config.json`,
and a nullable `cells.monthly_budget_usd`. Budget periods are UTC calendar months.
`BudgetService` reads aggregate totals directly from `UsageRepository.totals`; the narrow
reader adapter added before the ledger existed was removed once the ledger landed. Missing
`cost_usd` is unpriced, never zero or estimated; an all-unpriced period is `unknown` and
does not alert, while mixed data alerts against a known lower bound.

Durable alerts live in `budget_alerts`, not `master_events`. Their identity includes the
budget amount and warning percentage, so changing either starts a new generation without
deleting acknowledged history. Exceeded supersedes warning; acknowledging one silences
that generation for the month. `BudgetService` evaluates on start, every 60 seconds, and
on settings/cell changes, reports failures as `usage.budgets`, and never affects a turn.
Advisory budgets never pause or block work; opt-in hard caps are D54, extended by D65 to
stop in-flight turns.

**Cost.** Budget status is shown on Config, the Usage page, and the app banner. The unique
alert identity includes REAL budget amounts, which is acceptable for operator-entered
dollar values. Advisory alerts never pause work; opt-in hard caps are D54/D65. External
delivery remains separate work; usage retention uses D45, daily rollups are added by
D52. A retention window shorter than the month makes spend a lower bound, which the docs
and UI say explicitly.

## D48. A request can override its cell's harness

**Context.** The cell harness covers the normal workspace, but one request
occasionally needs the other adapter: a provider-specific reproduction, a repo that
only builds under one CLI, or a migration test. Creating a second cell would lose the
request's queue, policy, and master. Keeping the harness process-wide would make the
per-cell setting useless.

**Decision.** Add nullable `requests.harness` and one resolution order: request, cell,
process default. A request turn resolves once and uses the same adapter for parser,
prepare, and spawn. The existing session/process pinning means a switch drops the cached
child and starts a fresh provider session without losing the normalized transcript.
KB/setup remain process-default; a master or summary remains cell-scoped.

A cross-harness request does not inherit the cell's model or effort, because those were
chosen for the other adapter. It uses its own model, then the resolved adapter's brain
default. A patch that changes the effective harness clears `request.model` unless the
same patch supplies a replacement; effort is retained because OpenCode ignores it and it
is useful if the request returns to Claude. `GET /api/models?requestId=` resolves through
the same helper, so the SPA cannot drift.

**Cost.** An override can point at an adapter whose CLI is not installed; that turn then
fails visibly rather than falling back. A harness change discards the provider session
id. Direct API callers that set `harness` and a model in one patch remain responsible for
choosing a compatible model.

## D49. Unreported cost is estimated from effective-dated prices

**Context.** Harnesses sometimes omit a cost even when they report tokens. Operators can
still want a spend estimate, but a guessed price or a silent zero would be worse than an
explicit unknown.

**Decision.** Add a `model_pricing` table with one row per exact model and
`effective_from` timestamp, five USD-per-million-token rates (input, output, cache read,
cache write, reasoning), a source citation, and a creation time. A turn's estimate uses
the latest row with `effective_from <= usage_events.created_at`; estimates are computed
at query time and never written over the reported `cost_usd`. Reported cost always wins.
The table starts empty, is edited on the Config page or through `/api/pricing`, and is
append-only for normal changes. A model with no effective price remains unpriced, and the
aggregates report reported, estimated, total, and unpriced counts separately.

**Cost.** Prices are operator-maintained, exact-match only, flat per model, and USD only;
there is no scraper, currency conversion, context-length tier, or effort multiplier. A
wrong effective date or model id leaves turns unpriced, which is visible as a lower bound
rather than silently understating spend. Historical estimates change when an operator adds
a backdated row, which is intentional because the row records the source and date.

## D50. Index all is a scoped, human-triggered bulk close

**Context.** Operators can accumulate several finalized requests with proposed digests.
Closing them one drawer at a time is slow, but a background auto-finalizer would remove
the human approval gate.

**Decision.** Add `POST /api/requests/index-all {cellId?}` and a small **Index all**
control in the Finalize column header. The scope is the current cell filter (omitted
means all cells) and only `state = finalize`. A request is skipped and left in Finalize
when it is still working or when it expects a KB digest but has none; `kbDigest = false`
requests close without a KB entry. The SPA requires a second click within four seconds.
The endpoint returns `{indexed, closed, skipped[], failed[]}`, and a per-request failure
does not abort the batch.

**Cost.** Bulk close is intentionally coarser than the drawer: it uses the saved digest
and does not wait for review of every card. A working request or one with a missing
digest needs the drawer. The action stays human-triggered; do not wire it into the master,
scheduler, or a background job.

## D51. The bundled MCP server key is `aps`

**Context.** The product renamed from Sandbox Harness to Agent Process Segments, but the
bundled stdio MCP server still registered as `harness` and was injected as
`mcpServers.harness` / `mcp.harness`. That key is not the agent-substrate seam: it is the
config key and tool namespace the harnesses receive, and it was leaking the old product
name into generated configs, tool cards, transcripts, and docs.

**Decision.** The bundled server key and handshake identity are `aps`. Claude receives
`mcpServers.aps` and the allow-list uses `mcp__aps__*`; OpenCode receives `mcp.aps` and
names its tool events `aps_<tool>`. `HarnessId`, `AgentHarness`, `APS_HARNESS`, the
`clarify/harness*.ts` files, and the `requests.harness`/`cells.harness` columns keep the
"harness" name, because they describe the agent adapter rather than this MCP server. The
`aps` key is reserved: a user MCP server with the same key is replaced by the bundled
server, matching the old `harness` precedence, and the brain logs one warning naming the
user's config file when that happens. Persisted transcripts are normalized at
the web boundary (`mcp__harness__*` to `mcp__aps__*`, `harness_*` to `aps_*`) rather than
rewritten in storage. The MCP `version` stays `0.1.0`, declared once as
`MCP_SERVER_VERSION` in `mcp/identity.ts`, because the app has no separate release
version.

**Cost.** A user cannot name their own MCP server `aps` without it being overridden; the
one-time warning names the config file so the operator can rename or remove the entry.
Old and new tool labels appear as one canonical name in
the UI, while the raw stored transcripts still contain the old prefix for audit purposes.
No database or session migration is needed because the generated config is recreated
every turn.

## D52. Daily rollups preserve usage history before raw pruning

**Context.** D45 bounded `usage_events` by deleting raw rows after the retention window,
so "all time" totals silently meant "the retained window". Operators need long-range
spend and token history without keeping every per-turn row forever. The ledger is written
only after a turn completes, so a background rollup cannot race an in-flight turn.

**Decision.** Before pruning, `UsageRetention` rolls eligible raw days into `usage_daily`,
one row per UTC day × scope × cell × request × model, then deletes the raw rows. Retention
uses the UTC-day-aligned cutoff `startOfUtcDay(now - retentionDays)` rather than D45's
exact millisecond, keeping at most one extra partial day and making rolled days complete
and non-overlapping. Rollups are written in chunks of at most 31 days per transaction,
starting at the earliest raw day rather than epoch 0, with an event-loop yield between
chunks. Each chunk replaces its `usage_daily` range, aggregates with the same
effective-dated price lookup as live queries, and advances the exclusive
`usage_rollup_state.rolled_through` watermark in the same transaction. Raw rows are
deleted only after the chunks through the cutoff commit.

Queries read from a normalized union: raw rows at or after the watermark and daily rows
before it, so the sources cannot overlap. Totals, day series, model/cell/request
breakdowns, and the budget totals all use that merged view.
`GET /api/usage` exposes `coverage.rolledThrough` so the Usage page can say which part of
history is daily, `coverage.retentionDays` so it can state the raw retention window,
and `coverage.lastPrune` (`{ranAt, deletedRows}`, null before the first pass) so it can
show when retention last ran and how many raw rows it pruned. All three ride on the same
response instead of a separate settings or status request. The pass evidence is persisted
in `usage_prune_state` so a restart does not blank it; each completed pass, including a
disabled window or a zero-row pass, replaces the singleton row. Hourly series stay
raw-only; day-aligned ranges (all-time, UTC budget months) are exact, while a rolled day
overlapping a custom range is included whole.
`retentionDays = 0` deletes nothing and builds no rollups.

**Cost.** Rolled-day estimates are frozen at rollup time, so later `model_pricing`
corrections apply only to raw days; retroactive repricing would be separate work. Raising
the retention window cannot restore raw detail already pruned, though daily totals remain.
A custom range that starts or ends inside a rolled day has day resolution at that edge.
The `usage_daily` table grows with distinct requests/models per day, not with turns, and
rollups add bounded synchronous transactions to the retention job. There is no `VACUUM`,
new dependency, or per-cell retention policy.

## D53. Master activity retention keeps follow-up markers

**Context.** `master_events` records one row per scheduler cycle, prod, review, advance,
skip, and created follow-up. Nothing pruned it, so a long-running brain accumulated cycle
and skip noise forever even after D45/D52 bounded `usage_events`. The activity UI reads
only the latest 50 rows, and scorecard history lives separately in `cell_summaries`.

**Decision.** Add `retention.masterEventsDays` to `config.json` and the Config page,
default 90 days, `0` keeps activity forever. A `DataRetention` job runs after startup,
hourly, and immediately when the setting changes. It deletes rows with
`created_at < now - masterEventsDays` in 1000-row batches with an event-loop yield between
batches and an in-flight promise guard, relying on `idx_master_events_created`. Deletion
is strict at the cutoff, uses `config.json` as the only source of truth, and never runs
`VACUUM`.

Rows with `action = 'followup'` are exempt. `MasterEventRepository.hasEvent()` is the
permanent deduplication key for `FOLLOW-UP:` titles (invariant 16); deleting an old marker
could recreate a follow-up if a stale request advanced again. These rows grow with created
follow-ups, not with scheduler cycles, so they stay small.

Activity is not rolled up. Unlike usage, there is no need for an aggregate table: the
reader wants recent rows, and scorecards persist their own reports. Failures go to the
error sink as `retention.prune` with table/cutoff/deleted counts only and retry on the next
tick; they never fail a turn.

**Cost.** A window shorter than 90 days can drop activity that an operator wanted for
audit; raising it later cannot restore pruned rows. Follow-up markers survive regardless,
so the table is not perfectly bounded, but their growth is tied to actual created work.
There is no per-cell policy, manual prune button, new index, schema migration, or rollup.

## D54. Hard spend caps are opt-in admission checks

**Context.** Advisory alerts tell operators when spend crosses a budget, but some cells
and installations need a stop-the-line cap. Silently converting an existing advisory
budget into a hard cap on upgrade would stop automation without warning. Enforcement also
has to account for estimated cost without changing the shipped alert semantics, and it can
only be checked at turn boundaries because the ledger is written after a turn completes.

**Decision.** Add `budget.pauseOnExceeded` and `cells.pause_on_exceeded`, both default
false. A scope with the flag pauses when cap spend, defined as reported plus estimated
cost for the current UTC month, is greater than or equal to its budget. Advisory
`spendUsd`, alert state, threshold math, and `budget_alerts` remain reported-cost-only.
`capSpendIsLowerBound` is true when any turn has neither a reported nor an estimated cost;
an all-unpriced or unmeasurable scope fails open rather than blocking work. An overall
pause refuses every new agent turn, including KB and setup; a cell pause refuses only that
cell's request, master, and summary turns. Master/summary schedulers skip paused cells
without failure backoff and note the transition once. Acknowledgement never overrides a
pause. Admission happens before `clarifyStarted`, state transitions, `agentStatus`,
session writes, or spawning; in-flight turns finished, with no reservations. D65 later
added in-flight cancellation on a crossing; reservations are still not used. Refusals use
`SpendCapError` and HTTP `409 spend_cap`. Pause state is recomputed from the ledger and
policy, so budget changes and month rollover resume without a restart.

**Cost.** Admission-only enforcement lets a concurrent or long in-flight turn overshoot the
cap; D65 stops in-flight work when a crossing is observed but keeps the no-reservation
limit. Estimated cost is only as good as the
operator-maintained price table, and an unpriced turn leaves cap spend a lower bound. The
pause flag adds an additive cell column and one optional budget field. This also fixes
`SettingsStore.load()`, which previously dropped the saved budget block on restart, because
the new overall flag must persist. External delivery remains separate; D67 adds the strict
unknown-cost option and D68 adds a bounded operator snooze for a paused scope.

## D55. Budget alerts are delivered by a durable, signed webhook outbox

**Context.** Advisory budget alerts were in-app only (D47). Operators need them to reach a
team channel or local automation without the brain offering credentials, OAuth, or a
second delivery stack. A webhook can be retried safely only if delivery is idempotent and
a configuration change cannot replay an old alert with new credentials.

**Decision.** Add `notifications.webhook` to `config.json` (`enabled`, `url`, `format`,
`secret`) and an opt-in outbound HTTPS webhook. `format` is `json`, `slack`, or `discord`;
JSON events are signed with HMAC-SHA256 over the raw body. `BudgetNotifier` enqueues one
`budget_alert_deliveries` row per `(alert_id, channel)`; the unique key is the idempotency
record across evaluations and restarts. Each row stores the `destination_hash` it was
enqueued under, so URL/format/secret changes mark old rows `skipped` while a newly enabled
webhook still sends the alert enqueued in that same evaluation. Attempts are bounded to
five on a 60 s/5 min/30 min/2 h schedule, honor `Retry-After`, do not follow redirects,
and time out after 10 seconds. Acknowledgement, prior months, budget/threshold changes,
and cell deletion skip pending rows through the existing alert reconciliation and FK
cascade. The secret is never returned by `GET/PATCH /api/config`; failures go to
`budget.notify` with ids and a short reason only.

**Cost.** A generic webhook plus Slack/Discord text bodies covers external delivery
without SMTP or bot credentials. Email (D57), native chat apps (D64), delivery
history/resend (D63/D81), and general event notifications (D66) were later built as
separate changes. The outbox adds one small table and
one `unref()`'d timer; delivery is advisory and never changes budgets, turns, or the HTTP
response path. `destination_hash` is a one-way hash stored only in the local database and
is never logged. D64 later replaces the `(alert_id, channel)` identity with
`(alert_id, destination_id)`; webhook rows keep `destination_id = "webhook"`.

## D56. Proof scripts share one scrub-then-pin env builder

**Context.** The e2e suite became hermetic first: inherited `APS_*`/`SBOX_*` settings and
API credentials are dropped before the mock pins are applied. The other proof scripts
still spread `process.env` and pinned only legacy `SBOX_*` names. Because `readEnv()`
prefers `APS_*`, a normally configured host overrode those pins, so `mcp-smoke` could call
the live brain (and exited 0 when every call failed), `claude-mock-smoke` could launch the
wrong adapter against the live port and database, and inherited `XDG_CONFIG_HOME` or
`OPENCODE_CONFIG_DIR` could still steer skills and adapter config resolution even after
prefix scrubbing.

**Decision.** `scripts/e2e/env.mjs` owns `scrubEnv(hostEnv)` and
`buildPinnedEnv(hostEnv, pins)`; the E2E name `buildE2eEnv` is an alias. Every proof
script — e2e, MCP smoke, Claude mock smoke, and screenshots — builds its child env through
the helper with a validated pin builder. Scripts that deliberately prove the legacy
aliases keep `SBOX_*` pins; scrubbing inherited `APS_*` names first is what makes those
pins authoritative. The Claude smoke pins its legacy `SBOX_CONFIG`/`SBOX_PROCESS`/
`SBOX_ERROR_LOG`; the MCP smoke pins the canonical `APS_*` equivalents and also
`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`OPENCODE_CONFIG_DIR`, because `loadConfig()` and
`SkillCatalog` read those directories directly, outside `readEnv`. `mcp-smoke` now asserts
its tool round trips, persisted request, and KB entry, so a broken proof exits non-zero
instead of printing `MISSING ID`/`ERROR`.

**Cost.** The proof scripts import from an `e2e`-named module; renaming it to a neutral
path would churn imports, tests, and docs for no behavioral gain. The pins stay explicit
and per-script, so adding a script means adding a builder and a hostile-env test rather
than reusing one global env. `scripts/smoke.sh` is bash and keeps its own pinning; making
it share the contract is separate work.

The Claude smoke's own binary discovery is script-scoped too: `--claude-bin <path>` or
`CLAUDE_MOCK_SMOKE_BIN`, then `claude` on `PATH`. An inherited `APS_CLAUDE_BIN` (or the
legacy `SBOX_CLAUDE_BIN`) cannot choose the binary under test (the brain still reads
those normally), and the script-scoped variable is dropped from the child env by the same
`CLAUDE_*` scrub.

The chosen file must identify as Claude Code: the smoke runs `<bin> --version` with a 5 s
timeout and requires "Claude Code" in the output. A wrong `--claude-bin` or
`CLAUDE_MOCK_SMOKE_BIN` is an error, so an operator typo cannot quietly pass; a wrong
`claude` on `PATH` is skipped and the scan continues, so a hostile or unrelated PATH entry
cannot run the Claude proof. This only proves the binary's identity, not live model
behavior, which the mock cannot show.

## D57. Budget alerts also deliver by SMTP email

**Context.** D55 built one durable, signed webhook channel. Operators without a webhook
collector still need alerts outside the app, and a provider-specific chat API would add
credentials and API-version maintenance before the generic webhook formats were exhausted.
The outbox already keys rows by `(alert_id, channel)` and stores `channel`/`format` as
unconstrained text.

**Decision.** Add `notifications.email` (`enabled`, `host`, `port`, `secure`, `username`,
`password`, `from`, `to`) and an SMTP channel in the same `budget_alert_deliveries`
outbox. Email rows store `channel = "email"` and `format = "email"`; no migration is
needed. `nodemailer` is the transport, loaded lazily behind an injected `EmailSendLike` so
tests never open a socket and no real transport is constructed unless email is enabled and
a send is attempted. `secure: true` uses implicit TLS; `secure: false` requires STARTTLS
for every non-loopback host, matching the webhook loopback exception for local relays.
Certificates are always verified, credentials are optional but paired, and one transport
is created per send and closed on success, failure, or abort. The destination hash covers
host, port, TLS mode, from, sorted recipients, username, and password, so rotating any of
them skips queued mail instead of sending it with new credentials. Each channel is drained
and skipped independently; acknowledgement, prior months, and budget/threshold changes
still skip both. Subjects and bodies come from pure helpers in `domain/budget.ts`; the
message carries the alert sentence, UTC period, alert id, a stable `Message-ID`, and
`X-APS-Alert-Id`/`X-APS-Delivery-Id`. Auth/envelope/message/protocol failures are
permanent; connection, socket, DNS-temporary, timeout, and unknown failures retry on the
D55 schedule. The API returns `password: null` with `passwordSet` and reports per-channel
status, and `POST /api/notifications/email/test` exercises the sender without writing rows.

**Cost.** Email is plain text with a fixed layout and no HTML, attachments, DKIM, bounce
handling, provider APIs, or OAuth2; those are separate work. The password lives in
`config.json` (mode `0600`) because the brain has no keyring. A recipient list is capped at
ten. D64 later broadens the outbox key; email rows keep `destination_id = "email"`.
Delivery history/resend and non-budget events were later built as D63/D81 and D66. The
dependency is one runtime package with its own types and no transitive dependencies.

## D58. Request workdirs are owner-only

**Context.** `session.json` and `transcript.json` live under `$APS_DATA_DIR/requests/<id>/`.
The engine created the directory with the default `0755` and wrote both files with the
default `0644`, so under the usual `umask 022` any local account could read the full
conversation (user text, model output, tool inputs, command output, and file contents)
and the adapter session ids.

**Decision.** The `requests/` parent and every per-session workdir are created `0700`;
`session.json` and `transcript.json` are written through `writePrivateFile` (same-directory
temp file, rename, `chmod 0600`) so a write also repairs a loose file left by an older
version. Directory creation goes through `ensurePrivateDir`. A chmod or rename failure
propagates, matching `settings.ts` and `process/store.ts`. Mode tests skip on Windows; the
product targets Linux/systemd.

**Cost.** This is not encryption at rest, and root can still read the files. The SQLite
database is covered by D73; other data-dir artifacts are separate work. A bulk repair of
old, terminal workdirs that are not written again is `npm run repair:permissions` (D74).

## D59. Harness-reported error results fail the turn visibly

**Context.** Claude can finish a turn with `{"type":"result","is_error":true,...}` for
expired authentication, a rate limit, an invalid model, or a tool crash. The parser
recorded `isError`/`resultText` but emitted no event, and the engine only persisted a
failure when `turn.failure` was set. The turn therefore ended empty and silent. OpenCode
already emitted an `error` event, but the engine did not map it to `turn.failure`, so the
live error disappeared from the persisted `done` transcript and the error log.

**Decision.** A parser error event is a turn failure. The Claude parser detects
`is_error` and `error*` result subtypes, and returns one `{t:'error'}` whose message is
the trimmed, capped result text (fallback: `agent reported an error`). `Engine.consume`
maps the first error event to `turn.failure`, broadcasts it once, marks it reported, and
logs `engine.result` with session, harness, and request ids. `runTurn` does not
re-broadcast a reported failure, and `finishTurn` persists exactly one `⚠` line, deduped
by the exact labelled line. A later exit, duplicate error line, or OpenCode event cannot
duplicate the warning. There is no in-turn retry, no kill for a reported result, no
session write, and no usage change; the SPA already renders both the live error and the
persisted `⚠` text.

**Cost.** One new error-log source and a `failureReported` flag on `LiveTurn`. The
failure text is provider-facing and capped at the existing 8,000-char tool limit; it is
the only new error-log content and never includes a prompt or transcript. Classifying
provider errors and retrying them remain separate work.

## D60. Terminal request artifacts and worktrees expire on one window

**Context.** Every request gets `$APS_DATA_DIR/requests/<id>/` for `transcript.json`,
`session.json`, generated harness config, and a scratch `cwd`. Terminal transitions call
`engine.dispose`, which removes the linked checkout but never the request directory, and
the checkout removal swallows git failures. Finished requests therefore keep their
transcripts and any leftover checkouts forever.

**Decision.** Add `retention.requestArtifactsDays` to `config.json` and the Config page
(default 30, `0` keeps artifacts forever, max 3650). One startup/hourly job deletes the
whole request directory for `done`/`dropped` requests whose newest activity (row
`updated_at`, directory mtime, or `transcript.json`/`session.json` mtime) is strictly
before the cutoff, and removes `worktrees/<id>` for terminal, row-less, or
target-repo-less requests. It never touches a non-terminal request, a live turn, a
reserved session directory (`__kb__`, `__master__:*`, `__summary__:*`, `__setup__:*`),
or a non-UUID folder. Worktree removal uses `git worktree remove --force` from the
repository's common worktree and keeps the branch; a failed git removal falls back to
deleting the directory, and repo-level `git worktree prune` clears stale registrations.
Sweeps yield between batches, join overlapping runs, and report one `retention.artifacts`
record with counts and the cutoff only. There is no DB rollup, `VACUUM`, new route, env
var, or dependency.

**Cost.** Deleting the directory drops the terminal chat history and adapter session id;
a later chat starts fresh. Uncommitted work in an expired terminal checkout is
discarded, matching a normal terminal dispose. Reserved-session cleanup is separate, as
is visibility into the last sweep and worktrees orphaned by a `targetRepo` change.

## D61. Scorecard history retention keeps the newest report per cell

**Context.** The summary scheduler writes one `cell_summaries` row per generated report
(default every 6 hours per cell). The row holds the markdown scorecard plus its
`stats_json`; reads are only the newest report per cell and the latest five for the
drawer. Nothing pruned the table, so report history grew without bound.

**Decision.** Add `retention.cellSummariesDays` (default 90, `0` keeps history forever,
max 3650) alongside `masterEventsDays`: the same `config.json` block, the same
Config-page pattern of one card and one save per window, and the same startup/hourly
`DataRetention` pass. A report is deleted when `created_at` is strictly before
`now - cellSummariesDays`, except the newest row per cell as
`SummaryRepository.latest()` defines it (`created_at DESC, id DESC`). Deletes are
1000-row batches with an event-loop yield on the new `idx_cell_summaries_created` index,
and each table prunes in its own `try/catch`: one `retention.prune` record on failure,
the other table still runs, and the next tick retries. History is not rolled up, there is
no `VACUUM`, and per-cell windows remain out of scope.

**Why keep the newest row.** `latest()` drives both the drawer's last-known scorecard and
the scheduler's due-ness. Deleting it would blank the panel for dormant cells and cells
with scorecards disabled, and the scheduler would immediately regenerate a report for
every such cell. Keeping one row per cell is bounded by the cell count.

**Cost.** Up to one retained row per cell regardless of the window, and a correlated
keep-latest subquery inside each batch (backed by the two cell_summaries indexes). No
route, env var, column, or table changes.

## D62. Deleting a cell removes its activity and reserved sessions

**Context.** `DELETE /api/cells/:id` detached the cell's requests and deleted
`cell_summaries` and the `cells` row, but left every `master_events` row with that
`cell_id` and the lazily-created `requests/__master__:<cellId>/` and
`requests/__summary__:<cellId>/` directories. Artifact retention deliberately skips
reserved session ids, so those transcripts, adapter session ids, generated config, and
scratch `cwd` survived forever. An in-flight master cycle could also settle after the
delete and write new activity, notes, or a follow-up request for the dead cell.

**Decision.** `CellRepository.remove` deletes non-followup `master_events` in the same
transaction that detaches requests and deletes summaries. `followup` rows stay because
they are the permanent dedupe key for invariant 16 and the requests still exist as
detached rows. After the transaction, the DELETE route calls
`Engine.discardSession` for `__master__:<id>` and `__summary__:<id>`: it marks the id
discarded, cancels a live turn, waits for the background `runTurn` continuation to
settle, then recursively removes the session directory. Waiting is required because
`Engine.cancel` finishes the turn synchronously while `ensureProc`/`prepare` may still
write `session.json` or the scratch directory. A discarded id refuses new master/summary
turns and ignores notes, so a stale client cannot recreate it. `MasterService.record`,
`note`, and `createFollowUps` also no-op when the cell row is gone, so an in-flight cycle
cannot resurrect activity. Directory-removal failures are best-effort: each failed
session records one `cells.cleanup` error with the cell and session ids only, and the
delete still returns `204` because the database deletion is authoritative.

**Cost.** A deleted cell’s activity history is gone; follow-up markers remain forever with
no owning cell row, which is the same trade-off as activity retention. The discarded-id
set lives for the process lifetime (two ids per deleted cell); a crash between the
database delete and the `rm` can still leave a directory, which a startup sweep would
handle separately. Usage, budget-alert, and per-request artifacts are untouched; deleting
a cell still only detaches its requests.

## D63. Delivery history is a read-only audit and resend is guarded

**Context.** The alert outbox records every alert/destination attempt, but the
Config page only exposed aggregate pending/failed counts and the latest row. Operators
could not see why a specific alert failed or re-queue a notification that was skipped
after a destination change, short of editing SQLite.

**Decision.** Add `GET /api/notifications/deliveries`: a read-only, offset-paginated join
over `budget_alert_deliveries` and `budget_alerts`, filtered by channel, status, alert id,
and a `[from, to)` created-at window. It returns alert scope/cell, threshold, budget/spend,
attempts, next attempt, a sanitized error, timestamps, and a computed `canResend`. It
never returns `destination_hash`, a URL, credentials, recipients, or a payload body.
Add `POST /api/notifications/deliveries/:id/resend`, which re-queues only `failed` or
`skipped` rows whose alert is unacknowledged in the current UTC month and whose channel is
enabled and configured. Resend reuses the same row (the `(alert_id, destination_id)`
unique key stays the dedupe record), resets `attempts`, clears `delivered_at`, re-stamps
`format`/`destination_hash` to the current route, preserves `last_error`, and kicks a
flush. For chat, the current route must still resolve to the row's destination id.
`pending`/`delivering` is an idempotent no-op; delivered rows are immutable.

**Cost.** No schema change, migration, new dependency, or background job. The audit is an
ops list bounded by monthly alerts, two channels, and the configurable budget-alert
retention window (D77). D78 later replaces the join with an alert snapshot so history
survives alert deletion, and D81 extends the same read model and resend route to
operational event deliveries. Resends are not attributed to an operator because the app
has no user identity.

## D64. Budget alerts also deliver through native Slack and Discord bots

**Context.** The webhook channel can post Slack/Discord-shaped text to an incoming
webhook, but it cannot target a channel with a bot identity or route different cells to
different channels. The outbox deduped on `(alert_id, channel)`, so one alert could not
have more than one delivery row for the same provider. Operators with several cells need
the overall budget in one channel and selected cell budgets in others.

**Decision.** Add `notifications.slack` and `notifications.discord`, each with a bot token,
a list of `{ channelId, label }` destinations, an optional default destination, and
per-cell `{ cellId, channelId }` routes. The default receives the overall budget and is the
fallback for unrouted cells. Change the outbox identity to
`UNIQUE(alert_id, destination_id)`; webhook/email rows use their channel as the
destination id, while chat rows use `<provider>:<channelId>`. The old table is rebuilt on
migration and existing rows keep their behavior; D78 rebuilds it again to snapshot the
alert fields and drop the cascade. Each row stores a destination hash over
the provider, channel, and bot token, so a token or channel change skips pending rows
instead of sending them with new credentials.

Slack uses `chat.postMessage` with `Bearer` auth, `mrkdwn:false`, and unfurls disabled;
Discord uses the channel message endpoint with `Bot` auth and mention parsing disabled.
Bodies are text-only and include the alert sentence, threshold, UTC month, unpriced-turn
count, and a Usage link only for a non-loopback `APS_BRAIN_URL`. Slack's HTTP 200
`{ok:false}` is a failure; its rate-limit/internal codes retry and auth/permission/channel
codes fail. Discord `429` retries with `retry_after` from the body or header. Both use the
existing timeout, five-attempt schedule, no-redirect rule, and `budget.notify` error path.
Tokens are redacted from config responses and never logged; tests inject the sender.

**Cost.** One table rebuild plus one provider block per chat service, two test routes, and
two Config cards. Fan-out to multiple destinations for one scope, per-scope routing for
webhook/email, delivery history/resend, rich Block Kit/embeds, interactive
acknowledgement, and token storage outside `config.json` remain separate work.

## D65. Hard caps stop in-flight turns when a crossing is observed

**Context.** D54 refused new turns at a hard cap but let everything already running finish.
Operators read "paused" as "nothing is spending", yet a cell with several concurrent turns
could keep spending after the cap was crossed. Harness CLIs have no pause protocol, and the
ledger only records spend when a turn completes, so a long single turn cannot be seen or
stopped mid-flight from its own usage.

**Decision.** Add `SpendCapEnforcer.check()`, called after a usage row is written and after
`BudgetService.evaluate()` (the 60-second tick, settings changes, and the existing
cell/config evaluate calls). It snapshots `Engine.liveTurns()`, resolves admission once per
distinct cell, and stops every live turn whose scope is paused through
`Engine.cancelForSpendCap`. A stop kills the child with the existing SIGTERM→SIGKILL
escalation, marks the turn `cancelled` with `stoppedBy`, appends a deduplicated `⏸` agent
line, emits `{t:'paused', pause}` before `done`, keeps `session.json`, and sets request
`agentStatus` idle plus `unchecked`. Overall pauses stop every scope including KB, setup,
unassigned, master, and summary; a cell pause stops only that cell's live turns. There is
no SIGSTOP suspension, no persisted pause bit, and no automatic replay; the operator
resends after the pause clears and the saved session resumes.

A cap stop is a policy outcome, not an error: no `engine.turn`, `master.turn`,
`summary.generate`, HTTP error-log, or error-sink entry. A master candidate stopped this way
is not advanced and creates no follow-ups; a summary generation stopped this way throws
`SpendCapError` and the scheduler records no failure backoff. An admission race in the
master becomes a quiet skipped candidate instead of a logged failure.

Invariant 20 gains one narrow exception: a cap-stopped turn records usage the parser already
reported for completed steps (OpenCode `step_finish`) or a final result, because dropping it
would erase real spend from the ledger. User stop, dispose, and timeout still write nothing,
and no estimate is inserted into `usage_events`. Optional fields stay additive: the
`paused` event variant and `LiveTurn.stoppedBy` are the only contract additions. The
enforcer is single-flight with a bounded re-entry loop because a stopped turn recording
usage can trigger another check.

**Cost.** In-flight spend remains invisible, so the turn that crossed the cap has already
finished and a single long turn can overshoot; a just-started turn can be stopped
immediately by a sibling crossing. Enforcement adds two database reads per distinct live
cell at most once per completed turn and once per evaluation. Auto-resume of the interrupted
prompt, a broad partial-usage rule for user stop/timeout, and an operator override/snooze
remain separate work. D67 later adds strict unknown-cost enforcement.

## D66. Operational errors reuse the notification channels with a sibling outbox

**Context.** D55/D57 delivered budget alerts by a durable signed webhook and SMTP email,
and D64 added native Slack/Discord bot delivery. Failed request turns and master errors
still reached only the transcript, `master_events`, and the local error log, so an operator
had to watch the UI to notice a stuck factory. A second transport or a synthetic budget
alert would duplicate credentials, retry logic, and dedupe semantics or pollute the budget
banner.

**Decision.** Add per-event, per-channel opt-in routes under
`notifications.events.failedTurns`/`.masterErrors`. `turn.failed` covers request-scoped
turns that end in `engine.result`, `engine.exit`, `engine.timeout`, or `engine.turn`;
`master.error` covers `master.turn`/`master.cycle` failures and skips expected spend-cap
refusals. Events drain through the same `NotificationService`, channel settings,
destination hash, HMAC signing, 10-second timeout, retry schedule, and `Retry-After` as
budget alerts. Event rows use the configurable event-retention window from D89 rather
than the configurable budget-alert window. The sibling
`notification_event_deliveries` table keys `UNIQUE(dedupe_key, channel)`; a failed-turn key
is request+source+safe reason+UTC hour and a master key is cell+source+segment+UTC hour, so
a deterministic failure loop sends at most one message per signature per hour per channel.
It is a sibling rather than a synthetic alert because budget rows require an alert FK and
acknowledgement/period semantics. Event routes deliberately cover webhook and email only;
the native Slack/Discord bot channels remain budget-alert destinations in this change.
Payloads carry ids, title/state, harness/model, and a classification label only, never raw
error text, stderr, prompts, transcripts, or credentials. No route backfills historical
events; disabling a route marks pending rows `skipped`. Failures use error source
`notifications.event` with ids and a short reason.

**Cost.** A second small outbox table and a new Config card, no migration of existing
budget rows and no new dependency. Event history/resend initially remained outside the
budget history view; D81 folds it in. D80 later adds scorecard failures as a third event
kind, and D82 adds the configurable window and per-cell event routes. Bot event routes
remain a follow-up.

## D67. Strict unknown-cost caps fail closed on unpriced turns

**Context.** D54 hard caps count reported plus estimated cost and fail open when the
period contains a turn with neither, because the lower bound is still below the budget.
That is safe for availability but wrong for an operator who needs a true ceiling: one
unpriced model can hide any amount of spend for the rest of the UTC month.

**Decision.** Add `budget.pauseOnUnknownCost` and `cells.pause_on_unknown_cost`, both
default false, effective only when the same scope has `pauseOnExceeded` and a budget. A
strict scope pauses when `unpricedTurns > 0` for the current UTC month, even if cap spend
is below the budget. Estimated-cost turns do not trigger it because cap spend already
counts them. A reached cap still wins the pause reason (`cap_reached`), with
`unknown_cost` used only while the lower bound remains below the budget. `BudgetStatus`
carries `pauseOnUnknownCost` and `pauseReason`; `SpendPause` and the HTTP 409 carry
`reason`.

Pricing is effective-dated and recomputed on read, so adding a matching price clears the
pause on the next admission without a restart. Clearing the budget, disabling
`pauseOnExceeded` or `pauseOnUnknownCost`, or the next UTC month also clears it. Raising a
budget does **not** clear an unknown-cost pause because the trigger does not depend on the
budget amount. A turn with no reported model cannot match a price, so clearing the cap or
disabling strict mode is its only non-rollover remedy. Acknowledgement never clears a
pause. The master pause episode includes the reason so a cap-to-unknown transition notes
once.

Admission remains at turn boundaries; D65's in-flight stop applies when a strict pause is
observed, so a strict pause also stops live turns in that scope. Scope ordering is
unchanged, and a cell strict pause covers only that cell's request/master/summary turns. A
failed ledger read still fails open and is logged as `usage.budgets`, even in strict mode:
the policy governs cost data, not database availability. No new alert type is created; the
existing `pauses` array and banner surface the pause.

**Cost.** One additive cell column and one optional budget field. Strict mode can stop a
scope for the rest of the month over one unpriced turn, so operators must maintain prices.
The ledger-error fail-open is a deliberate availability tradeoff; a future fail-closed
ledger policy is separate work.

## D68. Hard-cap pauses can be snoozed for a bounded window

**Context.** D54, D65, and D67 made hard caps admission checks plus in-flight stops that
resume only when the budget, prices, or flags change, or the UTC month rolls over. That is
safe but rigid: an operator who needs a release review or a one-off maintenance run has to
raise or clear the budget, add prices, and remember to restore the policy. Acknowledgement
deliberately does not override a pause.

**Decision.** Add a durable `spend_cap_overrides` table. An override has a scope
(`overall|cell`), a UTC period, an expiry, an optional note, and a soft `revoked_at`. One
non-revoked row per scope and period is enforced by a partial unique index; re-granting
extends the same row. Grants require the scope to be a configured hard cap; the scope need
not be currently paused, so an operator can pre-authorize a window. An overall override
admits every new turn and suppresses the in-flight stop for every scope; a cell override
does the same for only that cell and can never release an overall pause. The window is
clamped before the next UTC period, so a snooze never outlives the budget month it was meant
for.

The override suppresses admission and the in-flight stop only. `status.paused`,
`pauseReason`, the `pauses` list, alerts, thresholds, delivery, and the budget itself are
unchanged; statuses gain `overrideId` and `overrideExpiresAt`, and `GET /api/budgets`
returns active `overrides` so the UI can keep the cap visible while new work is allowed.
`POST /api/budgets/overrides` creates or extends; `DELETE /api/budgets/overrides/:id`
revokes idempotently. A grant does not re-run evaluation: it only relaxes admission, cannot
require a stop, and `GET /api/budgets` reads active overrides live. A revoke does re-run
evaluation immediately, so the enforcer stops live turns in a scope that is still over its
cap; expiry is observed at the next evaluation (within 60 seconds) because there is no
per-override timer. Admission checks the overall override before the overall pause and
then the cell override, and `SpendCapEnforcer` therefore leaves covered live turns running
on its next check. A failed override read still fails open and is reported to
`usage.budgets` with `phase: admission`. Rows are bounded by
`retention.spendCapOverridesDays` (default 400 days) and pruned by the hourly retention
job in whole UTC budget months (see D97); the default matches the budget-alert retention
default. Policy edits and cell deletion do not rewrite or revoke
override rows; an inert
row simply expires.

**Cost.** One additive table and two routes, plus one shared SPA control. Turns already
stopped by a cap stay stopped, and a live turn keeps running while the override is active;
ending the override stops covered live turns at once, while an expiry is noticed by the
next evaluation. There are still no spend reservations or automatic replay. There is no
operator identity or approval workflow; the optional note is the only context recorded. A
read-only history view is D83; override grant/extension/expiry notifications are D84;
per-request overrides remain separate work.

## D69. Blank path overrides are ignored, with a startup warning

**Context.** `readEnv` treats an empty string as a defined value, which is right for
`APS_DEFAULT_MODEL=''` ("use the CLI default") and MCP's intentional empty request id.
Applied to a filesystem path it is not: `APS_DATA_DIR=''` made `resolvePath` return an
empty path, `pluginsDir` and request workdirs became relative, and `APS_DB=''`,
`APS_WEB_DIR=''`, and the other path variables were passed to SQLite, static serving,
and the harness spawn exactly as written. Whitespace-only values behaved the same way.

**Decision.** `loadConfig` reads its path settings through `readNonEmptyEnv` instead of
`readEnv`. A blank or whitespace-only value is ignored: the lookup continues with a
non-blank `SBOX_*` alias and then the existing default/legacy-location chain. The guard
covers `DATA_DIR`, `CONFIG`, `PROCESS`, `ERROR_LOG`, `DB`, `WEB_DIR`, `DOCS_DIR`,
`PLUGINS_DIR`, `TERMINAL_CWD`, `HARNESS_BIN`, `CLAUDE_BIN`, and `OPENCODE_BIN`. Startup
warns once through `console.warn`, names only, and never a value. `readEnv` and every
non-path setting keep their existing semantics, and `APS_DB=':memory:'` remains valid.
Non-blank paths are returned verbatim: no trimming, `~` expansion, or `path.resolve`, so
spaces and deliberate relative paths still work.

**Cost.** A blank override no longer fails fast; the brain runs on the default or the
legacy alias and the only signal is the one startup warning. A blank APS value therefore
can fall back to a still-set `SBOX_*` alias instead of blocking it. D46's rule that an
empty APS value wins still applies to every non-path setting; this is a deliberate
path-only exception.

## D70. Invalid settings blocks recover on their own

**Context.** `SettingsStore.load()` merged every block over its defaults and then
validated the whole object with one zod schema. A single bad value — a hand-edited
`budget.alertAtPercent`, a malformed SMTP port, an invalid bot token — failed the parse,
so the store returned all defaults. The next `PATCH /api/config` wrote those defaults
back, silently discarding unrelated blocks including a saved webhook URL and its signing
secret; the loss only appeared after a restart.

**Decision.** Validate ten units independently: `master`, `summary`, `usage`,
`retention`, `budget`, and the five `notifications` channels (`webhook`, `email`,
`slack`, `discord`, `events`). The field-level default merge still runs first, so
partial and legacy files keep their saved values and gain new defaults. A unit that
fails validation is replaced with that unit's `DEFAULT_SETTINGS` value, reported once as
`settings.invalid` with the unit name in `context.block`, and every other unit loads
unchanged. An unreadable, unparseable, or non-object file still falls back to all
defaults (`settings.unreadable`, or `settings.invalid` with `reason: 'not-an-object'`),
and a final whole-object parse keeps a future block from slipping through unnoticed.
A parse failure is reported as `invalid JSON` plus the parser's position when available
(`reason: 'invalid-json'`); the raw V8 message is never logged, because it can quote the
input and `config.json` can hold credentials. Loading never writes; the next successful
patch persists the recovered default. D76 preserves the file's original bytes before
that patch rewrites it.
Notification channels are separate units because they hold separate credentials: a bad
email port must not reset a webhook secret.

**Cost.** A bad field resets its whole unit, so an invalid `alertAtPercent` also drops a
saved `monthlyUsd` from the loaded settings. There is no last-valid-value cache — the
store loads once per process — and per-field salvage is unsound because the block
`superRefine` rules are cross-field. Reports carry the block name, file path, and zod
issue paths only, never the URL, secret, password, token, or channel id. The recovery
table adds a modest amount of schema wiring and a coverage test that fails when a future
block or channel is added without a recovery unit.

## D71. Blank XDG base directories are ignored too

**Context.** D69 made blank APS/SBOX path overrides fall back to an alias or default, but
`loadConfig` still read `XDG_CONFIG_HOME` and `XDG_STATE_HOME` with `??`. An empty or
whitespace-only value therefore produced relative `config.json`, `process.json`, and
`errors.log` paths, and built a relative legacy candidate that could hide an existing
`sandbox-harness` location.

**Decision.** Add `readNonBlankEnv(env, key)` for one exact env name and read both XDG
base directories through it. A blank or whitespace-only base is ignored: resolution
falls back to `<home>/.config` / `<home>/.local/state` and then the existing
canonical/legacy choice, so a real legacy location can still be selected and reported in
`legacyPaths`. The startup blank-path scan reports the two exact XDG names alongside the
APS/SBOX path names, sorted and names-only. Non-blank values stay verbatim, with no
trimming, `~` expansion, or `path.resolve`; `readEnv`, `readNonEmptyEnv`, and every
non-path setting keep their semantics.

**Cost.** A blank XDG base now runs on the default or legacy location instead of failing
fast, and the only signal is the startup warning. `HOME` has no such guard; a blank
`HOME` still makes the fallback bases relative and is separate work.

## D72. Terminal transitions retire legacy branches automatically

**Context.** D7 kept every branch on worktree removal and left legacy `sbox/<id>` refs
for an operator running `npm run migrate:branches`. That made the rebrand's cleanup a
manual chore, and terminal requests could keep a legacy ref indefinitely.

**Decision.** `Engine.dispose` runs the per-row retirement after `removeWorktree`, so
every terminal path (`done` through index/finalize or transition, and `dropped` through
transition/drop) uses one hook. The helper reuses the CLI's conservative decisions:
rename a lone legacy ref, delete it only when contained in `aps/<id>`, repair a row
whose legacy ref is gone, and skip non-terminal, checked-out, missing, and diverged
rows. DB updates reuse the guarded `migrateLegacyBranch` and preserve `updated_at`. A
separate `LegacyBranchSweeper` runs at startup and hourly to cover rows that were
already terminal and to retry transient git failures; it is not folded into
`ArtifactRetention` because that service is disabled when `requestArtifactsDays` is 0.
Automation applies directly because its dispositions cannot lose commits. Diverged
pairs are logged, never resolved automatically, and there is no disable setting.

**Cost.** A terminal transition now performs a few git probes when the row still stores
a legacy branch; canonical rows do no git work. A persistent divergence logs once per
hourly sweep until a human resolves it. Orphan `sbox/*` refs have a separate opt-in
`--prune-orphans` path, and canonical-branch pruning remains separate work.

## D73. SQLite database and sidecars are owner-only

**Context.** `openDb` created the database parent with the default mode and let SQLite
create the database, `-wal`, and `-shm` files at SQLite's default `0644` under the usual
`umask 022`. The database holds every request, KB entry (derived from transcripts),
digest, budget alert, usage row, and scorecard, so any local account could read the whole
brain state. SQLite copies the database file's mode to newly created WAL/SHM sidecars,
but a sidecar that already exists is opened as-is, so repairing only the main file is not
enough.

**Decision.** `openDb` tightens the database with `ensurePrivateFile` before opening it,
so SQLite creates new `-wal`/`-shm` sidecars at `0600`. After `journal_mode=WAL` is set,
a second sweep forces the database, `-wal`, `-shm`, and any leftover `-journal` to
`0600`; that repairs an older install on every startup. A missing database parent is
created `0700`, but an existing parent is never chmodded because the default parent is
the repo/cwd. `:memory:` skips every filesystem call. A chmod failure propagates (fail
closed), matching `writePrivateFile`, `settings.ts`, and `process/store.ts`; the POSIX
mode tests skip on Windows.

**Cost.** This is not encryption at rest, and root can still read the files. The deploy
`upgrade-vps.sh` snapshot is covered by D86. The maintenance `legacy-branches-cli.ts` now
opens through `openExistingDb` (D87), so a direct CLI run also repairs loose files.

## D74. Existing request workdirs are repaired explicitly, not recursively

**Context.** D58 repairs a session when the engine writes it again, but terminal
requests and reserved sessions are never rewritten, and artifact retention never prunes
reserved sessions. A live install can therefore keep `0755` session dirs and `0644`
transcripts indefinitely, even after the owner-only change ships.

**Decision.** Add `npm run repair:permissions`, a built maintenance CLI
(`src/server/src/maintenance/repair-permissions.ts` plus `repair-permissions-cli.ts`). It
is a dry run by default and changes modes only with `--apply`. It scans
`$APS_DATA_DIR/requests`, each direct child session dir, and the known artifacts
(`cwd/`, `opencode/`, `session.json`, `transcript.json`, `mcp-config.json`, and
`opencode/opencode.json`), setting dirs `0700` and files `0600`. It uses `stat` for the
top-level `requests/` path and `lstat` for children, skips symlinks and non-regular
entries, treats `ENOENT` as a skip, continues after other failures, and exits 1 when any
entry fails. It never recurses into `cwd/`, never touches the data-dir root, plugins,
worktrees, SQLite, the error log, or unrelated siblings, and never opens the database.

**Cost.** The repair is an explicit post-upgrade step, not automatic. It is not
encryption at rest and root can still read the files. A boot-time recursive repair is
rejected because `cwd/` contains unrelated git checkouts and repository files. The
automatic post-upgrade hook and the error-log/data-root modes are separate work.

## D75. Unreadable conversation state is reported and preserved

**Context.** `readStoredSession` and `loadTranscript` treated every failure as empty
state: a missing file, an `EACCES`/`EISDIR` read error, torn JSON, or a valid JSON value
of the wrong root shape all became `null` / `[]`. The next `writeSession`,
`writeStoredUsage`, or `saveTranscript` then replaced the file, destroying the only copy
of the transcript or the adapter session id. D58/D73/D74 fixed modes and repairs but
deliberately left the read paths alone.

**Decision.** Add a three-state engine reader: only `ENOENT` is "missing"; any other
read error, invalid JSON, a non-array `transcript.json`, or a non-object
`session.json` is "unreadable". Reads still return the empty fallback and never mutate a
file, but report the first unreadable observation per path per process (error sink plus
`console.warn`, shared `warnOnce` key) with `session`, `file`, and a safe reason
(`unreadable: <code>`, `invalid JSON`, `not a JSON object`, `not a JSON array`). Before a
write to an unreadable file, rename it to `<name>.unreadable-<timestamp>-<random>` in the
same directory, chmod `0600`, then write through `writePrivateFile`. If the rename fails,
log `preserved: false` and skip the write rather than throw; `finishTurn` calls
`saveTranscript` from a `finally`, so a throw there would strand the turn. Never copy
`JSON.parse` text or file contents into a log. The bulk `repair:permissions` scan stays
exact-name and does not include quarantine files.

**Cost.** The old transcript is preserved but not merged: the live transcript restarts
from messages produced after the corruption. A corrupt `session.json` cannot be resumed,
so the next turn starts a fresh harness session. Quarantined files accumulate until
artifact retention deletes the whole workdir, and the request UI still shows the empty
fallback (follow-up `48054349`). There is no size cap or CLI for quarantine files, no
JSON salvage, and no encryption at rest; root can still read them.

## D76. An unusable settings file is preserved before the first overwrite

**Context.** D70 recovers an invalid `config.json` unit by unit in memory and leaves the
file untouched while loading. The next `PATCH /api/config` then writes the recovered
defaults back, so the saved values that failed validation — and, for malformed or
non-object files, the whole original file — are silently destroyed. That is D70's
documented cost, but the operator has no copy to inspect or restore.

**Decision.** A load that could not use the file as-is marks the store: a read error
other than a missing file, invalid JSON, a non-object top level, any unit replaced by
`recover()`, or the final whole-object fallback. Before the first save after such a
load, `SettingsStore` re-reads the file and copies the exact bytes to a sibling
`config.json.invalid-<UTC stamp>` (with `:` and `.` replaced by `-`, and a numeric
suffix if that name exists). The copy is written with `writePrivateFile` (`0600`,
because it can hold a webhook secret, SMTP password, or bot tokens) and never overwrites
an earlier copy. Loading still never writes; a clean or missing file never creates a
copy, and the flag clears after one copy so later saves in the same process do not
duplicate it. Success warns once with both paths only. If the copy cannot be written,
the save is refused and reported as `settings.backupFailed`, so the file is never
replaced without one.

**Cost.** Copies accumulate until an operator deletes them; bounding them is separate
work. The snapshot is not encrypted and is never read back or repaired automatically. A
file edited on disk after the process loaded it is outside this rule; the store saves
its in-memory view either way. D88 surfaces the copy's path on the Config page.

## D77. Budget alert history has a configurable, period-safe retention window

**Context.** `budget_alerts` kept every acknowledged alert forever, and
`budget_alert_deliveries` was pruned only once at notifier start with a hardcoded 400-day
age. That made the outbox grow with every alert/destination attempt, ignored settings
changes until a restart, and could not be disabled or tuned by an operator.

**Decision.** Add `retention.budgetAlertsDays` (default 400, `0` = keep forever, max
3650) and prune both tables from the existing startup/hourly `DataRetention` pass. Delete
only terminal `budget_alert_deliveries` rows (`delivered`, `failed`, `skipped`) and only
acknowledged `budget_alerts` rows, in 1000-row batches with an event-loop yield. Cap the
effective cutoff at the start of the current UTC period: a delivery row is the
`(alert_id, destination_id)` idempotency record, a current-month acknowledged alert
suppresses a lower-severity alert through `hasAcknowledged()`, and current-month
failed/skipped rows must stay resendable. `pending`/`delivering` rows are never pruned,
and unacknowledged alerts stay under budget reconciliation. Deleting an expired
acknowledged alert leaves its snapshotted delivery history in place; terminal delivery
rows are pruned by the delivery pass and orphaned pending rows are skipped by the notifier
drain (D78). Add `idx_budget_alert_deliveries_created` for the cutoff scan; `budget_alerts`
already has a `created_at` index. Each table reports its own result and one
`retention.prune` failure, and the old notifier-start delivery prune is removed. The
operational event outbox is handled separately by D89.

**Cost.** The current UTC month is never pruned, so a window shorter than a month behaves
as "keep the current month"; the default 400 days preserves the previous delivery
behaviour. Expired acknowledged alerts keep their snapshotted delivery history until the
delivery rows themselves expire. There is no rollup, per-channel window, manual prune, or
`VACUUM`, and `notification_event_deliveries` retention is handled by D89.

## D78. Delivery history snapshots its alert instead of cascading with it

**Context.** D63 built the read-only delivery history as a join over
`budget_alert_deliveries` and `budget_alerts`, and left the delivery row's
`ON DELETE CASCADE` in place. Budget evaluation deletes unacknowledged alerts whenever a
budget is cleared or changed, the warning identity changes, a cell disappears, or the UTC
month rolls over. Those deletes removed the corresponding history, so an operator could
not audit why an alert failed after the alert itself was gone. D77 added retention that
also deletes acknowledged alerts, which had the same effect through the cascade.

**Decision.** Store the alert fields on each delivery row at enqueue time: `scope`,
`scope_id`, `threshold`, `alert_at_percent`, `budget_usd`, `spend_usd`,
`unknown_cost_turns`, `alert_period_start`, `alert_created_at`, and
`alert_acknowledged_at`. Drop the `budget_alerts` foreign key and its cascade; keep
`UNIQUE(alert_id, destination_id)` as the idempotency record. History reads the snapshot
only, keeps resolving the cell name live with a `Deleted cell` fallback, and never returns
a destination or payload. Snapshot values are immutable except that acknowledging an alert
stamps `alert_acknowledged_at` on its delivery rows in the same transaction. The send path
still refuses to deliver an alert that no longer exists and marks orphaned pending rows
`skipped` during the drain. Resending an orphan returns `409 alert_deleted`; a missing
delivery id still returns `404`. The table is rebuilt on migration from either earlier
shape, backfilling snapshots from `budget_alerts` and keeping `destination_id = channel`
when the oldest table had no destination id.

**Cost.** One table rebuild and ten columns. Snapshot budget/spend values are point-in-time
and can differ from the latest alert or budget; that is the intended audit semantics.
Alert rows and delivery rows are no longer transactionally coupled after enqueue, so the
orphan sweep is the guard against sending a deleted alert. Migrated rows whose alert was
already gone get safe default snapshot values; current installs cannot have that state
because the old cascade removed them first. Resends remain unattributed. D81 later adds
event rows to the same history and resend view without changing this budget snapshot.

## D79. Finalize is a manual-only segment

**Context.** When a cell enabled the Finalize segment, the master prodded every idle
request in `finalize` each `idleMinutes`. Cycles evaluate right-to-left and fill the
cell's spare `maxConcurrent` from the latest segment first, so those digest-proposal turns
took the whole bucket and starved `plan`, `implement`, `review`, and `merge` until the
operator indexed. The digest is also the one step that closes a request into the KB, so
turning it into an automatic loop contradicts the human gate.

**Decision.** `isSchedulableSegment` in `process/definition.ts` excludes `finalize`; the
master filters evaluation and candidate selection through it, so no stored policy can
make Finalize a candidate. Existing `process.json` files with `finalize.enabled: true`
still load and are accepted by `PATCH /api/process`; the flag is ignored rather than
migrated or rejected. The process editor shows Finalize as a “Manual” segment with its
schedule controls disabled. Review and Merge still advance a request into `finalize` on
`READY TO FINALIZE`, and the manual route (`POST /api/requests/:id/finalize`,
`finishRequest`, `index-all`) is unchanged.

**Cost.** A request that reaches Finalize no longer gets an automatic digest proposal, so
**Index all** skips it as `no_digest` until the human presses Finalize or writes the
digest. The finalize segment entry and its schema fields remain for config compatibility,
but its prompt, idle threshold, caps, and enable flag no longer affect any turn. The
master no longer converts a finalize backlog into queued work; that is intentional.

## D80. Scorecard failures reuse the operational event outbox

**Context.** D66 added `turn.failed` and `master.error` to the signed webhook/SMTP-event
outbox, but scorecard generation failures still reached only the scheduler's per-cell
`lastError`, the scorecard card, and the local `summary.generate` log. An unattended cell
could stop producing scorecards without an operator watching the UI, even though the same
webhook/email channels were already configured for other operational failures.

**Decision.** Add `summary.failed` as a third kind under
`notifications.events.summaryFailures`, with independent webhook/email flags defaulting
false. `SummaryService` emits once per failed generation through the existing
`NotificationService.observeSummaryFailure` path: an engine result/exit/timeout/turn maps
to `summary.result|exit|timeout|turn` with the engine's safe reason; empty model output is
`summary.empty`; a write failure is `summary.store`; an unexpected start/turn error is
`summary.turn`. A cap stop, the already-running guard, and a cell deleted mid-run are not
failures and do not notify. The v1 `summary` envelope carries only cell id, classification,
safe reason, and timestamp; raw failure text stays in the transcript and `summary.generate`.
The dedupe key is cell+source+safe reason+UTC hour, so a failing scheduler retries produce
at most one message per channel per hour. Delivery reuses D66's destination hashes, signing,
timeout, retry, `Retry-After`, crash recovery, and the configurable event-retention window
from D89; event routes remain
webhook/email only. SQLite cannot alter the existing `kind` CHECK, so `migrate()` performs
a one-time table rebuild that preserves every delivery row and the unique key.

**Cost.** One small setting, one Config row, one SummaryService callback, and one guarded
table rebuild. Event delivery history/resend were later added by D81, and D82 adds
per-cell routing and configurable coalescing windows; bot event routes remain out of scope.
A scorecard failure emits after the generation has already rejected, so the hook is
advisory and cannot change scheduler backoff or an HTTP response.

## D81. Delivery history and resend cover operational events

**Context.** D63/D78 built a read-only audit and guarded manual resend for budget-alert
deliveries only. D66 added a sibling `notification_event_deliveries` outbox for
`turn.failed`, `master.error`, and `summary.failed`, but the Config page exposed only
aggregate event pending/failed counts. An operator could not see which event failed,
why, or re-queue a failed/skipped event row without editing SQLite.

**Decision.** `GET /api/notifications/deliveries` reads both outboxes and returns one
newest-first list with a `source` discriminator. Budget rows keep `alertId` and their
immutable alert snapshot; event rows carry a safe `event` projection built with the same
pure envelope builders used outbound: kind, title, human text, failure source/reason,
turn/request/cell ids, segment, and occurrence time (scorecard rows carry source/reason
and no request/segment). Event history never returns
`destination_hash`, a URL, credentials, recipients, raw payload JSON, stderr, prompts,
transcripts, diffs, or model output. An unreadable payload renders a fallback label
instead of hiding or throwing. The merge is `(created_at DESC, id DESC)`; `total` is the
sum of matching per-source counts, and `limit`/`offset` apply to the merged list. Filters
add `source` (`budget|event`) and `kind`
(`turn.failed|master.error|summary.failed`); the two are mutually exclusive, `alertId`
is budget-only, and incompatible combinations are `400`.
Channel, status, and the `[from, to)` window apply to both sources.

`POST /api/notifications/deliveries/:id/resend` looks up the budget row first and then the
event row. Event resend re-queues only `failed`/`skipped` rows and requires both the
kind/channel event flag and the channel to be enabled/configured. A disabled route is
`409 event_disabled`, rather than overloading `channel_disabled`, so an operator's
per-event opt-out is never bypassed. The row is reused (`attempts` reset,
`next_attempt_at` now, `delivered_at` cleared, `format`/`destination_hash` re-stamped,
`last_error` preserved) and drained by the normal notifier. `pending`/`delivering` remains
an idempotent no-op, `delivered` remains immutable, and unknown ids remain `404`.
`idx_notification_event_deliveries_created` supports the audit sort and retention scan.

**Cost.** No table rebuild, new route, or dependency. Merged pagination fetches
`offset + limit` from each included source and merges in the service; the existing
100-row page cap bounds it. Event history remains webhook/email only because event routes
do, and event rows use the configurable retention window from D89. The event projection is
read-time: a renamed or deleted cell shows its current name or `Deleted cell`, and
malformed legacy payloads show a safe fallback rather than their raw body.

## D82. Event notifications expose a coalescing window and per-cell routes

**Context.** D66 and D80 put `turn.failed`, `master.error`, and `summary.failed` into
`notification_event_deliveries` with one row per failure signature per UTC hour, and every
enabled webhook/email route received every cell's events. Operators with several teams need
a shorter or longer noise window and a way to send one event kind/channel only for selected
cells. The outbox already has a stable per-signature identity, a destination hash, and a
drain that skips pending rows, so this is a policy extension rather than a second transport.

**Decision.** Add `notifications.events.coalesceMinutes` (integer 1–1440, default 60) and
`notifications.events.routes` (`{ kind, channel, cellId }`, default empty, at most 200).
The coalescing window is a fixed tumbling bucket anchored at the Unix epoch, so the default
60 exactly preserves the old UTC hour; the dedupe key includes the signature, window
length, and window start. Routes are an optional allowlist per `(kind, channel)`: no route
for that pair means every cell (including unassigned turn failures), and one or more routes
mean only exact cell-id matches. The kind/channel boolean and global channel enablement
still gate delivery. A nullable `cell_id` on each event row lets the drain mark pending
rows outside the current allowlist `skipped`; delivered/failed history and destination-hash
rotation keep their existing behavior. Arrays replace wholesale in a patch, and the event
settings remain one recovery unit.

**Cost.** The event settings and Readme/API shape grow by two fields and the table by one
nullable column; no row rebuild or new dependency. Narrowing a route is terminal for
already-pending rows, and enabling a route later never revives them. Changing the window
starts a new key space, so one duplicate message is possible in the transition window;
existing rows are never re-keyed. Per-cell destination URLs, per-kind windows, native
Slack/Discord event routes, and an explicit per-destination rate cap remain separate work.

## D83. Spend-cap override history is a read-only view over retained rows

**Context.** D68 stores each hard-cap snooze in `spend_cap_overrides` and keeps revoked and
expired rows until their retention window passes, but the operator UI only exposed the
currently active overrides. There was no way to see when an override was granted, whether
it had been extended, or whether it was revoked or simply expired.

**Decision.** Expose the retained rows as a read-only history instead of adding a second
event ledger. Add `extended_at` and `extension_count` to the existing table: a re-grant
increments them only when the stored `expires_at` moves later, so a note-only or shorter
re-grant refreshes `updated_at` without claiming an extension. Existing rows read `NULL`/`0`;
pre-migration extensions are not backfilled. `GET /api/budgets/overrides/history` lists
active, revoked, and expired rows across UTC periods, newest period then newest grant, with
optional `scope`, `cellId`, `state`, `from`/`to` period bounds, `limit`, and `offset`. State
is derived at read time (`revoked` wins over `expired`, then `active`). `active` is a
lifecycle state, not a policy-effectiveness check: a budget/cell edit can leave a row inert
and the live status/banner remains the source for current pause coverage.

The route is read-only: it never writes, evaluates budgets, admits or stops a turn, changes
alerts, or logs expected reads. The Config page renders a **Spend cap override history**
card after **Spend budgets**, with scope/state filters, 10-row pagination, refresh, and
columns for scope, state, period, granted, extended, expires, revoked, and note. It
refetches after a snooze or end-override. Deleted cells resolve to `Deleted cell` live. The
existing override prune bounds history; there is no new retention setting, export, identity,
or "who" attribution. A re-grant after expiry reopens the same row, so intermediate expiry
gaps and each extension's prior expiry are not retained. A per-event audit ledger remains
separate work.

**Cost.** Two additive columns, one read-only route, and one SPA card. No new table, event
write path, dependency, or change to budget, alert, admission, enforcement, or delivery
semantics.

## D84. Spend-cap override transitions reuse the operational event outbox

**Context.** D68 made hard-cap snoozes durable and D83 exposed their history, but an
operator who was not watching the UI had no out-of-band signal when a snooze started or
ended. The existing `notification_event_deliveries` outbox already provides signed
webhook/email delivery, retry, history, status, and resend; a second transport or a
synthetic budget alert would duplicate that machinery and disturb the alert model.

**Decision.** Add `spend.override` as a fourth event kind under
`notifications.events.spendOverrides` (default webhook/email off) with payload `change:
granted | extended | expired`. A successful grant emits synchronously when the stored
expiry moves later (or the row is new) and the target status is still `paused`; a no-op
re-grant, a pre-authorized grant while under budget, and a rejected grant are silent. An
expiry is observed by the existing 60-second budget evaluation. A new nullable
`spend_cap_overrides.expiry_handled_at` marker records that the transition was evaluated;
the evaluator emits only when the scope is still `paused` and `status.overrideId` is null,
then marks the row handled even when it stays silent, so a later spend increase cannot send
a stale expiry. A later-expiry grant clears the marker. Revocation is not notified, and an
expiry covered by another active override (for example an active overall override on a
cell row) is silent; the covering row's own expiry notifies when coverage ends. Dedupe is
`override:<id>:<change>:<expiresAt>` rather than the failure coalescing window, so an
extension is a new event and an identical repeat is suppressed. Cell event routes restrict
cell-scoped override events, but an overall override has no cell and is never filtered by a
route. The payload carries ids, scope, pause reason, budget/cap spend, lower-bound flags,
expiry, and the optional note; it never carries prompts, transcripts, destinations, or
secrets. The table kind CHECK is extended by a guarded rebuild that preserves `cell_id`.

**Cost.** One additive column, one event kind/route, one BudgetService callback plus the
expiry sweep, and Config copy. No new HTTP route, dependency, alert, admission, pause,
banner, or in-flight behavior change; override notifications are advisory and may lag an
expiry by up to one budget evaluation.

## D85. Recovered settings warnings reach the Config page

**Context.** D70 recovers an invalid settings unit to its defaults and reports
`settings.invalid` only to the error log and the server console; D76 preserves the
unusable file on the next save. An operator who opened the Config page after a bad
hand-edit saw defaults with no explanation and no way to tell which block had been reset.

**Decision.** `SettingsStore` retains the units recovered by the load that produced the
cached settings and exposes them through `warnings()`. Each entry is `{ block, message }`:
`block` is the same unit name reported as `settings.invalid` (`master`, `budget`,
`notifications.email`, and so on), or `null` when the whole file was unusable; `message`
is the zod issue text for a unit and a fixed reason for a file-level failure. A missing
file is silent; a read error keeps only the short error code. Reports never carry a saved
URL, secret, SMTP password, bot token, channel id, or raw file content. `GET` and `PATCH
/api/config` return `warnings`, so the Config page can name every reset block in one
non-dismissible banner. The list is per-load in-memory state, not persisted and not a
`config.json` key. A successful patch rewrites the file with the recovered defaults and
preserves the original (D76), so it clears the list; a rejected patch leaves both the file
and the warnings untouched. The banner adds no repair action: saving any card is the
existing resolution path, and every Config-page save applies the path and warnings from
the response through one helper. The contract lives in a Node-free module so the SPA can
re-export the type without pulling `node:fs` into its bundle.

**Cost.** One pure contract module, a store accumulator, two additive response fields, and
one Config card. No change to validation, recovery, backup, redaction, or which blocks
exist.

## D86. Upgrade run directories and database snapshots are owner-only

**Context.** `deploy/upgrade-vps.sh` wrote its `VACUUM INTO` snapshot to
`~/.aps-cutover/upgrades/<UTC>/db-backup.sqlite` inside a directory created with a bare
`mkdir -p`. Under the usual `umask 022` the run directory was `0755` and the snapshot
`0644`, so any local account could read the full brain state (every request, KB entry,
digest, budget alert, usage row, and scorecard) from the pre-upgrade snapshot. The run
directory also holds `upgrade.log`, `state`, the before/after JSON evidence, and the
dist/node_modules rollback trees. The snapshot is especially sensitive because an operator
may copy it out before a manual restore.

**Decision.** Every run directory is created owner-only: `prepare_run_dir` runs
`mkdir -p` under a local `umask 077` and then forces the directory to `0700`. The same
helper runs on the internal `--run --run-dir` path, so a retried run tightens a directory
left at `0755`. A missing `~/.aps-cutover`/`upgrades` ancestor chain is created `0700`; an
existing ancestor is never chmodded, matching D73's parent-directory rule. The `node`
subprocess that runs `VACUUM INTO` also runs under `umask 077`, so the destination and any
`-wal`/`-shm` sidecars created on the live database by that direct open are private; the
snapshot is then explicitly forced to `0600`. Both chmods fail closed through the existing
`set -Eeuo pipefail`/`on_error` path. The snapshot is taken before any clone mutation, so a
mode failure fails the run with the service and clone unchanged. No global umask is set;
the rest of the run keeps its current behavior.

**Cost.** One shell helper, two call sites, one extra `umask` line, and one `chmod`. The
snapshot contents, timing, `VACUUM INTO`, retention, and manual restore path are unchanged.
This is not encryption at rest, and root can still read the files. Run directories and
snapshots left by an earlier version are tightened by `npm run repair:upgrades` (D93).
The cutover sibling is covered by D94.

## D87. Maintenance opens share the owner-only database path

**Context.** D73 hardened `openDb` but left `src/server/src/maintenance/legacy-branches-cli.ts`
opening SQLite directly, because `openDb`'s `migrate`/`reconcile` would write to a live
brain and reset a `working` request to `idle`. That direct open never chmodded the
database or its sidecars, so a CLI run against an older store could leave the database or
sidecar files at `0644`.

**Decision.** `db.ts` owns a private `hardenDbFiles` sweep for `''`, `-wal`, `-shm`, and
`-journal`, reused by `openDb` after WAL is enabled. It also exports `openExistingDb`, which
tightens the database before SQLite opens it so new sidecars inherit `0600`, opens with
`{ fileMustExist: true }`, and sweeps again to repair sidecars already on disk. The helper
sets no pragmas and never migrates or reconciles, so maintenance cannot change a live
brain's schema or request state. The CLI calls it and keeps its own `busy_timeout`; it
selects the read-only open for a dry run (D95) and later opted out of the mode sweep there
(D111). A chmod failure propagates (fail closed) unless the caller explicitly passes
`harden: false` (D111).
`src/server/src` may contain `better-sqlite3`/`new Database` only in `db.ts`; a
source-scan test in `test/db.test.ts` enforces it. Test fixtures and the proof scripts are
exempt because they run on throwaway temp roots.

**Cost.** One more exported open path and a source-scan guard that must be updated
deliberately if a future maintenance command needs a different open mode. The dry run
uses the read-only option (D95) and skips the mode repair (D111); `--apply` still opens
read-write and hardens. This is not encryption at rest, and root can still read the files.

## D88. The Config page names the preserved settings file

**Context.** D76 copies an unusable `config.json` to a sibling
`config.json.invalid-<UTC stamp>` before the first save replaces it, but the only place
that names the copy is the server console and the error log. D85 puts recovered-settings
warnings on the Config page, yet the operator who resolves them by saving still has to
read server output to find the preserved original.

**Decision.** `SettingsStore` keeps the path of the copy made by its own save and exposes
it as `preservedPath()`, in memory for the life of the process. `GET` and
`PATCH /api/config` return it as `preservedPath` beside `path` and `warnings`; it is null
when no save has needed a copy, after a missing or valid load, and when the copy itself
failed so the save was refused. The Config page remembers the value from the load and from
every card's save response through the existing metadata helper, and shows a
non-dismissible `role="status"` notice below the recovery banner: the absolute path, a
warning that it may contain credentials, and a reminder to delete it after review. Only
paths cross the API; the store never reads the copy back, and no contents, secrets, or
metadata are added. The value is not a `config.json` key, and the single path is not
reconstructed across restarts; D103 lists the existing copies instead. D104 mirrors the
single-path notice for the global process editor, and D117 lists every process copy.

**Cost.** The notice can outlive a manual deletion of the copy and keeps naming it until
the page or server reloads. The Config page gains one small state field, one response
field on each endpoint, and one card; copying, opening, or pruning the file remains
separate work. D103 adds the cross-restart listing; the single `preservedPath` is still
per-process.

## D89. Notification event history has a configurable retention window

**Context.** `notification_event_deliveries` was pruned only once at notifier start with a
hardcoded 400-day age. That ignored settings changes until a restart, could not be
disabled or tuned, and deleted rows in every status, including a pending or in-flight row
that happened to be older than the cutoff. The outbox grows with every event signature and
channel, so operators need the same bounded history they already have for budget alerts.

**Decision.** Add `retention.notificationEventsDays` (default 400, `0` = keep forever, max
3650) and prune the outbox from the existing startup/hourly `DataRetention` pass. Delete
only terminal rows (`delivered`, `failed`, `skipped`) whose `created_at` is strictly
before `now - notificationEventsDays`, in 1000-row batches with an event-loop yield.
`pending` and `delivering` rows are never pruned; the notifier's crash recovery still
resets stale `delivering` rows on start. The cutoff is not capped at the current UTC
period: an event dedupe key is an epoch-anchored window of at most 1440 minutes, and
retention is whole days, so a terminal row old enough to prune cannot be the dedupe record
for an open window. Reuse `idx_notification_event_deliveries_created`; no table or index
change is needed. Each table reports its own result and one `retention.prune` failure, and
the old notifier-start prune and `NotificationEventDeliveryRepository.pruneBefore()` are
removed.

**Cost.** A terminal event row is history-only once its window passes: it disappears from
the delivery-history card and cannot be resent, which is the retention bound rather than a
new resend rule. `pending` rows stay until the notifier retries, fails, or skips them, so a
stuck pending row can outlive the window; that is deliberate because pruning live work
would race the drain. There is no rollup, per-channel window, manual prune, retention
status endpoint, or `VACUUM`.

## D90. An unusable process file is preserved before the first overwrite

**Context.** D76 preserved an unusable `config.json` before the first save, but explicitly
left `src/server/src/process/store.ts` alone even though it had the same
invalid-then-overwrite shape. `ProcessStore` falls back to a policy derived from the
master settings and leaves the file untouched while loading; the next
`PATCH /api/process` then replaces it, destroying the operator's prompts and policy
without a copy.

**Decision.** A load that cannot use the file marks `ProcessStore`: a non-`ENOENT` read
error, invalid JSON, or a `normalizeProcess`/`processSchema` failure. Before the first
save after such a load, the store re-reads the file and copies its exact bytes to a
sibling `process.json.invalid-<UTC stamp>` (with `:` and `.` replaced by `-`, and a
numeric suffix if that name exists). The copy uses `writePrivateFile` (`0600`) and never
overwrites an earlier copy. Loading still never writes; a clean or missing file never
creates a copy, the flag clears after one copy, and a corrected or removed file at save
time produces no copy. `patch()` loads before writing so a save that is the first
operation still preserves. A failed copy reports `process.backupFailed` and refuses the
save. Success warns once with both paths only; D104 exposes that path on
`GET/PATCH /api/process` and in the process editor.

**Cost.** D98 bounds the preserved copies to the five newest; before that they
accumulated until an operator deleted them. The snapshot is not encrypted, is never read
back, and is not repaired automatically. A file edited on disk after the process loaded
it follows the latest load attempt, so the copy is always the bytes being replaced.
D104 adds the editor notice that names this process's copy; a restart does not
rediscover earlier copies.

## D91. Webhook signatures version the timestamp with the body

**Context.** D55 signed only the raw webhook body. `X-APS-Timestamp` was sent but stayed
outside the HMAC, so a captured request could be replayed with any timestamp and a
receiver had no way to enforce freshness. The receiver example shipped later had to warn
that the timestamp proved nothing.

**Decision.** Keep `X-APS-Signature: sha256=<hex>` unchanged for compatibility and add
`X-APS-Signature-V2: t=<ms>,v2=<hex>` whenever a signing secret is set. `t` is the same
send-time millisecond value as `X-APS-Timestamp`; `v2` is HMAC-SHA256 over the exact ASCII
timestamp digits, a literal `.`, and the exact raw body. Every format is signed the same
way. Each attempt, including retries and Send test, uses the attempt's current clock, so
retries are fresh rather than stale. The receiver example requires V2, enforces a
five-minute window by default, and rejects stale or far-future timestamps. The old
body-only header and `verifyWebhookSignature` remain for older receivers and weaker
compatibility; legacy-only requests do not prove freshness. The same 16-256 character
secret signs both headers, with no setting, API, or storage change.

**Cost.** Every request computes one extra HMAC. Operators who only check the legacy
header stay replayable until they migrate, and clocks skewed by more than the tolerance
will reject valid deliveries. A replay inside the window still needs receiver dedupe on
authenticated body ids; the timestamp is not a nonce and the example intentionally adds no
seen-set. Removing the legacy header is a separate, breaking change.

## D92. Scorecard history is filtered by report generation time

**Context.** The Scorecards page grouped all persisted `cell_summaries` rows by cell and
asked for a fixed newest-10 or newest-25 per cell. Operators could not scope the page to a
recent stretch or page farther back; a cell whose latest report was older than the window
still looked current, and widening to "all" silently dropped rows behind the fixed limit.

**Decision.** Add optional `since` (inclusive `created_at`) and `before`/`beforeId`
(exclusive `(created_at, id)` keyset) filters to `GET /api/summaries` and
`SummaryRepository.list()`. The page defaults to the last 72 hours, offers
24h/72h/7d/30d/All, and requests 25 reports per cell plus one probe row to decide whether
to show **Load older**; the next page uses the oldest rendered report's `created_at` and
`id` as the cursor. The period filters by generation time, not `window_start`/`window_end`;
a report generated inside the period is shown even when its own window starts earlier.
The API has no default filter, so `MasterDetail`'s latest-five call and any other caller
keep today's behavior. The drawer is unchanged.

**Why keyset, not offset.** New reports are inserted at the head while an operator pages.
An offset would duplicate or skip rows; `(created_at, id)` is stable and `id` breaks ties
without a new column. The existing `idx_cell_summaries_created` and
`idx_cell_summaries_cell_created` indexes cover the predicates.

**Cost.** The page makes one request per cell and one extra row per page; no schema,
index, scheduler, retention, or report-content change. **All** is bounded by
`retention.cellSummariesDays` and still keeps one row per cell, so the page never implies
unlimited history. A flat cross-cell feed and a custom date picker are separate work.

## D93. Existing upgrade run directories and snapshots are tightened explicitly

**Context.** D86 made new `deploy/upgrade-vps.sh` runs owner-only, but evidence written
before that change is still `0755`/`0644` under the usual umask. Retention keeps only the
five newest terminal runs and never prunes a non-terminal one, so an old loose snapshot
can remain on disk indefinitely once upgrades stop. `repair:permissions` (D74) is limited
to `requests/`, and `prune:cutover` only removes `~/.aps-cutover/runs`.

**Decision.** Add `npm run repair:upgrades`, a built maintenance CLI
(`src/server/src/maintenance/repair-upgrade-permissions.ts` plus
`repair-upgrade-permissions-cli.ts`). It is a dry run by default and changes modes only
with `--apply`. With `--root DIR` (default `$HOME/.aps-cutover`) it scans only
`DIR/upgrades`, one level deep: it sets the `upgrades` directory and every direct run
directory to `0700`, and every top-level regular `db-backup.sqlite` to `0600`. It uses
`lstat`, never follows a symlinked run directory or snapshot, skips non-directory children
and non-regular snapshots, treats `ENOENT` as a skip, continues after other failures, and
exits 1 if any entry failed. It never deletes, reads file contents, or opens SQLite. The
`.aps-cutover` ancestor, `runs/`, `dist-backup/`, `node_modules.bak/`, and other files keep
their modes: the `0700` run directory protects the evidence, while the snapshot is
additionally `0600` because it may be copied out. The repair is an explicit post-upgrade
step, not a hook in `upgrade-vps.sh`.

**Cost.** Operators must run the repair once after the first fixed upgrade, and the built
CLI needs `npm run build` first, like `repair:permissions`. It is not encryption at rest,
root can still read the files, and `cutover-vps.sh` runs are covered by D94 and repaired
explicitly by D110. Snapshot contents are unchanged.

## D94. Cutover run directories are owner-only

**Context.** `deploy/cutover-vps.sh` created
`~/.aps-cutover/runs/<UTC>/` with a bare `mkdir -p` on both the detached launch and the
internal `--run --run-dir` path. Under the usual `umask 022`, `~/.aps-cutover`,
`runs`, and the run directory were `0755`, so any local account could read the cutover
evidence: `config-before.json`/`config-after.json`, `errors.log.before`,
`before.json`/`after.json`, `cutover.log`, `state`, `worktrees.before`, the copied
`cutover.sh`, the pre-build `dist/` tree, and `backup/systemd/` — the unit and drop-in
copies that are the only in-place rollback artifact. The run directory is the evidence
an operator reads after the detached turn dies with the old unit.

**Decision.** Mirror D86. `prepare_run_dir` runs `mkdir -p` under a local `umask 077`,
then forces the leaf to `0700`. It runs on both creation sites; the internal path's
`check_pruner` still runs first, so the existing "fails before creating the run
directory" contract is unchanged. A retried `--run --run-dir` tightens a directory left
at `0755`. A missing `~/.aps-cutover`/`runs` ancestor chain is created `0700`; existing
ancestors are never chmodded, matching D73/D86. `point_latest` also creates a missing
`~/.aps-cutover` under `umask 077`, because an internal run whose `--run-dir` is outside
the root would otherwise leave the `latest` symlink parent world-readable. Mode failures
fail closed through `set -Eeuo pipefail` and, inside `run_cutover`, `on_error`; the
detached launch fails before any service or config mutation. No global umask is set.

Directory-level `0700` is the protection boundary; individual evidence files and the
copied script keep their current modes, exactly as D86 chose for upgrades. There is no
`db-backup.sqlite` here, so no file-level `0600` rule applies.

**Cost.** One shell helper, two call sites, one root `mkdir` change, three tests, and
doc updates. Run contents, timing, names, retention, pruning, and the `latest` target are
unchanged. This is not encryption at rest, and root can still read the files. Run
directories left by an earlier version are tightened explicitly with
`npm run repair:runs` (D110); the shared `~/.aps-cutover` root, which a new install
already creates `0700`, is repaired by that command too (D120).

## D95. The legacy-branch dry run opens SQLite read-only

**Context.** D87 routed the maintenance `migrate:branches` CLI through
`openExistingDb`, but the dry run still opened the live database read-write and only then
set `query_only = ON`. A read-write WAL open can replay or checkpoint the WAL and needs
write access, so the default dry run was not non-mutating.

**Decision.** `openExistingDb` takes an options object with `readonly?: boolean`; the
default is unchanged read-write. It passes `readonly: true` to `better-sqlite3` (SQLite's
own read-only flag) rather than using `immutable=1`, which assumes no concurrent writer
and would be wrong for a live brain. `legacy-branches-cli.ts` opens with
`{ readonly: !options.apply }`, keeps `busy_timeout = 5000`, and drops `query_only`. The
owner-only `ensurePrivateFile`/`hardenDbFiles` sweep ran in both modes at the time; D111
later made the dry run skip it while `--apply` kept hardening and failing closed. The
guarantee is no database-content mutation: a
read-only WAL connection may still create an empty `-wal`/`-shm` or update `-shm` locks
through the wal-index, so it needs the same filesystem access as before. A database that
needs rollback-journal recovery now fails closed with SQLite's read-only-recovery error
instead of being mutated; operators can run `--apply` or open it once normally.

**Cost.** One option on the existing helper and one call-site branch. `--apply` keeps the
read-write open and remains the only path that writes `requests.branch`. D111 later made a
dry run work without ownership/chmod; this is not encryption at rest.

## D96. The brain's systemd unit is sandboxed and the lint gate pins the result

**Context.** The user unit that ships in `deploy/agent-process-segments.service` ran with
systemd's defaults; `systemd-analyze security --offline=yes --user` scored 9.2 UNSAFE. The
brain is a loopback server that also spawns PTYs, `git`, and user-controlled agent CLIs, so
the restrictive directives that usually raise that score (read-only home, private network,
syscall filtering) would break the product.

**Decision.** Add 18 reviewed directives to `[Service]`: `NoNewPrivileges`, `PrivateTmp`,
`ProtectSystem=full`, `ProtectKernelTunables`, `ProtectKernelModules`,
`ProtectControlGroups`, `ProtectKernelLogs`, `ProtectClock`, `ProtectHostname`,
`KeyringMode=private`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`,
`RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`,
`SystemCallArchitectures=native`, empty `CapabilityBoundingSet` and `AmbientCapabilities`,
and `UMask=0077`. D114 later added `PrivateDevices=yes` and `ProtectProc=invisible`; the
unit now scores 3.8 OK on systemd 259.
`scripts/verify-systemd-unit.mjs` (already the `lint:unit` step) asserts the exact
reviewed `[Service]` values, rejects the known-breaking values in any accepted boolean
spelling after normalizing systemd's `0/1`, `no/yes`, `n/y`, `false/true`, `f/t`, and
`off/on` forms, and runs
`systemd-analyze security --offline=yes --user --threshold=48`, so an exposure above 4.8
fails `npm run lint`. The directive map is the primary guard; the ceiling also
catches new checks in later systemd versions. D114 rejected `ProtectHome=read-only`,
`ProtectSystem=strict`, and `ProcSubset=pid` with live evidence and deferred
`RestrictNamespaces` and `SystemCallFilter` until an authenticated Claude Code turn
exercises the real sandbox. `PrivateNetwork`, `PrivateUsers`, and `MemoryDenyWriteExecute`
stay off for the reasons commented in the unit.

**Cost.** In brain terminals, `sudo`/setuid escalation fails, `/etc`, `/usr`, and `/boot`
are read-only, `/tmp` is private, new files are `0600`, and 32-bit binaries do not run.
The security review needs systemd 250 or newer, so older Linux hosts fail `npm run lint`
(a documented, fail-closed choice). Existing installs must copy the new unit by hand
because `upgrade-vps.sh` refuses target commits that change it.

## D97. Spend-cap override retention is a configurable whole-period window

**Context.** D68 stored each hard-cap snooze in `spend_cap_overrides` and pruned rows
during every budget evaluation with a hardcoded 400-day age. That ignored settings
changes until a process restart, could not be disabled or tuned, ran on the 60-second
budget tick rather than the retention schedule, and reported failures as `usage.budgets`
with an `override-prune` phase instead of alongside the other table prunes.

**Decision.** Add `retention.spendCapOverridesDays` (default 400, `0` = keep forever, max
3650) and prune `spend_cap_overrides` from the existing startup/hourly `DataRetention`
pass. Delete rows whose `period_start` is strictly before the start of the UTC budget
month containing `now - spendCapOverridesDays`, in 1000-row batches with an event-loop
yield. The cutoff stays month-aligned: overrides are keyed and browsed by UTC budget
month, the month holding the cutoff is kept whole, and `idx_spend_cap_overrides_period`
already serves the scan, so no `created_at` index or migration is needed. Effective
history is therefore `days` to `days + 31` days rather than an exact age. The current
month is never pruned, and an active override can only exist in the current period. Every
row in an old period is deleted regardless of `revoked_at` or `expiry_handled_at`, exactly
matching the old prune at the default; an unhandled expiry marker older than the window
has long outlived every notification attempt. Remove `OVERRIDE_RETENTION_MS`,
`SpendCapOverrideRepository.pruneBefore()`, and the budget-evaluation prune; failures now
report one `retention.prune` record with the table, cutoff, and deleted count.

**Cost.** Override history disappears with its UTC month rather than at an exact age, and
there is no per-scope window, rollup, manual prune, retention status endpoint, or
`VACUUM`. The history route, state derivation, filters, ordering, and pagination are
unchanged.

## D98. Preserved process copies are bounded to the five newest

**Context.** D90 copied an unusable `process.json` aside before the first save, and its
cost left the copies unbounded. Repeated invalid loads and saves could fill the config
directory with owner-only snapshots, and a stale backlog could outlive the invalid file
that produced it.

**Decision.** After every successful `process.json` write, `ProcessStore` lists the
process file's directory for regular files whose names start with
`<process-basename>.invalid-` and keeps the newest five, deleting older ones oldest
first. Ordering parses the embedded UTC stamp and numeric suffix, so `-10` is newer than
`-2` even when several copies share a millisecond. The copy just written is always
retained, even if a clock change gives it an older-looking name. Directories, symlinks,
the live file, `config.json` copies, and unrelated names are never candidates. Pruning
runs only after the replacement file is written, so a failed copy or save deletes
nothing, and the same pass cleans a backlog left by an earlier version. A failed listing
or unlink is best-effort: it reports `process.pruneFailed` with the process path (and
failed copy path) and the save still succeeds. Loading still never writes; no startup
prune or pruning setting is added. D104 reports the path of the copy just written, which
this pass always retains; D117 reports every copy the directory still holds.

**Cost.** Only the five newest forensic copies are kept; older originals are deleted
without review on the next successful save. An undeletable copy can leave the count above
five until a later save retries, and the error log is the only diagnostic. This is not
encryption, and `config.json` copies remain governed by D76 and D88.

## D99. Documentation links are checked in the web test suite

**Context.** The Markdown gate checks syntax, not destinations. A renamed heading or a
moved screenshot would leave `README.md` and `docs/` with links that render on GitHub but
fail inside the in-app Help, which is the product surface for those pages.

**Decision.** `src/web/src/doc-links.ts` walks every `*.md` file the Markdown gate owns
and resolves inline links, images, reference definitions, and raw `<a>`/`<img>` tags. A
fragment must match an `extractHeadings` id from `src/web/src/docs.ts` exactly, so it is
the same h2/h3 slug Help renders; GitHub's slugger is not consulted because Help, not
GitHub, is where these pages are read. Fenced blocks and inline code are masked, external
schemes and bare `?query` targets are skipped, and nothing is fetched. Problems are
reported as `file:line: target — reason` and fail the web suite; `npm run check:docs`
runs that one file.

**Cost.** One module, one test file, and a package script. The check runs with `npm test`
rather than `npm run lint` because it reuses the app's TypeScript slugger: a standalone
`.mjs` lint step would need either a duplicate slug implementation or native TypeScript
imports, which the documented Node 22.13 floor does not guarantee. Manifest-aware checks
landed later in D113; SPA Help targets in D123, and external-link liveness in D124.

## D100. An opt-in heartbeat file covers a brain whose port is unreachable

**Context.** D46's migration guard combines the systemd unit, a Linux `/proc` scan, and
the brain's `/health` endpoint. None of those sees a brain in another PID or mount
namespace when its port is unpublished, a brain on another host that the migration host
cannot route to, or a non-Linux holder. The operator still needs to move the shared data
directory and SQLite file, and moving them under a live brain can corrupt sessions,
worktrees, and the database.

**Decision.** An opt-in `APS_BRAIN_LOCK=1` (`1`/`true`, legacy `SBOX_BRAIN_LOCK`) makes
the brain write `<dataDir>/brain.lock` at startup and atomically refresh it every 10 s
with its pid, host, port, and timestamps. `migrate-paths` treats a file whose **mtime** is
at most 60 s old as a live brain and refuses a real run; it warns in `--dry-run` and
proceeds with the existing `--allow-running` override. The mtime is observed by the
migration host, so a container or remote clock cannot make a live lock look stale;
`heartbeatAt` is only for the operator message. A fresh file blocks even if its JSON is
unreadable, because file existence and age are the evidence. A stale file and a
permission-denied file are notes and do not block, matching the `/proc` policy. Discovery
checks planned data directories, `~/.sandbox-harness`, `~/.agent-process-segments`, and a
non-blank `APS_DATA_DIR`/`SBOX_DATA_DIR`; `--brain-lock FILE` overrides it for a
nonstandard mount. The writer logs only the first failure of an episode and never stops
the brain.

The pinning constraint is the data directory: detection works only when the brain's
`dataDir` is a bind mount, volume, or network share visible to the migration host. The
alternative, a PID file in a runtime directory, would not cross a container boundary and
a pid is meaningless in another namespace. A file next to the SQLite database for a
DB-only shared volume is separate work.

**Cost.** The check is opt-in, so it only helps after the brain is upgraded and restarted
with the variable. A SIGKILLed brain leaves a file that blocks for at most 60 s; the docs
tell the operator to wait rather than bypass the guard. Two brains sharing one data
directory are unsupported: the last writer owns the file and either stop removes it. The
guard remains point-in-time and does not lock the paths, so a brain that starts between
the guard and the rename is still a race.

## D101. Manual upgrade pruning reuses the cutover pruner

**Context.** `deploy/upgrade-vps.sh` has configurable retention and a `--no-prune` opt-out,
but operators could only prune `~/.aps-cutover/upgrades` by invoking
`scripts/prune-cutover-runs.mjs` directly or deleting run directories by hand. The
pruner already supported `--kind upgrade`, including the `upgrades/` layout,
`upgrades/latest`, and the `rolled_back` terminal state.

**Decision.** Add `npm run prune:upgrades` as a thin alias for
`node scripts/prune-cutover-runs.mjs --kind upgrade`. It forwards extra flags after `--`
and keeps the pruner's 10-run/30-day/7-day-grace defaults rather than copying
`upgrade-vps.sh`'s `--keep-runs 5`; an operator passes `--keep-runs 5` to match the
automatic pass. The script's `--help` names the alias so its `--kind` default is not
misleading. The command needs no build and only touches the selected `upgrades`
directory. Docs cover the dry-run-first workflow, protections, data-loss warning, and a
cron example, and a test pins both package-script entries.

**Cost.** Two command names now address one script, and the manual defaults keep more
evidence than the automatic pass. There is no new scheduling, retention setting,
classification rule, or dependency, and cutover pruning is unchanged.

## D102. Process parse failures log a position-only reason

**Context.** `ProcessStore.load()` fell back to the derived default policy when
`process.json` was not valid JSON, but it reported the caught `SyntaxError` to the error
log and stderr. Recent V8 versions can format that message with a quoted slice of the
input (`Unexpected token 'a', "…" is not valid JSON`), and `process.json` holds
operator-authored prompts, markers, and notes. D70 already redacts the same leak for
`config.json`, whose contents are more sensitive still.

**Decision.** A `JSON.parse` failure in `ProcessStore.load()` is reported through
`jsonParseReason` from `util/json.ts`: `invalid JSON`, optionally followed by the
parser's position and line/column, built only from fixed words and the captured digits.
The sink receives a fresh `Error` with that message and context
`{ path, reason: 'invalid-json' }`, and `console.warn` prints the same reason instead of
`String(error)`. The read-failure branch, which reports an fs error such as `EISDIR` with
a path and errno but no file bytes, keeps its current form. Recovery, the
backup-before-save copy, and the five-copy prune are unchanged.

**Cost.** The log no longer shows the parser's own wording, so an operator debugging a
malformed file gets only a position; Node 20-style messages without a position suffix
collapse to `invalid JSON`. There is no file-content leak, and the preserved
`process.json.invalid-*` copy still holds the original bytes for inspection.

## D103. The Config page lists preserved settings copies across restarts

**Context.** D88 names only the copy the current process made. After a restart that path
is null even when `config.json.invalid-<UTC>` copies still sit next to the settings file,
so the notice disappears and the operator has to inspect the directory to find them.

**Decision.** `SettingsStore.preservedCopies()` scans the settings file's directory for
regular files whose names start with `<basename>.invalid-` and returns their absolute
paths newest first, ordered by the embedded UTC stamp and then the numeric collision
suffix. It is path-only and never reads a copy back. A missing or unreadable directory
returns an empty list without failing the config endpoint or logging, because this is an
optional read-only display path and a missing config directory is normal on a first run.
`GET` and `PATCH /api/config` return the list as `preservedCopies` beside `preservedPath`;
the Config page merges the two, deduplicating and keeping the current process's copy
first, and lists every path in the existing `role="status"` notice. The list is not
pruned or capped here: bounding the files is separate work.

**Cost.** Every config response now scans the settings directory. A legacy backlog is
listed in full until the separate pruning work lands, and a copy deleted after the page
loaded stays on screen until the next response or reload. The list is filesystem state,
not a `config.json` key, and it can include copies made by processes that are no longer
running.

## D104. The process editor names the preserved process file

**Context.** D90 copies an unusable `process.json` aside before the first save, and D98
bounds those copies to five, but only the server console and error log name the copy.
D88 and D103 already let the Config page show a settings copy; the global process editor
had no equivalent, so an operator who resolved an invalid process file by saving had to
read server output to find the original.

**Decision.** `ProcessStore` keeps `preservedFilePath`, set from the copy path returned by
`preserveUnusableSource()` after the copy is written, and exposes it as `preservedPath()`
in memory for the life of the process. `GET` and `PATCH /api/process` return it beside
`path`; it is null until a save creates a copy and stays at that path for later saves in
the same process. The Config page keeps the value from the load and from the process save
response, and passes it to the global `ProcessEditor`, which shows a non-dismissible
`role="status"` notice named "Preserved process file": the absolute path, a warning that
it may contain prompts or policy, and a reminder to delete it after review. The cell
editor does not show it because cell saves write `cells.process_json`, not `process.json`.
Only paths cross the API; the copy is never read back, and no contents or prompts are
added. The value is not a `process.json` key and is not reconstructed across restarts.
D98's copy, prune, and five-copy limit are unchanged; the named copy is the one just
written, which that save always retains.

**Cost.** The notice can outlive a manual deletion of the copy and keeps naming it until
the page or server reloads. A restarted process does not rediscover earlier process
copies through `preservedPath`, so the single-path notice disappears even when
`process.json.invalid-*` files remain; D117 lists them from the directory. Resolving a
copy never happened here and is still out of scope.

## D105. The legacy body-only webhook signature is removed

**Context.** D91 added `X-APS-Signature-V2: t=<ms>,v2=<hex>` next to the legacy
`X-APS-Signature: sha256=<hex>` so receivers could migrate without a flag day, and the
receiver example has required V2 since then. Keeping the compatibility header alive costs
a second HMAC per request and leaves a replayable path for any receiver that still checks
only the body. APS cannot observe whether receivers have migrated, so this is a deliberate
breaking change rather than a gated flip.

**Decision.** When a signing secret is set, APS emits only
`X-APS-Signature-V2: t=<ms>,v2=<hex>`; `X-APS-Timestamp` is still sent. The receiver
example drops `verifyWebhookSignature` and its body-only parsing, and requires V2 as
before. Operator and reference docs present V2 as the only signature. The migration note
tells operators to upgrade receivers before APS, which works because pre-removal APS
versions send both headers. There is no setting, environment variable, or dual mode.

**Cost.** A receiver that still verifies only `X-APS-Signature` breaks at the APS upgrade
with no toggle; a receiver that treats a missing signature as unsigned can accept
unauthenticated deliveries until it is fixed. Code copied from the old example's legacy
helper must move to V2. There is no data or config migration. `X-APS-Timestamp` remains an
unsigned informational header; removing it is separate.

## D106. The all-cells scorecard view loads one latest-per-cell feed

**Context.** D92 gave the Scorecards page generation-time filters and keyset paging, but
the all-cells view still fetched one `GET /api/summaries` page per cell. With N cells a
single load, Refresh, or period change made N summaries requests plus the cell list and
status. The page only needs each cell's newest report for its first render; older pages
are already per-cell keyset requests. A grouped variant that returned 25 reports per cell
would remove the request fan-out but keep the same multi-megabyte payload.

**Decision.** Add an additive `GET /api/summaries/latest-per-cell[?since=…&until=…]` returning
`[{ cell: { id, name }, summary, hasOlder }]`. `since` and `until` are the same inclusive
generation-time bounds as the existing list route. `SummaryRepository.latestPerCell()`
ranks in-range rows per cell with
`ROW_NUMBER() OVER (PARTITION BY cell_id ORDER BY created_at DESC, id DESC)`, keeps the
first two, and returns the first as `summary` with `hasOlder` set when the second exists.
Groups follow their newest report, so the response is already newest-first. The route
joins `cells.list()` to add the cell name and drops a summary whose cell no longer
exists. The all-cells view makes this one feed request plus the status request with the
selected bounds, does not fetch `/api/cells`, and does not request per-cell summaries
until the operator presses
**Load older**. That button still pages the selected cell through `/api/summaries` with
the D92 keyset. The focused-cell view stays unchanged; `GET /api/summaries` and
`/api/summaries/latest` keep their shapes for other callers.

**Cost.** The feed scans and ranks the in-range rows once, and its response carries one
report per cell instead of 25, so the initial payload no longer grows with history depth.
Older history is fetched only for the card an operator opens. There is no migration or new
index: `since` and `until` use `idx_cell_summaries_created` and retention bounds the
scanned rows; equal-`created_at` ties may sort in memory. `SummaryScheduler.status()`
initially still computed one `latest()` per cell internally; D119 replaces that with the
grouped query.

## D107. The Cell master drawer scopes its latest five reports by period

**Context.** D92 added a generation-time period filter to the Scorecards page and
deliberately left the Cell master drawer at the unfiltered latest five. Operators asked
for the same control in the drawer so they can widen from the recent window and see older
reports without leaving the drawer, while keeping the drawer a quick glance rather than a
second history browser.

**Decision.** The drawer reuses the page's range options through one shared
`ScorecardPeriod` module: `24h`, `72h` (default), `7d`, `30d`, and `All`. The selected
period scopes the whole Scorecard card, not just **Earlier scorecards**. The drawer asks
for `GET /api/summaries` with `limit=5` and an inclusive `since` (omitted for **All**), so
it shows at most the newest five reports generated inside the period. The expanded report
comes from the first row of that filtered list; the drawer stops calling
`/api/summaries/latest` so an out-of-period report cannot bypass the control. There is no
paging, probe row, or larger limit in the drawer; the Scorecards page remains the history
browser. A range change clears the previous list and shows a small loading state, and a
request token discards a late response for an older cell or period. The choice is not
persisted across drawer opens. **All** is bounded by `retention.cellSummariesDays`, which
always keeps the newest report per cell. This supersedes D92's "the drawer is unchanged"
sentence.

**Why not keep the unfiltered latest card above a filtered history.** A latest report
generated outside the selected period would contradict the control and make the empty
state ambiguous. The filtered list already contains the newest row, so the separate
`/latest` call is redundant here.

**Cost.** The drawer makes one summaries request per load with the existing index-backed
`since` predicate; there is no schema, API, scheduler, retention, or report-content
change. The drawer cannot show more than five reports, by design. The drawer renders only
the preset options; the Scorecards page adds its optional Custom segment to the same
control.

## D108. Scorecards custom ranges use inclusive local whole-day bounds

**Context.** D92 gave the Scorecards page five rolling presets. D106 routes the all-cells
first page through one latest-per-cell request, and D107 shares the preset control with
the drawer. Operators still could not ask for an arbitrary calendar window, such as a
specific week or a range that ends in the past, because the read paths had no upper bound
and the page had no date inputs.

**Decision.** Add a sixth **Custom** segment with native start and end date inputs. The
browser's local dates become inclusive bounds: start at local `00:00:00.000` and end at
local `23:59:59.999`, converted to epoch ms. `GET /api/summaries`,
`GET /api/summaries/latest-per-cell`, and their repository methods accept an optional
inclusive `until`, and it ANDs with `since`, `cellId`, the limit, and the
`(created_at, id)` cursor. `until` is not a cursor: `before` remains the exclusive keyset
bound, so paging inside a custom range keeps both the applied `since`/`until` and the
cursor. Selecting Custom prefills the start from the current finite preset (or the last
72 hours from All) and the end from today, then applies at once; subsequent edits need
**Apply**. Draft dates never affect Refresh or **Load older**, and the page reuses the
window that produced the visible page when paging. The all-cells feed and the focused-cell
list both receive the same applied window. Presets still compute a fresh rolling lower
bound on each load. The API places no ordering rule on `since` and `until`; an inverted
pair returns an empty list, while the UI rejects it before sending. The range is not
persisted across reloads, and the drawer keeps its preset-only control.

**Why local whole days.** The control is a date picker, not a datetime picker, and
operators read report history in local time. Parsing `YYYY-MM-DD` with `new Date(value)`
would use UTC midnight and shift the boundary by a day in negative-offset zones; building
the date from its local components avoids that. No new index is needed because the
existing `created_at` indexes cover both bounds.

**Cost.** Custom ranges are bounded by `retention.cellSummariesDays`, not by an artificial
cap, and a future end date simply includes everything up to now. Time-of-day precision,
timezone selection, URL persistence, and a custom range in the drawer are separate work.

## D109. The flat scorecard feed returns a server-owned page envelope

**Context.** The Scorecards page's **All cells** view shows one latest report per cell, so
its height grows with the number of cells. A single chronological stream is an alternative
when the latest-per-cell page gets long.

**Decision.** Add `GET /api/summaries/feed?limit=&since=&until=&before=&beforeId=` for an
opt-in **Flat** layout in the All cells view. It returns
`{ reports, hasMore, nextCursor }`, ranked `created_at DESC, id DESC` across cells, with
the same inclusive `since`/`until` bounds and paired `(created_at, id)` keyset cursor as
`/api/summaries`. The server clamps the page to 1–50 (default 25), fetches one probe row,
trims it, and returns the last row's cursor. **Grouped** (the latest-per-cell view) stays
the default and `/api/summaries` keeps its bare-array contract used by the drawer and
focused-cell history. The feed reuses the list WHERE/ORDER query through a non-clamping
helper so a 50-row page still gets a probe row. A report whose cell no longer exists is
kept and labelled with its raw id rather than dropped, so the rendered count matches
`hasMore`. The page captures the first page's window (`since`/`until`) and reuses it for
**Load more**, so a boundary report cannot age out between pages and a custom range keeps
its upper bound while paging. No schema or index change is needed;
`idx_cell_summaries_created` bounds the in-range scan.

**Cost.** The response carries 25 full reports in one payload, so it can be several
hundred KB; the flat layout asks for one request per page and keeps the previous rows in
memory. The flat view is All cells only; a focused cell stays grouped. The latest-per-cell
feed, per-cell **Load older**, and any paging beyond the flat page are unchanged.

## D110. Existing cutover run directories are tightened explicitly

**Context.** D94 made new `deploy/cutover-vps.sh` runs owner-only, but evidence written
before that change is still `0755` under the usual umask. `~/.aps-cutover/runs` and every
run directory created by an older script can be read by any local account, including the
`config-before.json`/`config-after.json`, `errors.log.before`, `cutover.log`, `state`, the
copied `cutover.sh`, the pre-build `dist/` tree, and `backup/systemd/` — the only in-place
rollback copy. Retention may keep those runs indefinitely once cutovers stop.
`repair:permissions` (D74) covers `requests/`, `repair:upgrades` (D93) deliberately covers
only `upgrades/`, and `prune:cutover` only removes runs.

**Decision.** Add `npm run repair:runs`, a built maintenance CLI
(`src/server/src/maintenance/repair-run-permissions.ts` plus
`repair-run-permissions-cli.ts`). It is a dry run by default and changes modes only with
`--apply`. With `--root DIR` (default `$HOME/.aps-cutover`) it scans `DIR/runs`, one
level deep (D120 adds `DIR` itself): it sets the `runs` directory and every direct run
directory to `0700`. It uses `lstat`, never follows a symlinked run directory, skips
non-directory children, treats `ENOENT` as a skip, continues after other failures, and
exits 1 if any entry failed. A missing `runs` is a successful no-op and is never created
(D120 makes only a missing root the no-op). It never deletes, reads file contents,
descends into `dist/` or `backup/`, or opens SQLite. The `latest` symlink and
`upgrades/` keep their modes; the shared root is repaired by D120.

Directory-level `0700` is the protection boundary; individual evidence files and the
copied script keep their current modes, exactly as D86/D93 chose for upgrades. Cutover
runs have no `db-backup.sqlite` that may be copied out, so no file-level `0600` rule
applies. The repair is an explicit post-cutover step, not a hook in `cutover-vps.sh`.

**Cost.** Operators must run the repair once after the first fixed cutover, and the built
CLI needs `npm run build` first, like `repair:permissions` and `repair:upgrades`. It is not
encryption at rest, and root can still read the files. Run contents, timing, names,
retention, pruning, and the `latest` target are unchanged.

## D111. The legacy-branch dry run skips the owner-only repair

**Context.** D87/D95 kept the `openExistingDb` chmod sweep in both modes, so
`npm run migrate:branches --dry-run` failed with `EPERM` before reading anything whenever
the database was owned by another user. A read-only operator inspecting a shared brain
copy or a snapshot could not get the branch plan. The run only needs read access; the
chmod is a defensive repair, not a requirement for reading.

**Decision.** `openExistingDb` takes `harden?: boolean`, default `true`. Callers that keep
the default still run `ensurePrivateFile` before the open and `hardenDbFiles` after it and
still fail closed on a chmod error. `legacy-branches-cli.ts` passes
`harden: options.apply`: a dry run is `{ readonly: true, harden: false }` and performs no
chmod on the database, `-wal`, `-shm`, or `-journal`; `--apply` is
`{ readonly: false, harden: true }` and is the only path that writes `requests.branch`.
The dry run still uses SQLite's read-only flag, never `immutable=1`, and the
no-content-mutation guarantee from D95 is unchanged. Read access to the database and any existing
sidecars is still required; the option does not bypass filesystem permissions, and a
`0600` database owned by someone else remains unreadable. `openDb` on the next brain start
and `--apply` still repair loose modes. A WAL database whose `-shm` is absent in a
non-writable directory still needs the wal-index and fails with
`SQLITE_READONLY_DIRECTORY`; that is separate work.

**Cost.** A dry run no longer repairs loose modes on an owned database; `openDb` and
`--apply` do. A database the caller cannot chmod keeps its current privacy, which the
owner controls. This is not encryption at rest.

## D112. The web stress harness runs the real suite under CPU hogs

**Context.** The parallel-load hardening in `942fb341` proved its 10 s query and 30 s
case budgets with an ad-hoc shell snippet: four `while :` loops plus one
`NODE_ENV=test npx vitest run`. The snippet was never committed, so re-verifying the
budgets means reconstructing it by hand, and it cannot catch the three ways a load proof
lies: a hog dies and the run is no longer loaded, Vitest crashes or times out and leaves
no results while the shell still exits 0, and an interrupted run leaves busy loops
burning a core forever.

**Decision.** Add `npm run test:web-stress` (`scripts/web-stress.mjs`, helpers under
`scripts/web-stress/`). It runs `npm test --workspace src/web` `--runs` times (default 3)
sequentially, with `--hogs` busy-loop Node children (default 4) alive for the whole run.
Each iteration runs Vitest's `verbose` and `json` reporters, with the report written to
an absolute `--outputFile.json` path because npm runs the workspace script with cwd
`src/web`. The iteration fails on a non-zero exit, `success !== true`,
`numFailedTests > 0`, a missing/empty/unparsable/zero-test report, or the per-iteration
timeout (600 s). The run also fails when a hog exits early. Exit codes are 0 pass, 1
failure, 2 usage, and 130/143 on SIGINT/SIGTERM.

Each iteration runs under `scripts/web-stress/suite-supervisor.mjs`, spawned `detached`
so it is the session and process-group leader and npm, its shell, and the Vitest workers
share that group. The runner signals the recorded group on a timeout or interrupt. The
supervisor also polls `process.ppid` against the runner pid passed at spawn and SIGKILLs
its own group when the runner disappears, so a `SIGKILL` of the runner cannot leave the
suite running; hogs have their own `process.ppid` watchdog for the same reason. The
`aps-web-stress-hog` marker keeps a leaked hog findable, and the default log directory is
an `aps-web-stress-*` mkdtemp under `TMPDIR`, so `clean-test-tmp.mjs` reclaims one left by
a crash.

**Cost.** The default run is several minutes of full-suite work with four cores
oversubscribed, so it is manual only: not in `npm test`, not in either CI workflow. It
adds no Vitest cases or files (the guarded totals in `AGENTS.md`, `README.md`, and
`docs/02-status.md` stay unchanged); its guard is a `node:test` file in `test:e2e-env`.
Windows is not a goal (process groups are POSIX), and a filtered `--only` run is not a
full-suite proof.

## D113. Served Help links are checked against the manifest

**Context.** The D99 link gate proves a target exists in the repo, but not that Help can
render it. Help rewrites every local `*.md` link to `?help=<basename>` and the server 404s
any slug the manifest does not list, so a served page could link `docs/05-plan.md` or
`AGENTS.md` and pass the gate while dead-ending the reader inside Help.

**Decision.** `src/server/src/docs/manifest.ts` is the single manifest authority:
`DocsService` serves it and `src/web/src/doc-links.test.ts` imports it. `checkHelpLinks`
validates every link on a manifest-served page with the SPA's own `resolveDocHref` and
`slugForDocPath` rewrite, requires a direct `.md` link to resolve to the same source its
slug serves (so a same-named file elsewhere cannot masquerade), and validates literal
`?help=<slug>#fragment` targets. `manifestProblems` enforces unique lowercase slugs,
existing Markdown sources, and `slugForDocPath(source) === slug`. Internal-only notes
never render in Help, so they stay unconstrained; served pages refer to them as inline
code or absolute GitHub URLs. Runtime behavior is unchanged: the service still filters
missing sources and returns an empty list when `docs/` is absent.

**Cost.** One pure module, two checker exports, and cases in the existing docs-gate test
file. Images and non-Markdown local targets stay separate checks;
SPA-authored Help links landed in D123, and external-link liveness in D124.

## D114. Deeper systemd sandboxing is decided by a live probe, not by the score

**Context.** D96 deliberately excluded seven directives that could break PTYs, `/proc`
readers, agent-CLI sandboxes, syscalls, or writable repos, and noted that evaluating them
needs a live run. The exclusion list had no repeatable test, so a later "raise the score"
edit could either break the brain or silently stay conservative forever.

**Decision.** Add `scripts/systemd-sandbox-probe.mjs` (`npm run probe:sandbox`), a manual
proof script that boots the built brain in a transient `systemd-run --user` unit with the
shipped `[Service]` sandbox block plus one candidate directive and drives the real
surfaces: `/health` and the SPA, a `node-pty` terminal (`git status`, `ps`, `free`, `top`,
`/proc` reads, `$HOME`/`/tmp`/data/outside-repo touches, `systemctl --user`, a nested
`systemd-run --user`, and `npm run repair:permissions -- --dry-run`), a clarify turn with
each available harness, and git worktrees for a repo inside and outside the fake home.
Every writable path lives under one run root derived from `--root`, `%h` is substituted
with `<root>/home`, inherited `APS_*`/`SBOX_*` are scrubbed by `buildProbePins`, and the
unit is stopped and collected on every path. The probe copies the invoking user's local
OpenCode/Claude state into the fake home so a real turn can authenticate; that copy stays
under the run root and is deleted unless `--keep` is set.

On systemd 259 (kernel 7.0.0-38-generic, Node 24.22.3, OpenCode available, Claude Code
absent), the control run passed every check except the skipped Claude turn, and the seven
candidates resolved as:

| Candidate | Result | Evidence |
| --- | --- | --- |
| `PrivateDevices=yes` | **ADOPT** | PTY create/echo/close, the OpenCode turn, and all terminal commands pass |
| `ProtectProc=invisible` | **ADOPT** | `ps aux`, `ps -ef`, `top -b -n 1`, `/proc/self/status` pass |
| `ProcSubset=pid` | **REJECT** | `ps=1` and `free=1`; `/proc/meminfo` is missing inside the unit |
| `RestrictNamespaces=~user` | **DEFER** | `unshare -U` is blocked (the expected signature), but `turn:claude` skipped because no Claude binary was available |
| `SystemCallFilter=@system-service` | **DEFER** | Node, npm, git, the PTY, and the OpenCode turn pass; `turn:claude` skipped |
| `ProtectHome=read-only` + `ReadWritePaths=` | **REJECT** | `touch $HOME/...` fails with `Read-only file system`; home target repos lose worktrees |
| `ProtectSystem=strict` + `ReadWritePaths=` | **REJECT** | `touch` in the outside repo (`/srv`) fails; target repos outside the allow-list break |

**Re-run, 2026-11-27 (`204d9c8`).** The run used systemd 259, Node 24.22.3, and OpenCode
2.3.2 on kernel 7.0.0-38-generic. A cached Claude Code **2.1.330 (Claude Code)** binary
was present, but the host had no `~/.claude.json`, no `~/.claude/.credentials.json`, and
no `ANTHROPIC_*`/`CLAUDE_*` environment. A direct `claude -p` with that binary returned
`is_error: true` and `result: "Not logged in · Please run /login"`. The probe's control
passed every check except `turn:claude` **SKIP** (`claude has no local state to seed a
turn`), then both candidates ran and remained **DEFER**:

| Candidate | Result | Evidence |
| --- | --- | --- |
| `RestrictNamespaces=~user` | **DEFER** | `boot`, `namespace` (user namespaces blocked), and `turn:opencode` pass; `turn:claude` SKIPs because the probe has no authenticated state to seed; `detach=0` |
| `SystemCallFilter=@system-service` | **DEFER** | `boot`, `terminal`, `repair`, `worktree:home`, and `turn:opencode` pass; `turn:claude` SKIPs for the same reason; `detach=0` |

No unit line, lint map, ceiling, or quoted score changed. The exact missing evidence is a
real, seedable Claude Code login; a binary on `PATH` or in the npm cache is not enough.

Adopt `PrivateDevices=yes` and `ProtectProc=invisible` in the unit and in
`HARDENING_REQUIRED`; reject `ProcSubset=pid`, `ProtectSystem=strict`, and
`ProtectHome` booleans with `read-only`/`tmpfs` in `HARDENING_FORBIDDEN` by normalizing
every accepted boolean spelling; leave
`RestrictNamespaces` and `SystemCallFilter` out of both maps until an authenticated
Claude Code turn exercises the sandbox. The measured exposure is **3.8**, so
`SECURITY_THRESHOLD` drops from 55 to **48** (the
smallest tenth at least 1.0 above the score), and the unit gate now rejects more than one
assignment of a list directive such as `ReadWritePaths=` so a duplicate line cannot widen
a reviewed list. The probe stays manual: it needs a user manager, the built tree, literal
agent CLIs, and network auth, so it is not in `npm run lint`, `npm test`, or CI; only its
pure helpers and `buildProbePins` are guarded by `node:test` (`test:e2e-env`).

**Cost.** `PrivateDevices=yes` removes sound, input, and raw block/character devices from
the service's `/dev`; PTYs and standard tty devices remain. `ProtectProc=invisible` hides
other users' processes, so a brain terminal can no longer inspect another login. The probe
is slow (a real turn per candidate), copies local agent state into the run root, and
depends on the host's CLI auth; a missing or unauthenticated Claude Code defers the
namespace and syscall verdicts. The five rejected/deferred directives keep their previous
behavior, and a changed unit still installs by hand because `upgrade-vps.sh` refuses
target commits that edit it.

## D115. An unusable process file is reported once per distinct state

**Context.** `ProcessStore` caches only a successful load, so while `process.json` is
unusable every `get()` reads it again. That re-read is deliberate: a corrected file is
picked up without a restart. But the report was not deduped, so the same broken file
appended a `process.unreadable` or `process.invalid` row and printed a `console.warn` on
every master bucket tick and every `GET /api/process`, burying everything else in the
error log. Caching the failure would silence the noise but also hide a correction until a
restart, which is why the settings store's approach does not fit here.

**Decision.** `ProcessStore` keeps an in-memory signature of the last unusable state it
reported: the failure kind, its detail (the `jsonParseReason` text, the zod message, or
the fs error), and, when the file could be read, a SHA-256 of its bytes. A failure whose
signature matches the previous one returns the fallback without touching the error sink or
`console.warn`; a new signature reports once. A missing file and a successful load clear
the signature. Every load still reads and validates the file and still sets
`preserveSource`, so the atomic write, the backup-before-save copy, and the five-copy
prune are unchanged. The signature is never logged and the raw bytes are not retained in
it.

**Cost.** While an identical unusable state persists, the log shows one row instead of
one per tick, and the same applies to the stderr warning; a restart reports the
still-broken file once. Operators editing an unusable file get a fresh report because the
byte identity changes. A corrected file is read on the next `get()` and then cached as
before, so later edits to an already-valid file still need a restart (unchanged). The
digest is computed only on a failed load and only on the small operator file.

## D116. The redundant unsigned webhook timestamp header is removed

**Context.** D91 added `X-APS-Signature-V2: t=<ms>,v2=<hex>` and put the send-time
timestamp inside the HMAC. D105 removed the legacy body-only `X-APS-Signature` but kept
`X-APS-Timestamp` as an unsigned informational header. That header duplicates the signed
`t` when a secret is set, while without a secret anyone can set it, so it cannot support
freshness or replay rejection. Keeping it also leaves a second, untrustworthy timestamp
next to the authoritative one and forces every receiver doc to explain the difference.

**Decision.** APS stops sending `X-APS-Timestamp` on every webhook path: budget alerts,
event notifications, retries, resends, and Send test. The send-time timestamp is only the
signed `t` inside `X-APS-Signature-V2`. JSON bodies keep their own `occurredAt` /
`alert.createdAt` fields, and a request without a saved secret carries no send-time
header. The receiver example is unchanged because it never read the header. There is no
setting, environment variable, or dual mode.

**Cost.** A receiver that logs or branches on `X-APS-Timestamp` must switch to V2's signed
`t` or the JSON body fields at the APS upgrade. This is a deliberate breaking change like
D105, with no data or config migration. Freshness for unsigned deliveries was never
verifiable, so nothing that could be trusted is lost.

## D117. The process editor lists preserved process copies across restarts

**Context.** D104 names only the copy the current process made. After a restart that path
is null even when `process.json.invalid-<UTC>` copies still sit next to the process file,
so the notice disappears and the operator has to inspect the directory to find them.
D103 already solves the same problem for `config.json` copies.

**Decision.** `ProcessStore.preservedCopies()` delegates to the shared
`listPreservedCopies` helper with `newest` set to the copy this process made. It scans the
process file's directory for regular files whose names start with
`<basename>.invalid-`, returns their absolute paths newest first by embedded UTC stamp
and then numeric suffix, and pins the current copy first when it is present, even if the
clock moved backwards. It never reads a copy back, caps nothing, writes nothing, and
prunes nothing. A missing or unreadable directory returns an empty list without console
output or an error-log entry, because this is an optional read-only display path; the
save-time prune keeps its existing `process.pruneFailed` reporting. `GET` and
`PATCH /api/process` return the list as `preservedCopies` beside `preservedPath`. The
Config page stores it from the load and from the process save response, merges the
current path first, deduplicates, and passes the merged list to the global
`ProcessEditor`, which shows a non-dismissible `role="status"` notice named "Preserved
process files": every path, pluralized heading/caption, and the existing warning that the
files may contain prompts or policy. The cell editor still shows no notice because cell
saves write `cells.process_json`, not `process.json`.

**Cost.** Every process response now scans the config directory. A legacy backlog is
listed in full until the next successful save prunes it, and a copy deleted after the
page loaded stays on screen until the next response or reload. The list is filesystem
state, not a `process.json` key, and it can include copies made by processes that are no
longer running. D98's copy, prune, and five-copy limit are unchanged.

## D118. Scorecards custom ranges accept a local time of day

**Context.** D108 gave the Scorecards page an inclusive custom start/end date range and
deliberately left sub-day windows out: the control was a date picker, so every window
started at local midnight and ended at the last millisecond of the end date. Operators
asking for a shift-sized window had no way to express it.

**Decision.** The Custom panel keeps its two native date inputs and adds two native
`<input type="time">` inputs with `step=60`, prefilled to `00:00` and `23:59`. The start
instant is exact at the selected local minute (`:00.000`); the end instant includes the
whole selected minute through `:59.999`, so the untouched defaults reproduce D108's
whole-day bounds exactly. Blank or cleared times fall back to those defaults.
`customWindow` builds both instants from local date/time components, rejects values that
do not round-trip through the local constructor (invalid dates and DST gaps), and rejects
only an end minute earlier than the start minute; equal minutes are valid. The panel still
applies only on **Apply**, shows the applied local range in its helper copy, and keeps the
existing `since`/`until` request, paging capture, cell scoping, and grouped/flat behavior.
The Cell master drawer keeps its preset-only control; timezone selection and URL
persistence remain separate work.

**Why minute precision.** `datetime-local` would have replaced the date inputs and their
labels; two time inputs preserve the existing control. An inclusive end minute is what
makes 00:00/23:59 identical to D108's bounds, including reports generated during the
final minute. Building from components avoids the UTC shift of `new Date('YYYY-MM-DD')`.

**Cost.** No API, schema, scheduler, or retention change: the three summary reads already
take inclusive epoch-ms bounds. Two inputs and a stricter pure helper are the only UI
surface; a custom range can now be as narrow as one minute. D108 remains the record of the
date-only version; this decision supersedes its note that time-of-day precision is
separate work.

## D119. Summary status aggregates from one latest-per-cell query

**Context.** `GET /api/summaries/status` is polled by the web UI and calls
`SummaryScheduler.status()` when no cell is selected. That method mapped `statusFor()`
over `cells.list()`, and each `statusFor()` performed a `cells.require()` plus a
`summaries.latest(cellId)` point lookup; it then iterated the same cells again and called
`latest()` a second time for `lastRunAt`. A status read therefore cost about two latest
queries plus one cell lookup per cell, even though the grouped `latestPerCell()` query
already existed for the Scorecards all-cells feed. D106 deferred replacing this path.

**Decision.** `status()` reads `settings.get().summary` once and `cells.list()` once. When
the cell list is non-empty it calls `summaries.latestPerCell()` exactly once, builds a
`cellId -> Summary` map from the groups (`hasOlder` is ignored), and formats every cell in
the snapshot through a private `cellStatus(cellId, latest, settings)` helper shared with
`statusFor()`. `statusFor()` keeps its current contract: it still requires the cell and
performs one single-cell `latest()` point lookup. An empty board skips the summary query
entirely. Aggregation iterates the cell snapshot, never the grouped result, so an orphan
summary for a deleted cell cannot appear. The `nextRunAt`, `lastRunAt`, `running`,
`lastError`, and enabled/interval/window fields keep their exact formulas and values.

**Why the grouped query rather than a narrower MAX query.** `latestPerCell()` already
encodes the `(created_at DESC, id DESC)` ordering used by `latest()`, so status cannot
disagree with the per-cell route on timestamp ties. It also avoids a second repository
method and keeps the scan loop and single-cell paths untouched.

**Cost.** An all-cells status read now scans and ranks the retained summaries once
(bounded by `retention.cellSummariesDays`) instead of issuing 3N indexed point queries;
the single-cell status route remains one indexed lookup. The response shape, route
validation, schema, retention, and web client are unchanged. `SummaryScheduler.scan()`
still looks up each cell's latest report separately; that is a separate request.

## D120. The shared cutover root is owner-only

**Context.** D94 made `~/.aps-cutover/runs/<UTC>/` owner-only and D110 added
`repair:runs` for older run directories, but both deliberately left the shared
`~/.aps-cutover` root at its existing mode. A new install already gets a `0700` root
because `prepare_run_dir` and cutover's `point_latest` create the ancestor chain under
`umask 077`; an install that predates that change can keep a `0755` root indefinitely.
The `0700` children protect run and snapshot contents, but a world-readable root still
lets any local account list `runs/` and `upgrades/` names and resolve the `latest`
symlink target. An operator who ran both repairs could reasonably assume the whole
evidence tree was owner-only. `upgrade-vps.sh` also had one creation gap: its internal
`--run --run-dir` path could reach `point_upgrade_latest` with the root still missing, and
that helper used a bare `mkdir -p`, creating the root and `upgrades/` at `0755` under the
usual umask.

**Decision.** The shared `~/.aps-cutover` root is `0700`, the same boundary as its
children. A new root is created `0700` by both deploy scripts: `upgrade-vps.sh` now runs
`point_upgrade_latest`'s `mkdir -p` under a local `umask 077`, and `cutover-vps.sh` is
unchanged. Neither script gains a chmod of an existing root; silently changing an
operator's shared directory on the next run would violate the "existing ancestors are
left alone" rule from D73/D86/D94. Instead, both existing dry-run-first repairs own the
root: `npm run repair:runs` (D110) inspects `--root` itself before `runs/`,
`npm run repair:upgrades` (D93) inspects `--root` itself before `upgrades/`, and each
tightens a real directory to `0700` in its normal pass. That means either command fixes
an old root, so an upgrade-only host does not have to remember the cutover repair.
`latest` needs no separate change: on Linux a symlink's mode is ignored, and the `0700`
root plus the `0700` target run directory already block traversal and resolution.

A symlinked root is not chmodded, so a relocated tree is left for the operator to
tighten, while its `runs/` or `upgrades/` tree is still scanned through the link. A
non-directory root and the filesystem root (`--root /`) fail closed in the engine; both
CLIs also refuse a resolved root equal to the current user's home directory before any
inspection or chmod, so `--apply --root ~` cannot tighten the real home.

**Why not a new command.** A dedicated `repair:cutover-root` would duplicate the three
existing dry-run repairs' argument handling and output for one chmod, and the two
evidence repairs already own the root's children. Leaving the root `0755` and documenting
it was rejected because the name and symlink-target leak is real and new installs already
use the tighter boundary.

**Cost.** One more directory in each evidence repair and one explicit run for an old
install; either command is sufficient. No run contents, retention, pruning, `latest`
target, or child mode changes. This is not encryption at rest; root can still read the
files.

## D121. Maintenance permission repairs share one engine and CLI core

**Context.** `repair:permissions` (D74), `repair:upgrades` (D93), and `repair:runs`
(D110/D120) each carried a copy of the owner-only chmod engine: the `0700`/`0600`
decision, the `lstat`/`stat` and kind checks, symlink refusal, the `ENOENT`-as-skip
rule, the dry-run accounting, the report loop, argument parsing, the exit code, and the
direct-run bootstrap. The cutover engines imported the requests engine only for
`PRIVATE_*_MODE`/`RepairAction`, and the cutover CLIs imported its `formatMode`. A fix
applied to one repair could silently miss the other two, and the security-sensitive
`chmod` logic had three homes.

**Decision.** Move the engine to `src/server/src/maintenance/permission-repair.ts`
(`PermissionRepair`, both modes, the entry/result types, `formatMode`) and the CLI core
to `repair-cli.ts` (`parseRepairArgs`, `printRepairReport`, `repairExitCode`,
`runDirectly`). The three engines now only describe their tree; the three CLIs only hold
their usage text, default target, and missing-root messages. Commands, flags, report
lines, order, exit codes, and traversal are unchanged. The root rules stay explicit
options instead of silent unification: `repair:permissions` follows a symlinked
`requests/` root (`stat`) and records a session dir that vanishes between `readdir` and
`lstat` as a skip; the cutover repairs use `lstat`, both skip a symlinked cutover root
while refusing a symlinked `runs/` or `upgrades/` (D120), and missing children are
silent.
`src/server/test/repair-permissions.test.ts` guards the split: only
`permission-repair.ts` may mention `chmodSync`, every engine constructs
`PermissionRepair`, and every CLI imports the shared core.
`src/server/test/permission-repair.test.ts` covers the policy seam directly: a missing
root under every symlink mode, refused/followed/skipped symlinked roots, and the
silent-versus-vanished child rule.

**Cost.** Two new modules, one structural guard test, and one focused policy-seam test
file. A future repair must use the shared scanner; the guard fails if it imports
`chmodSync` directly. Changing either root rule is a separate decision (the symlinked
`requests/` root is filed separately). The shell `chmod` in
`deploy/upgrade-vps.sh`/`cutover-vps.sh` is unchanged and cannot share this code.

## D122. The stress harness covers the server suite too

**Context.** `npm run test:web-stress` (D112) proves the web suite under four CPU hogs,
but the server suite carries the explicit 30 s budgets for the cutover/upgrade cases and
the process-heavy `deploy/*.sh` fixtures. Re-verifying those under load meant editing the
web-only workspace constant or reconstructing a shell recipe, and a copy of the runner
would let the two stress paths drift on the fail-closed rules.

**Decision.** `scripts/web-stress.mjs` gains `--suite web|server` (default web) and
`npm run test:server-stress` passes `--suite server`. A pure
`scripts/web-stress/suites.mjs` holds the workspace, label, log prefix, and hog marker
for each suite; `suiteArgs` builds the common `npm test --workspace <suite> --
--reporter=verbose --reporter=json --outputFile.json=<abs>` argv. Both suites use the
same 3 runs x 4 hogs x 600 s defaults, the same
`buildPinnedEnv(process.env, { NODE_ENV: 'test' })`, sequential iterations, and the same
fail-closed report and exit-code rules. Both suites run under D112's
`suite-supervisor.mjs` group leader, so a `SIGKILL` of the runner reaps the npm/Vitest
group for either workspace. Server output is `server-stress:`, the default log dir is
`aps-server-stress-*`, and the hog marker is `aps-server-stress-hog`; web values are
unchanged. There is no `all` mode: `npm test` already composes the suites, and one stress
command per suite keeps the logs and labels clear.

**Cost.** One more registry module, one CLI flag, one npm script, and guard cases; no
Vitest case or file changes, so the guarded totals stay unchanged. It is manual only:
not in `npm test`, not in either CI workflow. The suite registry only supplies the
workspace, labels, and argv; the process-group spawn and supervisor behavior are shared
with web.

## D123. SPA Help targets are checked against the manifest

**Context.** D99 and D113 prove that Markdown links and Help-served pages resolve, but the
SPA's own Help affordances are TypeScript constants and literals. A manifest rename or a
typo in `src/web/src/links.ts` or `HelpPanel.tsx` turned a Help link into Help's "Page not
found" without failing any gate.

**Decision.** `src/web/src/links.ts` declares `HelpTarget` plus `GETTING_STARTED_HELP`,
`VERIFY_WEBHOOK_SIGNATURES_HELP`, and the `SPA_HELP_TARGETS` registry; `helpHref` accepts a
target so a slug and anchor cannot be paired by accident. `HelpPanel`, `App`, and
`ConfigPage` use those constants. `src/web/src/doc-links.test.ts` iterates the registry,
requires each slug to be a `HELP_MANIFEST` entry and each non-null anchor to be an
`extractHeadings` id of that entry's source, checks the built `?help=` href, and scans
non-test `src/web/src` files for a quoted `?help=<slug>` or bare Help slug. `docs.ts`
keeps the README-to-`getting-started` path alias, which `manifestProblems` already
validates.

**Cost.** One registry, one gate, and four cases in the existing docs-gate test file; no
runtime behavior, dependency, or manifest change. The SPA scan is a text guard, not a
parser: it catches quoted slug literals, and dynamically built `?help=` strings remain out
of scope. External URLs are the opt-in probe in D124; image and non-Markdown targets stay
separate checks.

## D124. External documentation links are probed by an opt-in check

**Context.** The D99/D113/D123 gates are deterministic and filesystem-only:
`resolveLinkTarget` skips every `scheme:` target, so an external URL can rot without
failing anything. Fetching it inside `npm test` would make CI depend on the network and on
other sites' uptime.

**Decision.** `src/web/src/doc-links-external.ts` collects every `http(s)` destination
from `collectDocLinks` (inline links, images, raw HTML, and reference definitions),
deduplicates by normalized URL, and probes each once with `HEAD` (`GET` fallback on
`403`/`405`/`501` or a thrown request). `2xx`/`3xx` are live; `404`, `410`, other `4xx`,
`5xx`, and network/timeout failures are dead; `401`/`403`/`405`/`429` are unverified
warnings; loopback and RFC 2606 example hosts are skipped without a request. Defaults are
10 s per attempt, concurrency 4, and one retry. `npm run check:docs:external`
(`APS_CHECK_DOCS_EXTERNAL=1`) runs one env-gated Vitest case that prints the report and
fails only on dead links. The corpus has no external destinations yet, so the run reports
zero checked; injected-fetch cases prove the classification offline.

**Cost.** One pure module, one test file, and a package script; no new dependency and no
runtime change. The check is manual only: not in `npm test`, `npm run check:docs`, or
either CI workflow, so link rot is caught when an operator runs it, not on every push.
