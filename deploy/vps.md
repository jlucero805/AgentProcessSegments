# Running the brain on a VPS

The brain is one Node process. It serves the SPA, the API, and the websocket on a single
loopback port (`127.0.0.1:7391` by default). The tunnel in front of that port is the
audience gate; do not widen the bind.

This runbook assumes a single-user VPS with:

- Node 20 or newer on `PATH` (verified on Node 24).
- `git`.
- Build tools (`make`, `g++`, `python3`) when `better-sqlite3` v11 has no prebuild for the
  Node version; on Node 24 it compiles from source.
- the `claude` CLI on the service `PATH` for real agent turns.
- `herdr-core` installed if you use interactive terminals. The brain drives `claude`
  directly and does not import herdr.

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
Environment=PATH=/home/sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin
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
it, and do not start the brain inside a herdr-spawned terminal. The brain spawns
headless `claude -p` children per request; it does not attach to herdr panes.

## Troubleshooting

- `better-sqlite3` install fails with `not found: make`: install the toolchain
  (`sudo apt-get install -y make g++ python3`), then run `npm ci` again.
- `GET /api/models` returns `source: "fallback"`: `claude` is not on the service `PATH`.
  Add its directory to `Environment=PATH=...` in the unit and restart.
- Port already in use: another brain or a stale process owns 7391. Check with
  `ss -tlnp | grep 7391`.
- SPA 404: `src/web/dist` was never built, or `SBOX_WEB_DIR` points elsewhere. Run
  `npm run build` and check the unit environment.
- Logs: `journalctl --user -u sandbox-harness -f` for the user unit, or
  `journalctl -u sandbox-harness -f` for the system unit.
