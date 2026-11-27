# Design liberties

Choices made autonomously while continuing the build after the handoff. Each entry says
what was chosen, what was not, and why. `docs/01-system-spec.md` remains the governing
contract; these are additions or deviations, and the D references point at
`docs/03-decisions.md`.

## 1. Harness seam with `claude` as the default

**Chosen.** The engine depends on `AgentHarness` through a cached registry.
`APS_HARNESS=claude|opencode` sets the process default (legacy `SBOX_HARNESS` still
works), and each cell may override it. `APS_CLAUDE_BIN` and `APS_OPENCODE_BIN` point at
each binary; the legacy `APS_HARNESS_BIN` is the default adapter's fallback and loses to
the specific value.

**Alternative.** Hardwire OpenCode because it is what this host has authenticated.

**Why.** Preserves the spec's contract, keeps existing request/model choices working, and
lets one brain mix work and home workspaces. Adding a third harness is one adapter plus a
registry entry.

## 2. OpenCode is one archived standalone process per turn

**Chosen.** `opencode run --format json --auto --standalone --archived` per turn. The
session id lives in `session.json`; `--session` resumes; `PWD` is pinned to the request
cwd; `--auto` is the request-session permission posture; the KB session gets explicit
deny rules.

**Alternatives.** A persistent `opencode serve` per request (faster, more state), or
leaving sessions visible in the user's list.

**Why.** The CLI is one-shot per message, `--standalone` gives the generated
`OPENCODE_CONFIG_DIR` config a private server, and `OPENCODE_CONFIG_PROJECT_DISABLE=1`
stops project/ancestor config from layering above it. Archived sessions do not clutter
the user's list. The child environment also strips
`OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT`, which OpenCode layers above the generated
file; a set variable warns once and is ignored. Cost: about a second of server start per
turn, and effort is inert for this harness.

**Review note.** If turn latency matters more than simplicity, a per-request server is
the upgrade path.

## 3. User MCP merge sources

**Chosen.** Claude reads user and local scopes from `~/.claude.json` plus project
`<cwd>/.mcp.json`, merges them into the generated config in the CLI's precedence order
(local > project > user, each winning entry used whole), and adds `mcp__<server>__*`
allow rules. The reserved-key `aps` warning names the winning file and scope. OpenCode
merges `mcp` entries from the global `opencode.json` or `opencode.jsonc`, both read as
JSONC (comments and trailing commas are accepted; JSON5 is not). Project and ancestor
files are disabled (`OPENCODE_CONFIG_PROJECT_DISABLE=1`), so they are not a merge source.
KB sessions exclude user servers entirely. A missing file is silent; a file that exists but cannot be read or
interpreted is skipped with a one-time stderr warning and a `harness.mcpConfig`
error-log record naming the path and a short reason. Configuration-level env overrides
(`OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`) are not a merge source; §2 strips them
from the child.

**Alternatives.** Parse `claude mcp get` text or ask the CLI for definitions (private,
unstable output); merge into global configs (shared state).

**Why.** These files are the CLI's own storage, and the KB stays read-only. Risk: the
Claude file layout is private and can change. The wildcard allow rules are verified from
the CLI binary and the mock turn, not a live Claude model.

## 4. Plugin mapping for OpenCode

**Chosen.** Installed `commands/**/*.md` become OpenCode `commands` templates; each
`skills/*/SKILL.md` folder is added to `skills`, plus a thin `plugin:skill` command so the
SPA slash menu works. Names keep `plugin:name`, matching `/api/commands`.

**Alternatives.** Leave OpenCode plugins unsupported, or load plugin JavaScript through
OpenCode's plugin API.

**Why.** Preserves the Skills page semantics without executing third-party JS. Cost:
plugin content is copied into each request config; malformed commands are skipped.

## 5. Effort is harness-specific

**Chosen.** `/api/models` adds `harness` and `supportsEffort`; the drawer shows the
effective harness and renders Effort as inert with a hint when the harness ignores it.
The cell editor chooses a cell's adapter, and the request drawer can override that cell
for one request. A cross-harness request does not inherit the cell's model or effort.

**Alternatives.** Hide the field, or map effort to OpenCode model variants.

**Why.** Effort is a Claude flag, and an inert control is misleading. A layered override
avoids duplicating an entire cell for a one-off request while keeping the adapter's model
list honest. Additive fields
keep older clients working.

## 6. KB search ranks literal terms

**Chosen.** Whitespace-separated terms are ANDed with escaped `LIKE`; a title phrase
scores 6, a title term 3, a body term 1, with recency as the tiebreak and a 1000-row
candidate cap.

**Alternatives.** FTS5, or an embedding provider.

**Why.** No new dependency or index, and multi-word results are better. Cost: no semantic
recall, and a space-separated query is AND of terms rather than one phrase.

## 7. Deployment and CI

