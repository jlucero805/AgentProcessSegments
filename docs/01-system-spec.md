# Agent Process Segments: System Spec

The governing document for this rebuild. It describes the system as it existed at
extraction (`f849fed` plus the uncommitted `db.ts` index-ordering fix), with
infrastructure-specific names generalized for public distribution. It is the *what*,
not the *why*. Rationale for choices made during this rebuild lives in
`docs/03-decisions.md`.

---

## 1. What it is

A client-agnostic "brain": a local Node/TS service that orchestrates headless Claude
Code agent sessions through an ISA-95-style request workflow (Intake → Plan →
Implement → Review → Finalize), with a streaming chat per request, a knowledge base,
installable skill/command plugins, and named "cells" (floors). A web SPA is one
front-end over its HTTP API; the design goal is that any client (for example a
terminal editor plugin) can drive the same API.

### Hard external dependencies (must be installed)

- **`claude` CLI** on `PATH`, the agent substrate. The brain shells out to it; it is
  not vendored.
- **`git`** for per-request worktrees.
- Nothing else. No cloud SDK, prompt router, or pipeline calls in the logic. The brain
  only assumes that a `claude` CLI exists and speaks stream-json.
- **Dormant:** `src/server/hc/` in the original was a generated client from an earlier
  design. It was imported nowhere and unused at runtime; the engine drives `claude`
  directly. It is not reproduced here.

### Remote access (operational, not in code)

The brain binds loopback `127.0.0.1:7391` only. Remote or mobile use is an external
tunnel or reverse proxy in front of that port. Not part of the brain; any tunnel
substitutes.

### Single-origin principle

The brain serves its own built SPA from the same process and port as `/api` and `/ws`.
SPA (`/`), API (`/api`), and websocket (`/ws`) are one origin on one port, which is the
point: one port is all that gets tunnelled, and the SPA uses relative, same-origin fetch
paths, so there is no CORS and no second service.

- **Prod:** `tsc` and `vite build` into `src/web/dist`; the brain vends it via
  `@fastify/static` when `webDir` exists. SPA client-side routes fall back to
  `index.html`.
- **Dev:** the Vite dev server hosts the SPA and proxies `/api` and `/ws` to the brain,
  so the same relative paths work. Run both with `npm run dev`.

A new client is just another consumer of this one loopback origin.

### Security defaults

Bind defaults to `127.0.0.1` even though `SBOX_HOST` can override it. Never widen the
bind. The audience gate is the tunnel, not the process. Before sharing a tunnel, verify
that anonymous requests to `/` and `/api` hit the SSO redirect. The agent child is
non-interactive and auto-approves exactly the tools in its `--allowedTools` allowlist,
plus the user's MCP servers. That allowlist is the agent's permission boundary.

---

## 2. Tech stack

- **Server** (`src/server`, ESM, Node 20+): `fastify`, `@fastify/static`,
  `@fastify/websocket`, `better-sqlite3`, `zod`, `@modelcontextprotocol/sdk`. Tests:
  `vitest`. Build: `tsc`.
- **Web** (`src/web`, Vite, React 18, TS): `@assistant-ui/react` for chat,
  `react-markdown`, `mermaid` (lazy-loaded for Help diagrams), `diff`, `clsx`,
  `tailwind-merge`; Tailwind v3 with preflight on, `darkMode: 'class'`, dark by default,
  plus a hand-rolled shadcn-style kit (`ui.tsx`).
- **Monorepo:** npm workspaces (`src/server`, `src/web`). Root scripts: `build` (web
  then server), `typecheck`, `test` (server), `lint` (eslint), `dev` (both).

---

## 3. Process layout and config

- **Entry:** `src/server/app.ts` opens the database, constructs `RequestRepository`,
  `KbRepository`, `CellRepository`, `PluginManager`, and the engine, builds the server,
  and listens. Loopback only; no in-process auth, because the tunnel is the gate.
