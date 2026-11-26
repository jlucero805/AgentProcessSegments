# Webhook payloads

This page is the receiver-side field reference for the **Alert delivery** webhook. It covers the
JSON bodies APS sends for budget alerts and event notifications. Signing, response, retry, and
replay guidance lives in [Verify webhook signatures](08-user-workflows.md#verify-webhook-signatures)
in the User workflows guide.

## What you receive

- The webhook channel has one URL, one format, and one signing secret shared by budget alerts and
  event notifications. One endpoint can receive both.
- Only the `json` format carries structured fields. `slack` sends `{ "text": ... }` and `discord`
  sends `{ "content": ... }`; both are text-only, so a receiver that needs `event`, ids, or amounts
  must use `json`.
- `content-type` is always `application/json`. When a signing secret is configured, every request
  carries `X-APS-Signature: sha256=<64 hex>` over the exact raw body. `X-APS-Timestamp`
  (milliseconds) and `Idempotency-Key` are informational and not signed. `User-Agent` is
  `aps-budget-alert/1` for budget alerts and `aps-notify/1` for event notifications, but the body is
  authoritative.
- Respond 2xx only after durably accepting the event. APS retries 408, 429, and 5xx with the
  schedule documented in
  [Verify webhook signatures](08-user-workflows.md#verify-webhook-signatures), and a 4xx other than
  those is permanent.

## Event discriminators

Every JSON body has `version: 1` and an `event` discriminator. Branch on `event`, not on the
`User-Agent` header. Each value carries one nested object with its details:

- `budget.alert`: a durable budget alert; details in `alert`.
- `budget.test`: the **Send test** button; same shape as `budget.alert` with a `test-<uuid>` id.
- `turn.failed`: a failed request turn; details in `turn`.
- `master.error`: a failed master turn or scheduler cycle; details in `master`.
- `summary.failed`: a failed scorecard generation; details in `summary`.
- `spend.override`: a spend-cap override grant, extension, or expiry that still leaves work
  blocked; details in `override`.

Slack and Discord bodies contain only the human `text` of the same event:

```json
{ "text": "Acme reached 80% of its $250.00 monthly budget (at least $203.50)." }
```

```json
{ "content": "Acme reached 80% of its $250.00 monthly budget (at least $203.50)." }
```

## Budget alert body

The budget body is the v1 event described by `BudgetAlertEvent` in
`src/server/src/domain/budget.ts`. The `budget.test` event has the same shape; only the `event`
value and the `test-<uuid>` id differ.

### budget.alert and budget.test

```json
{
  "version": 1,
  "event": "budget.alert",
  "alert": {
    "id": "alert-7f3c2a",
    "scope": "cell",
    "cellId": "cell-1",
    "cellName": "Acme",
    "threshold": "warning",
    "alertAtPercent": 80,
    "budgetUsd": 250,
    "spendUsd": 203.5,
    "spendIsLowerBound": true,
    "unknownCostTurns": 2,
    "periodStart": 1793491200000,
    "periodEnd": 1796083200000,
    "createdAt": 1794744000000
  },
  "text": "Acme reached 80% of its $250.00 monthly budget (at least $203.50)."
}
```

- `version`: always `1`.
- `event`: `budget.alert` for a durable alert, or `budget.test` for **Send test**.
- `alert.id`: the durable alert id. Use it as the idempotency key for this alert; `budget.test`
  uses `test-<uuid>` instead.
- `alert.scope`: `overall` or `cell`.
- `alert.cellId`: the cell id, or `null` for an overall budget.
- `alert.cellName`: the cell name captured with the alert, or `null` when unavailable.
- `alert.threshold`: `warning` at the configured percentage, or `exceeded` when spend reached the
  monthly budget.
- `alert.alertAtPercent`: the configured warning percentage (a number, not a fraction).
- `alert.budgetUsd`: the monthly budget in USD.
- `alert.spendUsd`: the reported spend in USD. When `alert.spendIsLowerBound` is `true`, this is
  only a floor.
- `alert.spendIsLowerBound`: `true` when at least one current-month turn has no reported or
  estimated cost, so `spendUsd` is a lower bound.
- `alert.unknownCostTurns`: the number of turns counted in `spendIsLowerBound`.
- `alert.periodStart` and `alert.periodEnd`: the UTC month boundaries in milliseconds since the
  Unix epoch, as the half-open interval `[periodStart, periodEnd)`.
- `alert.createdAt`: when the alert was created, in milliseconds since the epoch.
- `text`: the human sentence for the alert. Slack and Discord send this same text.

## Event notification bodies

The four event kinds share these top-level fields, plus the nested object named in the
discriminator list:

- `version`: always `1`.
- `event`: one of `turn.failed`, `master.error`, `summary.failed`, or `spend.override`.
- `severity`: `error` for the three failure kinds and `warning` for `spend.override`.
- `title`: a short display title used by email and delivery history. Embedded names and titles may
  be clipped; do not use it as an id.
- `occurredAt`: when the event occurred, in milliseconds since the epoch.
- `text`: the human sentence. Slack and Discord send this same text.

Payloads contain ids, titles, states, amounts, and short classifications only. They never contain
prompts, transcripts, diffs, model output, or raw stderr.

### turn.failed

```json
{
  "version": 1,
  "event": "turn.failed",
  "severity": "error",
  "title": "Turn failed: Fix the parser",
  "occurredAt": 1794744000000,
  "text": "Turn failed for \"Fix the parser\" in dispatch, Acme: process exited with code 1.",
  "turn": {
    "turnId": "turn-1",
    "requestId": "req-1",
    "requestTitle": "Fix the parser",
    "state": "dispatch",
    "cellId": "cell-1",
    "harness": "claude",
    "model": "claude-sonnet-4-5",
    "source": "engine.exit",
    "reason": "process exited with code 1",
    "occurredAt": 1794744000000
  }
}
```

- `turn.turnId`: the failed turn id. Use it for dedupe.
- `turn.requestId`: the request id the turn belongs to.
- `turn.requestTitle`: the request title at failure time.
- `turn.state`: the request state at failure time: `clarify`, `dispatch`, `review`, `merge`,
  `finalize`, `done`, or `dropped`.
- `turn.cellId`: the cell id, or `null` when the request is unassigned.
- `turn.harness`: `claude` or `opencode`.
- `turn.model`: the model label, or `null` when it is unknown.
- `turn.source`: `engine.result`, `engine.exit`, `engine.timeout`, or `engine.turn`.
- `turn.reason`: a short safe classification such as `process exited with code 1`. It is never raw
  stderr or model output.
- `turn.occurredAt`: when the failure occurred, in milliseconds since the epoch.

### master.error

```json
{
  "version": 1,
  "event": "master.error",
  "severity": "error",
  "title": "Master error: Acme",
  "occurredAt": 1794744000000,
  "text": "Master cycle failed for cell \"Acme\".",
  "master": {
    "source": "master.cycle",
    "cellId": "cell-1",
    "requestId": null,
    "segment": null,
    "occurredAt": 1794744000000
  }
}
```

- `master.source`: `master.turn` for a failed master turn, or `master.cycle` for a failed scheduler
  cycle.
- `master.cellId`: the cell id.
- `master.requestId`: the request the master was acting on, or `null` when not applicable.
- `master.segment`: the process segment, or `null` when not applicable.
- `master.occurredAt`: when the failure occurred, in milliseconds since the epoch.

### summary.failed

```json
{
  "version": 1,
  "event": "summary.failed",
  "severity": "error",
  "title": "Scorecard failed: Acme",
  "occurredAt": 1794744000000,
  "text": "Scorecard generation failed for cell \"Acme\": process exited with code 1.",
  "summary": {
    "cellId": "cell-1",
    "source": "summary.exit",
    "reason": "process exited with code 1",
    "occurredAt": 1794744000000
  }
}
```

- `summary.cellId`: the cell whose scorecard failed.
- `summary.source`: `summary.result`, `summary.exit`, `summary.timeout`, `summary.turn`,
  `summary.empty`, or `summary.store`.
- `summary.reason`: a short safe classification; never raw stderr or model output.
- `summary.occurredAt`: when the failure occurred, in milliseconds since the epoch.

### spend.override

```json
{
  "version": 1,
  "event": "spend.override",
  "severity": "warning",
  "title": "Spend cap override granted: Overall",
  "occurredAt": 1794744000000,
  "text": "Spend cap override granted for overall spend until 2026-11-15T12:15:00.000Z. The hard cap is still blocking new work (cap reached): $120.00 of a $100.00 monthly budget. Note: release review.",
  "override": {
    "overrideId": "override-1",
    "change": "granted",
    "scope": "overall",
    "cellId": null,
    "reason": "cap_reached",
    "periodStart": 1793491200000,
    "expiresAt": 1794744900000,
    "note": "release review",
    "budgetUsd": 100,
    "spendUsd": 120,
    "spendIsLowerBound": false,
    "capSpendUsd": 125,
    "capSpendIsLowerBound": false,
    "occurredAt": 1794744000000
  }
}
```

- `override.overrideId`: the override id. Dedupe with `change` and `expiresAt`.
- `override.change`: `granted`, `extended`, or `expired`. A revoke is not notified; an expiry is
  notified only when the hard cap still blocks work.
- `override.scope`: `overall` or `cell`.
- `override.cellId`: the cell id, or `null` for an overall override.
- `override.reason`: `cap_reached` or `unknown_cost`, the reason work is still blocked.
- `override.periodStart`: the UTC month start in milliseconds since the epoch.
- `override.expiresAt`: when the override expires, in milliseconds since the epoch.
- `override.note`: the optional operator note, or `null`.
- `override.budgetUsd`: the monthly budget in USD.
- `override.spendUsd`: the reported spend in USD; a lower bound when
  `override.spendIsLowerBound` is `true`.
- `override.spendIsLowerBound`: whether unpriced turns make `spendUsd` a floor.
- `override.capSpendUsd`: the cap spend in USD, which includes estimates.
- `override.capSpendIsLowerBound`: whether unpriced turns make `capSpendUsd` a floor.
- `override.occurredAt`: when the transition was observed, in milliseconds since the epoch.

## Ids and dedupe

`X-APS-Timestamp` is not signed and `Idempotency-Key` is not signed, so neither can authenticate a
body. After verifying the signature, dedupe on the authenticated body data:

- `budget.alert` and `budget.test`: `alert.id`. The `Idempotency-Key` header is the same alert id.
- `turn.failed`: `turn.turnId`, together with `turn.requestId`. The `Idempotency-Key` has the shape
  `turn:<requestId>:<source>:<reason-slug>:<coalesceMinutes>:<windowStartMs>`.
- `master.error`: there is no dedicated event id. Use `master.cellId`, `master.source`, and
  `master.occurredAt`, or the `Idempotency-Key` (`master:<cellId>:<source>:<segment-slug>:
  <coalesceMinutes>:<windowStartMs>`).
- `summary.failed`: there is no dedicated event id. Use `summary.cellId`, `summary.source`, and
  `summary.occurredAt`, or the `Idempotency-Key` (`summary:<cellId>:<source>:<reason-slug>:
  <coalesceMinutes>:<windowStartMs>`).
- `spend.override`: `override.overrideId` with `override.change` and `override.expiresAt`. The
  `Idempotency-Key` is `override:<overrideId>:<change>:<expiresAt>`.

Treat the `Idempotency-Key` string as opaque. It is stable across retries for the same occurrence,
but its shape is informational and not a compatibility contract.

Failure notifications coalesce per kind and channel inside the configured coalescing window
(default 60 minutes). The delivered envelope is the first occurrence in that window, including its
ids and `occurredAt`; later matching failures are not delivered as separate events. Override events
dedupe by override id, change, and expiry, so a grant and a later extension are separate
deliveries. Because the window is part of the failure key, changing the coalescing window starts a
new key.
