# User workflows

This is the operator view of the system: how a cell gets a master, how work moves, and
where each setting lives.

## 1. Create a cell and define its master

A cell is a repo/queue boundary. Its master is policy, not a separate process: the
scheduler ticks once and applies each cell’s policy to that cell’s requests.

1. Open the sidebar and press **New cell** (or the pencil on an existing cell).
2. Name the cell.
3. Optionally set **Agent harness** to Claude Code or OpenCode. **Brain default** inherits
   `APS_HARNESS` (legacy `SBOX_HARNESS` still works). Requests and this cell’s master use
   the chosen adapter; changing it later starts that cell’s next turn on a fresh session.
4. Optionally set **Master interval (minutes)**. Empty inherits the global cadence; a
   value gives this cell its own ticker.
5. Set **Max concurrent requests** (default 3), **default model**, **default
   difficulty**, and **Auto-compact at (%)** (default 80). The master pauses new work
   when that many requests in the cell are already `working`; a request’s own
   model/effort wins. Effort is disabled for OpenCode. Auto-compaction applies to
   request sessions in this cell; Claude cannot raise its built-in threshold, so values
   above its default fall back to that default.
6. The process editor opens with a full copy of the global default from
   `process.json`. Adjust the five segments:
   - **Requests** (intake): start clarification for unplanned work.
   - **Plan**: groom tickets and advance to Implement.
   - **Implement**: continue/build work and advance to Review.
   - **Review**: check the result; optionally create a draft change request.
   - **Merge**: optional single-worker bucket; rebase, test, push, then advance.
   - **Finalize**: manual gate; a human runs the digest turn and approves KB indexing.
     The master never schedules this segment.
7. For each segment set the enabled switch, idle threshold, per-cycle cap, optional
   segment concurrency (Merge defaults to 1), prompt, ready marker, legal target, and
   follow-up rule. Finalize is manual-only: its controls are disabled and its Enable
   setting is ignored.
8. Press **Create cell**. The policy is stored on the cell as a snapshot.
9. Later, press **Process** on the cell in Config or the pencil in the sidebar to edit it.

Existing cells with no policy inherit the global default. New cells snapshot it so later
global edits do not silently rewrite every cell. Existing cells with no harness inherit
the process default.

## 2. Choose how far the cron should push

The most common policies:

- **Conservative (default):** only Implement is enabled. Stalled dispatch work is
  prodded and moves to Review on `READY FOR REVIEW`.
- **Hands-off pipeline:** enable Intake, Plan, and Implement. Raw requests get clarified,
  planned requests move to Implement, and implementation moves to Review. Each segment
  waits for its own idle window.
- **Strict repo:** enable Plan, Implement, Review, and Merge. Review can create a draft
  change request; Merge is capped at one worker, so requests rebase/push sequentially
  instead of colliding. Set `merge.advanceTo` to Finalize when the push succeeds.
- **Follow-up farm:** enable follow-ups on Implement or Review. The prompt tells the agent
  to emit `FOLLOW-UP: <title>` lines; the master creates those requests in the same cell’s
  intake and records them in activity.

Each tick handles at most the cell’s spare concurrency, taking the latest pipeline
segments first and the oldest request in each segment first. The selected batch is prodded
concurrently; per-segment caps still bound how many from one segment can join the batch.
The cycle returns once the turns are started, and their follow-ups/advancement settle in
the background, so the next tick can refill freed capacity. Work beyond that budget waits
for the next tick, so a busy board does not flood the cell-master chat with notes.

The full field reference is in `docs/07-process-segments.md`.

## 3. Create and groom a request

1. Press **+ New request**, choose a title/body/target repo. If a cell is selected it is
   attached to that cell.
2. The drawer’s **Harness** selector defaults to **Inherit** (the cell’s adapter, then
   the brain default). Pick **Claude Code** or **OpenCode** to pin this one request. The
   model list follows the resolved adapter; changing harness resets a stale model, and
   Effort is inert for OpenCode.
3. The request starts in **Requests** (intake). If the cell’s intake segment is enabled,
   the master starts clarification; otherwise open the request and press **Start
   clarify**.
4. Clarify, dispatch, review, and finalize share one chat thread. Interject at any time;
   messages sent while a turn runs are queued, and **Stop** cuts the turn short so you can
   redirect it.
5. Type `/` at the start of a message to open the slash menu. Skills show a `skill` badge
   and are sent as instructions such as “Use the poteto-mode skill now…”. Plugin commands
   are sent as ordinary slash commands. See `docs/11-skills.md`.
