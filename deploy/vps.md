# Running the brain on a VPS

The brain is one Node process. It serves the SPA, the API, and the websocket on a single
loopback port (`127.0.0.1:7391` by default). The tunnel in front of that port is the
audience gate; do not widen the bind.

This runbook assumes a single-user VPS with:

- Node 22.13 or newer on `PATH` (verified on Node 24; `better-sqlite3` v13 needs Node 22).
- `git`.
- Build tools (`make`, `g++`, `python3`): `node-pty` has no Linux prebuild and compiles
  during `npm ci`, and npm still runs an implicit gyp pass for `better-sqlite3`. Python
  3.14 needs npm 11.7 or newer; `npm run check:native` reports both.
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
`--session`. User MCP servers are read from the user's global OpenCode config; a project
`opencode.json(c)` or `.opencode` config in the repo is ignored because every child sets
`OPENCODE_CONFIG_PROJECT_DISABLE=1`. The knowledge base session is forced read-only. Do
not set `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT` in the unit environment: the
harness strips both for session children, so put user settings in
`~/.config/opencode/opencode.json(c)` (or `$XDG_CONFIG_HOME/opencode`) instead.

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
The scheduler keeps one timer per enabled cell. A cell runs at most one dispatch cycle
at a time; a tick during an active cycle is skipped and retried next interval. Per-cell
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
`%h/agent-process-segments/docs`). The manifest is an explicit list in
`src/server/src/docs/manifest.ts`; add a page there to expose it in the nav. The viewer
never copies Markdown into the SPA, so a `git pull`
updates the in-app docs after a restart. `GET /api/docs` lists pages,
`GET /api/docs/:slug` returns one article, and `GET /api/docs/assets/*` serves only
`docs/screenshots/**` in the supported image types. A served page may reference only those
screenshots; every other local file is not served, so link it by absolute URL or show it
as inline code.

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
tunnel. The node-pty native module is built during `npm ci --include=dev`; this host
already has `make`, `g++`, and `python3`. Run `npm run check:native` after installing and
before trusting a terminal session: it loads both native modules and names the missing
piece.

## Install as a systemd user unit

The unit exports `NODE_ENV=production`, and a shell started from the service inherits
it. Install with `npm ci --include=dev` (or `NODE_ENV=development npm ci`): a bare
`npm ci` omits `typescript`, `vite`, and the rest of the devDependencies, so the next
`npm run build` fails. The upgrade notes below apply the same rule to the self-hosted
upgrade path.

