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
the agent substrate swappable (OpenCode today, others later), so an engine that spawns
one CLI directly is both untestable and closed.

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
created on the first save.

**Cost.** A second configuration surface. Invalid files silently use defaults until an
operator saves a valid patch; the path is shown on the page so it is discoverable.

## D22. Cell masters are a deterministic, marker-based scheduler

**Context.** The operator wants each cell reviewed on a cadence, with stalled
implementation sessions prodded to record decisions and keep moving, and completed work
moved to Review.

**Decision.** A server-side scheduler runs a master cycle (default every 5 minutes).
Each enabled cell's `dispatch` queue, plus unassigned work when configured, is filtered
to idle requests older than the idle threshold and not prodded within the interval. The
prod is an ordinary `engine.send` turn using the configured prompt. If the reply contains
`READY FOR REVIEW` and auto-review is on, the request moves `dispatch → review`. Every
prod/review/cycle/skip is stored in `master_events`; status, history, and a manual run are
exposed, and the Config page owns the policy and per-cell switches.

**Cost.** One prod at a time per cell, sequentially inside that cell; a hung turn delays
the rest of that cell’s cycle. D27 later made cadence and policy per cell and replaced
the single prod rule with configurable segments. The review move relies on the marker
rather than an LLM judgment. Prods are ordinary agent turns, so they cost tokens.

## D23. Chat queue is client-side; stop keeps the session

**Context.** A turn can take minutes. The operator wants to compose while it runs, cut it
short deliberately, and interject without losing the conversation.

**Decision.** Queue messages in the SPA per request (localStorage) and drain them in
order when the turn ends. `POST /clarify/stop` marks the turn cancelled, kills the child
(SIGTERM then SIGKILL), lets `finishTurn` save the partial transcript, and leaves
`session.json` alone so the next message resumes. Stop clears the queue; the client shows
"Stopped. You can interject."

**Cost.** The queue is per browser and not visible to other clients or the server. A stop
is best-effort: the process can take a moment to die, and the transcript is whatever the
parser had flushed.

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
existing cells. Each enabled cell has its own timer and cycle; cycles are sequential
inside a cell. Prompts cost tokens when segments are enabled.

## D28. The cell master has its own detail

**Context.** The master was a section inside Config. The operator wants to watch what
the cron is doing, see the prompt it uses, and chat with it as a first-class object.

**Decision.** Add a `Cell master` button above `+ New request`. It opens a dedicated
drawer with status, the cell’s own ticker/last/next run, the enabled segment loop and
prompts, filtered activity, and the cell’s `__master__:<cellId>` chat. With no cell
selected it shows the global template, the unassigned ticker, and the global chat.
`?master=1` restores the drawer. Config remains the editor; the drawer is the
observability surface.

**Cost.** The drawer polls status and events every 10 seconds while open. Each cell’s
chat is separate; unassigned work keeps the global chat. The chat remains
read-only/advisory.

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

**Cost.** Concurrency is per cell; unassigned work uses the default cap of 3 until a cell
is attached. Changing a cell model affects the next spawned turn, not a child that is
already running. Token/cost tracking is backlogged in `docs/09-backlog.md`.

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
the harness MCP server so tools are called directly and appear as tool cards. The setup
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
cells remain independent scheduler keys, and a global `runOnce` still walks buckets in
order.

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

## D43. APS names are canonical, SBOX names stay as aliases

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
and is idempotent. The unit template moves to `deploy/agent-process-segments.service`.

**Cost.** Two names exist for one release, and a partial upgrade can keep using legacy
paths until the operator migrates. Moving a data directory also moves git worktrees,
whose metadata may need `git worktree repair`; the script warns instead of guessing. A
rollback to an older binary needs a unit or drop-in that passes the migrated paths under
the `SBOX_*` names.