**Chosen.** A systemd **user** unit with `loginctl enable-linger` (deploy/vps.md), and a
CI workflow published at `.github/workflows/ci.yml` from the `deploy/ci-workflow.yml`
template.

**Alternatives.** A system-wide unit; keeping the workflow only as an unpublished
template.

**Why.** The user unit keeps the operator's `claude`/`opencode` login and keeps the brain
out of a herdr cgroup. The template is copied byte-for-byte to
`.github/workflows/ci.yml`, and `src/server/test/ci-workflow.test.ts` fails on drift; that
keeps one editable source (the template) while GitHub runs the published copy.

## 8. SPA dependency pins

**Chosen.** React 18 with `@assistant-ui/react` 0.15.38 and Tailwind 3; Vite 8 and
Vitest 5 for the web workspace, Vitest 2 on the server; mermaid 12.3.0 for Help
diagrams.

**Alternative.** React 19; keeping mermaid 12 pinned to the pre-v12 `dagre` layout and
`classic` look.

**Why.** The spec names the external-store API and React 18, and 0.15.38 still supports
both while clearing the vulnerable `nanoid` range that 0.10 pulled in. mermaid 12.3.0
moves its KaTeX dependency onto the patched 0.18 line (`GHSA-238p-pmpm-9mq7`). Its ELK
layout and `neo` look are adopted for Help diagrams after a deliberate visual review of
the three README diagrams; the first diagram loads the lazy ~1.5 MB ELK chunk behind the
existing spinner, and later diagrams reuse it.

## 9. Cell masters are deterministic and marker-based

**Chosen.** A server-side scheduler runs every configured interval, prods idle `dispatch`
requests in enabled cells through the normal agent session, and moves
`dispatch → review` only when the reply contains `READY FOR REVIEW`.
Policy and per-cell switches live in the XDG settings file; prod/review/cycle/skip events
are stored.

**Alternatives.** A dedicated master LLM session per cell; automatic review based on
transcript heuristics; a per-cell cadence in this pass.

**Why.** The scheduler is cheap, observable, and cannot invent state transitions without
the marker. Cost: a cycle starts its selected batch and returns, then completion and
marker advancement settle in the background; the next tick can refill capacity while
turns run. Runs are keyed per cell, so a tick during an active dispatch cycle is dropped
and retried at the next cadence. The batch shares the cell/model concurrency budget;
cadence was global in this early pass. Per-cell cadence and an LLM judge were natural
next steps.

## 10. One thread and an advisory master chat

**Chosen.** The same chat thread is rendered in clarify, dispatch, review, and finalize;
terminal states are read-only. The master is a reserved `__master__` session with
read-only board/KB tools, and the scheduler writes cycle/prod/review notes into it.

**Alternatives.** A separate chat per segment; giving the master write or prod tools;
running an LLM master turn every cycle.

**Why.** One persistent session already exists per request, so one thread is the honest
interface. The master chat is advisory and the deterministic scheduler still drives
work. Cost: the chat cannot operate the master; notes are one-way.

## 11. The SPA type-imports the server contract

**Chosen.** `src/web/src/types.ts` re-exports the pure modules
`server/src/domain/request`, `master/types`, `plugins/types`, and `clarify/models`
instead of restating them. Those modules stay free of Node imports.

**Alternative.** A `src/shared` workspace package compiled for both sides.

**Why.** It removes drift between the workflow table and request shape with one source
of truth and no extra build graph. Cost: the boundary is enforced by convention and a
comment, not package exports.

## 12. Process segments are XDG JSON with per-cell snapshots

**Chosen.** `process.json` beside `config.json` is the global default; JSON rather than
YAML so the existing zod/atomic-write path is reused without a parser dependency. A cell
stores a full snapshot in `cells.process_json`, seeded from the global default at
creation, plus an optional `master_interval_minutes` for its own ticker. The Config page
edits the global template structurally; raw JSON is not shown in the SPA.

**Alternatives.** Put segments inside `config.json`, global-only policy, or YAML support.

**Why.** Pipeline definitions are larger and change more often than the scheduler policy,
and separate per-cell snapshots let a strict repository diverge without changing every
other cell. Cost: two config locations; snapshots do not follow later global edits; each
cell has its own timer and master chat.

## 13. Browser terminal uses node-pty and xterm.js

**Chosen.** Server-owned PTY sessions with xterm.js in the SPA, a visible session strip,
detach-on-hide with scrollback replay, explicit session close, desktop-only trigger,
maximize/restore, `APS_TERMINAL=0` kill switch, and a configurable starting cwd.

**Alternatives.** A command runner without a PTY (breaks interactive tools), killing the
shell when the panel hides, reusing the agent’s child process (violates isolation), or a
separate local terminal app.

**Why.** The operator asked for occasional shell work without leaving the harness and for
reuse instead of a fresh shell every open. Server-owned sessions make hiding, reload, and
phone/laptop handoff reattach to the same shell. Cost: a native dependency, a bounded
scrollback buffer, a powerful no-auth endpoint, and a desktop-only UI that relies on the
loopback/trusted-tunnel boundary.

