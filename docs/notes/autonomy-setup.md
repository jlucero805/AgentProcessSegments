# Note: full-autonomy segment setup

Working note, not operator documentation. Keep it out of the in-app Help manifest, which
lists pages explicitly.

Saved 2026-11-21. Nothing here is configured yet. This is the intent to set up later.

## Intent

- The **Requests** segment knows the deployment works in
  `https://github.com/jlucero805/AgentProcessSegments`.
- The **master** has autonomy across **every** segment, not just Implement.
- **Implement** can create more tasks.
- When there is no work, the master **updates documentation** so it stays current and
  looks for **gardening** work. Gardening means surveying the codebase for issues:
  refactors, bugs, memory leaks, bad practices, duplication (DRY), and similar.

## Where each instruction actually goes

The wizard's **Purpose** field is cosmetic. It appears in the editor and the cell master
drawer, is stored with the policy, and is never sent to the agent. Only **Agent prompt**
reaches the session. Put the repo URL and the autonomy rules in prompts.

| Want | Control |
| --- | --- |
| Repo identity in Requests | `intake.prompt` (empty today, so add it) |
| Master works every segment | `enabled` on all five segments |
| Hand-off between stages | `readyMarker` plus `advanceTo` per segment |
| Implement creates tasks | `implement.followUps.enabled` with marker `FOLLOW-UP:` |
| Richer task creation | `spawn_request` MCP tool, already allow-listed for request sessions |
| Documentation upkeep and gardening | not expressible today, see the gap below |
| Cadence per cell | `masterIntervalMinutes` and the global interval |
| Spend ceiling | `idleMinutes`, `maxPerCycle`, cell and segment concurrency |

## Suggested segment shape

- **intake** on, short idle threshold. Prompt carries the repo URL plus "read
  `AGENTS.md` and `docs/01-system-spec.md` before proposing anything".
- **plan** on, `advanceTo: dispatch`, marker `READY FOR IMPLEMENTATION`.
- **implement** on, `advanceTo: review`, marker `READY FOR REVIEW`, follow-ups on.
- **review** on, `advanceTo: finalize` or back to `dispatch` for rework, marker
  `READY TO FINALIZE`.
- **finalize** on. It can be prodded but never auto-advances, because the human index
  action is what writes the KB digest.

Validation rules to respect:

- `advanceTo` requires a non-null `readyMarker`.
- `intake` and `finalize` cannot set `advanceTo`.
- Every segment id must appear exactly once; array order is evaluation order.

## The gap: "when there is no work"

The scheduler only runs a segment against **eligible requests** (right state, enabled
segment, idle window passed, no live turn, under limits). An empty cycle records
nothing and sends no turn. There is no idle hook, so documentation upkeep and gardening
cannot be configured today.

Options, cheapest first:

1. **Standing request.** Keep a "gardening" request in intake. Works with zero code, but
   it competes for `maxPerCycle` and shows on the board forever.
2. **Idle hook in `MasterService`.** When a cell cycle finds zero eligible work, send a
   prompt to that cell's master chat (`__master__:<cellId>`, or `__master__` for
   unassigned) or create a maintenance request. Needs its own interval, a spend cap, and
   a way to avoid firing every tick.
3. **Separate scheduled job.** A daily maintenance run outside the master, writing its
   findings as requests. Cleanest budget story, most new code.

Option 2 is the smallest change that matches the intent. Do not ship it without a cap.

## Instructions to put in the implement prompt

- Work in the request's worktree on its `sbox/<id>` branch. Do not push, do not open a
  change request, unless the operator says otherwise in that segment's prompt.
- Finish with `READY FOR REVIEW` only after `npm test`, `npm run typecheck`, and
  `npm run build` pass.
- Call out out-of-scope work as `FOLLOW-UP: <short title>` on its own line, one per item.

## Instructions for the idle pass (once it exists)

- Read `AGENTS.md`, `docs/02-status.md`, and the changed code before editing docs.
- Update `docs/02-status.md` when what is built changes, and the README when commands or
  layout change. Do not rewrite the spec to match a bug.
- Gardening sweep: dead code, duplicated helpers, swallowed errors, unbounded growth,
  listener or timer leaks, missing boundary validation, tests that assert implementation
  instead of behavior.
- File each finding as a request with a concrete title and the file or symbol it touches.
  Do not bundle unrelated cleanups into one request.

## Open questions

1. Does full autonomy include pushing branches and opening draft change requests, or
   local commits only?
2. Gardening cadence and daily cap, and which model and effort to spend on it.
3. Do documentation updates ride the request branch, or get their own docs request?
4. Should maintenance live in the existing cells or a dedicated cell with its own ticker
   and a low-cost model default?
