# Running the brain on a VPS

The brain is one Node process. It serves the SPA, the API, and the websocket on a single
loopback port (`127.0.0.1:7391` by default). The tunnel in front of that port is the
audience gate; do not widen the bind.

This runbook assumes a single-user VPS with:

- Node 20 or newer on `PATH` (verified on Node 24).
- `git`.
- Build tools (`make`, `g++`, `python3`) when `better-sqlite3` v11 has no prebuild for the
  Node version; on Node 24 it compiles from source.
- an agent CLI on the service `PATH`: `claude` (default) or `opencode`.
- `herdr-core` installed if you use interactive terminals. The brain drives the agent CLI
  directly and does not import herdr.

Every `APS_*` variable also accepts the legacy `SBOX_*` name, and `APS_*` wins when both
are set. Default paths prefer an existing `agent-process-segments` location, then an
existing legacy `sandbox-harness` one. The upgrade section below moves a live install.

## Agent harness

`APS_HARNESS` selects the substrate: `claude` (default) or `opencode`.
`APS_HARNESS_BIN` overrides the binary; `APS_CLAUDE_BIN` still works for the Claude
case.

With `opencode`, the brain probes `opencode models`, writes a per-request
`OPENCODE_CONFIG_DIR` containing the harness MCP server plus the user's MCP servers, and
runs `opencode run --format json --auto --standalone` once per turn, resuming with
`--session`. User MCP servers are read from the user's OpenCode config. The knowledge
base session is forced read-only.

```bash
# either select it in the unit …
#   Environment=APS_HARNESS=opencode
# … or in a drop-in:
mkdir -p ~/.config/systemd/user/agent-process-segments.service.d
cat > ~/.config/systemd/user/agent-process-segments.service.d/harness.conf <<'EOF'
[Service]
Environment=APS_HARNESS=opencode
Environment=APS_HARNESS_BIN=%h/.opencode/bin/opencode
EOF
systemctl --user daemon-reload
systemctl --user restart agent-process-segments
```

The unit's `PATH` includes `%h/.opencode/bin`, so an install there resolves without the
binary override.

## Settings

Scheduler policy lives in `$XDG_CONFIG_HOME/agent-process-segments/config.json` (usually
`~/.config/agent-process-segments/config.json`); set `APS_CONFIG` to move it. Edit it from the
Config page or `PATCH /api/config`. The file is created on the first save; an invalid
file falls back to defaults until a valid one is written.

Process segments live beside it in `$XDG_CONFIG_HOME/agent-process-segments/process.json`
(`APS_PROCESS` overrides). This is the global default and the template for new cells.
Each cell stores its own copy in SQLite (`cells.process_json`) plus an optional
`master_interval_minutes`, `max_concurrent` (default 3), and `model`/`effort` defaults.
The scheduler keeps one timer per enabled cell plus one for unassigned work. Per-cell
master chats use `__master__:<cellId>`. Edit cell policy from the cell creation/edit flow
or `PATCH /api/cells/:id`. The Config page edits the global default; the Cell master
drawer shows the selected cell’s policy, ticker, activity, and chat. See
`docs/07-process-segments.md` and `docs/08-user-workflows.md`. Token/cost timelines are
backlogged in `docs/09-backlog.md`.

Both files are intentionally outside the repo and outside the systemd unit. The master
scheduler runs inside the brain.

The turn model falls back to `APS_DEFAULT_MODEL`. When unset, OpenCode uses
`opencode-go/deepseek-v4.1-flash`; set it to an empty string to use the CLI default, or to
another id from `GET /api/models`. Request and cell model settings still win.

Turn safety is configurable:

- `APS_TURN_TIMEOUT_MS` (default `600000`, ten minutes) caps one agent turn. A child
  that stays alive but silent is killed, the turn emits an error and `done`, and
  `engine.timeout` is written to the error log.
- `APS_MCP_TIMEOUT_MS` (default `15000`, fifteen seconds) caps one harness MCP call to
  the brain. A stalled call returns an MCP error result so the agent can recover.

Leave the defaults unless a slow repo genuinely needs a longer turn; a shorter turn
timeout is useful when a CLI wrapper is suspected of hanging at startup.

## Verification

