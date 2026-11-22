# Backlog

Scoped but not built yet. Each item names the data, API, UI, and acceptance criteria so it
can be picked up without re-deciding the shape.

## Usage tracking follow-ups

Token/cost tracking is built: `usage_events`, parser normalization, engine capture,
`GET /api/usage`, the **Usage** page, and the request Usage card. Estimated pricing is
built too: `model_pricing`, `/api/pricing`, the Config page editor, and query-time
estimates that never overwrite a harness-reported cost. Deferred work:

- **Retention and pruning.** `usage_events` grows one row per completed turn. Add a
  validated retention setting, a bounded boot/daily purge, and a documented decision
  about historical totals (prune-only or rollups).
- **Budget alerts.** Add per-cell/global daily or monthly USD caps, advisory alerts from
  the usage aggregates, one deduplicated alert per period, and conservative wording when
  `unpricedTurns > 0`. Enforcement is a separate decision. Decide whether caps compare
  reported cost only or reported plus estimated cost.
- **Pricing maintenance at scale.** Follow-ups cover bulk JSON/CSV import/export,
  context-length tiers, currencies other than USD, and a per-turn applied-price audit
  view. The current table is exact-model, flat, USD-only, and operator-maintained.
