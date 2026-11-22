# Plan: mobile shell, cell masters, durable chat

Working plan for the next feature set. Each task ships with tests and its own commit.
Statuses are updated in place.

## Goals

1. Make the SPA usable on a phone: the left menu closes behind a hamburger, the board
   scrolls, and the drawer uses the full screen.
2. Give every cell a master that periodically reviews its implementation queue, prods
   stalled agents to record decisions and continue, and moves genuinely finished work to
   Review.
3. Make chat durable: a reload reopens the same request and reattaches to a live stream.
4. Put master behavior in a user-editable config file (XDG) with a page for it.

Non-goals for this pass: multi-user auth, a separate master LLM process, per-cell custom
prompt libraries, and semantic KB retrieval.

## Task list

- [x] **1. Mobile shell** — hamburger + overlay sidebar; horizontally scrolling board
  columns on small screens; full-width drawer; responsive top bar.
- [x] **2. Durable chat and routing** — page/request in the URL; restore on reload;
  reattach to a live turn with a running state; keep streaming text.
- [x] **3. Config store** — `$XDG_CONFIG_HOME/sandbox-harness/config.json` (override
  `SBOX_CONFIG`), zod-validated defaults, `GET/PATCH /api/config`, and a Config page.
- [x] **4. Cell masters** — scheduler with configurable interval (default 5 min),
  idle threshold, prod prompt, auto-review marker, per-cell enable toggles, event log,
  manual "run now", and a Master page section.
- [x] **5. Tests and docs** — unit/HTTP/web coverage, browser smoke on mobile viewport,
  status/decision/plan updates.

## 1. Mobile shell

- `App` keeps one sidebar component. On `md+` it is static. Below `md` it is off-canvas
  (`-translate-x-full`) with a backdrop, and the top bar carries a hamburger.
- Nav and cell selection close the menu on mobile. Escape closes it.
- Board columns become a horizontal snap scroller on mobile (`min-w-[85vw]` per column)
  and keep the five-column grid on desktop.
- The request drawer is full-width below `md` and maximizable as before.

Acceptance: hamburger toggles `aria-expanded`; choosing a nav item closes it; a 390 px
viewport can reach every column and the drawer without horizontal page overflow.

## 2. Durable chat and routing

- Keep `page` and `request` in the URL query (`?page=board&request=<id>`), written with
  `history.replaceState` and read on boot. A reload restores the board or KB page and the
  open drawer.
- On mount, the chat fetches `GET /clarify` for the transcript, then attaches to
  `GET /clarify/stream`. While attached it shows `running`, appends text deltas live, and
  on `{active:false}` falls back to the snapshot.
- A finished turn is already persisted on disk; a live turn is decoupled from the HTTP
  request and replays its buffer to the reattached client.

Acceptance: reload during a live turn re-renders history and continues streaming; reload
after a turn restores the same transcript; sending while a turn is live is blocked in the
UI.

## 3. Config store

Path: `SBOX_CONFIG` or `$XDG_CONFIG_HOME/sandbox-harness/config.json`
(`~/.config/sandbox-harness/config.json` fallback). The file is created lazily with:

```json
{
  "master": {
    "enabled": true,
    "intervalMinutes": 5,
    "idleMinutes": 10,
    "autoReview": true,
    "prompt": "…prod instructions…"
  }
}
```

- Zod validates every field; unknown keys are stripped. Invalid files fall back to
  defaults with a warning instead of crashing the brain.
- `GET /api/config` returns the effective config and the file path; `PATCH /api/config`
  merges, validates, writes atomically, and tells the scheduler to reschedule.
- The Config page edits master defaults, shows the path, and lists per-cell switches.

## 4. Cell masters

The master is deterministic server-side, not another LLM session. It has the board view
through the repositories and prods request sessions with a configured prompt.

Every interval (default 5 minutes), for each enabled cell:

1. Select requests in `dispatch` that belong to the cell, are `idle` (no live turn), and
   have not been touched for `idleMinutes` (default 10).