- **Config** (`src/server/config.ts`, every value env-overridable):
  - `host` = `SBOX_HOST` ?? `127.0.0.1`; `port` = `SBOX_PORT` ?? `7391`
  - `dbPath` = `SBOX_DB` ?? `sandbox-harness.sqlite`
  - `webDir` = `SBOX_WEB_DIR` ?? `<cwd>/src/web/dist`
  - `dataDir` = `SBOX_DATA_DIR` ?? `~/.sandbox-harness` (per-request workdirs)
  - `pluginsDir` = `SBOX_PLUGINS_DIR` ?? `~/.sandbox-harness/plugins`
  - `brainUrl` = `SBOX_BRAIN_URL` ?? `http://127.0.0.1:<port>`, used by the MCP proxy
  - `harness` = `SBOX_HARNESS` ?? `claude`; must be `claude` or `opencode`
  - `harnessBins.claude` = `SBOX_CLAUDE_BIN` ?? `claude`;
    `harnessBins.opencode` = `SBOX_OPENCODE_BIN` ?? `opencode`.
    `SBOX_HARNESS_BIN` is the legacy fallback for the adapter selected by
    `SBOX_HARNESS` only; the adapter-specific value wins when both are set.
  - `defaultModels` = one fallback per adapter. `SBOX_DEFAULT_MODEL` overrides the
    process-default harness; OpenCode otherwise gets
    `opencode-go/deepseek-v4.1-flash`, Claude gets null.
- **Run:** `node src/server/dist/app.js` with `SBOX_DB` set. The original had no process
  supervisor; it ran as a backgrounded process and had to be restarted manually.

---

## 4. Data model

SQLite with WAL and `foreign_keys=ON`. `db.ts` creates tables and runs idempotent
additive migrations, with an `addColumn` guard per column. Boot reconcile sets
`agent_status='idle'` where it was persisted as `working`, because no child survives a
restart.

### `requests`

`id` (uuid PK), `title`, `body`, `state`, `groomed` (0/1), `clarify_started` (0/1),
`model`, `effort`, `target_repo`, `acceptance_criteria`, `context`, `skills` (JSON
array), `kb_digest` (0/1, default 1), `digest`, `agent_status`
(`none|idle|working|blocked|error`, default `none`), `unchecked` (0/1), `hc_run_ids`
(JSON array), `branch`, `cr_url`, `cell_id`, `created_at`, `updated_at`.

Indexes: `idx_requests_state`, `idx_requests_cell`, the second created **after** the
`cell_id` addColumn, because an index on a missing column fails on an older database.

### `cells`

`id` (uuid PK), `name`, `master_enabled`, `master_interval_minutes`, `max_concurrent`,
`harness` (null inherits the process default), `model`, `effort`, `process_json`,
`created_at`. Requests inherit the cell harness; a cell master uses its cell's harness.

### `kb_entries`

`id` (uuid PK), `request_id`, `title`, `content`, `created_at`; index
`idx_kb_entries_request`. Re-indexing a request replaces its prior entry.

### `usage_events`

`id` (uuid PK), `turn_id` (unique engine turn id), `session_id`, `scope`
(`request|master|kb|setup`), `cell_id`, `request_id`, `model`, `effort`,
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `cost_usd` (nullable harness-reported cost), `created_at`.
One row is written after a completed turn that reported usage; cancelled, timed-out,
and usage-less turns write nothing. Unknown cost stays null, never zero. Indexes:
`idx_usage_events_created`, `idx_usage_events_cell_created`,
`idx_usage_events_request_created`, and unique `idx_usage_events_turn`.

### Domain (`src/server/domain/request.ts`)

- `STATES = clarify | dispatch | review | finalize | done | dropped`.
  `TERMINAL_STATES = done, dropped`.
- `TRANSITIONS`, enforced by the repository:
  - `clarify → dispatch, dropped`
  - `dispatch → review, clarify, dropped`
  - `review → finalize, clarify, dispatch, dropped`
  - `finalize → done, dropped`
  - `done` and `dropped` have none.
- `AGENT_STATUSES = none | idle | working | blocked | error`, normalized agent
  liveness, independent of `state`. Today the clarify child only sets `working` and
  `idle`.
