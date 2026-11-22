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
4. The agent calls `get_cell_draft` when needed, then calls `update_cell_draft` with
   targeted `segmentUpdates` (or a full `segments` array for a wholesale rewrite). The
   structured fields in the modal refresh when the turn finishes.
5. Review the result, adjust anything by hand, and press **Create cell**/**Save cell**.
6. The chat closes and the draft is deleted with the wizard.

## Session lifecycle

- Each wizard has a server-side draft id and a reserved `__setup__:<draftId>` chat session
  with no request row.
- Before each turn, the modal syncs its current fields to `PUT /api/cell-drafts/:id`, so
  the agent starts from what you see.
- `get_cell_draft` returns the current draft; `update_cell_draft` can change the name,
  limits, model/effort, a few segments via `segmentUpdates`, or the complete `segments`
  array. `segmentUpdates` is a list of `{ id, ...fields }`; the server merges each into
  the current segment (including partial `followUps`) and validates the full process. Use
  it for simple edits instead of rebuilding all six segments.
- The setup session gets only `Read` plus `get_cell_draft`/`update_cell_draft`. It cannot
  inspect the board/KB, mutate tickets, spawn requests, or write the KB.
- The prompt and tool description include the safe flow contract: intake and Finalize
  keep `advanceTo` null, Plan→Dispatch, Implement→Review, Review→Merge/Finalize/Dispatch,
  Merge→Finalize, and every advancement needs an exact ready marker. A rejected update
  returns the same contract so the model does not guess.
- Closing or saving stops any live setup turn, unmounts the chat, and deletes the draft.
- A new wizard gets a new draft id; conversations do not leak between cells.

## Failure states

The wizard never leaves the chat spinner running forever.

- Draft sync gets a five-second deadline. A failed or slow `PUT /api/cell-drafts/:id`
  replaces the spinner with **Could not start the setup chat**, the server message, and
  **Retry** inside the modal. The page-level error banner is not the only signal.
- Once the draft is ready, a later sync failure keeps the conversation mounted and shows
  a draft-sync warning instead of discarding the chat.
- A chat transport error shows an inline **Retry**. A failed send is replayed with the
  same text, without appending a duplicate user bubble; if events had already arrived,
  Retry rehydrates instead so the server does not process the message twice.
- A live driver turn is capped by `APS_TURN_TIMEOUT_MS` (default ten minutes). The
  engine emits `error`, appends the error to the transcript, kills the child, emits
  `done`, and writes `engine.timeout` with capped stderr.
- Setup turns use the normal default-model chain, so they start from
  `APS_DEFAULT_MODEL` (OpenCode defaults to `opencode-go/deepseek-v4.1-flash`) unless the
  wizard's model field or the CLI overrides it.
- Harness MCP tools are exposed directly (`codemode: false`), so the chat shows each
  `get_cell_draft`/`update_cell_draft` call as a tool card instead of one opaque
  `execute`. The setup prompt asks for one segment per update; the wizard refreshes its
  structured fields after every successful draft update, and the running bar shows
  elapsed time plus the last tool.
- The seed prompt answers simple greetings directly and asks at most one or two
  plain-text configuration questions. It explicitly says not to use an interactive
  question tool or inspect the draft unless the answer needs it.
- The Requests (`intake`) prompt is now included in the first clarification turn, so
  repo identity and standing autonomy instructions placed there actually reach the agent.
- There is no idle/keep-busy scheduler hook. Prompts cannot make the master update docs
  or do gardening when the board is empty; the setup assistant should say so rather than
  inventing a transition. Follow-up callouts can create new requests only when a
  segment enables `followUps`.
- Chat send/start bodies are sent as `application/json` through the NDJSON client. The
  earlier missing header made Fastify treat the JSON body as `text/plain`, so every
  send failed validation and Retry tried the same rejected request again.
- OpenCode inherits `question: 'deny'` for every brain session. `opencode run` is
  non-interactive, so allowing that tool makes the model wait for an answer that cannot
  arrive; the setup chat then looks dead while the turn is still running.
- Harness MCP calls to the brain are capped by `APS_MCP_TIMEOUT_MS` (default 15
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
`update_cell_draft` in `setup` scope, with the draft id passed as `APS_SETUP_DRAFT_ID`.

## API

```text
PUT    /api/cell-drafts/:id          full draft (UI sync)
GET    /api/cell-drafts/:id          read current draft
PATCH  /api/cell-drafts/:id          partial fields, segmentUpdates, or segments
DELETE /api/cell-drafts/:id          discard with the wizard
```
