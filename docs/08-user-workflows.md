# User workflows

This is the operator view of the system: how a cell gets a master, how work moves, and
where each setting lives.

## 1. Create a cell and define its master

A cell is a repo/queue boundary. Its master is policy, not a separate process: the
scheduler ticks once and applies each cell’s policy to that cell’s requests.

1. Open the sidebar and press **New cell** (or the pencil on an existing cell).
2. Name the cell.
3. Optionally set **Master interval (minutes)**. Empty inherits the global cadence; a
   value gives this cell its own ticker.
4. The process editor opens with a full copy of the global default from
   `process.json`. Adjust the five segments:
   - **Requests** (intake): start clarification for unplanned work.
   - **Plan**: groom tickets and advance to Implement.
   - **Implement**: continue/build work and advance to Review.
   - **Review**: check the result; optionally create a draft change request.
   - **Finalize**: produce the digest; the human still approves KB indexing.
5. For each segment set the enabled switch, idle threshold, per-cycle cap, prompt, ready
   marker, legal target, and follow-up rule.
6. Press **Create cell**. The policy is stored on the cell as a snapshot.
7. Later, press **Process** on the cell in Config or the pencil in the sidebar to edit it.

Existing cells with no policy inherit the global default. New cells snapshot it so later
global edits do not silently rewrite every cell.

## 2. Choose how far the cron should push

The most common policies:

- **Conservative (default):** only Implement is enabled. Stalled dispatch work is
  prodded and moves to Review on `READY FOR REVIEW`.
- **Hands-off pipeline:** enable Intake, Plan, and Implement. Raw requests get clarified,
  planned requests move to Implement, and implementation moves to Review. Each segment
  waits for its own idle window.
- **Strict repo:** enable Plan, Implement, and Review. Review uses a prompt that creates a
  draft change request and does not push anything automatically before that point. Set
  `review.advanceTo` to Finalize or leave it null to stop for a human.
- **Follow-up farm:** enable follow-ups on Implement or Review. The prompt tells the agent
  to emit `FOLLOW-UP: <title>` lines; the master creates those requests in the same cell’s
  intake and records them in activity.

The full field reference is in `docs/07-process-segments.md`.

## 3. Create and groom a request

1. Press **+ New request**, choose a title/body/target repo. If a cell is selected it is
   attached to that cell.
2. The request starts in **Requests** (intake). If the cell’s intake segment is enabled,
   the master starts clarification; otherwise open the request and press **Start
   clarify**.
3. Clarify, dispatch, review, and finalize share one chat thread. Interject at any time;
   messages sent while a turn runs are queued, and **Stop** cuts the turn short so you can
   redirect it.
4. The drawer’s workflow buttons can move work manually. The master and a human use the
   same transition table.

## 4. Watch the master

Press **Cell master** (above **+ New request**).

- With no cell selected it shows the global template and all activity.
- With a cell selected it shows that cell’s policy and **ticker interval**, filters
  activity to the cell, and says whether the cell is using its own policy or inheriting
  the global default.
- The drawer shows status, last/next run, every segment prompt, recent
  start/prod/advance/followup/skip events, and **that cell’s master chat**. Unassigned
  work uses the global master chat.
- **Run now** executes one cycle for the selected cell (or the global cycle when no cell
  is selected).
- **Configure** jumps to the Config page.

Each cell’s master chat is a separate reserved session, so one cell’s notes and
conversation do not mix with another’s. The chat is advisory: it can read the board and
KB but cannot mutate requests.

## 5. Review, finalize, and follow-ups

1. Implementation ends with `READY FOR REVIEW` and the request moves to Review when the
   Implement segment is configured to advance.
2. In Review, a human or the Review prompt checks the work. For a strict repo, the Review
   prompt can create a draft change request using the operator’s CLI; there is no
   hardcoded forger integration.
3. When satisfied, press **Finalize**. The finalize turn proposes a digest.
4. Review the digest and press **Index and finalize**. This is the only step that writes
   the KB entry and closes the request; the master cannot auto-advance Finalize.
5. Out-of-scope findings can become intake requests automatically (follow-up markers) or
   through the agent’s `spawn_request` tool.

## 6. Where things live

| Thing | Location |
| --- | --- |
| Scheduler switch, interval, unassigned flag | `$XDG_CONFIG_HOME/sandbox-harness/config.json` (`SBOX_CONFIG`) |
| Global process template | `$XDG_CONFIG_HOME/sandbox-harness/process.json` (`SBOX_PROCESS`) |
| Per-cell process snapshot | `cells.process_json` in SQLite |
| Requests, cells, KB, events | SQLite (`SBOX_DB`) |
| Session ids and transcripts | `$SBOX_DATA_DIR/requests/<id>/` |
| Worktrees | `$SBOX_DATA_DIR/worktrees/<id>` |
| Master chat | reserved `__master__` transcript |

All of this is single-operator: there is no auth, and the brain binds loopback. Put a
tunnel or SSO proxy in front for remote access (see `deploy/vps.md`).