- `isIntake(r) = state === 'clarify' && !clarifyStarted`. Intake is a view, not a state.

### Repositories

- `requests/repository.ts`: `create`, `get`, `list(filter)`, `setClarifyStarted`,
  `edit(fields)` with a partial PATCH of all editable fields, `transition(to)` which
  validates through `canTransition` and throws
  `RequestError('ILLEGAL_TRANSITION'|'NOT_FOUND')`, `addRun`, and agent-status, seen,
  and branch setters. `RequestError` maps to HTTP 404 or 409.
- `cells/repository.ts`: `list` by name, `get`, `create`, `rename`, `delete` in a
  transaction that nulls requests' `cell_id` before deleting the cell. No cascade
  delete of requests.
- `kb/repository.ts`: `store({requestId,title,content})` replaces the prior entry for
  that request, plus `list`, `getByRequest`, and a literal LIKE `search`.
- `usage/repository.ts`: `record(input)` writes one event per completed turn and
  `query(filter)` returns totals, UTC bucket series, and model/cell/request groups.
  Cost is the harness-reported value only; an unreported cost remains null.

---

## 5. HTTP API

All JSON unless marked **NDJSON**, which is chunked `reply.hijack()` with one JSON
object per line.

### Requests CRUD and lifecycle

- `GET /health`
- `GET /api/requests` with `?view=intake`, `?state=…`, or `?cellId=…`
- `GET /api/requests/:id`, `POST /api/requests {title, body?, targetRepo?, cellId?}`
- `PATCH /api/requests/:id` with all editable fields optional and nullable: title,
  body, targetRepo, acceptanceCriteria, context, skills[], groomed, model, effort,
  kbDigest, digest, cellId
- `POST /api/requests/:id/transition {to}`
- `POST /api/requests/:id/drop`, `POST /api/requests/:id/seen` (clears `unchecked`)
- Terminal transitions and `/drop` call `engine.dispose(id)`, which kills the session
  and removes the worktree.

### Agent and chat (NDJSON streams)