The built brain is exercised by `scripts/smoke.sh`, `scripts/mcp-smoke.mjs`, and
`scripts/e2e.mjs`. The E2E suite uses a temp DB, a deterministic mock Claude CLI, and a
dedicated `E2E` cell; it never indexes into the KB. Run it with `npm run e2e` (builds
first). The CI template includes it.

## In-app Help docs

The SPA's sidebar **Help** surface serves the operator docs and screenshots from the same
brain, so keep the clone's `docs/` directory in place. `APS_DOCS_DIR` overrides the docs
root (default `<cwd>/docs`, and the unit sets it explicitly to
`%h/agent-process-segments/docs`). The manifest is an explicit code list; add a page there to
expose it in the nav. The viewer never copies Markdown into the SPA, so a `git pull`
updates the in-app docs after a restart. `GET /api/docs` lists pages,
`GET /api/docs/:slug` returns one article, and `GET /api/docs/assets/*` serves only
`docs/screenshots/**`.

## Skills in chat

The chat slash menu shows skills found in `~/.config/opencode/skills`, `~/.claude/skills`,
`~/.agents/skills`, and project `.opencode`/`.claude`/`.agents` skill directories. A
request chat also scans its target repo/worktree. Install a global skill at
`~/.config/opencode/skills/<name>/SKILL.md`; after reloading the SPA, `/name` appears in
the menu. See `docs/11-skills.md`.

## Error log

Explicit error paths append NDJSON to
`$XDG_STATE_HOME/agent-process-segments/errors.log` (usually
`~/.local/state/agent-process-segments/errors.log`). Override with `APS_ERROR_LOG`; cap with
`APS_ERROR_LOG_MAX_BYTES` (default 2 MiB, rotated once to `.1`). Read it with
`tail`/`jq`. See `docs/10-error-log.md` for sources and format. Normal logs remain in
`journalctl --user -u agent-process-segments`.

## Browser terminal

The desktop SPA includes server-owned PTY sessions. They start in `APS_TERMINAL_CWD`
(default: the brain’s working directory) and are independent of agent sessions. Hiding
the panel detaches; reopening or reloading reattaches with scrollback. Closing a session
tab kills it. Sessions are visible via `GET /api/terminals`, up to four at once. Disable
creation with `APS_TERMINAL=0` in the unit. The UI hides the action on phones, but the
session API is a direct shell: keep the brain on loopback or behind an authenticated
tunnel. The node-pty native module is built during `npm ci`; this host already has
`make`, `g++`, and `python3`.

## Install as a systemd user unit

```bash
git clone https://github.com/jlucero805/AgentProcessSegments ~/agent-process-segments
cd ~/agent-process-segments
npm ci
npm run build

mkdir -p ~/.config/systemd/user
cp deploy/agent-process-segments.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-process-segments

# Start the user manager at boot without an interactive login.
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger    # expect Linger=yes

systemctl --user status agent-process-segments --no-pager
curl -s http://127.0.0.1:7391/health    # {"ok":true}
```

If the clone is somewhere other than `~/agent-process-segments`, add a drop-in:

```bash
mkdir -p ~/.config/systemd/user/agent-process-segments.service.d
cat > ~/.config/systemd/user/agent-process-segments.service.d/paths.conf <<'EOF'
[Service]
WorkingDirectory=/srv/agent-process-segments
Environment=APS_DB=/srv/agent-process-segments/agent-process-segments.sqlite
Environment=APS_WEB_DIR=/srv/agent-process-segments/src/web/dist
EOF
systemctl --user daemon-reload
systemctl --user restart agent-process-segments
```

## Reach it from another machine

Keep the process on loopback and put the gate in front of the port.

- Tailscale Serve: `sudo tailscale serve --bg 7391`, then browse
  `https://<host>.<tailnet>.ts.net/`.
- Any reverse proxy or SSO tunnel: proxy to `http://127.0.0.1:7391`.

Before sharing a tunnel, check that anonymous requests to `/` and `/api` hit the SSO
redirect. The brain has no in-process auth by design.

Tunnel the one port. The SPA, API, and websocket must share an origin, so do not serve
`src/web/dist` from a separate web server.

## Update and restart

```bash
cd ~/agent-process-segments
git pull --ff-only
npm ci
npm run build
systemctl --user restart agent-process-segments
journalctl --user -u agent-process-segments -n 50 --no-pager
```

Requests, transcripts, and agent session ids are on disk. A restart loses no request
state; the engine resumes the agent session from `session.json` on the next turn.