2. Send a prod through the engine:
   - record any decision already made in the request `context` via `update_request`;
   - continue the implementation instead of waiting;
   - if the work is complete, end the reply with the exact marker `READY FOR REVIEW`.
3. Persist a master event (cell, request, action, detail). Keep the last prod time per
   request in the event table so a request is not prodded more than once per interval.
4. If `autoReview` is on and the prod turn's final agent text contains
   `READY FOR REVIEW`, transition `dispatch → review`.

Cells get `master_enabled` (default 1). Masters exist only for cells: requests without a
cell stay manual until assigned. A per-cell cadence override is future work; the cadence
is global for now.

Endpoints: `GET /api/master/status` (last run, next run, counts),
`POST /api/master/run?cellId=…` (one cell cycle now),
`GET /api/master/events?cellId=…&limit=…`.
The Master page shows the switch, cadence, event log, and per-cell switches; the Cell
master drawer owns the per-cell manual run and chat.

Safety: master turns are ordinary request turns, one at a time per request; terminal
states dispose the session as before; disabling the master stops scheduling immediately.

## 5. Verification

- Config: defaults, invalid file fallback, patch validation, atomic write, scheduler
  reload.
- Master: fake clock/cycle over a fake engine; idle selection, prod text, event rows,
  READY marker transition, disabled cell skip, manual run.
- HTTP: config + master routes over a real socket.
- Web: hamburger/aria, nav close, URL restore, running reattach, config page save, master
  controls.
- Browser: 390 px viewport smoke through the create → drawer → board flow.

## Follow-up: message queue and stop

- [x] **6. Stop a live turn** — `Engine.cancel`, `POST /clarify/stop`, kill the child,
  finish with the partial transcript, keep the session id so the next message resumes.
- [x] **7. Queue and interject** — composing while a turn runs queues the message locally
  (persisted per request), drains in order when the turn ends; Stop clears the queue and
  cuts the stream so the human can interject.
- [x] **8. Tests and docs** — engine/HTTP stop tests, queue/drain/stop component tests,
  browser smoke.
- [x] **9. One thread across segments** — the drawer keeps the same chat for clarify,
  dispatch, review, and finalize; terminal states are read-only transcripts.
- [x] **10. Master chat** — a reserved `__master__` session with read-only board/KB
  tools; the scheduler writes prod/review/cycle notes into it, and the Config page
  embeds the chat.
- [x] **11. Tests and docs** — scoped MCP tests, engine/HTTP master chat tests, web
  thread and master chat tests.

## Follow-up: refactor and bug audit

- [x] **12. Shared contract** — web type-imports pure server modules; master/plugin
  shapes moved to pure type files; web no longer mirrors the transition table.
- [x] **13. Deduplicate boundaries** — sentinel session routing, MCP board tools, plugin
  markdown/fs helpers, repository writes, and master cycle helpers each have one home.
- [x] **14. Bug fixes** — dispose-while-live, detached board kicks, illegal drag guards,
  cell-id validation, slash commands, KB backslash search, drawer form clobber, mobile
  cell controls, KB mobile layout, and aborted chat streams.
- [x] **15. Docs** — `docs/06-refactor-audit.md` plus decision/status updates.

## Follow-up: configurable process segments

- [x] **16. Process config** — separate `$XDG_CONFIG_HOME/sandbox-harness/process.json`
  (`SBOX_PROCESS`), zod-validated, atomic writes, conservative fallback derived from
  the legacy master policy.
- [x] **17. Generic master loop** — walk enabled segments in order, start/prod due work,
  apply follow-up callouts, and advance on exact markers through legal transitions.
- [x] **18. Process UI** — structured segment editor and a first-class Cell master
  detail with status, prompts, activity, and chat (`?master=1`).
- [x] **19. Tests and docs** — process/store/defaults/follow-up tests, master pipeline
  tests, HTTP process routes, ConfigPage and MasterDetail tests, `docs/07`.

## Follow-up: per-cell process ownership