6. The drawer’s workflow buttons can move work manually. The master and a human use the
   same transition table.

## 4. Watch the master

Select a cell, then press **Cell master** (above **+ New request**). There is no master
for **All cells**: requests without a cell stay manual until you assign one.

- The drawer shows that cell’s policy and **ticker interval**, filters activity to the
  cell, and says whether the cell is using its own policy or inheriting the global
  default.
- The drawer shows status, last/next run, every segment prompt, recent
  start/prod/advance/followup/skip events, and **that cell’s master chat**. Recent
  activity is capped at 20rem and scrolls inside its card, so a busy master does not
  push the chat out of reach.
- **Run now** executes one cycle for the selected cell. A tick that lands while that
  cell’s cycle is already active is skipped and retried on the next interval.
- **Configure** jumps to the Config page or that cell’s policy editor.

Each cell’s master chat is a separate reserved session, so one cell’s notes and
conversation do not mix with another’s. The chat is advisory: it can read the board and
KB but cannot mutate requests.

## 4a. Read the scorecard

With a cell selected in the **Cell master** drawer, the **Scorecard** card shows the most
recent report for that cell: a short markdown summary, throughput, pipeline health,
automation activity, risks, and a comparison with the prior window. It also shows when
the report was generated and the window it covers. Expand **Earlier scorecards** for the
last five.

- **Run scorecard now** generates one immediately. It is allowed even when automatic
  scorecards are disabled.
- The sidebar's **Scorecards** page browses the same persisted reports. A period control
  defaults to **72h** and can be widened to **24h**, **7d**, **30d**, or **All**. The
  period filters by when a report was generated, not by the window the report covers;
  each report still shows its own configured trailing window. With **All cells** selected
  it lists every cell with a report in the period, newest cell first, and with a cell
  selected it shows only that cell's history. Each cell's latest in-range report is
  expanded and the older ones are collapsed under **Earlier scorecards**. When a cell has
  more than 25 in-range reports, **Load older** pages back through the selected period.
- Old reports expire under the Config page's **Scorecard retention** window
  (`retention.cellSummariesDays`, default 90 days, `0` keeps history). **All** is bounded
  by that window. The newest report per cell is always kept, so **Earlier scorecards** and
  the next scheduled run stay intact even when a cell has no report in the selected
  period.
- The schedule lives on the Config page: enable/disable, **Every (minutes)** (default
  360), **Window (minutes)** (default 360), and the report instructions. Save it with
  **Save schedule**.
- The scheduler checks every 30 seconds, writes one report per due cell, and catches up a
  missing or overdue report after a restart. Generations run one at a time.
- A failed report leaves no row and shows a warning in the card. Retries back off for
  `min(interval, 30 min)`.
- The report is based on request timestamps and master activity events, so terminal
  timing is approximate. It is read-only and never moves work.

## 4b. Use the desktop terminal

- On desktop, press **Terminal** in the sidebar. It attaches to a server-owned shell in
  the brain’s configured cwd (`APS_TERMINAL_CWD`), completely separate from every agent
  session.
- The session strip lists every shell with a status dot and a close button. **Hide** only
  detaches, so reopening or reloading reattaches to the same shell and scrollback.
  **Close** on a session tab kills that shell.
- Maximize/restore from the panel header. **Reconnect** reattaches the active session.
- `APS_TERMINAL=0` disables creation. The action is hidden below `md`, but the endpoint
  is still a direct shell—protect the brain with loopback or an authenticated tunnel.

## 4c. Set and watch spend budgets

1. Open **Config** and use **Spend budgets** to set an overall monthly budget and warning
   percentage. Leave the amount blank to remove the overall budget.
2. Tick **Pause new work when the overall budget is exceeded** to make the overall budget a
   hard cap. Edit a cell for an optional monthly budget and its own pause checkbox.
3. Budgets use the UTC calendar month. A warning appears at the configured percentage and
   an exceeded alert appears when reported spend reaches the budget. Alerts alone never
   stop work.
4. With pause enabled, new work stops and in-flight work is stopped when reported plus
   estimated cap spend reaches the budget. An overall pause stops every agent turn; a cell
   pause stops only that cell's request, master, and summary turns. A stopped turn saves its
   partial transcript with a `⏸` line and keeps its harness session, so sending again after
   the pause clears continues the conversation; nothing is replayed automatically. Raise or
   clear the budget, turn the checkbox off, or wait for the next UTC month to resume.
