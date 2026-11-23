# User workflows

This is the operator view of the system: how a cell gets a master, how work moves, and
where each setting lives.

## 1. Create a cell and define its master

A cell is a repo/queue boundary. Its master is policy, not a separate process: the
scheduler ticks once and applies each cell’s policy to that cell’s requests.

1. Open the sidebar and press **New cell** (or the pencil on an existing cell).
2. Name the cell.
3. Optionally set **Agent harness** to Claude Code or OpenCode. **Brain default** inherits
   the value from the Config page, which falls back to `APS_HARNESS` (legacy
   `SBOX_HARNESS` still works). Requests and this cell’s master use the chosen adapter;
   changing it later starts that cell’s next turn on a fresh session.
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
   - **Finalize**: produce the digest; the human still approves KB indexing.
7. For each segment set the enabled switch, idle threshold, per-cycle cap, optional
   segment concurrency (Merge defaults to 1), prompt, ready marker, legal target, and
   follow-up rule.
8. Press **Create cell**. The policy is stored on the cell as a snapshot.
9. Later, press **Process** on the cell in Config or the pencil in the sidebar to edit it.

Existing cells with no policy inherit the global default. New cells snapshot it so later
global edits do not silently rewrite every cell. Existing cells with no harness inherit
the brain default.

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
2. Edit a cell to set its optional monthly budget. Blank means no cell budget.
3. Budgets use the UTC calendar month. A warning appears at the configured percentage and
   an exceeded alert appears when known spend reaches the budget. Both are advisory and
   never stop work.
4. Active alerts appear above every page. Press the alert's **×** to acknowledge it;
   that alert stays silent for the rest of the month (a new month or a changed
   budget/threshold can alert again).
5. Costs are harness-reported only. Unpriced turns are counted and shown as unknown or a
   lower bound, never as zero. The Usage page shows the same monthly budget progress
   beside the token and cost breakdowns.
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
- Entering a backdated row recalculates historical estimates immediately because
  estimates are query-time. It never changes the reported cost stored on a turn.

## 4e. Choose the brain default harness

The **Agent harness** card on the Config page sets the adapter for setup, KB, and
unassigned sessions, and for any cell or request without its own choice.

- **Environment default (Claude Code / OpenCode)** follows `APS_HARNESS` (legacy
  `SBOX_HARNESS` still works).
- Choosing Claude Code or OpenCode saves an explicit `harness` in `config.json`. It wins
  over the environment and takes effect on the next turn, with no restart. Pick the
  environment option again to follow the environment value.
- A cell or request can still override it; the order is request, cell, brain default.
- `APS_DEFAULT_MODEL` stays with the boot default from `APS_HARNESS`, so switching the
  saved default never hands a Claude model id to OpenCode.

## 5. Review, finalize, and follow-ups

1. Implementation ends with `READY FOR REVIEW` and the request moves to Review when the
   Implement segment is configured to advance.
2. In Review, a human or the Review prompt checks the work. For a strict repo, the Review
   prompt can create a draft change request using the operator’s CLI; there is no
   hardcoded forger integration.
3. When satisfied, press **Send to merge** if the cell has a Merge segment. The master
   allows only one merge worker at a time (`maxConcurrent: 1`), draining the bucket one
   rebase/test/push at a time. Each success advances to Finalize.
4. Press **Finalize** (or let the Merge marker advance it). The finalize turn proposes a digest.
5. Review the digest and press **Index and finalize**. This is the only step that writes
   the KB entry and closes the request; the master cannot auto-advance Finalize.
5. Out-of-scope findings can become intake requests automatically (follow-up markers) or
   through the agent’s `spawn_request` tool.

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
| Per-cell harness | `cells.harness` in SQLite (NULL = brain default) |
| Brain default harness | `harness` in `config.json` (NULL = `APS_HARNESS`) |
| Overall spend budget | `budget` in `config.json` |
| Cell spend budget | `cells.monthly_budget_usd` in SQLite |
| Budget alert history | `budget_alerts` in SQLite |
| Requests, cells, KB, events | SQLite (`APS_DB`) |
| Session ids and transcripts | `$APS_DATA_DIR/requests/<id>/` |
| Worktrees | `$APS_DATA_DIR/worktrees/<id>` |
| Master chat | reserved `__master__` transcript |

All of this is single-operator: there is no auth, and the brain binds loopback. Put a
tunnel or SSO proxy in front for remote access (see `deploy/vps.md`).