- `POST /api/requests/:id/clarify/start`, `POST /api/requests/:id/clarify/send {text}`
- `POST /api/requests/:id/dispatch` (review kickoff: `clarify → dispatch` plus a "start
  building" turn)
- `POST /api/requests/:id/finalize` (`review → finalize` plus a "propose KB digest" turn)
- `GET /api/requests/:id/clarify/stream` reattaches to an in-flight turn: it replays the
  event buffer, then streams live events, or returns `{active:false}` when idle
- `GET /api/requests/:id/clarify` returns `{started, transcript[]}`
- `POST /api/requests/:id/index {digest?, index?}` stores the digest to the KB when
  `index && kbDigest`, then transitions `finalize → done`
- **KB chat** is a reserved session on these same routes under id `__kb__`. It has no
  database row.

### Models, KB, plugins, cells

- `GET /api/models[?refresh=1][&harness=<id>|&cellId=<id>]` returns
  `{models[], source:'probe'|'fallback', effortLevels, harness, supportsEffort,
  defaultModel}`. `harness` and `cellId` are mutually exclusive.
- `GET /api/kb`, `GET /api/kb?q=…&limit=…`, `POST /api/kb {requestId,title,content}`
- `GET /api/plugins`, `POST /api/plugins {url, subdir?, name?}`,
  `DELETE /api/plugins/:name`
- `GET /api/commands` returns installed plugins' slash commands and skills as
  `[{command, description, plugin}]`
- `GET /api/cells`, `POST /api/cells {name, harness?, model?, effort?, process?}`,
  `PATCH /api/cells/:id {…}`, `DELETE /api/cells/:id`
- `GET /ws` is a websocket skeleton (echo plus hello), reserved for an event bridge and
  unused.
- When `webDir` exists, `@fastify/static` serves the SPA at `/` with an `index.html`
  fallback for non-`/api`, non-`/ws` GETs.

### Usage

- `GET /api/usage?cellId=…&requestId=…&from=…&to=…&bucket=hour|day&limit=…`
  returns `{range, totals, series[], byModel[], byCell[], byRequest[]}`. Bounds are
  epoch milliseconds (`from` inclusive, `to` exclusive). Series buckets are UTC-aligned
  and zero-filled when both bounds are supplied; a bounded request over 10,000 buckets
  is rejected with 400. Totals separate known cost from
  `unknownCostTurns`; a model with no reported cost is unknown, not zero. Request groups
  include the request's current cell as `cellId`/`cellLabel`.

### NDJSON event shape

`{t:'text', text}` · `{t:'tool', id, name, input}` ·
`{t:'tool_result', id, text, isError}` · `{t:'done', request|null, transcript}` ·
`{t:'error', message}`.

---

## 6. The agent engine

One persistent child per request, carried across all workflow steps and resumed across
restarts. The adapter is chosen per session: a request or cell master resolves through
its cell (`cells.harness`, then `SBOX_HARNESS`), while setup, KB, and unassigned sessions
use the process default. The same resolved adapter creates the parser and spawns the
child.

- **Spawn:** Claude runs `claude -p --input-format stream-json --output-format
  stream-json --include-partial-messages --verbose --mcp-config <generated>
  --strict-mcp-config --allowedTools <…> [--model …] [--effort …] [--resume <sid>]`,
  with `cwd` set to the request's worktree and
  `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` in the environment. OpenCode runs
  `opencode run --format json --auto --standalone --archived [--model …] [--session …]`.
  The `session_id` from the adapter's init event is captured to `session.json` with the
  harness id, then reused only by that adapter on later spawns. An in-flight turn keeps
  its adapter; changing a cell's harness discards the cached child and session id before
  the next turn.
- **Allowed tools:** request sessions get `Write, Read, Edit, Bash, Skill, Glob, Grep`,
  the harness MCP tools, and the user's own MCP servers (Claude reads
  `~/.claude.json`/`.mcp.json`; OpenCode reads its config). The KB session (`__kb__`) is
  read-only: `Read` plus the KB MCP tools, no plugins, no user servers, no request scope.
- **Live turns and reattach:** a turn is decoupled from the originating HTTP request.
  `beginTurn` creates a `LiveTurn` with an event buffer, subscribers, a done flag, and a
  promise. Events are buffered and broadcast to every subscriber. `attach(id, emit)`
  replays the buffer, then streams the rest. `hasLive(id)` is false once done, and the
  turn is dropped immediately so a post-completion mount does not replay it.
  `start`, `send`, `dispatch`, and `finalize` all run through `beginTurn` and are
  idempotent; a second caller attaches.
- **Turn parsing:** reads stream-json lines, accumulates text deltas and tool cards
  (input plus capped output), persists an ordered `transcript.json`, and resolves on the
  `result` event.
- **Prompts:** fresh sessions fold a role brief into the first message. `seedPrompt`
  grooms and tells the agent to maintain the ticket through `update_request`.
  `dispatchPrompt` says stop clarifying and build on an isolated branch, do not push,
  do not open a change request. `finalizePrompt` asks for a KB digest. `kbSeedPrompt`
  answers from the KB through `search_kb` and `list_kb`.
- **Agent status:** `working` on turn start, `idle` on end, `unchecked` when a turn
  finishes, cleared by `/seen`. Boot reconciles a stale `working` to `idle`.
- **Per-request git worktree:** `agentCwd` resolves the session cwd to a worktree off
  the target repo on branch `sbox/<requestId>`, via `ensureWorktree`,
  `removeWorktree`, and `branchName`. It falls back to the scratch workdir when there is
  no target repo or git fails. Transcript, session, and MCP config stay in the scratch
  workdir, out of the repo. `dispose(id)` kills the child and removes the worktree on
  terminal transitions.
- **Workdirs:** `~/.sandbox-harness/requests/<id>/` holds `transcript.json`,
  `session.json` (`{harness, sessionId}`), and the harness-specific config
  (`mcp-config.json` or `opencode/opencode.json`).

