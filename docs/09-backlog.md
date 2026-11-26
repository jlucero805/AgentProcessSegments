# Backlog

Scoped but not built yet. Each item names the data, API, UI, and acceptance criteria so it
can be picked up without re-deciding the shape.

## Usage tracking follow-ups

Token/cost tracking is built: `usage_events`, parser normalization, engine capture,
`GET /api/usage`, the **Usage** page, the request Usage card, daily rollups that survive
raw pruning, advisory monthly overall/per-cell budgets with durable alerts and signed
webhook, SMTP email, and native Slack/Discord bot delivery with per-cell routing,
configurable budget-alert and delivery-history retention, opt-in hard caps that pause new
work and stop in-flight turns in the paused scope, and strict unknown-cost caps that pause
while any turn is unpriced. Estimated pricing is built too: `model_pricing`, `/api/pricing`, the Config
page editor, and estimates that never overwrite a harness-reported cost. Deferred work:

- **Alert delivery refinements.** Signed webhook, SMTP email, and native Slack/Discord
  bot delivery with per-cell routing, read-only delivery history with guarded manual
  resend, and opt-in failed-turn/master-error events are built. Add fan-out to multiple
  chat destinations per scope, per-scope routing for the webhook and email channels,
  interactive acknowledgement from chat, pause-transition delivery, summary-failure
  events, bot event routes, and configurable event coalescing windows. Keep every
  destination deduped by its delivery row and credentials redacted.
- **Hard-cap refinements.** Admission plus in-flight cancellation is built (D65), strict
  unknown-cost enforcement is built (D67), and bounded per-scope snoozes are built (D68).
  Override history/audit and grant-or-expiry notifications, automatic replay of a
  cap-stopped prompt, a broad partial-usage rule for user stop/timeout, and a fail-closed
  policy for an unreadable usage ledger are deferred; caps still fail open when the ledger
  is unreadable.
- **Pricing maintenance at scale.** Follow-ups cover bulk JSON/CSV import/export,
  context-length tiers, currencies other than USD, and a per-turn applied-price audit
  view. The current table is exact-model, flat, USD-only, and operator-maintained.