```bash
git clone https://github.com/jlucero805/AgentProcessSegments ~/agent-process-segments
cd ~/agent-process-segments
npm ci --include=dev
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

## Sandboxing

The unit ships a reviewed `[Service]` sandbox: `NoNewPrivileges`, `PrivateTmp`,
`PrivateDevices=yes`, `ProtectProc=invisible`, `ProtectSystem=full`, the kernel
protections, `RestrictAddressFamilies`, a private keyring, and `UMask=0077`.
`systemd-analyze security --offline=yes --user deploy/agent-process-segments.service`
reports about 3.8; `npm run lint` pins the directives and fails above a 4.8 exposure
ceiling.

What changes at runtime:

- A command run from the brain's terminal cannot gain privileges (`sudo`, setuid
  binaries) and cannot write under `/etc`, `/usr`, or `/boot`.
- `/tmp` and `/var/tmp` are private to the service, so files there are not visible to your
  other sessions; files the service creates start at `0600` and directories at `0700`.
- The service sees a minimal `/dev`: sound, input, and raw block/character devices are
  gone, while `/dev/ptmx`, `/dev/pts`, `/dev/null`, and the standard tty devices remain.
  Browser terminals and `node-pty` keep working.
- Processes owned by other users are hidden from `/proc` inside the service. The service
  user's own `ps`, `top`, and `free` still work; a terminal cannot inspect another
  login's processes.
- 32-bit binaries do not run (`SystemCallArchitectures=native`).

Three candidates were rejected by the live probe (`npm run probe:sandbox`, D114):

- `ProtectHome=read-only` makes `$HOME` read-only outside an explicit allow-list, so a
  target repo under the home (not just the clone) cannot receive a worktree.
- `ProtectSystem=strict` does the same to every path outside the allow-list, including
  `/srv` repos.
- `ProcSubset=pid` removes `/proc/meminfo`, so `ps`, `free`, and `uptime` fail inside a
  browser terminal.

`RestrictNamespaces=~user` and `SystemCallFilter=@system-service` are deferred until an
authenticated Claude Code turn exercises the real sandbox. A cached binary is not enough:
without a seedable login the probe skips `turn:claude` and keeps both deferred (D114).
`PrivateNetwork`, `PrivateUsers`, and `MemoryDenyWriteExecute` stay off for the reasons in
the unit. Read D96 and D114 in `docs/03-decisions.md` before adding any of them.

### Rerun the sandbox probe

The probe boots the built brain under the shipped block plus one candidate directive in
a transient user unit, then drives `/health`, a PTY, each available agent harness, git
worktrees, and the repair dry-run. It never touches the installed unit or the live
database.

```bash
npm ci --include=dev
npm run build
npm run probe:sandbox -- --report /tmp/aps-sandbox-probe.md
```

Options: `--root DIR` (default `~/.cache/aps-sandbox-probe`; must stay inside the real
home), `--srv-root DIR` (a writable non-temp path for the outside-repo check; `/srv` is
used when writable), `--harness claude|opencode|both`, `--candidate ID` (repeatable),
`--directive Key=Value` for an ad-hoc run, `--claude-bin`/`--opencode-bin`, `--timeout
SECONDS`, and `--keep` to inspect the run directories. Exit 0 means every check passed or
skipped, 1 means a check failed, and 3 means the host or build could not run the probe.

A candidate's suggested verdict is **ADOPT** only when every check passed, **REJECT** when
one failed, and **DEFER** when a required check skipped (for example no Claude binary).
The probe copies the invoking user's local OpenCode/Claude state into the isolated fake
home so a real turn can authenticate; that copy lives under the run root and is deleted
unless `--keep` is set.

Prove the host's user manager can apply the sandbox before restarting a live brain:

```bash
systemd-run --user --unit=aps-sandbox-probe --wait --collect \
  -p PrivateTmp=yes -p ProtectSystem=full -p NoNewPrivileges=yes /bin/true
```

If the unit refuses to start after an update, remove the sandboxing block from the
installed copy, run `systemctl --user daemon-reload`, and restart. Inspect the applied
values with `systemd-analyze security --user agent-process-segments`. A changed unit is
still installed by hand: `deploy/upgrade-vps.sh` refuses a target commit that edits it.

## Tailscale

Serve publishes the loopback port to your tailnet. The brain stays bound to
`127.0.0.1:7391`; Tailscale terminates TLS and is the audience gate. Do not use
Tailscale Funnel for this service.

Before the first Serve command, confirm the tailnet has MagicDNS and HTTPS enabled. In
the Tailscale admin console, open **DNS** and enable **MagicDNS** and **HTTPS
Certificates**. Serve cannot issue the `*.ts.net` certificate until HTTPS is enabled.
Also confirm TCP 443 is free on the VPS:

```bash
ss -tlnp | grep ':443'    # no output means 443 is free
```

Install Tailscale and join the tailnet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

Publish the brain. `--bg` keeps the Serve configuration across reboots and Tailscale
restarts, and the proxy target stays on loopback:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:7391
```

`sudo tailscale serve --bg 7391` is the shorthand for the same mapping. Verify it:

```bash
tailscale serve status
# https://<host>.<tailnet>.ts.net (tailnet only)
# |-- / proxy http://127.0.0.1:7391

curl -fsS https://<host>.<tailnet>.ts.net/health
# {"ok":true}
```

