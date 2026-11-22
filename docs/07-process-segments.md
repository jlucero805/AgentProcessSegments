# Process segments

The master no longer hardcodes a single “prod dispatch” rule. The pipeline is data:
six ordered segments, each with a purpose, a prompt, an idle threshold, an optional
ready marker, and an optional follow-up rule. The SPA edits it as structured controls;
the file underneath is ordinary JSON.

`Agent Process Segments` is the product name; a *process segment* is one stage in a
cell's pipeline.

There are two layers:

1. **Global default** — `process.json`, used for unassigned work and as the template for
   new cells.
2. **Cell policy** — a full copy of the same shape stored on the cell. Once a cell has
   one, its master uses it instead of the global default. Existing cells without a
   policy keep inheriting the global default.

The store upgrades old files on read: a five-segment file gets the disabled Merge
segment, and any segment missing `maxConcurrent` inherits the cell cap (`null`). This
keeps pre-Merge prompts and settings instead of falling back to the default policy.

Each cell also has its own **ticker** and **master chat**:

- `masterIntervalMinutes` on the cell overrides the global scheduler interval; null
  inherits it.
- The scheduler keeps one timer per enabled cell plus one for unassigned work.
- Scheduler notes for a cell go to `__master__:<cellId>`; unassigned work uses the global
  `__master__` chat. The Cell master drawer opens the chat for the selected cell.

## File and path

- Default: `$XDG_CONFIG_HOME/sandbox-harness/process.json`
  (`~/.config/sandbox-harness/process.json` when `XDG_CONFIG_HOME` is unset).
- Override: `SBOX_PROCESS=/path/to/process.json`.
- Writes are atomic and mode `0600`.
- Missing or invalid files fall back to a conservative policy derived from
  `config.json`’s `master` section until you save a valid process.
- Once the file exists, it is authoritative. The legacy `master.idleMinutes`,
  `master.autoReview`, and `master.prompt` values are only used to derive the fallback
  when `process.json` is absent.

## Shape

```json
{
  "version": 1,
  "segments": [
    {
      "id": "intake",
      "label": "Requests",
      "purpose": "Capture a raw request before planning starts.",
      "enabled": false,
      "idleMinutes": 10,
      "maxPerCycle": 5,
      "maxConcurrent": null,
      "prompt": "",
      "readyMarker": null,
      "advanceTo": null,
      "followUps": { "enabled": false, "marker": "FOLLOW-UP:" }
    },
    {
      "id": "plan",
      "label": "Plan",
      "purpose": "Groom the request into a buildable plan with acceptance criteria.",
      "enabled": false,
      "idleMinutes": 10,
      "maxPerCycle": 5,
      "maxConcurrent": null,
      "prompt": "Continue grooming this ticket…\nREADY FOR IMPLEMENTATION",
      "readyMarker": "READY FOR IMPLEMENTATION",
      "advanceTo": "dispatch",
      "followUps": { "enabled": false, "marker": "FOLLOW-UP:" }
    },
    {
      "id": "implement",
      "label": "Implement",
      "purpose": "Build the change in a worktree and report when it is ready for review.",
      "enabled": true,
      "idleMinutes": 10,
      "maxPerCycle": 10,
      "maxConcurrent": null,
      "prompt": "…READY FOR REVIEW",
      "readyMarker": "READY FOR REVIEW",
      "advanceTo": "review",
      "followUps": { "enabled": false, "marker": "FOLLOW-UP:" }
    },
    {
      "id": "review",
      "label": "Review",
      "purpose": "Check the implementation and decide whether to finalize or send it back.",
      "enabled": false,
      "idleMinutes": 10,
      "maxPerCycle": 5,
      "maxConcurrent": null,
      "prompt": "…READY TO FINALIZE",
      "readyMarker": "READY TO FINALIZE",
      "advanceTo": "finalize",
      "followUps": { "enabled": false, "marker": "FOLLOW-UP:" }
    },
    {
      "id": "merge",
      "label": "Merge",
      "purpose": "Rebase and push one request at a time, then hand it to Finalize.",
      "enabled": false,
      "idleMinutes": 10,
      "maxPerCycle": 10,
      "maxConcurrent": 1,
      "prompt": "You are the single merge worker…\nREADY TO FINALIZE",
      "readyMarker": "READY TO FINALIZE",
      "advanceTo": "finalize",
      "followUps": { "enabled": false, "marker": "FOLLOW-UP:" }
    },
    {
      "id": "finalize",
      "label": "Finalize",
      "purpose": "Produce the digest that closes the request and feeds the knowledge base.",
      "enabled": false,
      "idleMinutes": 10,
      "maxPerCycle": 5,
      "maxConcurrent": null,
      "prompt": "…READY TO INDEX",
      "readyMarker": "READY TO INDEX",
      "advanceTo": null,
      "followUps": { "enabled": false, "marker": "FOLLOW-UP:" }
    }
  ]
}
```