### Models

`EFFORT_LEVELS = low|medium|high|xhigh|max`. Each harness has its own model catalog and
ten-minute cache: Claude probes the CLI (there is no `claude models` command) and falls
back to `HARDCODED_MODELS`; OpenCode probes `opencode models` and has no offline fallback.
`GET /api/models?harness=<id>` or `?cellId=<id>` returns that adapter's list,
`supportsEffort` (Claude only), and its default model. No query uses the process default;
passing both parameters or an unknown harness is a 400.

### Model and effort guidance

**Source of truth is runtime, not this table.** `GET /api/models` returns the live list.
The snapshot below is a default to override, and should be re-verified as models ship.
Model and effort are per-request (`--model`, `--effort`; null means the brain default,
then the CLI default) and apply to that request's one persistent session across every
step. `SBOX_DEFAULT_MODEL` sets the process-default harness's fallback; per-cell model
overrides win. OpenCode otherwise defaults to `opencode-go/deepseek-v4.1-flash`; Claude
otherwise has no model default.

**Current family** (id, tier, when to pick it, first-party USD per million in and out):

| Model id | Tier | $/1M | Pick for |
|---|---|---|---|
| `claude-fable-5-2` | Most capable | 8 → 40 | Hardest reasoning and long-horizon agentic work; only when Opus is not enough |
| `claude-opus-5-5` | Flagship | 4 → 20 | Default for correctness-sensitive work: implementation, verification, tricky planning |
| `claude-sonnet-5-5` | Balanced | 2 → 10 | Everyday coding, interactive grooming, digests |
| `claude-haiku-5-5` | Fast and cheap | 0.10 → 0.50 | High-volume, mechanical, latency-sensitive steps |

Older point versions stay selectable; prefer the current generation unless pinning.

**Effort.** Higher means deeper reasoning and more tokens. Defaults differ. Opus 5.5
defaults to `medium` when set explicitly; most others default to `high`. Coding and
agentic work repays `high` or `xhigh`; chat, classification, and bulk work do well at
`low` or `medium`.

**Recommended default per workflow segment** (tune on real traffic):

| Segment | Model | Effort | Why |
|---|---|---|---|
| Auto-research and follow-up questions | haiku | low to medium | Mechanical, high volume, fast |
| Plan and clarify | sonnet | medium | Interactive; judgment, not correctness |
| Implement | opus | high or xhigh | Correctness matters; agentic coding |
| Verify and write tests | opus | high | Catching real failures |
| Finalize digest | sonnet | medium | Summarization |
| KB chat | haiku | low to medium | Retrieval plus answer, latency-sensitive |
| Exceptionally hard or stuck | fable | high | Escalation only, because of cost |

Pricing varies by platform and contract. The relative capability and cost ordering is
what this guidance keys on.

### Harness MCP server

A stdio MCP server the engine launches per session through `--mcp-config`, scoped by
env `SBOX_REQUEST_ID` and `SBOX_BRAIN_URL`, proxying to the loopback REST API. Tools:
`update_request`, `get_request`, `spawn_request`, `list_requests`, `index_to_kb` for
request sessions; `search_kb`, `list_kb` for the KB session. Namespaced
`mcp__harness__*` and allow-listed so the agent can call them under auto-approve.

### Wire contracts

**Claude stream-json events the engine consumes**, one JSON per line on child stdout,
mapped to our NDJSON:

- `{type:'system', subtype:'init', session_id}` captures the session id for `--resume`.
- `{type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta', text}}}` becomes `{t:'text', text}`.
- `{type:'assistant', message:{content:[{type:'tool_use', id, name, input}]}}` becomes `{t:'tool', id, name, input}`.
- `{type:'user', message:{content:[{type:'tool_result', tool_use_id, content, is_error}]}}` becomes `{t:'tool_result', id, text, isError}`.
- `{type:'result'}` completes the turn; the engine then emits `{t:'done', …}`.