Open `https://<host>.<tailnet>.ts.net/` from another device on the tailnet. If 443 is
already in use, publish on 8443 instead and include the port in the URL:

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:7391
# browse https://<host>.<tailnet>.ts.net:8443/
```

Remove the mapping with `sudo tailscale serve reset`; this clears all Serve entries on
the node. `tailscale serve status` should then print nothing.

Troubleshooting:

- `tailscale status` shows the node is not logged in: run `sudo tailscale up`.
- Serve cannot provision a certificate: enable HTTPS Certificates and MagicDNS in the
  admin console, then retry.
- The tailnet URL hangs or refuses: confirm the device is on the same tailnet and the
  tailnet ACL allows TCP 443 to this node.
- 443 is occupied: find the listener with `ss -tlnp | grep ':443'` and use the 8443
  variant.

## Reach it from another machine

Keep the process on loopback and put the gate in front of the port. The Tailscale setup
and exact commands are in [Tailscale](#tailscale).

- Tailscale Serve: `sudo tailscale serve --bg --https=443 http://127.0.0.1:7391`, then
  browse `https://<host>.<tailnet>.ts.net/`. The shorthand
  `sudo tailscale serve --bg 7391` is equivalent.
- Any reverse proxy or SSO tunnel: proxy to `http://127.0.0.1:7391`.

Before sharing a tunnel, check that anonymous requests to `/` and `/api` hit the SSO
redirect. The brain has no in-process auth by design.

Tunnel the one port. The SPA, API, and websocket must share an origin, so do not serve
`src/web/dist` from a separate web server.

## Update and restart

```bash
cd ~/agent-process-segments
git pull --ff-only
npm ci --include=dev
npm run build
systemctl --user restart agent-process-segments
journalctl --user -u agent-process-segments -n 50 --no-pager
```

Then tighten request workdirs left by an older version: preview with
`npm run repair:permissions`, then apply with `npm run repair:permissions -- --apply`.
If `requests/` is a symlink, the command refuses it (exit 1) instead of following it;
point `--data-dir` at the real parent to repair the relocated tree.

Requests, transcripts, and agent session ids are on disk. A restart loses no request
state; the engine resumes the agent session from `session.json` on the next turn.

An operator with a shell outside the service can run that sequence by hand. It kills
in-flight turns, and it cannot be run from inside the brain itself, because the
`systemctl --user restart` stops the service cgroup that owns the shell. Use the
self-hosted upgrade below for that case.

## Upgrade a live, self-hosted brain

`deploy/upgrade-vps.sh` upgrades an install that is already on the Agent Process Segments
names, including one whose own brain is orchestrating the upgrade. It pauses
`master.enabled`, drains every request with `agentStatus=working`, snapshots the database
and the current `dist`/`node_modules` trees, fast-forwards the clone, installs
dependencies only when the lockfile or a workspace `package.json` changed, rebuilds,
restarts the unit, and verifies the new build before restoring the master setting.
Running it from inside the service requires `--detach`: the script copies itself into a
run directory and launches it in a transient user unit, so the restart cannot kill it.

A failure before the restart restores the old commit, dependencies, and `dist` in place
and never restarts. A failure after the restart puts them back, restarts the old build,
and marks the run `rolled_back`.

```bash
cd ~/agent-process-segments
npm run upgrade:vps -- --dry-run            # inspect the plan; changes nothing
npm run upgrade:vps -- --detach --request-id <request-id>
```

The first upgrade runs on a clone that does not contain the script yet. Invoke it from a
worktree that is already at the merged commit; `--clone` defaults to the unit's
`WorkingDirectory`, so the worktree does not need to be the live checkout:

```bash
git worktree add /tmp/aps-upgrade origin/main
bash /tmp/aps-upgrade/deploy/upgrade-vps.sh --dry-run
bash /tmp/aps-upgrade/deploy/upgrade-vps.sh --detach
```

Options: `--unit NAME`, `--branch NAME`, `--to REF`, `--wait-seconds N`,
`--health-timeout N`, `--allow-busy`, `--home DIR`, `--clone DIR`, `--request-id ID`,
`--keep-runs N` (default 5), `--keep-days D` (default 30; `0` disables the age rule),
and `--no-prune`. `--clone` must resolve to the unit's `WorkingDirectory`; the script
refuses any other directory because that is not the live deployment.

Watch the run, and read the evidence afterwards:

```bash
cat ~/.aps-cutover/upgrades/latest/state
tail -f ~/.aps-cutover/upgrades/latest/upgrade.log
journalctl --user -f | grep aps-upgrade
```

