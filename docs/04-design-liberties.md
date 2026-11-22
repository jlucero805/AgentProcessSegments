# Design liberties

Choices made autonomously while continuing the build after the handoff. Each entry says
what was chosen, what was not, and why. `docs/01-system-spec.md` remains the governing
contract; these are additions or deviations, and the D references point at
`docs/03-decisions.md`.

## 1. Harness seam with `claude` as the default

**Chosen.** The engine depends on `AgentHarness`. `SBOX_HARNESS=claude|opencode`, default
`claude`; `SBOX_HARNESS_BIN` overrides the binary, and `SBOX_CLAUDE_BIN` still works for
Claude.

**Alternative.** Hardwire OpenCode because it is what this host has authenticated.

**Why.** Preserves the spec's contract and keeps existing request/model choices working.
Adding a third harness is one adapter plus a config value.

## 2. OpenCode is one archived standalone process per turn

**Chosen.** `opencode run --format json --auto --standalone --archived` per turn. The
session id lives in `session.json`; `--session` resumes; `PWD` is pinned to the request
cwd; `--auto` is the request-session permission posture; the KB session gets explicit
deny rules.

**Alternatives.** A persistent `opencode serve` per request (faster, more state), or
leaving sessions visible in the user's list.

**Why.** The CLI is one-shot per message, `--standalone` makes `OPENCODE_CONFIG_DIR`
reliable, and archived sessions do not clutter the user's list. Cost: about a second of
server start per turn, and effort is inert for this harness.

**Review note.** If turn latency matters more than simplicity, a per-request server is
the upgrade path.

## 3. User MCP merge sources

**Chosen.** Claude reads user and local scopes from `~/.claude.json` plus project
`<cwd>/.mcp.json`, merges them into the generated config, and adds `mcp__<server>__*`
allow rules. OpenCode merges `mcp` entries from its config. KB sessions exclude user
servers entirely.

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
harness and renders Effort as inert with a hint when the harness ignores it.

**Alternatives.** Hide the field, or map effort to OpenCode model variants.

**Why.** Effort is a Claude flag, and an inert control is misleading. Additive fields
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
ready CI workflow at `deploy/ci-workflow.yml`.

**Alternatives.** A system-wide unit; publishing `.github/workflows` directly.

**Why.** The user unit keeps the operator's `claude`/`opencode` login and keeps the brain
out of a herdr cgroup. The publishing token lacks the `workflow` scope, so the workflow
stays a template until that scope is granted.

## 8. SPA dependency pins

**Chosen.** React 18 with `@assistant-ui/react` 0.10 and Tailwind 3; Vite 8 and Vitest 5
for the web workspace, Vitest 2 on the server.

**Alternative.** The current assistant-ui 0.15 line and React 19.

**Why.** The spec names the external-store API and React 18; the 0.10 line matches it.
**Review note.** Upgrading assistant-ui later is a primitives migration.

## 9. Cell masters are deterministic and marker-based

**Chosen.** A server-side scheduler runs every configured interval, prods idle `dispatch`
requests in enabled cells (and optionally unassigned work) through the normal agent
session, and moves `dispatch → review` only when the reply contains `READY FOR REVIEW`.
Policy and per-cell switches live in the XDG settings file; prod/review/cycle/skip events
are stored.

**Alternatives.** A dedicated master LLM session per cell; automatic review based on
transcript heuristics; a per-cell cadence in this pass.

**Why.** The scheduler is cheap, observable, and cannot invent state transitions without
the marker. Cost: a cycle now starts its selected batch together, so a slow turn no longer
delays the others in that batch, but they share the cell/model concurrency budget; cadence
was global in this early pass. Per-cell cadence and an LLM judge were natural next steps.

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
maximize/restore, `SBOX_TERMINAL=0` kill switch, and a configurable starting cwd.

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

## Open items for review

- Activate CI by publishing `deploy/ci-workflow.yml` with a `workflow`-scoped credential.
- Decide whether OpenCode should use a per-request persistent server.
- Decide whether effort should map to OpenCode model variants or stay inert.
- KB embeddings versus the ranked literal search.
- Pipeline/review automation stays human-driven by design.