Input to the child is written to stdin as
`{type:'user', message:{role:'user', content:[{type:'text', text}]}}` plus a newline.

**Generated `mcp-config.json`**, per-request workdir, passed with
`--mcp-config … --strict-mcp-config`:

```json
{ "mcpServers": { "harness": {
  "command": "<node>", "args": ["<dist>/mcp/server.js"],
  "env": { "SBOX_BRAIN_URL": "http://127.0.0.1:7391", "SBOX_REQUEST_ID": "<id or ''>" } } } }
```

`SBOX_REQUEST_ID` is empty for the `__kb__` session.

**TranscriptMsg**, persisted to `transcript.json`, returned by `GET /clarify`, and
carried in the `done` event:
`{role:'you'|'agent', kind:'text'|'tool', text, toolId?, toolName?, toolInput?, toolResult?, toolError?, ts}`.

**HTTP error mapping:** `ZodError` becomes 400 `{error:'invalid',issues}`;
`RequestError` becomes 404 for `NOT_FOUND` and 409 otherwise; anything else becomes 500
`{error:'internal',message}`.

---

## 7. Plugins, skills, slash commands

`PluginManager(pluginsDir)`:

- `install({url, subdir?, name?})` shallow-clones, optionally into a monorepo subdir,
  verifies `plugin.json`, copies into `pluginsDir/<name>`, and **strips** plugin
  `hooks` and `mcpServers`, plus the `hooks/` directory and `.mcp.json`, so a plugin
  contributes only skills, commands, and subagents.
- `list()`, `remove(name)` with a slug guard, `installedPluginDirs(dir)` returning child
  dirs that have a `plugin.json` (the engine passes one `--plugin-dir` each on request
  spawns), and `listCommands()` which walks `commands/*.md` recursively with
  `:`-namespaced names, adds `skills/*/SKILL.md`, and reads descriptions from
  frontmatter.
- URL validation: only `http(s)`, `git`, and `ssh` transports.

---

## 8. Web SPA

- `main.tsx` adds `.dark` to `<html>`. `App.tsx` is the shell: a left nav (Floor, board
  columns, Knowledge base, Skills), a `CellBar` to switch cells, a stacked-table board,
  a right-side request detail drawer that can maximize, and a create modal.
- **Board:** columns labelled Requests (intake), Plan (clarify), Implement (dispatch),
  Review, and Finalize. `done` leaves the board. `columnOf` and `STATE_LABELS` map state
  to label; `types.ts` mirrors the server state machine.
- **RequestDetail:** editable fields, model and effort pickers, transition buttons with
  a two-step drop confirm, the dispatch and finalize kickoff streams, and the finalize
  digest box with "Index and finalize".
- **Chat:** `ClarifyChat` plus `runtime.ts` using `useExternalStoreRuntime`; React owns
  messages and running state and probes `/clarify/stream` to reattach on mount.
  `Thread.tsx` holds assistant-ui primitives, markdown, tool cards, and code diffs.
  `Composer.tsx` is a custom input with a `/` slash-command autocomplete from
  `/api/commands`, disabled for the KB chat. KB chat is `ClarifyChat` against `__kb__`.
- **SkillsPage** installs, lists, and removes plugins. **CellBar** creates, switches,
  renames, and deletes cells, filtering the board by `cellId`.
- `api.ts` is the typed client (fetch plus NDJSON readers). `ui.tsx` is the component
  kit. The bundle is vended by the brain at `/`.

---

## 9. Build, run, test

```bash
npm install                 # workspaces
npm run build               # web (vite) then server (tsc) into src/*/dist
npm run typecheck           # tsc --noEmit for both
npm test                    # vitest, server
npm run lint                # eslint
SBOX_DB=/abs/sandbox-harness.sqlite node src/server/dist/app.js
```

The original test suite covered the request repo and state machine, the cells repo,
the KB repo, models, MCP grants parsing, worktree isolation, and an HTTP server test.

---

## 9a. Canonical data shapes

The server is the source of truth; the SPA mirrors these by hand.

### Domain entities

