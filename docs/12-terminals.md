# Terminal sessions

The desktop terminal is server-owned. A browser WebSocket **attaches** to a terminal
session; hiding the panel or losing the connection only detaches. The PTY keeps running
and its scrollback is replayed on the next attach.

## Lifecycle

- **New terminal:** `POST /api/terminals` creates one PTY in `APS_TERMINAL_CWD`.
- **Hide panel (`×`):** unmounts the panel and closes its WebSocket. The shell keeps
  running; it stays visible in `GET /api/terminals`.
- **Reopen Terminal:** the SPA lists existing sessions and attaches to the most recent
  one, replaying up to the last 200 KB of output.
- **Close tab (`×` in the session strip):** `DELETE /api/terminals/:id` kills the PTY and
  removes it from the list. This is the only UI action that ends a shell.
- **Natural `exit`:** the session remains in the list as `alive: false` until explicitly
  closed, so a dead shell is visible rather than silently orphaned.
- **Brain restart:** PTYs do not survive a process restart; the list starts empty.
- **Limit:** up to four sessions total. If all four are open, creating another returns an
  error instead of leaking an invisible shell.

## UI

The terminal panel has:

- a session strip with `#1 cwd`, `#2 cwd`, status dot, and a per-session close button
- `+` for a new session
- **Reconnect** for the active session
- **Maximize/Restore**
- **Hide** (does not kill the shell)

The sidebar **Terminal** button shows a `(n)` count whenever sessions exist, even when
the panel is hidden, so detached shells are never invisible.

Hiding is intentionally not the same as closing a tab. The session remains on the VPS and
is visible when you reopen the panel or reload the SPA.

## API and socket

```text
GET    /api/terminal          status: available + cwd
GET    /api/terminals         visible sessions (id, shell, cwd, pid, attached, alive)
POST   /api/terminals         {cols?, rows?} -> create
DELETE /api/terminals/:id     close/kill a session
GET    /ws/terminal?sessionId=…&cols=…&rows=…
```

Socket frames:

- server → client: `{t:'ready', session}`, `{t:'buffer', data}`, `{t:'data', data}`,
  `{t:'exit', code}`, `{t:'closed'}`, `{t:'error', message}`
- client → server: `{type:'input', data}` and `{type:'resize', cols, rows}`

A closing WebSocket only detaches; it never calls `kill`.

## Safety

- `APS_TERMINAL=0` disables creation and the UI action.
- `APS_TERMINAL_CWD` sets the starting directory.
- The route is a direct shell with no auth of its own; keep the brain loopback-only or
  behind an authenticated tunnel.
- The terminal is independent of every harness/agent session and transcript.
