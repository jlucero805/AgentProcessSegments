# Process segments

The master no longer hardcodes a single “prod dispatch” rule. The pipeline is data:
five ordered segments, each with a purpose, a prompt, an idle threshold, an optional
ready marker, and an optional follow-up rule. The SPA edits it as structured controls;
the file underneath is ordinary JSON.

There are two layers:

1. **Global default** — `process.json`, used for unassigned work and as the template for
   new cells.
2. **Cell policy** — a full copy of the same shape stored on the cell. Once a cell has
   one, its master uses it instead of the global default. Existing cells without a
   policy keep inheriting the global default.

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
      "prompt": "…READY TO FINALIZE",
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
      "prompt": "…READY TO INDEX",
      "readyMarker": "READY TO INDEX",
      "advanceTo": null,
      "followUps": { "enabled": false, "marker": "FOLLOW-UP:" }
    }
  ]
}
```

The array order is the evaluation order inside a cycle. Every segment id must appear
exactly once.

## Segment semantics

| Segment | Request view | Turn action | Advancement |
| --- | --- | --- | --- |
| `intake` | `clarify`, not started | `engine.start` seeds clarification | none (starting moves it to Plan) |
| `plan` | `clarify`, started | prompt via `engine.send` | legal target, e.g. `dispatch` |
| `implement` | `dispatch` | prompt via `engine.send` | legal target, e.g. `review` |
| `review` | `review` | prompt via `engine.send` | legal target, e.g. `finalize` or `dispatch` |
| `finalize` | `finalize` | prompt via `engine.send` | none; the human still approves indexing |

A segment turn is eligible when:

- the segment is `enabled`;
- the request is in the segment’s view/state;
- no turn is live and the request is not `working`;
- `now - updated_at >= idleMinutes`;
- the request was not already started/prodded within `idleMinutes`;
- fewer than `maxPerCycle` requests were handled in this segment/cell this cycle.

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
Lower a segment’s `idleMinutes` to move through that segment sooner; the same request is
not handled twice inside that window.

## Cell creation process

The operator defines the policy before the cell receives work:

1. In the sidebar, press **New cell** or edit an existing cell.
2. Name the cell and optionally set its own **master interval** (empty uses the global
   cadence). This is the cell’s separate ticker.
3. The process editor opens with a complete copy of the global default.
4. Adjust the segments for that cell. Typical changes:
   - enable `intake` and `plan` for a hands-off pipeline;
   - shorten segment idle thresholds;
   - rewrite the implement/review prompts;
   - enable follow-up callouts;
   - choose where a segment advances.
5. Create the cell. The policy is stored as JSON on the cell and used by its master.
6. Press **Cell master** while that cell is selected to see its status, ticker, prompts,
   recent activity, and **its own chat**. Press **Process** on the cell in Config to edit
   it later.

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

- **Config** edits the schedule, the five segment definitions, prompts, markers,
  advancement, and follow-up rules as structured controls.
- **Cell master** (the button above `+ New request`) opens a first-class detail drawer:
  current status, next/last run, the enabled cron loop with the exact prompt used for
  each segment, recent activity, and the master chat. `?master=1` restores it on reload.

## Endpoints

```text
GET   /api/process                 process.json plus its resolved path
PATCH /api/process {segments}      validate, write atomically, return the saved policy
```
