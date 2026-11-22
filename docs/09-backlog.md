# Backlog

Scoped but not built yet. Each item names the data, API, UI, and acceptance criteria so it
can be picked up without re-deciding the shape.

## Usage tracking follow-ups

Token/cost tracking is built: `usage_events`, parser normalization, engine capture,
`GET /api/usage`, the **Usage** page, the request Usage card, and advisory monthly
overall/per-cell budgets with durable alerts. Deferred work:

- **Long-range usage rollups.** Raw `usage_events` are pruned by
  `usage.retentionDays` (default 90 days, `0` = forever), so "all time" totals cover the
  retained window. Add daily rollups if operators need history beyond it.
- **Hard budget caps and external delivery.** Advisory budget alerts are built. Add
  optional enforcement that pauses new work and optional webhook/email delivery; keep
  both opt-in and conservative when `unknownCostTurns > 0`.
- **Estimated pricing.** Add an auditable `pricing` table keyed by model and effective
  date. Never overwrite harness-reported cost; a model with no effective price stays
  unknown.
