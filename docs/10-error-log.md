# Error log

The brain keeps a **dedicated error-only log**. Normal operation is not persisted; only
explicit error paths append a record. This is meant for debugging, not analytics.

## Location and size

- Default: `$XDG_STATE_HOME/agent-process-segments/errors.log`
  (`~/.local/state/agent-process-segments/errors.log` when `XDG_STATE_HOME` is unset).
- Override: `APS_ERROR_LOG=/path/to/errors.log`.
- Size cap: `APS_ERROR_LOG_MAX_BYTES` (default **2 MiB**).
- When the file reaches the cap, it is renamed to `errors.log.1`; the next error starts a
  fresh primary file. Only one rotated backup is kept.
- Files are created with mode `0600` in a directory created on demand.

## Format

One JSON object per line (NDJSON):

```json
{"at":"2026-11-21T20:10:31.000Z","pid":1234,"source":"http.request","name":"Error","message":"boom","stack":"Error: boom\n    at ...","context":{"requestId":"req-42","method":"GET","url":"/api/foo"}}
```

Fields:

| Field | Meaning |
| --- | --- |
| `at` | ISO timestamp |
| `pid` | Brain process id |
| `source` | Stable error site, e.g. `http.request`, `engine.turn`, `master.cycle` |
| `name`, `message`, `stack` | Standard `Error` fields when available |
| `context` | Small identifiers such as session, cell, request, method, URL |

The logger never includes request bodies, prompts, transcripts, tokens, or environment
values. `engine.exit` and `engine.timeout` may include the last capped lines of child
stderr; that is diagnostic output, not a prompt or transcript.

## Instrumented sites

| Source | When |
| --- | --- |
| `app.startup` | The brain fails to start |
| `settings.invalid` / `settings.unreadable` | `config.json` is invalid or unreadable |
| `process.invalid` / `process.unreadable` | `process.json` is invalid or unreadable |
| `http.request` | An unexpected 5xx from the HTTP layer (includes request id/method/URL) |
| `engine.turn` | An agent turn throws or fails |
| `engine.result` | The harness reports an error result or parser error event; includes `session`, `harness`, and `request` when present. The message is the capped result text, never the transcript. |
| `engine.exit` | An agent process exits before completing a turn (includes recent stderr) |
| `engine.timeout` | A turn exceeds `APS_TURN_TIMEOUT_MS`; the child is killed and the turn is closed |
| `master.turn` | A master turn fails for a request (cell, request, segment) |
| `master.cycle` | A scheduler cycle rejects unexpectedly |
| `summary.generate` | A scorecard turn fails, times out without text, or returns no text (cell id only) |
| `usage.budgets` | A budget status/alerts evaluation fails; includes `periodStart` and scope/cell ids only |
| `budget.notify` | A webhook or email enqueue/send/delivery update fails; includes the channel, alert/delivery ids, attempt, and a short HTTP/network/SMTP code only—never the URL, secret, SMTP password, recipients, headers, or body |
| `usage.rollup` | A rollup chunk fails before pruning; includes the day-aligned cutoff and committed watermark only |
| `usage.prune` | Raw usage deletion fails after the rollup watermark commits; includes the cutoff and deleted count only |
| `retention.prune` | Master activity pruning fails; includes the table name, cutoff, and deleted count only |
| `retention.artifacts` | A request-directory or worktree sweep fails; includes the request-dir count, worktree count, failure count, and cutoff only |
| `cells.cleanup` | A deleted cell’s reserved master or summary session directory cannot be removed; includes the cell id and session id only |
| `terminal.create` / `terminal.attach` | A PTY cannot be created, or a socket attaches to a missing session |

Expected client errors (400 validation, 404, 409 transitions) are **not** written to this
file. They are returned to the caller and remain visible in the UI. Normal lifecycle
events stay in `master_events` and transcripts.

## Reading it

```bash
# recent errors, one line each
tail -n 50 ~/.local/state/agent-process-segments/errors.log

# pretty-print the last 20
tail -n 20 ~/.local/state/agent-process-segments/errors.log | jq .

# only engine failures
jq -c 'select(.source | startswith("engine."))' ~/.local/state/agent-process-segments/errors.log
```

## Adding a new error site

Use the injected `ErrorSink`/`ErrorLogger`, never `console.error` for something an
operator should be able to debug later:

```ts
this.errors?.error('my.source', error, { requestId: id });
```

Rules:

- Call it only on a genuine failure path, not on normal completion.
- Keep `context` to small identifiers; never put prompts, bodies, or secrets in it.
- Logging is best-effort: a broken path or full disk must never fail the request. The
  logger swallows its own write errors.
- Rotate rather than append without bound; the default cap is intentionally small.
