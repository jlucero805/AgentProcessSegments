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
`sbox/<id>` branches may coexist with new `aps/<id>` branches until an operator retires
them. `npm run migrate:branches` does that: dry run by default, `--apply` renames a lone
legacy ref, deletes it only when it is already contained in `aps/<id>`, and rewrites the
terminal request's stored branch without touching `updated_at` (which would reorder
history and reset the master's idle clock). Non-terminal requests, checked-out branches,
and diverged pairs are always skipped; orphan `sbox/*` refs are reported but never
deleted. A human resolves a diverged pair because committing to either disposition could
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
`mcp__<server>__*` (the CLI's wildcard rule). OpenCode merges `mcp` entries from its
config into the generated `OPENCODE_CONFIG_DIR/opencode.json`; `--auto` makes them
callable.

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

## D14. The SPA pins assistant-ui 0.10 and React 18

**Context.** The spec names React 18 and `useExternalStoreRuntime`. The registry now
ships `@assistant-ui/react` 0.15, whose primitives and runtime helpers moved, and React
19 is current.

**Decision.** Pin the 0.10 line of `@assistant-ui/react` with React 18 so the spec's
external-store model is exactly what the code uses. Keep Tailwind v3 with PostCSS and
autoprefixer; Vite 8 and Vitest 5 run in the web workspace while the server keeps
Vitest 2.

**Cost.** Two Vitest majors live in the repo, and a later assistant-ui upgrade will be
a primitives migration. In exchange the chat code matches the contract the spec
describes and the server tests are untouched.

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
`--session` next turn. `--standalone` gives each turn a private server so
`OPENCODE_CONFIG_DIR` (the generated per-request config) applies. `PWD` is pinned to the
session cwd because OpenCode resolves the project root from it. `--archived` keeps brain
sessions out of the user's session list, and resume still works. KB sessions get explicit
deny permissions instead of a tool allowlist.

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

**Cost.** The queue is per browser and not visible to other clients or the server. A stop
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
state, and follow-up marker. The master evaluates enabled segments by pipeline position
from right to left (`finalize` first, `intake` last), not in stored array order, so
finishing work is not starved by a backlog of planning. `intake` uses `engine.start`;
other segments use `engine.send` with the configured prompt. A marker
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
`maxConcurrent: 1`, `maxPerCycle: 10`, `READY TO FINALIZE`, and advances to Finalize. The wizard keeps a server-side draft per modal. Its `__setup__:<draftId>` chat gets
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
`src/server/src/docs/service.ts`. `GET /api/docs` returns the ordered manifest,
`GET /api/docs/:slug` reads one entry, and `GET /api/docs/assets/*` serves only
`docs/screenshots/**`. Slugs never become filesystem paths; unknown or traversal-shaped
slugs are 404s. The SPA renders Markdown with the existing `react-markdown` dependency and
rewrites in-repo links to `?help=<slug>` deep links.

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
and is idempotent. It refuses to run while a known brain unit is active unless
`--allow-running` is passed; moving under a live brain can corrupt the database and
sessions. The unit template moves to `deploy/agent-process-segments.service`.
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
delivery remains separate work; usage retention uses D45, daily rollups are added by D52. A retention window shorter than the month makes spend
a lower bound, which the docs and UI say explicitly.

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
rewritten in storage. The MCP `version` stays `0.1.0` because the app has no separate
release version.

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
history is daily, and `coverage.retentionDays` so it can state the raw retention window
from the same response instead of a separate settings request. Hourly series stay
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
without SMTP or bot credentials. Email, native chat apps, delivery history/resend, and
general event notifications remain separate requests. The outbox adds one small table and
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
wrong adapter against the live port and database, and inherited `XDG_CONFIG_HOME` could
still reach the host's config, process, and error-log files even after prefix scrubbing.

**Decision.** `scripts/e2e/env.mjs` owns `scrubEnv(hostEnv)` and
`buildPinnedEnv(hostEnv, pins)`; the E2E name `buildE2eEnv` is an alias. Every proof
script — e2e, MCP smoke, Claude mock smoke, and screenshots — builds its child env through
the helper with a validated pin builder. Scripts that deliberately prove the legacy
aliases keep `SBOX_*` pins; scrubbing inherited `APS_*` names first is what makes those
pins authoritative. The Claude smoke also pins `SBOX_CONFIG`/`SBOX_PROCESS`/
`SBOX_ERROR_LOG` and the XDG dirs because `loadConfig()` reads XDG directly, outside
`readEnv`. `mcp-smoke` now asserts its tool round trips, persisted request, and KB entry,
so a broken proof exits non-zero instead of printing `MISSING ID`/`ERROR`.

**Cost.** The proof scripts import from an `e2e`-named module; renaming it to a neutral
path would churn imports, tests, and docs for no behavioral gain. The pins stay explicit
and per-script, so adding a script means adding a builder and a hostile-env test rather
than reusing one global env. `scripts/smoke.sh` is bash and keeps its own pinning; making
it share the contract is separate work.

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
Delivery history/resend and non-budget events remain separate requests. The dependency is
one runtime package with its own types and no transitive dependencies.

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
database and other data-dir artifacts are separate work, as is a bulk repair of old,
terminal workdirs that are not written again.

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
ops list bounded by monthly alerts, two channels, and the existing 400-day prune. History
rows still cascade with their alert, so clearing a budget, changing a threshold, deleting
a cell, or a month rollover removes unacknowledged history; snapshotting alert fields is a
separate follow-up. Resends are not attributed to an operator because the app has no
user identity.
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
migration and existing rows keep their behavior. Each row stores a destination hash over
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
destination hash, HMAC signing, 10-second timeout, retry schedule, `Retry-After`, crash
recovery, and 400-day prune as budget alerts. The sibling
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
budget rows and no new dependency. Event history/resend is not part of the existing budget
history view; that, summary-generation events, bot event routes, and configurable
coalescing windows remain follow-ups.

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
extends the same row. Grants require the scope to be a configured hard cap but not to be
currently paused, so an operator can pre-authorize a window. An overall override admits
every new turn and suppresses the in-flight stop for every scope; a cell override does the
same for only that cell and can never release an overall pause. The window is clamped
before the next UTC period, so a snooze never outlives the budget month it was meant for.

The override suppresses admission and the in-flight stop only. `status.paused`,
`pauseReason`, the `pauses` list, alerts, thresholds, delivery, and the budget itself are
unchanged; statuses gain `overrideId` and `overrideExpiresAt`, and `GET /api/budgets`
returns active `overrides` so the UI can keep the cap visible while new work is allowed.
`POST /api/budgets/overrides` creates or extends; `DELETE /api/budgets/overrides/:id`
revokes idempotently. Revoking re-runs evaluation immediately, so the enforcer stops live
turns in a scope that is still over its cap; expiry is observed at the next evaluation
(within 60 seconds) because there is no per-override timer. Admission checks the overall
override before the overall pause and then the cell override, and `SpendCapEnforcer`
therefore leaves covered live turns running on its next check. A failed override read
still fails open and is reported to
`usage.budgets` with `phase: admission`. Rows are pruned after 400 days, matching delivery
history. Policy edits and cell deletion do not rewrite or revoke override rows; an inert
row simply expires.

**Cost.** One additive table and two routes, plus one shared SPA control. Turns already
stopped by a cap stay stopped, and a live turn keeps running while the override is active;
ending the override stops covered live turns at once, while an expiry is noticed by the
next evaluation. There are still no spend reservations or automatic replay. There is no
operator identity or approval workflow; the optional note is the only context recorded. A
history/audit view, notification when an override is granted or expires, and per-request
overrides remain separate work.