```ts
type State = 'clarify' | 'dispatch' | 'review' | 'finalize' | 'done' | 'dropped';
type AgentStatus = 'none' | 'idle' | 'working' | 'blocked' | 'error';

interface Request {
  id: string; title: string; body: string;
  state: State;
  groomed: boolean; clarifyStarted: boolean;
  targetRepo: string | null;
  model: string | null;          // claude --model id, null means the CLI default
  effort: string | null;         // low|medium|high|xhigh|max, null means default
  acceptanceCriteria: string | null;
  context: string | null;
  skills: string[];
  kbDigest: boolean;             // index into the KB on finalize? default true
  digest: string | null;         // human-approved KB digest text
  agentStatus: AgentStatus;
  unchecked: boolean;            // agent finished, human has not opened it since
  hcRunIds: string[];            // provenance (dormant)
  branch: string | null;         // sbox/<id>
  crUrl: string | null;
  cellId: string | null;         // at most one cell; null means the unfiltered floor
  createdAt: number; updatedAt: number;
}

interface Cell { id: string; name: string; createdAt: number; }

interface KbEntry {
  id: string; requestId: string; title: string; content: string; createdAt: number;
}
```

### HTTP DTOs

```ts
interface CreateInput { title: string; body?: string; targetRepo?: string | null; cellId?: string | null; }

interface EditInput {
  title?: string; body?: string; targetRepo?: string | null;
  acceptanceCriteria?: string | null; context?: string | null;
  skills?: string[]; groomed?: boolean;
  model?: string | null; effort?: 'low'|'medium'|'high'|'xhigh'|'max' | null;
  kbDigest?: boolean; digest?: string | null; cellId?: string | null;
}

// POST /api/requests/:id/transition   { to: State }
// POST /api/requests/:id/index        { digest?: string | null; index?: boolean }
// POST /api/kb                        { requestId: string; title: string; content: string }
// POST /api/plugins                   { url: string; subdir?: string; name?: string }
// POST /api/cells {name, harness?, model?, effort?}; PATCH /api/cells/:id {…}

interface ModelOption { id: string; label: string; }
interface ModelsResult { models: ModelOption[]; source: 'probe' | 'fallback'; effortLevels: string[];
  harness: 'claude' | 'opencode'; supportsEffort: boolean; defaultModel: string | null; }

interface PluginInfo  { name: string; description: string; dir: string; }
interface CommandInfo { command: string; description: string; plugin: string; }
```

### Chat and streams

```ts
interface TranscriptMsg {
  role: 'you' | 'agent'; kind: 'text' | 'tool'; text: string;
  toolId?: string; toolName?: string; toolInput?: string;
  toolResult?: string; toolError?: boolean; ts: number;
}
interface ClarifyState { started: boolean; transcript: TranscriptMsg[]; }

type ClarifyEvent =
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; name: string; input: string }
  | { t: 'tool_result'; id: string; text: string; isError: boolean }
  | { t: 'done'; request: Request | null; transcript: TranscriptMsg[] }
  | { t: 'error'; message: string };
```

### Persistence note

Row columns are `snake_case` (`clarify_started`, `kb_digest`, `cell_id`); JSON array
fields are stored as JSON text; booleans as `0/1`. Repositories map rows to the
camelCase domain types.

---

## 10. Status at extraction

- **Implemented:** request CRUD and state machine, clarify/implement/finalize streaming
  with reattach, per-request sessions with resume, harness MCP plus user MCP servers,
  per-request git worktrees, KB store and KB chat, plugins with slash menu, cells,
  agent-status and unchecked indicators, SPA, single-origin vend plus an SSO tunnel.
- **Not built:** no process supervisor (manual restarts), no CI pipeline integration
  (the review step is human-driven and agents are told not to push or open change
  requests), the KB is a verbatim store with no embeddings or semantic retrieval, the
  dormant `hc` scaffolding, and the data-defined "factory workflow plus mentor" vision,
  which is design-stage.

The rebuild's own status is tracked separately in `docs/02-status.md`.
