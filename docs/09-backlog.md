# Backlog

Scoped but not built yet. Each item names the data, API, UI, and acceptance criteria so it
can be picked up without re-deciding the shape.

## Usage tracking follow-ups

Token/cost tracking is built: `usage_events`, parser normalization, engine capture,
`GET /api/usage`, the **Usage** page, the request Usage card, daily rollups that survive
raw pruning, advisory monthly overall/per-cell budgets with durable alerts and signed
webhook, SMTP email, and native Slack/Discord bot delivery with per-cell routing, and
opt-in hard caps that pause new work at turn boundaries. Estimated pricing is built too: `model_pricing`, `/api/pricing`, the Config
page editor, and estimates that never overwrite a harness-reported cost. Deferred work:

- **Alert delivery refinements.** Signed webhook, SMTP email, and native Slack/Discord
  bot delivery with per-cell routing plus read-only delivery history with guarded manual
  resend are built. Add fan-out to multiple chat destinations per scope, per-scope routing
  for the webhook and email channels, interactive acknowledgement from chat,
  pause-transition delivery, and reuse of the outbox for non-budget events (failed turns,
  master errors). Keep every destination deduped by the existing delivery row and
  credentials redacted.
- **Hard-cap refinements.** Cancelling in-flight work on a crossing, an operator one-turn
  override/snooze, and a strict unknown-cost policy are deferred; current caps are
  admission-only and fail open when spend is unknowable.
- **Pricing maintenance at scale.** Follow-ups cover bulk JSON/CSV import/export,
  context-length tiers, currencies other than USD, and a per-turn applied-price audit
  view. The current table is exact-model, flat, USD-only, and operator-maintained.
