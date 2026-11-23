# Backlog

Scoped but not built yet. Each item names the data, API, UI, and acceptance criteria so it
can be picked up without re-deciding the shape.

## Usage tracking follow-ups

Token/cost tracking is built: `usage_events`, parser normalization, engine capture,
`GET /api/usage`, the **Usage** page, the request Usage card, daily rollups that survive
raw pruning, and advisory monthly overall/per-cell budgets with durable alerts. Estimated
pricing is built too: `model_pricing`, `/api/pricing`, the Config page editor, and
estimates that never overwrite a harness-reported cost. Deferred work:

- **Hard budget caps and external delivery.** Advisory budget alerts are built and
  compare reported cost only. Add optional enforcement that pauses new work and optional
  webhook/email delivery; keep both opt-in and conservative when turns are unpriced or
  only estimated. Decide whether caps should include estimates.
- **Pricing maintenance at scale.** Follow-ups cover bulk JSON/CSV import/export,
  context-length tiers, currencies other than USD, and a per-turn applied-price audit
  view. The current table is exact-model, flat, USD-only, and operator-maintained.
