# Backlog

Scoped but not built yet. Each item names the data, API, UI, and acceptance criteria so it
can be picked up without re-deciding the shape.

## Token and cost tracking per cell

**Goal.** A timeline of token and cost spend per cell, with request/model breakdowns and
optional budget alerts. The operator should see whether a cell is cheap or runaway
without reading transcripts.

**Data.** Add `usage_events`: `id`, `cell_id`, `request_id`, `turn_id` (engine turn),
`model`, `effort`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_write_tokens`, `cost_usd`, `created_at`. Store one row per completed agent turn.
An optional `pricing` table keyed by model and effective date keeps estimates auditable;
if the harness reports a cost, keep both reported and estimated values.

**Harness extraction.** The parsers currently ignore usage.
- Claude: the `result` event carries `usage` (input/output/cache tokens) and sometimes
  `total_cost_usd`.
- OpenCode: `step_finish` carries token counts and possibly cost.
Add a normalized `usage` field to the engine's turn result so a parser never writes to
the database. The engine records one usage event after `finishTurn`.

**API.**
```text
GET /api/cells/:id/usage?from=…&to=…&bucket=hour|day
GET /api/usage?cellId=…&from=…&to=…
```
Return totals plus per-model and per-request buckets. Include a zero-cost row when a
harness reports tokens but no price.

**UI.** A Usage tab or card in the Cell master drawer: total spend, tokens, turns, and a
small time-series chart. A cell-level monthly/daily budget is optional; alerts are a
notification or a master-chat note, not a hard stop until the operator asks for one.

**Why deferred.** It needs parser/usage fixtures for both harnesses and a pricing source.
Retention is no longer a blocker: `usage.retentionDays` (default 90, `0` = forever) is
stored in `config.json`, edited on the Config page, and enforced shortly after startup and
hourly in 1000-row batches. It does not change how work moves, so it is safe to add after
per-cell process, ticker, concurrency, and model controls.

**Acceptance.**
- A real Claude/OpenCode turn produces one usage event with the correct request/cell.
- A usage query returns deterministic totals for a seeded timeline.
- The Cell master drawer renders the timeline without loading full transcripts.
- A model with no price is reported as unknown, not silently zero cost.