## Upgrade from Sandbox Harness

An existing install keeps working after a binary upgrade: the brain still reads the
legacy `SBOX_*` variable names and uses an existing `sandbox-harness` data, config, state,
or SQLite location automatically. `APS_*` is canonical and wins when both names are set.

To move the data and the service to the new names:

```bash
# 1. Stop the old unit and keep it from starting again at boot.
systemctl --user stop sandbox-harness
systemctl --user disable sandbox-harness

# 2. Move the clone so the unit's WorkingDirectory matches. The SQLite file in the
#    clone moves with it.
mv ~/sandbox-harness ~/agent-process-segments
cd ~/agent-process-segments
npm ci
npm run build

# 3. Preview, then move the data, config, and state directories and the DB.
npm run migrate:paths -- --dry-run
npm run migrate:paths

# 4. Install and start the renamed unit.
cp deploy/agent-process-segments.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-process-segments
systemctl --user status agent-process-segments --no-pager
```

If you keep the old clone path, add a drop-in that sets `WorkingDirectory`,
`APS_DB`, `APS_WEB_DIR`, and `APS_DOCS_DIR` under that path, and run
`npm run migrate:paths -- --cwd <old clone>` so the script finds the SQLite file there.

Do **not** install the new unit before running the migration. It sets explicit `APS_*`
paths, so the brain would create an empty database and data directory at the new names
while the old data stays behind. The migration script never overwrites an existing
destination; if both names exist it reports the conflict and leaves the legacy path
alone. Existing worktrees move with the data directory; if git reports them at the old
path, run `git worktree repair` in the target repo or remove and recreate them.

Rollback is manual. An older binary reads only `SBOX_*`, so a rollback unit or drop-in
must set `SBOX_DB`, `SBOX_DATA_DIR`, `SBOX_CONFIG`, `SBOX_PROCESS`, and `SBOX_ERROR_LOG`
to the migrated paths and point `WorkingDirectory` at the renamed clone.

## System-wide variant

On a multi-user host, install as a system unit instead, running as the account that owns
the clone and the `claude` login:

```ini
# /etc/systemd/system/agent-process-segments.service
[Unit]
Description=Agent Process Segments brain
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sandbox
WorkingDirectory=/srv/agent-process-segments
ExecStart=/usr/bin/env node src/server/dist/app.js
Environment=NODE_ENV=production
Environment=APS_HOST=127.0.0.1
Environment=APS_PORT=7391
Environment=APS_DB=/srv/agent-process-segments/agent-process-segments.sqlite
Environment=APS_WEB_DIR=/srv/agent-process-segments/src/web/dist
Environment=APS_DOCS_DIR=/srv/agent-process-segments/docs
Environment=APS_DATA_DIR=/home/sandbox/.agent-process-segments
Environment=PATH=/home/sandbox/.local/bin:/home/sandbox/.opencode/bin:/usr/local/bin:/usr/bin:/bin
# Optional: Environment=APS_HARNESS=opencode
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
KillMode=mixed

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agent-process-segments
sudo systemctl status agent-process-segments --no-pager
```

## herdr-core

`herdr-core` keeps interactive terminals alive; the brain is a separate process. Run
herdr under its own unit or session so restarting the brain cannot take its panes with
it, and do not start the brain inside a herdr-spawned terminal. The brain spawns headless agent CLI children per request; it does not attach to herdr
panes.

## Troubleshooting

- `better-sqlite3` install fails with `not found: make`: install the toolchain
  (`sudo apt-get install -y make g++ python3`), then run `npm ci` again.
- `GET /api/models` returns `source: "fallback"`: the selected agent binary is not on the
  service `PATH`. Install `claude`/`opencode`, add its directory to
  `Environment=PATH=...`, and restart.
- `APS_HARNESS=opencode` but turns fail with no session: confirm `opencode run --help`
  works as the service user and that `opencode auth list` shows a stored provider.
- Port already in use: another brain or a stale process owns 7391. Check with
  `ss -tlnp | grep 7391`.
- SPA 404: `src/web/dist` was never built, or `APS_WEB_DIR` points elsewhere. Run
  `npm run build` and check the unit environment.
- Logs: `journalctl --user -u agent-process-segments -f` for the user unit, or
  `journalctl -u agent-process-segments -f` for the system unit.