Every segment id must appear exactly once. The array order is the display and storage
order; inside a cycle the master evaluates enabled segments by pipeline position from
right to left: `finalize`, `merge`, `review`, `implement`, `plan`, then `intake`.
Finishing work gets the first turns, and the earlier segments run when no later work is
due, so a steady backlog of planning cannot starve the right side of the pipeline.

A cycle is bounded by the cell. It selects at most `maxConcurrent` minus the requests
already working in that cell; the budget is filled from the latest segment first and,
inside a segment, from the oldest request start date (`created_at`) first. Once the budget
is full, the remaining requests are left for the next cycle. This keeps the turns and the
master chat’s cycle notes small instead of enumerating every queue on every tick.

## Segment semantics

| Segment | Request view | Turn action | Advancement |
| --- | --- | --- | --- |
| `intake` | `clarify`, not started | `engine.start` seeds clarification and appends the intake prompt | none (starting moves it to Plan) |
| `plan` | `clarify`, started | prompt via `engine.send` | legal target, e.g. `dispatch` |
| `implement` | `dispatch` | prompt via `engine.send` | legal target, e.g. `review` |
| `review` | `review` | prompt via `engine.send` | legal target, e.g. `merge`, `finalize`, or `dispatch` |
| `merge` | `merge` | prompt via `engine.send` | legal target, e.g. `finalize` |
| `finalize` | `finalize` | prompt via `engine.send` | none; the human still approves indexing |

A segment turn is eligible when:

- the segment is `enabled`;
- the request is in the segment’s view/state;
- no turn is live and the request is not `working`;
- `now - updated_at >= idleMinutes`;
- the request was not already started/prodded within `idleMinutes`;
- fewer than `maxPerCycle` requests were handled in this segment/cell this cycle;
- if the segment sets `maxConcurrent`, fewer than that many requests are working in the
  segment’s state for the cell.

After a turn finishes, the master reads the last agent text. If it contains
`readyMarker`, the request moves to `advanceTo` when that transition is legal.
`finalize` cannot auto-advance because closing without the human index action would skip
the knowledge base.

## Enabling the full pipeline

Conservative defaults only enable `implement`, preserving the previous behavior. To let
the master carry work from an unplanned request through implementation:

1. Enable `intake` with a short idle threshold.
2. Enable `plan` and keep its `advanceTo` at `dispatch`.
3. Keep `implement` enabled; review its prompt and marker.
4. Optionally enable `review` and `finalize`.

Each cell’s ticker drives its own cycle; a cell interval overrides the global cadence.
A bucket has at most one dispatch cycle in flight: if a tick lands while the cell or a
global manual run is already active, that tick is skipped and the cell tries again on its
next interval. A global Run now waits for in-flight cell cycles before it dispatches.
Lower a segment’s `idleMinutes` to move through that segment sooner; the same request is
not handled twice inside that window.

## Cell creation process

The operator defines the policy before the cell receives work:

1. In the sidebar, press **New cell** or edit an existing cell.
2. Name the cell and optionally set its own **master interval** (empty uses the global
   cadence). This is the cell’s separate ticker.
3. Set the cell’s **max concurrent requests** (default 3), **default model**, and
   **default difficulty**. A request’s own model/effort overrides the cell default, and
   the cell default overrides `SBOX_DEFAULT_MODEL`. On OpenCode the brain default is
   `opencode-go/deepseek-v4.1-flash`. The master will not start more work in a cell while
   that many requests are already `working`.
4. Use the **Setup assistant** chat to reason about the repo’s risk posture, merge
   policy, and concurrency. It is advisory and closes with the wizard.
