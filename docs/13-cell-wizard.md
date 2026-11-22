# Cell creation wizard and setup chat

The cell creation/edit modal includes a **Setup assistant** chat that can **read and
modify the live draft**. It is how an operator builds the process flow conversationally:
the agent can add/remove process steps, rewrite prompts, set ready markers, choose
advance targets, and set cell/segment limits before the cell exists.

## Workflow

1. Open **New cell** or edit a cell.
2. The wizard creates a server-side draft and seeds a transient setup chat. Describe the
   repository, how strict it is, whether agents may push, how many workers are safe, and
   what “done” means.
3. Ask for changes, for example:
   - “This is a strict work repo. Add a merge bucket after review, cap it at one worker,
     and move successful merges to finalize.”
   - “Rewrite the implementation prompt so it must run the integration tests.”
   - “Use `READY FOR MERGE` as the review marker and add a follow-up rule.”
4. The agent calls `get_cell_draft`, edits the draft, and calls `update_cell_draft`. The
   structured fields in the modal refresh when the turn finishes.
5. Review the result, adjust anything by hand, and press **Create cell**/**Save cell**.
6. The chat closes and the draft is deleted with the wizard.

## Session lifecycle

- Each wizard has a server-side draft id and a reserved `__setup__:<draftId>` chat session
  with no request row.
- Before each turn, the modal syncs its current fields to `PUT /api/cell-drafts/:id`, so
  the agent starts from what you see.
- `get_cell_draft` returns the current draft; `update_cell_draft` can change the name,
  limits, model/effort, or the complete `segments` array.
- The setup session uses the setup tool posture: board/KB reads plus draft read/update.
  It cannot mutate tickets, spawn requests, or write the KB.
- Closing or saving stops any live setup turn, unmounts the chat, and deletes the draft.
- A new wizard gets a new draft id; conversations do not leak between cells.

## Failure states

The wizard never leaves the chat spinner running forever.

- Draft sync gets a five-second deadline. A failed or slow `PUT /api/cell-drafts/:id`
  replaces the spinner with **Could not start the setup chat**, the server message, and
  **Retry** inside the modal. The page-level error banner is not the only signal.
- Once the draft is ready, a later sync failure keeps the conversation mounted and shows
  a draft-sync warning instead of discarding the chat.
- A chat transport error shows **Setup chat error** with **Retry**, which remounts the
  chat and rehydrates its transcript.
- A live driver turn is capped by `SBOX_TURN_TIMEOUT_MS` (default ten minutes). The
  engine emits `error`, appends the error to the transcript, kills the child, emits
  `done`, and writes `engine.timeout` with capped stderr.
- Harness MCP calls to the brain are capped by `SBOX_MCP_TIMEOUT_MS` (default 15
  seconds) and return an MCP error result instead of waiting forever.

## Validation

`update_cell_draft` is validated by the brain before it is accepted:

- every segment id appears exactly once (six built-in ids);
- `advanceTo` must be a legal transition from the segment’s state;
- an advancement requires a ready marker;
- intake and finalize cannot auto-advance;
- prompt/marker/limit types and ranges must be valid.

If the agent sends invalid JSON or an illegal transition, the tool returns the validation
error and the draft stays unchanged.

## What to ask it to reason about

The default six segments are Requests, Plan, Implement, Review, Merge, and Finalize.
Useful prompts ask for:

- which segments to enable and where each advances;
- exact ready markers for the harness;
- review and merge policy (draft CR, who pushes, one merger at a time);
- cell and segment concurrency limits;
- follow-up callouts and whether they should create intake requests;
- model/effort defaults and where a request override is warranted.

The merge bucket use case is documented in `docs/07-process-segments.md` and
`docs/08-user-workflows.md`.

## Implementation

`CellModal` creates a random draft id, syncs its fields to `/api/cell-drafts/:id`,
renders `ClarifyChat` against `setupSessionId(draftId)`, and calls `POST /clarify/stop`
and `DELETE /api/cell-drafts/:id` on close. `ClarifyChat.onDone` refetches the draft and
updates the form after each turn. The MCP server exposes `get_cell_draft` and
`update_cell_draft` in `setup` scope, with the draft id passed as `SBOX_SETUP_DRAFT_ID`.

## API

```text
PUT    /api/cell-drafts/:id          full draft (UI sync)
GET    /api/cell-drafts/:id          read current draft
PATCH  /api/cell-drafts/:id          partial fields or segments (agent tool)
DELETE /api/cell-drafts/:id          discard with the wizard
```
