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

## Agent harness

`SBOX_HARNESS` selects the substrate: `claude` (default) or `opencode`.
`SBOX_HARNESS_BIN` overrides the binary; `SBOX_CLAUDE_BIN` still works for the Claude
case.

With `opencode`, the brain probes `opencode models`, writes a per-request
`OPENCODE_CONFIG_DIR` containing the harness MCP server plus the user's MCP servers, and
runs `opencode run --format json --auto --standalone` once per turn, resuming with
`--session`. User MCP servers are read from the user's OpenCode config. The knowledge
base session is forced read-only.

```bash
# either select it in the unit …
#   Environment=SBOX_HARNESS=opencode
# … or in a drop-in:
mkdir -p ~/.config/systemd/user/sandbox-harness.service.d
cat > ~/.config/systemd/user/sandbox-harness.service.d/harness.conf <<'EOF'
[Service]
Environment=SBOX_HARNESS=opencode
Environment=SBOX_HARNESS_BIN=%h/.opencode/bin/opencode
EOF
systemctl --user daemon-reload
systemctl --user restart sandbox-harness
```

The unit's `PATH` includes `%h/.opencode/bin`, so an install there resolves without the
binary override.

## Settings

Scheduler policy lives in `$XDG_CONFIG_HOME/sandbox-harness/config.json` (usually
`~/.config/sandbox-harness/config.json`); set `SBOX_CONFIG` to move it. Edit it from the
Config page or `PATCH /api/config`. The file is created on the first save; an invalid
file falls back to defaults until a valid one is written.

Process segments live beside it in `$XDG_CONFIG_HOME/sandbox-harness/process.json`
(`SBOX_PROCESS` overrides). This is the global default and the template for new cells.
Each cell stores its own copy in SQLite (`cells.process_json`) plus an optional
`master_interval_minutes`; the scheduler keeps one timer per enabled cell plus one for
unassigned work. Per-cell master chats use `__master__:<cellId>`. Edit cell policy from
the cell creation/edit flow or `PATCH /api/cells/:id`. The Config page edits the global
default; the Cell master drawer shows the selected cell’s policy, ticker, activity, and
chat. See `docs/07-process-segments.md` and `docs/08-user-workflows.md`.

Both files are intentionally outside the repo and outside the systemd unit. The master
scheduler runs inside the brain.

## Browser terminal

The desktop SPA includes a real PTY shell. It starts in `SBOX_TERMINAL_CWD` (default: the
brain’s working directory) and is independent of agent sessions. Disable it with
`SBOX_TERMINAL=0` in the unit. The UI hides the action on phones, but the `/ws/terminal`
route is a direct shell: keep the brain on loopback or behind an authenticated tunnel.
The node-pty native module is built during `npm ci`; this host already has `make`, `g++`,
and `python3`.

## Install as a systemd user unit

```bash
git clone https://github.com/jlucero805/AgentProcessSegments ~/sandbox-harness
cd ~/sandbox-harness
npm ci
npm run build

mkdir -p ~/.config/systemd/user
cp deploy/sandbox-harness.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now sandbox-harness

# Start the user manager at boot without an interactive login.
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger    # expect Linger=yes

systemctl --user status sandbox-harness --no-pager
curl -s http://127.0.0.1:7391/health    # {"ok":true}
```

If the clone is somewhere other than `~/sandbox-harness`, add a drop-in:

```bash
mkdir -p ~/.config/systemd/user/sandbox-harness.service.d
cat > ~/.config/systemd/user/sandbox-harness.service.d/paths.conf <<'EOF'
[Service]
WorkingDirectory=/srv/sandbox-harness
Environment=SBOX_DB=/srv/sandbox-harness/sandbox-harness.sqlite
Environment=SBOX_WEB_DIR=/srv/sandbox-harness/src/web/dist
EOF
systemctl --user daemon-reload
systemctl --user restart sandbox-harness
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
cd ~/sandbox-harness
git pull --ff-only
npm ci
npm run build
systemctl --user restart sandbox-harness
journalctl --user -u sandbox-harness -n 50 --no-pager
```

Requests, transcripts, and agent session ids are on disk. A restart loses no request
state; the engine resumes the agent session from `session.json` on the next turn.

## System-wide variant

On a multi-user host, install as a system unit instead, running as the account that owns
the clone and the `claude` login:

```ini
# /etc/systemd/system/sandbox-harness.service
[Unit]
Description=Sandbox Harness brain
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sandbox
WorkingDirectory=/srv/sandbox-harness
ExecStart=/usr/bin/env node src/server/dist/app.js
Environment=NODE_ENV=production
Environment=SBOX_HOST=127.0.0.1
Environment=SBOX_PORT=7391
Environment=SBOX_DB=/srv/sandbox-harness/sandbox-harness.sqlite
Environment=SBOX_WEB_DIR=/srv/sandbox-harness/src/web/dist
Environment=SBOX_DATA_DIR=/home/sandbox/.sandbox-harness
Environment=PATH=/home/sandbox/.local/bin:/home/sandbox/.opencode/bin:/usr/local/bin:/usr/bin:/bin
# Optional: Environment=SBOX_HARNESS=opencode
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
KillMode=mixed

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sandbox-harness
sudo systemctl status sandbox-harness --no-pager
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
- `SBOX_HARNESS=opencode` but turns fail with no session: confirm `opencode run --help`
  works as the service user and that `opencode auth list` shows a stored provider.
- Port already in use: another brain or a stale process owns 7391. Check with
  `ss -tlnp | grep 7391`.
- SPA 404: `src/web/dist` was never built, or `SBOX_WEB_DIR` points elsewhere. Run
  `npm run build` and check the unit environment.
- Logs: `journalctl --user -u sandbox-harness -f` for the user unit, or
  `journalctl -u sandbox-harness -f` for the system unit.