5. The process editor opens with a complete copy of the global default.
6. Adjust the segments for that cell. Typical changes:
   - enable `intake` and `plan` for a hands-off pipeline;
   - shorten segment idle thresholds;
   - set an optional segment concurrency (Merge defaults to 1);
   - rewrite the implement/review/merge prompts;
   - enable follow-up callouts;
   - choose where a segment advances.
7. Create the cell. The policy is stored as JSON on the cell and used by its master.
8. Press **Cell master** while that cell is selected to see its status, ticker, prompts,
   recent activity, and **its own chat**. Press **Configure** there (or **Process** on the
   cell in Config) to reopen the editor with that cell's current policy, then tweak and
   save it.

New cells start from `process.json`. An existing cell with no policy (for example one
created before this feature) inherits the global default until edited. Clearing a cell
policy with `process: null` returns it to inheritance.

## Example: strict repo with a draft change request

A stricter repository can stop before the finalize gate and use review as the handoff
point. The cell’s `review` segment could be enabled with a prompt like:

```text
Review the implementation against the acceptance criteria.
If it is acceptable, push the request branch and create a draft change request with
`gh pr create --draft --fill`. Do not mark the request complete.
If it needs changes, finish with READY FOR IMPLEMENTATION.
Finish with READY TO FINALIZE only after the draft change request exists.
```

Then set `review.advanceTo` to `finalize` (or leave it null to stop at review). The
request session has the normal request tools, including Bash, so the prompt can use the
operator’s CLI. Door-specific integrations are deliberately not hardcoded.

For out-of-scope findings, enable `followUps` on `implement` or `review`. The agent is
told to emit:

```text
FOLLOW-UP: Add a migration for the legacy rows
```

The master creates that request in the same cell’s intake and records a `followup` event.
Deduplication is per source request and title, so repeated callouts do not multiply.

## Per-cell API

```text
GET   /api/cells                       list cells, each with its process and interval
GET   /api/cells/:id                   one cell with its process
POST  /api/cells {name, process?, masterIntervalMinutes?}
                                       create; omitted process snapshots the global default
PATCH /api/cells/:id {name?, masterEnabled?, masterIntervalMinutes?, process?}
GET   /api/master/status?cellId=…      that cell's ticker/last-run status
POST  /api/master/run?cellId=…         run that cell's cycle now
```

`PATCH` with `process: null` makes the cell inherit the global default again. An empty
`masterIntervalMinutes` inherits the global scheduler interval.

Per-cell master chats use the reserved `__master__:<cellId>` session; unassigned work
uses `__master__`.

## Merge bucket (single worker)

A built-in optional `merge` segment sits between Review and Finalize. Its default policy
sets `maxConcurrent: 1` and `maxPerCycle: 10`, so the master walks the merge bucket
sequentially: one request rebases/tests/pushes to origin, then the next one starts. This
avoids concurrent merges and rebase conflicts while still draining the bucket in one cycle.

Recommended policy for a strict repo:

1. Enable `merge`; keep `maxConcurrent: 1`.
2. Give it a prompt that rebases onto the target branch, resolves conflicts, runs tests,
   and pushes to origin.
3. Set `readyMarker: READY TO FINALIZE` and `advanceTo: finalize`.
4. Enable `finalize` only for digest generation; the human still indexes into the KB.

The merge prompt default already describes the single-worker rule. The cell-level
concurrency cap still applies; the segment cap is an additional limit.

## Follow-up requests

When `followUps.enabled` is on for `plan`, `implement`, or `review`, the master appends an
instruction to that segment’s prompt:

```text
If you discover work that should happen later, list each item on its own line as
`FOLLOW-UP: <short title>`.
```

After the turn, each matching line creates a new request in the same cell, linked in the
activity log as a `followup` event. Titles are deduplicated per source request, so the
same callout cannot be re-created on a later cycle. The agent’s `spawn_request` MCP tool
is still available for richer follow-ups.

## UI

- **Config** edits the schedule, the six segment definitions, prompts, markers,
  advancement, and follow-up rules as structured controls.
- **Cell master** (the button above `+ New request`) opens a first-class detail drawer:
  current status, next/last run, the enabled cron loop with the exact prompt used for
  each segment, recent activity, and the master chat. `?master=1` restores it on reload.

## Endpoints

```text
GET   /api/process                 process.json plus its resolved path
PATCH /api/process {segments}      validate, write atomically, return the saved policy
```