- [x] **20. Cell policies** — each cell can store its own process snapshot; the master
  uses it instead of the global template. Existing cells keep inheriting the global.
- [x] **21. Cell creation flow** — New/Edit cell opens a process editor seeded from the
  global default; Config links to the same editor; the Cell master drawer is cell-scoped.
- [x] **22. Tests and docs** — cell process persistence, per-cell master selection, cell
  modal, HTTP cell process routes, and `docs/07` workflow examples.
- [x] **23. Per-cell master runtime** — cell interval tickers, per-cell master chat
  sessions and notes, cell-scoped status/run endpoints, and per-cell chat in the drawer.
- [x] **24. Tests and docs** — scheduler ticker, per-cell chat/status, cell interval, and
  workflow/decision updates.
- [x] **25. Desktop terminal** — sidebar action, xterm.js panel, node-pty WebSocket,
  maximize/restore/reconnect, env kill switch, and PTY/HTTP/UI tests.
- [x] **26. Per-cell limits/defaults** — max concurrent working requests (default 3),
  persistent default model/effort, engine fallback, master capacity guard, UI fields.
- [x] **27. E2E workflow** — isolated real brain, deterministic mock Claude, dedicated
  `E2E` cell, clarify/dispatch/master/follow-up/chat/concurrency/finalize, no KB index.
- [x] **28. Error logging** — error-only NDJSON sink, XDG state path, size rotation,
  startup/config/HTTP/engine/master/terminal instrumentation, tests and docs.
- [x] **29. Chat skills** — skill discovery (global/project/request repo), merged slash
  menu, skill badge, prompt-text invocation, API and tests.
- [x] **30. Persistent terminals** — server-owned sessions, detach on hide, scrollback
  replay, visible session strip, explicit close, list API, lifecycle tests.
- [x] **31. Merge and segment limits** — optional Merge state/column, per-segment
  `maxConcurrent`, single-merge walkthrough, old-process upgrade, tests and docs.
- [x] **32. Cell wizard chat** — transient `__setup__` chat with a server-backed draft,
  `get_cell_draft`/`update_cell_draft` tools, live form refresh, close cleanup.
- [x] **33. In-app Help** — manifest-backed docs API, sidebar Help overlay, grouped nav,
  markdown with anchors, copy-as-Markdown, `?help` deep links, screenshot assets,
  traversal guards, and tests.
- [x] **34. Setup-chat hang hardening** — inline wizard draft-sync error + Retry,
  per-turn watchdog, MCP fetch timeout, capped stderr in exit/timeout errors, tests and
  docs.
- [x] **35. Setup-chat responsiveness** — direct reply prompt, plain-text questions,
  OpenCode `question` deny in every non-interactive scope, tests and docs.
- [x] **36. Setup-chat transport** — JSON content type on NDJSON POST bodies, inline
  retry that replays the failed send, regression test and docs.
- [x] **37. Cleanup round** — normalize legacy process files in place, descriptive API
  validation errors, stale-count/doc updates, and regression tests.
- [x] **38. Setup flow contract** — intake prompt in the first turn, draft-only setup
  tools, legal-transition guide in the prompt/tool errors, regression tests and docs.
- [x] **39. Incremental setup** — direct harness MCP tool cards, elapsed/last-tool
  progress, per-update form refresh, deepseek-v4.1-flash brain default, tests and docs.
- [x] **40. Parallel, non-blocking master batches** — select up to spare cell
  concurrency, respect segment caps across the batch, start turns with `Promise.all`,
  return after prodding, settle follow-ups/advancement in the background, tests and docs.
- [x] **41. Usage tracking** — one `usage_events` row per completed turn from both
  harnesses, `GET /api/usage` totals/series/groups, overall **Usage** page, request Usage
  card, unknown-cost handling, tests and docs.
- [x] **42. Auditable model pricing** — effective-dated `model_pricing` rows with five
  per-million rates and a source, `/api/pricing` list/create/delete, Config page editor,
  query-time estimates for harness-unreported turns, reported/estimated/unpriced totals,
  tests and docs.