`--detach` prints the transient unit name; `journalctl --user -u <name>` shows that unit
while it still exists. `state` is one of `launched`, `running`, `success`, `failed`, or
`rolled_back`. A run that finds the clone already at the target records `success`, creates
the shared root if needed, points `upgrades/latest` at its run directory, and changes
nothing else. Each run directory is created (or tightened) `0700` and keeps `before.json`,
`after.json`, `config-before.json`, `config-after.json`, `db-backup.sqlite`, and the
previous `dist` and `node_modules` trees; the snapshot itself is written `0600`. After
every terminal state the script keeps the current/`latest` run, the newest successful run,
the newest 5 finished runs, any run modified in the last 30 days, and incomplete runs for
a 7-day grace window, then removes the older terminal runs. Use `--keep-runs` and
`--keep-days` to tune those windows, or `--no-prune` to leave pruning to an external
schedule. A refused preflight in a detached run and a detached unit that cannot start are
terminal too: both write `failed`, run the same retention pass, and make the launching
command exit non-zero.

### Prune upgrade run directories

Prune upgrade evidence by hand (for example after running with `--no-prune`, or on a
schedule) with the same pruner:

```bash
npm run prune:upgrades -- --dry-run   # list what would be removed
npm run prune:upgrades
```

The command scans only `~/.aps-cutover/upgrades`. It uses the pruner's defaults: the
newest 10 runs, anything modified in the last 30 days, `upgrades/latest`, the newest
successful run, and incomplete runs for a 7-day grace window. The upgrade script's
automatic pass defaults to the newest 5, so pass `--keep-runs 5` to match it. Tune with
`--keep-runs N`, `--keep-days D` (0 disables the age rule), and
`--incomplete-grace-days D`; `--root DIR` points at a different cutover root, and
`--help` lists every flag. Deleting a run directory also deletes its `db-backup.sqlite`
and previous build trees, so inspect `upgrades/latest` and the newest successful run
before an aggressive prune.

The command is a plain `.mjs` script: it needs no `npm run build`, and it only touches the
selected `upgrades` directory, so the brain can keep running. `--no-prune` on
`upgrade:vps` disables only that automatic pass; this command still works and can be
scheduled instead.

To schedule it instead of using the automatic pass:

```cron
17 5 * * 0 cd "$HOME/agent-process-segments" && npm run prune:upgrades -- --keep-runs 5 --keep-days 14 >> "$HOME/.aps-cutover/prune.log" 2>&1
```

Runs left by an older version have not been tightened. After the first upgrade to a build
with the owner-only modes, repair them explicitly:

```bash
npm run build
npm run repair:upgrades              # preview
npm run repair:upgrades -- --apply   # tighten old upgrade run dirs and snapshots
```

The command scans the shared `~/.aps-cutover` root and `~/.aps-cutover/upgrades`. It sets
the root, the `upgrades` directory, and each direct run directory to `0700`, and each
top-level `db-backup.sqlite` to `0600`. It never follows a symlinked `upgrades/`, deletes
anything, opens the database, changes snapshot contents, chmods the `latest` symlink, or
touches `~/.aps-cutover/runs`. A symlinked root is skipped, while its `upgrades/` tree is
still scanned through the link, so tighten the target yourself. The root is tightened
first, so its run/upgrade names and the `latest` target stop being listable by other local
accounts.

Notes:

- The turn that launched a detached upgrade dies with the service. Check
  `state` and `upgrade.log` after the unit comes back instead of waiting for the turn.
- `npm ci` is not optional when the lockfile moves, and it must pass `--include=dev`:
  the unit exports `NODE_ENV=production`, which otherwise omits `typescript`, `vite`, and
  the rest of the devDependencies and breaks the build. The script handles this.
- `db-backup.sqlite` is a consistent, owner-only snapshot taken before the install. The
  script never restores it automatically. Migrations are additive, so a rolled-back build
  can usually read the upgraded database; restore the snapshot by hand only if it cannot.
- The script refuses a dirty clone, a non-fast-forward target, a branch mismatch, or a
  target commit that changes `deploy/agent-process-segments.service`; install a changed
  unit deliberately instead of letting an upgrade replace it. The sandboxing blocks from
  D96 and D114 are such changes: copy the new unit, run `daemon-reload`, and restart by
  hand.