5. For a true ceiling, also tick **Also pause when a turn's cost is unknown (strict)**. The
   scope then pauses while any current-month turn has no reported or estimated cost, even
   if the known spend is below the budget. Add a matching effective-dated price, clear the
   budget, turn strict mode off, or wait for the next month to resume. Raising the budget
   does not clear an unknown-cost pause, and a turn with no reported model cannot be
   priced after the fact. A ledger read failure still fails open.
6. Active alerts appear above every page and can be dismissed with **×**; dismissing does
   not override a hard cap. A separate red pause notice stays until the pause clears and
   explains whether the cap was reached or the cost is unknown; when it applies, it says
   in-flight turns were stopped. If you need to keep working, choose 15 minutes through
   rest of month and press **Snooze**; an overall snooze admits every new turn, while a
   cell snooze admits only that cell. The notice stays visible with the override expiry and
   an **End override** action; ending it immediately re-pauses the scope and stops its live
   turns, while letting it expire re-pauses new work and is enforced by the next budget
   check. A snooze changes no budget and clears no alert. The Usage page shows paused
   scopes, cap spend, the reason, and the same snooze controls. Config's Spend budgets
   card, the app banner, and Usage all read the same polled snapshot, so a snooze or
   revoke in one updates the others immediately. If you enabled the
   **Spend cap overrides** event route, a grant or extension while the cap still blocks
   work and an expiry that leaves it blocked again are delivered to the configured
   webhook/email channels; revoking a snooze does not notify, and an expiry may take up
   to a minute to be observed. To audit recent snoozes,
   use **Config → Spend cap override history**: each row shows the scope, state
   (`active`, `revoked`, or `expired`), budget month, grant time, later-expiry extensions,
   final expiry, revocation time, and note. Filter by scope or state and page through the
   retained 400 days. The card is read-only and does not change a budget, alert, or pause.
   An `active` row means its window is still open; the Spend budgets status above shows
   whether the scope is currently paused or covered.
7. Alert spend is harness-reported only. Cap spend also includes estimates; unpriced turns
   are counted and shown as unknown or a lower bound, never as zero.
