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
the marker. Cost: prods are sequential, a hung turn blocks the cycle, and cadence is
global. Per-cell cadence and an LLM judge are natural next steps.

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

## Open items for review

- Activate CI by publishing `deploy/ci-workflow.yml` with a `workflow`-scoped credential.
- Decide whether OpenCode should use a per-request persistent server.
- Decide whether effort should map to OpenCode model variants or stay inert.
- KB embeddings versus the ranked literal search.
- Pipeline/review automation stays human-driven by design.
