# Backlog

Scoped but not built yet. Each item names the data, API, UI, and acceptance criteria so it
can be picked up without re-deciding the shape.

## Usage tracking follow-ups

Token/cost tracking is built: `usage_events`, parser normalization, engine capture,
`GET /api/usage`, the **Usage** page, and the request Usage card. Deferred work:

- **Retention and pruning.** `usage_events` grows one row per completed turn. Add a
  validated retention setting, a bounded boot/daily purge, and a documented decision
  about historical totals (prune-only or rollups).
- **Budget alerts.** Add per-cell/global daily or monthly USD caps, advisory alerts from
  the usage aggregates, one deduplicated alert per period, and conservative wording when
  `unknownCostTurns > 0`. Enforcement is a separate decision.
- **Estimated pricing.** Add an auditable `pricing` table keyed by model and effective
  date. Never overwrite harness-reported cost; a model with no effective price stays
  unknown.