- Re-running when the clone is already at the target prints `already up to date` and
  changes nothing.

After a finished run, verify the service independently:

```bash
systemctl --user is-active agent-process-segments
systemctl --user show agent-process-segments -p WorkingDirectory -p ActiveEnterTimestamp
curl -fsS http://127.0.0.1:7391/health
curl -fsS http://127.0.0.1:7391/api/models
git -C ~/agent-process-segments log --oneline -1
```

The script also probes a route added in the target build (currently
`/api/notifications/status`, which returns 404 on older builds) so a green `/health`
alone cannot hide a restart on the previous binary.

Then run the one-time repairs. `npm run repair:permissions` previews and
`npm run repair:permissions -- --apply` changes modes for request workdirs created by an
older version. `npm run repair:upgrades` previews and
`npm run repair:upgrades -- --apply` changes modes for upgrade run directories and
snapshots created by an older version. `npm run repair:runs` previews and
`npm run repair:runs -- --apply` changes modes for cutover run directories and the shared
`~/.aps-cutover` root created by an older version. `repair:permissions` refuses a
symlinked `requests/` root instead of following it. None is part of the upgrade script
yet.

## Upgrade from Sandbox Harness

An existing install keeps working after a binary upgrade: the brain still reads the
legacy `SBOX_*` variable names and uses an existing `sandbox-harness` data, config, state,
or SQLite location automatically. `APS_*` is canonical and wins when both names are set.
A brain that still sees any `SBOX_*` variable logs one startup warning naming those
variables (names only, never values); rename them to `APS_*` to clear it.
`npm run migrate:paths` moves only the filesystem defaults, not the variable names.

The migration refuses to run while `agent-process-segments.service` or the legacy
`sandbox-harness.service` is active in either user or system scope, while a visible
process still has the legacy data, config, state, or SQLite paths open, while a
brain answers its health endpoint, or while an opt-in brain lock is fresh. On Linux the
script checks `/proc` for open file descriptors and cwds, so a foreground/dev brain or a
custom unit name is caught when the process is visible. It also requests
`http://127.0.0.1:<APS_PORT|SBOX_PORT|7391>/health`; pass `--brain-url` to probe a
container, tunnel, or another host instead. For a brain whose HTTP port is not reachable
at all, start it with `APS_BRAIN_LOCK=1`: it writes `<data-dir>/brain.lock` and refreshes
it every 10 s, and the migration treats a lock younger than 60 s as live. The brain must
be upgraded and restarted with the variable, and its data directory must be on storage
shared with the machine running the migration; `--brain-lock FILE` checks a different
heartbeat path. Stop the brain or process first; `--allow-running` bypasses all four
guards and can corrupt an open SQLite database. A brain that did not opt in, a shared
database whose data directory is not shared, a non-HTTP or non-file holder, or a process
hidden by permissions is still not detected.

To move the data and the service to the new names:

```bash
# 1. Stop the old unit and keep it from starting again at boot.
systemctl --user stop sandbox-harness
systemctl --user disable sandbox-harness

# 2. Move the clone so the unit's WorkingDirectory matches. The SQLite file in the
#    clone moves with it.
mv ~/sandbox-harness ~/agent-process-segments
cd ~/agent-process-segments
npm ci --include=dev
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

## Cutting over a live, self-hosted brain

The steps above assume an operator shell outside the service. When the brain being
migrated also orchestrates the migration, a normal shell session cannot perform it:
`systemctl --user stop sandbox-harness` kills the service cgroup, including the script
that would do the cutover. Use the bundled cutover script, which detaches itself into a
transient user unit and survives the stop.

The script pauses `master.enabled`, waits for every request with `agentStatus=working`
to leave that state, fast-forwards and builds the clone, then stops the old unit, moves
the clone and paths, repairs git worktrees, installs the renamed unit with the migrated
harness drop-in, verifies the database and UI, and restores the master setting. If
anything fails it restores the old unit in place — it never moves migrated data back.

The run directory's `state` file records how it ended. `failed` means the run stopped
before moving the clone or paths: the clone and units are untouched, and `master.enabled`
is restored if the run had paused it. `rolled-back` means the old unit was restored and
restarted; if it does not become healthy, the script logs a warning and still records
`rolled-back`. If the clone or XDG paths had already moved, they stay at the APS names and
the restored unit reads them through a generated
`sandbox-harness.service.d/zz-rollback.conf` with `SBOX_*` paths. Once the run reaches
the backup step, the old unit, drop-ins, and pre-build `dist` bundles are under
`<run-dir>/backup/`; keep that directory until the new unit has run for a while. A
repeat run detects the migrated paths as already migrated and refuses to continue while
the new unit is inactive; it does not resume a rolled-back attempt automatically.
Inspect the run and the unit before retrying.

```bash
cd ~/AgentProcessSegments          # the legacy clone name, or pass --old-clone
npm run cutover:vps -- --dry-run   # inspect the full plan; changes nothing
npm run cutover:vps -- --detach --request-id <request-id>
```

Options: `--dry-run`, `--detach`, `--request-id ID`, `--home DIR`, `--old-clone DIR`,
`--new-clone DIR`, `--wait-seconds N`, `--allow-busy`, `--keep-runs N`, `--keep-days D`,
`--no-prune`, `--help`.

A real cutover also prunes older run directories before it creates the new one and after
it writes `success`, `failed`, or `rolled-back`. By default it keeps the newest 10 runs
and anything modified in the last 30 days, plus the current run, the `latest` target, the
newest successful rollback point, and any non-terminal run inside the pruner's 7-day
grace window. Use `--keep-runs`/`--keep-days` to tune it, or `--no-prune` to skip both
passes and keep scheduling `npm run prune:cutover` yourself. The effective flags and the
`prune-before`/`prune-after` output are recorded in `cutover.log`.

`--detach` copies the script to `~/.aps-cutover/runs/<UTC>/cutover.sh` and launches it
with `systemd-run --user`. Watch it with:

```bash
journalctl --user -f | grep aps-cutover
cat ~/.aps-cutover/latest/state
cat ~/.aps-cutover/latest/cutover.log
```

The launch prints the exact transient unit name; use `journalctl --user -u <name>` for
that unit if it is still present.

Each real cutover creates (or tightens) its run directory under `~/.aps-cutover/runs/` to
`0700`, so the evidence, `cutover.log`, `state`, and the `backup/` rollback copy stay
owner-only. A missing `~/.aps-cutover` or `~/.aps-cutover/runs` ancestor is created `0700`
too; an existing ancestor is left alone.

The shared root and run directories left by an older version have not been tightened.
After updating to a build with the owner-only mode, repair them explicitly:

```bash
npm run build
npm run repair:runs              # preview the root and old run dirs
npm run repair:runs -- --apply   # tighten the root and old run dirs
```

The command scans `~/.aps-cutover` itself, `~/.aps-cutover/runs`, and each direct run
directory. It sets all of them to `0700`, and never follows a symlinked `runs/`, deletes
anything, descends into `dist/` or `backup/`, reads or changes run contents, or touches
the `latest` symlink or `~/.aps-cutover/upgrades`. New installs already create the root
`0700`; either repair command also tightens an older root. A symlinked root is not
chmodded; its `runs/` tree is still scanned through the link, so tighten the target
yourself.

After it finishes, verify the new unit and paths:

```bash
systemctl --user is-active agent-process-segments
systemctl --user show agent-process-segments -p FragmentPath -p WorkingDirectory -p Environment
curl -s http://127.0.0.1:7391/health
curl -s http://127.0.0.1:7391/api/models
git -C ~/agent-process-segments worktree list
```

Notes for similar installs:

- The legacy clone may have a different name (for example `~/AgentProcessSegments`).
  The script prefers `~/AgentProcessSegments` when it exists, then `~/sandbox-harness`;
  pass `--old-clone` for any other path.
- `harness.conf` must be migrated to `APS_HARNESS=opencode` and
  `APS_HARNESS_BIN=$HOME/.opencode/bin/opencode`. If the host has no `claude` binary,
  dropping the harness drop-in leaves `/health` green while every turn fails.
- Do not copy `verify.conf`: its `WorkingDirectory`/`SBOX_*` path overrides are now the
  new unit's defaults.
- The cutover drains **all** active turns, not only `--request-id`, because the service
  stop kills every child. `--allow-busy` skips the drain and accepts that loss; use it
  only for an emergency.
- The cutover stops the old unit before calling `migrate-paths` and waits for the port
  to stop answering, so the unit, `/proc`, health, and brain-lock guards pass without a
  flag. The cutover does not enable the lock. Do not add `--allow-running`: moving while
  a brain unit, process, health endpoint, or fresh lock is active can corrupt the
  database. If the previous process was killed without a graceful stop, a fresh
  `brain.lock` can make the migration refuse for up to 60 s; wait for it to go stale and
  retry instead of bypassing the guard.
- Moving the clone and `~/.sandbox-harness` breaks absolute gitdir links. The script
  runs `git worktree repair` and `git worktree prune`; verify the worktree used by the
  request that launched the cutover before resuming it.
- The new unit keeps the old port. If the old unit used a non-default port or host, the
  script writes `port.conf`/`host.conf` drop-ins to preserve it.
- `~/.aps-cutover/latest/backup` holds the old unit file, drop-ins, and the pre-build
  `dist` directories. Keep it until the new unit has run for a while.
- Re-running is safe. If the new unit is active and the new clone, data, config, state,
  and database already exist with no legacy counterparts, the script prints
  `already migrated` and exits 0 without changing anything. If the new paths exist but
  the unit is not active, it fails and asks you to inspect rather than claiming success.

## Prune cutover run directories and backups

Each real cutover leaves a run directory under `~/.aps-cutover/runs/<UTC>/`. Run
directories are created `0700`, and pruning removes whole directories without changing
the mode of the ones it keeps. A real cutover prunes older runs automatically before it
starts and after it finishes; each one is roughly 6 MB on a typical host: `dist/` holds
the pre-build bundles, `errors.log.before` the old error log, and `backup/systemd/` the
rollback unit and drop-ins. Prune them by hand with:

```bash
npm run prune:cutover -- --dry-run   # list what would be removed
npm run prune:cutover
```

The pruner keeps the newest 10 run directories, anything modified in the last 30 days,
the `latest` target, and the newest successful run, because that run's
`backup/systemd/` copy is the only in-place rollback artifact. A run whose `state` is
still `launched` or `running` is kept for seven days even when it falls outside those
windows. Tune it with `--keep-runs N`, `--keep-days D`, and
`--incomplete-grace-days D`; `--keep-days 0` keeps only the count and protection rules.
Deleting a run directory also deletes its rollback copy, so inspect
`~/.aps-cutover/latest/backup` before an aggressive prune.

A real `deploy/cutover-vps.sh` forwards `--keep-runs`/`--keep-days` to this pruner and
skips both passes with `--no-prune`. If you opted out, run the command manually after a
cutover, or schedule it weekly:

```cron
17 4 * * 0 cd "$HOME/agent-process-segments" && npm run prune:cutover -- --keep-runs 5 --keep-days 14 >> "$HOME/.aps-cutover/prune.log" 2>&1
```

The pruner only touches `~/.aps-cutover`, so the brain can stay running.

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
# Same reviewed sandboxing set as the user unit; see D96 and D114 in docs/03-decisions.md.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
KeyringMode=private
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
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
it, and do not start the brain inside a herdr-spawned terminal. The brain spawns headless
agent CLI children per request; it does not attach to herdr panes.

## Troubleshooting

- Native install fails with `not found: make` or a gyp error: install the toolchain
  (`sudo apt-get install -y make g++ python3`), then run
  `npm rebuild node-pty --foreground-scripts` (the only package with a source build) or
  `rm -rf node_modules && npm ci --include=dev` for a clean re-extract to see the build
  output. On Python 3.14, gyp itself crashes unless npm is 11.7 or newer (bundled node-gyp
  12): run `npm install -g npm@latest`. `npm run check:native` names the failing module.
- A gyp `write` error usually means the disk is full: check `df -h`, then retry.
- npm prints `install-scripts ... not yet covered by allowScripts` for `node-pty`/`esbuild`:
  review them with `npm install-scripts ls` and approve (or deny) them; a denied native
  build leaves the module without its binary, which `npm run check:native` catches.
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
