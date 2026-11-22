# Error log

The brain keeps a **dedicated error-only log**. Normal operation is not persisted; only
explicit error paths append a record. This is meant for debugging, not analytics.

## Location and size

- Default: `$XDG_STATE_HOME/sandbox-harness/errors.log`
  (`~/.local/state/sandbox-harness/errors.log` when `XDG_STATE_HOME` is unset).
- Override: `SBOX_ERROR_LOG=/path/to/errors.log`.
- Size cap: `SBOX_ERROR_LOG_MAX_BYTES` (default **2 MiB**).
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

The logger never includes request bodies, prompts, transcripts, tokens, agent output, or
environment values.

## Instrumented sites

| Source | When |
| --- | --- |
| `app.startup` | The brain fails to start |
| `settings.invalid` / `settings.unreadable` | `config.json` is invalid or unreadable |
| `process.invalid` / `process.unreadable` | `process.json` is invalid or unreadable |
| `http.request` | An unexpected 5xx from the HTTP layer (includes request id/method/URL) |
| `engine.turn` | An agent turn throws or fails |
| `engine.exit` | An agent process exits before completing a turn |
| `master.turn` | A master turn fails for a request (cell, request, segment) |
| `master.cycle` | A scheduler cycle rejects unexpectedly |
| `terminal.create` / `terminal.attach` | A PTY cannot be created, or a socket attaches to a missing session |

Expected client errors (400 validation, 404, 409 transitions) are **not** written to this
file. They are returned to the caller and remain visible in the UI. Normal lifecycle
events stay in `master_events` and transcripts.

## Reading it

```bash
# recent errors, one line each
tail -n 50 ~/.local/state/sandbox-harness/errors.log

# pretty-print the last 20
tail -n 20 ~/.local/state/sandbox-harness/errors.log | jq .

# only engine failures
jq -c 'select(.source | startswith("engine."))' ~/.local/state/sandbox-harness/errors.log
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