8. To deliver alerts outside the app, use **Config → Alert delivery**: enable the webhook,
   paste an HTTPS URL (loopback may use http), pick JSON, Slack, or Discord, and optionally
   set a 16-256 character signing secret. Save, then press **Send test** to verify. Verify
   `X-APS-Signature-V2` before acting; the legacy body-only `X-APS-Signature` remains for
   compatibility (see [Verify webhook signatures](#verify-webhook-signatures)). Slack and
   Discord ignore both headers. The card also shows pending/failed counts and the latest
   delivery.
9. For email, use the separate **Email delivery** card: enable it, set the SMTP host and
   port (465 for implicit TLS, 587 for STARTTLS), optional username and password, a From
   address, and up to ten recipients. Save, then **Send test email**. A blank password
   keeps the saved one; **Clear password** removes it, and the username must be cleared at
   the same time. Remote hosts require STARTTLS when implicit TLS is off.
10. For native chat, create a Slack app with the `chat:write` scope (or a Discord
   application with View Channel and Send Messages), install it, and copy the bot token.
   Invite the bot to each target channel. In **Config → Slack alerts** or **Discord
   alerts**, paste the token, add each channel ID and an optional label, choose a default
   destination, and add per-cell routes. Save, then **Send test** on a destination. A
   blank token keeps the saved one; **Clear token** disables the provider and removes it.
   Use channel IDs, not `#channel` names.
11. The overall budget goes to the default destination. A cell uses its route when one is
    set and otherwise the default; a cell with neither is not delivered to that provider.
    Each alert is sent once per destination. Acknowledging it, clearing a budget, changing
    a route/default, or rotating a token/channel cancels that destination's pending
    notification without touching other channels. Transient failures retry for about
    three hours; permanent ones are marked failed in the Config card. Delivery problems
    never stop work or hide the in-app banner.
12. The **Delivery history** card below the channel settings lists recent budget and
    operational-event attempts for webhook, email, Slack, and Discord. Filter by type
    (budget, failed turns, master errors, scorecard failures, spend cap overrides),
    channel, or status; use
    **Refresh** or the Newer/Older buttons to page. Budget subjects show the alert
    scope/threshold/spend; event subjects show the safe title and reveal the human summary
    on hover. A failed or
    skipped budget row that still belongs to an unacknowledged current-month alert shows
    **Resend** when its destination still matches; an event row shows it only while its
    kind/channel route, channel, and destination remain enabled and configured. Pressing
    Resend re-queues the same outbox row under the current destination and format, resets
    its attempt count, and shows a queued message; the next notifier flush sends it.
    Delivered rows never show Resend. Budget history is pruned under the Config **Budget
    alert retention** window (default 400 days; `0` keeps it forever), the current UTC
    month is always kept, and clearing a budget, changing its threshold, or deleting a
    cell removes its unacknowledged rows. Event rows follow the Config **Notification
    event retention** window (default 400 days; `0` keeps them forever), and pending or
    in-flight rows are never pruned. Full failure text remains in the request transcript
    and error log, not in the history payload.
13. The **Event notifications** card can send failed request turns, master turn/cycle
    errors, scorecard failures, and spend-cap override grants/extensions/expiries. Check
    Webhook and/or Email per event kind, choose a coalescing window (default 60 minutes;
    1–1440), and optionally add **cell routes** that limit a kind/channel to specific
    cells; with no route that pair covers every cell. Then **Save event notifications**;
    each selected channel must also be enabled above. Notifications contain the request
    title/state or cell, ids, and a classification only, never prompts, transcripts, or
    raw error text. A cap-stopped scorecard is a pause and does not notify; the full error
    remains in the scorecard warning and `summary.generate` log. Repeat failures with the
    same signature are coalesced inside the window per channel; override events dedupe by
    override, change, and expiry, and an overall override is never filtered by a cell
    route. Revoking a snooze is not notified; a grant/extension while the cap still
    blocks and an expiry that leaves it blocked again are. Narrowing a route skips
    pending rows for excluded cells, and enabling a route or widening the window does not
    replay old events. The card shows aggregate and per-kind pending/failed counts.

### Verify webhook signatures

APS signs the exact bytes it sends. When a signing secret is saved, every webhook request
carries two signature headers:

- `X-APS-Signature-V2: t=<ms>,v2=<64 hex>` is the recommended signature. The `t` value is
  milliseconds since epoch and is the same value as `X-APS-Timestamp`. The `v2` value is
  HMAC-SHA256 over the exact ASCII timestamp digits, a literal `.`, and the exact raw body
  bytes. Because the timestamp is inside the HMAC, changing it invalidates the signature.
- `X-APS-Signature: sha256=<64 hex>` is the legacy body-only signature. It remains for
  compatibility and does not prove freshness.

A request without a saved secret has neither signature header. Slack and Discord servers
ignore both headers; the signature covers the raw body for every format (`json`, `slack`,
`discord`).

Verify V2 before parsing or trusting the body, and reject a timestamp outside your
freshness window. Five minutes is a good default: reject stale and far-future values and
keep the receiver clock synchronized. Every APS retry is re-signed with the attempt's
current timestamp, so a retry after 5 minutes, 30 minutes, or 2 hours is fresh and must
not be rejected as stale.

A complete zero-dependency receiver lives in the repo at
`scripts/webhook-receiver-example.mjs`. It requires V2, uses a 5-minute window by default,
and accepts `--tolerance-ms` to change it. Run it on loopback:

```bash
APS_WEBHOOK_SECRET='the exact 16-256 character secret' \
  node scripts/webhook-receiver-example.mjs --port 8787
```

Point the webhook at `http://127.0.0.1:8787` (loopback may use HTTP). For a remote
receiver, terminate HTTPS in front and keep the example on loopback. It prints the
bound URL and, after a verified request, the event kind and a safe id; replace its
`onVerified` handler with your durable work. Pointed at an older APS that sends only the
legacy header, the example returns 401; upgrade the sender first or use
`verifyWebhookSignature` and accept body-only security.

The core V2 check is:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_MS = 5 * 60 * 1000;

function verifyV2(rawBody, header, secret, now = Date.now()) {
  if (typeof header !== 'string') return false;
  const match = /^t=([0-9]{1,15}),v2=([0-9a-fA-F]{64})$/.exec(header);
  if (match === null) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > TOLERANCE_MS) {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(`${match[1]}.`)
    .update(rawBody)
    .digest();
  const provided = Buffer.from(match[2], 'hex');
  return provided.length === expected.length && timingSafeEqual(expected, provided);
}
```

`rawBody` must be the exact bytes received, not `JSON.stringify(req.body)`. Key order,
whitespace, escapes, and a BOM all change the bytes. Read the body as a Buffer before
any JSON parser runs:

- `node:http`: collect the request chunks as Buffers (the example does this).
- Express: mount `express.raw({ type: 'application/json' })` on this route before
  `express.json()`; `req.body` is then the Buffer.
- Next.js route handlers: `Buffer.from(await request.text(), 'utf8')`.
- Fastify: use a raw-body content-type parser and verify the Buffer before parsing.

If a framework has already consumed the body, the route is misconfigured; re-parsing
and re-serializing will fail verification.

Every request carries these headers:

- `content-type`: `application/json`, including Slack and Discord text bodies.
- `x-aps-signature-v2`: `t=<ms>,v2=<64 hex>` when a secret is saved. The embedded `t` is
  authoritative and must be within the freshness window.
- `x-aps-signature`: the legacy `sha256=<64 hex>` body-only signature when a secret is
  saved. It does not prove freshness.
- `x-aps-timestamp`: milliseconds since epoch. It matches V2's `t` but is informational;
  verify the `t` inside `X-APS-Signature-V2`, not this header alone.
- `idempotency-key`: the alert id for budget alerts, or the event dedupe key for
  event notifications. It is informational and **not** signed.
- `user-agent`: `aps-budget-alert/1` or `aps-notify/1`. It is informational only.

A signed timestamp bounds replay: a captured request is rejected once its `t` is outside
the tolerance. A replay inside the window cannot be distinguished cryptographically
without a nonce or receiver state. Return 2xx only after durable acceptance, dedupe on
authenticated body data such as `alert.id`, `turn.turnId`, `master.*`, or a hash of the raw
body, and treat an already-processed event as a successful no-op. `Idempotency-Key` is a
hint, not authentication, and legitimate retries carry the same event identity with a
fresh timestamp.

One webhook can receive both budget alerts and event notifications. Branch on the
body's `event` field:

- `budget.alert` and `budget.test`: `alert.id`. **Send test** uses `budget.test` and
  is signed the same way.
- `turn.failed`: `turn.turnId`.
- `master.error`: `master.cellId`, `master.source`, and `master.occurredAt`.
- `summary.failed`: `summary.cellId`, `summary.source`, and `summary.occurredAt`.
- `spend.override`: `override.overrideId`, `override.change`, and `override.expiresAt`.

See [Webhook payloads](14-webhook-payloads.md) for every field, type, discriminator, and dedupe id.

Respond with 2xx only after the event is durably accepted. APS retries 408, 429, and
5xx at 60 s, 5 min, 30 min, and 2 h (five attempts total), honors `Retry-After`, and
times out after 10 s. Other 4xx responses are permanent, and redirects are not
followed. A 401 from a wrong secret is permanent: fix the secret in Config, then use
**Delivery history → Resend** for the failed current-month row.

## 4d. Read spend and maintain model prices

- Open **Usage** from the sidebar. Pick 24h, 7d, 30d, or all time and optionally one
  cell. The summary separates reported cost, estimated cost, and turns that remain
  unpriced; the chart stacks reported and estimated spend.
- A turn uses the harness-reported cost whenever there is one. Only unreported turns can
  use a price. An exact model with no effective price stays unknown, and a mixed total is
  shown as a lower bound (`≥`) rather than a precise number.
- Add or remove prices in **Config → Model pricing**. Each row is USD per 1,000,000
  tokens for input, output, cache read, cache write, and reasoning, with a source and a
  UTC effective date. A price change is a new row with a later effective date; delete
  only an entry created by mistake.
- The page states the raw retention window and, once retention has run, which date is
  covered by daily totals versus raw turns and when the job last ran with how many raw
  rows it pruned. Older history is aggregate-only, so very old breakdowns have UTC-day
  resolution.
- Entering a backdated row recalculates estimates for raw turns immediately because
  estimates are query-time. It never changes the reported cost stored on a turn or
  revalues a day that has already been rolled up and pruned.

## 5. Review, finalize, and follow-ups

1. Implementation ends with `READY FOR REVIEW` and the request moves to Review when the
   Implement segment is configured to advance.
2. In Review, a human or the Review prompt checks the work. For a strict repo, the Review
   prompt can create a draft change request using the operator’s CLI; there is no
   hardcoded forger integration.
3. When satisfied, press **Send to merge** if the cell has a Merge segment. The master
   allows only one merge worker at a time (`maxConcurrent: 1`), draining the bucket one
   rebase/test/push at a time. Each success advances to Finalize.
4. Press **Finalize** to propose a digest. Review/Merge can advance the request into
   Finalize, but the master never runs the finalize turn itself.
5. Review the digest and press **Index and finalize**. This is the normal per-request
   path that writes the KB entry and closes the request; the master never prods Finalize
   and cannot auto-advance it.
6. To close several at once, press **Index all** beside the Finalize column title. It is
   scoped to the cards under the current cell filter and asks for a second click within
   four seconds. Each ready request is indexed and closed. Requests that are still working
   or expect a KB digest but have none stay in Finalize and appear in the status line.
   Requests with KB indexing disabled close without a KB entry.
7. Out-of-scope findings can become intake requests automatically (follow-up markers) or
   through the agent’s `spawn_request` tool. Both carry over the source request’s cell,
   harness override, and target repo; a `spawn_request` that names a different cell uses
   that cell’s defaults instead of inheriting the old harness and repo.

## 7. Run the end-to-end suite

`npm run e2e` builds the brain, boots it on a throwaway database/data dir, and drives the
workflow through a deterministic mock Claude CLI. Everything happens inside a dedicated
`E2E` cell: clarify, dispatch, master prod/review, follow-up creation in the same cell,
per-cell master chat, finalize, and the concurrency cap. It **never indexes into the KB**
and asserts the knowledge base stays empty. No live data is touched.

## 8. Where things live

| Thing | Location |
| --- | --- |
| Scheduler switch and interval | `$XDG_CONFIG_HOME/agent-process-segments/config.json` (`APS_CONFIG`) |
| Global process template | `$XDG_CONFIG_HOME/agent-process-segments/process.json` (`APS_PROCESS`) |
| Per-cell process snapshot | `cells.process_json` in SQLite |
| Per-cell harness | `cells.harness` in SQLite (NULL = `APS_HARNESS`) |
| Overall spend budget | `budget` in `config.json` (`monthlyUsd`, `alertAtPercent` (1–100, default 80), `pauseOnExceeded`, `pauseOnUnknownCost`) |
| Cell spend budget | `cells.monthly_budget_usd`, `cells.pause_on_exceeded`, `cells.pause_on_unknown_cost` in SQLite |
| Budget alert history | `budget_alerts` in SQLite (acknowledged rows expire under `retention.budgetAlertsDays`) |
| Webhook delivery settings | `notifications.webhook` in `config.json` (secret redacted by API) |
| Email delivery settings | `notifications.email` in `config.json` (password redacted by API) |
| Alert delivery outbox | `budget_alert_deliveries` in SQLite, one row per alert and destination, with a self-contained alert snapshot; terminal rows expire under `retention.budgetAlertsDays` |
| Event delivery outbox | `notification_event_deliveries` in SQLite, one row per signature and channel, with the safe classification payload; terminal rows expire under `retention.notificationEventsDays` |
| Requests, cells, KB, events | SQLite (`APS_DB`) |
| Session ids and transcripts | `$APS_DATA_DIR/requests/<id>/` (terminal dirs expire under `retention.requestArtifactsDays`) |
| Brain heartbeat (opt-in) | `$APS_DATA_DIR/brain.lock` when `APS_BRAIN_LOCK=1`; refreshed every 10 s so `migrate-paths` can detect a live brain without its HTTP port |
| Worktrees | `$APS_DATA_DIR/worktrees/<id>` (terminal leftovers expire under the same window; branches stay) |
| Master chat | reserved `__master__` transcript |

All of this is single-operator: there is no auth, and the brain binds loopback. Put a
tunnel or SSO proxy in front for remote access (see `deploy/vps.md`).

A single invalid block in `config.json` does not reset the rest: that block (or, under
`notifications`, that channel) falls back to its defaults and is reported in the error
log with the block name, while other blocks — including webhook URLs and secrets — load
unchanged. An unreadable or non-JSON file falls back to all defaults. The Config page
shows a banner naming every block the load reset, and keeps it until a save; saving any
card persists the recovered values and drops the banner. Before the next save replaces
such a file, the raw bytes are copied to a sibling `config.json.invalid-<UTC>`
(owner-only); the save is refused if that copy cannot be written. After that save the
Config page shows the copy's path, so an operator can review and delete the original
without reading the server log. The same preserve-before-overwrite rule applies to an
invalid `process.json`; the process editor does not yet show the copy path, so read the
server warning or error log to find it.