## 14. Cell concurrency and model defaults over per-segment settings

**Chosen.** `max_concurrent` (default 3), `model`, and `effort` live on the cell, not on
each process segment. The engine falls back to them when a request leaves model/effort
empty; a request override wins. The master checks `working` count before starting turns.

**Alternative.** Per-segment model/effort/concurrency.

**Why.** Most operators change a cell’s risk posture as a whole, and a request-level
override already exists. Cost: a cell cannot run Plan on a cheaper model than Implement
without a request override; per-segment limits are future work if that becomes common.

## 15. Error-only disk logging

**Chosen.** A single NDJSON error log under XDG state, injected as a narrow `ErrorSink`.
It records startup, invalid config, unexpected 5xx, engine/master failures, and terminal
open failures, with ids/method/URL only. Size-rotated once; write failures swallowed.

**Alternatives.** Full structured logging, rotating daily files, or relying on
`journalctl`/stderr only.

**Why.** Disk space is cheap but not free, and failure context is what usually matters
after the fact. Cost: no normal-operation trace on disk; use `journalctl` or the in-app
event log/transcripts for those.

## 16. Slash skills become prompt instructions

**Chosen.** Discover skills from the CLIs’ standard directories, show them in the same
slash menu as plugin commands, and translate a sent skill label into an instruction.

**Alternatives.** Inject every skill as an OpenCode command, require users to type the
full instruction, or only show plugin skills.

**Why.** Both Claude and OpenCode can load skills, but their slash-command mechanisms
differ. An instruction is portable and keeps the UI simple. Cost: the menu is not a
literal CLI command list; a skill that exists only inside a target repo is request-scoped.

## 17. Merge is a built-in optional state, not a dynamic stage DSL

**Chosen.** Add one fixed `merge` state/column and per-segment `maxConcurrent`. The cell
wizard chat edits the server-backed draft with the same validation.

**Alternative.** A fully dynamic stage definition language where operators add arbitrary
states and columns.

**Why.** Merge is the concrete operational bottleneck (serialize rebase/push), and a fixed
state keeps the transition table, board, and API honest. Cost: arbitrary extra stages
still require a new state and UI column; the wizard can recommend them but not invent
them. The `maxConcurrent` field is generic, so other segments can be serialized now.

## 18. Auto-compaction is harness-native and configured per cell

**Chosen.** A cell stores `autocompact_percent` (default 80, range 1–99). Request
sessions translate it into the harness's own compaction controls: OpenCode gets
`compaction.auto: true` and `compaction.buffer: "<100 - percent>%"`; Claude gets
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `autoCompactEnabled: true`. Unassigned requests
use 80. KB, master, setup, and summary sessions keep their existing behavior.

**Alternatives.** Brain-side token accounting plus transcript summarization; a global
setting only; a per-request override.

**Why.** Both harnesses already compact and account for their model context windows.
Reusing their thresholds is small, observable, and avoids a second source of truth.
Token/usage accounting is separate and already built. Cost: Claude cannot
raise its built-in threshold, so cell values above that default collapse to Claude's
default; a global default and per-request overrides remain follow-ups if operators ask.

## 19. Pricing is an empty operator-maintained table

**Chosen.** Ship `model_pricing` empty and expose a Config page editor plus `/api/pricing`
rather than bundling a vendor price list. Normal price changes add an effective-dated row;
`DELETE` is for mistaken entries only.

**Alternatives.** Seed public list prices, read a checked-in JSON file, or infer a price
from the model name.

**Why.** The repo uses fictional model ids and cannot know an operator's contract, region,
or plan. Guessing would make estimates look authoritative when they are not. Cost: an
operator must enter prices before estimates appear. Matching is exact and USD-only; tiered
pricing, currencies, and bulk import are follow-ups.

## 20. The bundled MCP key is reserved and old transcript labels are normalized

**Chosen.** Key the bundled stdio MCP server `aps`, reserve that key, and normalize
legacy `mcp__harness__*` / `harness_*` tool labels in the web client instead of
rewriting persisted transcripts.

**Alternatives.** Keep `harness` as the MCP key; use the full product name
`agent-process-segments`; reject a user config that already defines `aps`; migrate old
transcripts in the database.

**Why.** `aps` matches the canonical runtime prefix and keeps tool names short, while a
reserved key mirrors the old `harness` precedence and avoids a hard failure in a turn.
Normalizing only at render time keeps stored history auditable and needs no migration.
Cost: a user MCP server named `aps` is replaced by the bundled server, and the brain logs
one warning naming the winning config file and scope. The stored transcript still contains the old
prefix, so raw exports show the historical name.

## Open items for review

- Decide whether OpenCode should use a per-request persistent server.
- Decide whether effort should map to OpenCode model variants or stay inert.
- KB embeddings versus the ranked literal search.
- Pipeline/review automation stays human-driven by design.
