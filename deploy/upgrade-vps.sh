#!/usr/bin/env bash
# Upgrade an already cut-over, self-hosted Agent Process Segments brain in place.
#
# Fast-forwards the clone, installs dependencies only when the lockfile moved,
# rebuilds, restarts the unit, verifies the new build, and rolls back in place
# when a step fails. Running from inside the brain unit requires --detach,
# because the restart kills the service cgroup, including this script.
#
# This is a sibling of deploy/cutover-vps.sh, not a mode of it: cutover moves a
# legacy Sandbox Harness install and refuses to run twice, while this script
# upgrades an install that is already on the Agent Process Segments names. The
# helpers below are intentionally duplicated from cutover so an upgrade cannot
# break the cutover path. Do not extract them into a shared library here.
#
# Usage:
#   deploy/upgrade-vps.sh --dry-run
#   deploy/upgrade-vps.sh --detach --request-id <request-id>
#
# Run --help for every option.

set -Eeuo pipefail

ORIGINAL_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$ORIGINAL_SCRIPT")" && pwd)"

HOME_ARG="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
CLONE_ARG=""
UNIT="agent-process-segments"
BRANCH="main"
TO=""
REQUEST_ID=""
WAIT_SECONDS=1800
HEALTH_TIMEOUT=90
DRY_RUN=0
DETACH=0
ALLOW_BUSY=0
INTERNAL_RUN=0
RUN_DIR_ARG=""
KEEP_RUNS=5
KEEP_DAYS=30
NO_PRUNE=0

PAUSED=0
MERGED=0
RESTARTED=0
ROLLED_BACK=0
PRUNED=0
NODE_MODULES_BACKED_UP=0
SERVER_DIST_BACKED_UP=0
WEB_DIST_BACKED_UP=0
MASTER_ENABLED=false
NPM_CI=0
NPM_CI_REASON=""
BEHIND=0
REQUEST_DIRS=0
HARNESS_BEFORE=""

usage() {
  cat <<'EOF'
Usage: deploy/upgrade-vps.sh [options]

Fast-forwards an already cut-over brain clone, installs dependencies when the
lockfile changed, rebuilds, restarts the unit, verifies the new build, and rolls
back in place if anything fails. Run --dry-run first. Use --detach when the
caller is inside the live brain unit; the detached run survives the restart.

Options:
  --dry-run             Print the plan and change nothing.
  --detach              Copy this script to a stable run directory and launch it
                        in a transient systemd user unit. Required from inside
                        the brain service.
  --request-id ID       Request to associate with the upgrade. It is used to
                        confirm the request exists; the script drains all
                        working turns, not only this one.
  --home DIR            Home directory that owns the clone and run directories.
  --clone DIR           Live clone to upgrade. Defaults to the unit's
                        WorkingDirectory; passing a different directory is
                        refused because that is not the live deployment.
  --unit NAME           systemd user unit (default agent-process-segments).
  --branch NAME         Branch to fast-forward to (default main).
  --to REF              Target commit on the branch. Defaults to origin/NAME.
  --wait-seconds N      Maximum seconds to wait for active turns to drain
                        (default 1800). Zero means fail immediately if busy.
  --health-timeout N    Maximum seconds to wait for /health after a restart
                        (default 90).
  --allow-busy          Do not wait for active turns. This kills in-flight work;
                        use only when the operator accepts that.
  --keep-runs N         Keep the N newest upgrade run directories (default 5).
  --keep-days D         Keep upgrade run directories modified within D days
                        (default 30). Zero disables the age rule.
  --no-prune            Do not prune older upgrade run directories. Use this
                        when you schedule pruning yourself.
  --help                Show this help.

A real upgrade prunes older run directories under ~/.aps-cutover/upgrades after
it writes a terminal state. It keeps the current/latest run, the newest
successful run, the newest N runs, any run modified within D days, and
incomplete runs for a 7-day grace window. Use --keep-runs/--keep-days to tune it
or --no-prune to opt out.

The run writes ~/.aps-cutover/upgrades/<UTC>/ with upgrade.log, state,
before.json, after.json, config-before.json, config-after.json, the database
snapshot, and the previous dist and node_modules trees for rollback.
EOF
}

log() {
  local line
  line="$(date -u +%FT%TZ) $*"
  printf '%s\n' "$line"
  if [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]]; then
    printf '%s\n' "$line" >>"$RUN_DIR/upgrade.log"
  fi
}

die() {
  log "ERROR: $*"
  return 1
}

refuse() {
  log "REFUSED: $*"
  if [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]]; then
    write_state failed
    # A refusal is terminal, so prune like the other terminal states. Clear the
    # ERR trap first: a prune problem must not fall into rollback(), which would
    # write the state again and try to prune a second time.
    trap - ERR
    set +e
    retention_after failed
  fi
  exit 2
}

write_state() {
  if [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]]; then
    printf '%s\n' "$1" >"$RUN_DIR/state"
  fi
}

pruner_path() {
  local candidate
  for candidate in "$SCRIPT_DIR/prune-cutover-runs.mjs" \
    "$SCRIPT_DIR/../scripts/prune-cutover-runs.mjs"; do
    if [[ -f "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

check_pruner() {
  local pruner
  if ! pruner="$(pruner_path)"; then
    printf 'upgrade pruner not found; run from a checkout with scripts/prune-cutover-runs.mjs or pass --no-prune\n' >&2
    log "ERROR: upgrade pruner not found; expected $SCRIPT_DIR/prune-cutover-runs.mjs or $SCRIPT_DIR/../scripts/prune-cutover-runs.mjs"
    return 1
  fi
  printf '%s' "$pruner"
}

point_upgrade_latest() {
  [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]] || return 0
  (umask 077; mkdir -p "$UPGRADE_ROOT") || {
    log "WARNING: could not create $UPGRADE_ROOT; skipping prune"
    return 1
  }
  ln -sfn "$RUN_DIR" "$UPGRADE_ROOT/latest" || {
    log "WARNING: could not point $UPGRADE_ROOT/latest at $RUN_DIR; skipping prune"
    return 1
  }
  return 0
}

retention_after() {
  local phase="$1"
  [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]] || return 0
  # The ERR trap is inherited by subshells, so a rollback can run once inside a
  # redirected subshell and again in the top-level shell. Only the top-level
  # shell owns the single retention pass.
  if [[ "${BASH_SUBSHELL:-0}" -gt 0 || "$PRUNED" -eq 1 ]]; then
    return 0
  fi
  PRUNED=1
  if [[ "$NO_PRUNE" -eq 1 ]]; then
    log "pruning skipped (--no-prune)"
    return 0
  fi
  point_upgrade_latest || return 0
  local pruner
  if ! pruner="$(pruner_path)"; then
    log "WARNING: upgrade pruner not found; skipping post-$phase prune"
    return 0
  fi
  local output status
  if output="$(node "$pruner" --kind upgrade --root "$CUTOVER_ROOT" \
    --keep-runs "$KEEP_RUNS" --keep-days "$KEEP_DAYS" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  log "prune $phase (--keep-runs $KEEP_RUNS --keep-days $KEEP_DAYS)"
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output" >>"$RUN_DIR/upgrade.log"
    printf '%s\n' "$output"
  fi
  if (( status != 0 )); then
    log "WARNING: prune $phase failed (exit $status); older run directories may remain"
  fi
  return 0
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

normalize_path() {
  realpath -m "$1"
}

# Create (or tighten) a run directory that holds the snapshot and evidence.
# A missing ancestor chain is created owner-only; an existing ancestor is left alone.
prepare_run_dir() {
  local dir="$1"
  (umask 077; mkdir -p "$dir")
  chmod 700 "$dir"
}

# Warn (never fail, never chmod) when the shared cutover root already exists with
# a mode other than 0700. A symlinked root is reported as-is, not followed.
warn_if_cutover_root_permissive() {
  local root="$HOME/.aps-cutover" mode
  if [[ -L "$root" ]]; then
    log "WARNING: $root is a symlink; not following it or changing its mode. The repair commands do not chmod a symlinked root, so tighten the target yourself."
    return 0
  fi
  [[ -d "$root" ]] || return 0
  if ! mode="$(stat -c '%a' "$root" 2>/dev/null)"; then
    log "WARNING: could not read the mode of $root; skipping the permission check."
    return 0
  fi
  [[ "$mode" == "700" ]] && return 0
  log "WARNING: $root is mode $mode, expected 700; run 'npm run repair:runs -- --apply' (or 'npm run repair:upgrades -- --apply') to tighten it. This run leaves it unchanged."
  return 0
}

short_sha() {
  printf '%s' "${1:0:12}"
}

unit_active() {
  [[ "$(systemctl --user is-active "$1" 2>/dev/null || true)" == "active" ]]
}

unit_loaded() {
  systemctl --user show "$1" -p LoadState --value 2>/dev/null | grep -qx loaded
}

unit_prop() {
  systemctl --user show "$UNIT" -p "$1" --value 2>/dev/null || true
}

main_process_cwd() {
  local pid
  pid="$(unit_prop MainPID)"
  [[ -n "$pid" && "$pid" != "0" ]] || return 0
  readlink "/proc/$pid/cwd" 2>/dev/null || true
}

api_url() {
  printf 'http://%s:%s%s' "$HOST" "$PORT" "$1"
}

api_get() {
  curl -fsS --max-time 10 "$(api_url "$1")"
}

api_patch_config() {
  curl -fsS --max-time 10 -X PATCH -H 'content-type: application/json' \
    -d "$1" "$(api_url /api/config)" >/dev/null
}

http_status() {
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$(api_url "$1")" 2>/dev/null || true)"
  printf '%s' "${status:-000}"
}

models_harness() {
  local body
  body="$(api_get /api/models 2>/dev/null || true)"
  [[ -n "$body" ]] || return 0
  printf '%s' "$body" | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        process.stdout.write(String(JSON.parse(body).harness ?? ""));
      } catch {
        // A body that is not JSON proves nothing about the harness; report none.
      }
    });
  ' || true
}

json_get() {
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const parts = process.argv[2].split(".");
    let value = data;
    for (const part of parts) value = value == null ? undefined : value[part];
    if (value !== undefined) process.stdout.write(String(value));
  ' "$1" "$2"
}

json_equal_without_path() {
  node -e '
    const fs = require("node:fs");
    const util = require("node:util");
    const left = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const right = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    delete left.path;
    delete right.path;
    if (!util.isDeepStrictEqual(left, right)) {
      console.error("config trees differ");
      console.error("left:  " + JSON.stringify(left));
      console.error("right: " + JSON.stringify(right));
      process.exit(1);
    }
  ' "$1" "$2"
}

count_working() {
  curl -fsS --max-time 10 "$(api_url /api/requests)" | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const requests = JSON.parse(body);
      process.stdout.write(String(requests.filter((r) => r.agentStatus === "working").length));
    });
  '
}

sha() {
  sha256sum "$1" | awk '{print $1}'
}

request_dir_count() {
  if [[ -d "$1/requests" ]]; then
    find "$1/requests" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' '
  else
    printf '0'
  fi
}

inspect_db() {
  local db="$1"
  local out="$2"
  local cwd="$3"
  (
    cd "$cwd"
    node - "$db" "$out" <<'NODE'
const fs = require('node:fs');
const Database = require('better-sqlite3');
const dbPath = process.argv[2];
const outPath = process.argv[3];
const tables = [
  'requests',
  'master_events',
  'cells',
  'kb_entries',
  'cell_summaries',
  'usage_events',
  'budget_alerts',
];
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const integrity = db.pragma('integrity_check', { simple: true });
const counts = {};
for (const table of tables) {
  try {
    counts[table] = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
  } catch {
    // Older databases do not have every table; only compare what existed.
  }
}
const present = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);
fs.writeFileSync(
  outPath,
  JSON.stringify({ path: dbPath, integrity, counts, tables: present }, null, 2),
);
db.close();
NODE
  )
}

compare_db_not_lower() {
  local before="$1"
  local after="$2"
  node -e '
    const fs = require("node:fs");
    const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (after.integrity !== "ok") {
      console.error(`integrity after=${after.integrity}`);
      process.exit(1);
    }
    for (const [table, count] of Object.entries(before.counts)) {
      const now = after.counts[table];
      if (now === undefined || now < count) {
        console.error(`table ${table}: before=${count} after=${now ?? "missing"}`);
        process.exit(1);
      }
    }
  ' "$before" "$after"
}

collect_unit_env() {
  local text=""
  if unit_loaded "$UNIT" || [[ -f "$HOME/.config/systemd/user/$UNIT.service" ]]; then
    text+="$(systemctl --user show "$UNIT" -p Environment --value 2>/dev/null || true)"$'\n'
  fi
  if [[ -f "$HOME/.config/systemd/user/$UNIT.service" ]]; then
    text+="$(cat "$HOME/.config/systemd/user/$UNIT.service")"$'\n'
  fi
  if [[ -d "$HOME/.config/systemd/user/$UNIT.service.d" ]]; then
    local file
    for file in "$HOME/.config/systemd/user/$UNIT.service.d"/*.conf; do
      [[ -f "$file" ]] && text+="$(cat "$file")"$'\n'
    done
  fi
  printf '%s' "$text"
}

detect_service_settings() {
  local text raw
  text="$(collect_unit_env)"
  text="$(printf '%s\n' "$text" | sed 's/^[[:space:]]*#.*$//')"

  raw="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_PORT=[0-9]+' | tail -1 | cut -d= -f2 || true)"
  PORT="${raw:-7391}"
  raw="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_HOST=[^[:space:]]+' | tail -1 | cut -d= -f2- || true)"
  HOST="${raw:-127.0.0.1}"

  raw="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_DB=[^[:space:]]+' | tail -1 | cut -d= -f2- || true)"
  raw="${raw//%h/$HOME}"
  DB="$(normalize_path "${raw:-$CLONE/agent-process-segments.sqlite}")"
  raw="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_DATA_DIR=[^[:space:]]+' | tail -1 | cut -d= -f2- || true)"
  raw="${raw//%h/$HOME}"
  DATA_DIR="$(normalize_path "${raw:-$HOME/.agent-process-segments}")"
  raw="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_WEB_DIR=[^[:space:]]+' | tail -1 | cut -d= -f2- || true)"
  raw="${raw//%h/$HOME}"
  WEB_DIR="$(normalize_path "${raw:-$CLONE/src/web/dist}")"
}

check_preflight() {
  require_cmd bash
  require_cmd git
  require_cmd node
  require_cmd npm
  require_cmd curl
  require_cmd systemctl
  require_cmd systemd-run
  require_cmd sha256sum
  require_cmd find
  require_cmd stat
  require_cmd cmp
  require_cmd journalctl

  systemctl --user show-environment >/dev/null 2>&1 \
    || die "systemd user manager is not available"

  warn_if_cutover_root_permissive

  unit_loaded "$UNIT" || refuse "$UNIT is not installed as a systemd user unit"
  unit_active "$UNIT" || refuse "$UNIT is not active; start it before upgrading"

  local unit_dir raw_unit_dir
  raw_unit_dir="$(unit_prop WorkingDirectory)"
  unit_dir=""
  if [[ -n "$raw_unit_dir" ]]; then
    unit_dir="$(normalize_path "$raw_unit_dir")"
  fi
  if [[ -n "$CLONE_ARG" ]]; then
    CLONE="$(normalize_path "$CLONE_ARG")"
    if [[ -n "$unit_dir" && "$unit_dir" != "/" && "$CLONE" != "$unit_dir" ]]; then
      refuse "--clone $CLONE is not the live deployment; $UNIT runs from $unit_dir"
    fi
  else
    CLONE="$unit_dir"
  fi
  [[ -n "$CLONE" && "$CLONE" != "/" ]] || refuse "could not resolve the live clone from $UNIT"
  [[ -d "$CLONE" ]] || refuse "live clone does not exist: $CLONE"

  git -C "$CLONE" rev-parse --git-dir >/dev/null 2>&1 \
    || refuse "$CLONE is not a git clone"

  local current_branch dirty
  current_branch="$(git -C "$CLONE" branch --show-current)"
  [[ "$current_branch" == "$BRANCH" ]] \
    || refuse "clone is on branch '$current_branch', expected '$BRANCH'"
  dirty="$(git -C "$CLONE" status --porcelain)"
  if [[ -n "$dirty" ]]; then
    printf '%s\n' "$dirty" | head -5 >&2
    refuse "clone has uncommitted changes; reconcile them in $CLONE first"
  fi

  log "fetching origin for $CLONE"
  git -C "$CLONE" fetch --prune origin \
    || die "git fetch failed in $CLONE; check the remote and network"

  OLD_SHA="$(git -C "$CLONE" rev-parse HEAD)"
  if [[ -n "$TO" ]]; then
    TARGET="$(git -C "$CLONE" rev-parse --verify "$TO^{commit}" 2>/dev/null || true)"
    [[ -n "$TARGET" ]] || refuse "unknown --to ref: $TO"
    git -C "$CLONE" merge-base --is-ancestor "$TARGET" "origin/$BRANCH" \
      || refuse "--to $TO is not on origin/$BRANCH"
  else
    TARGET="$(git -C "$CLONE" rev-parse --verify "origin/$BRANCH^{commit}" 2>/dev/null || true)"
    [[ -n "$TARGET" ]] || refuse "cannot resolve origin/$BRANCH in $CLONE"
  fi
  BEHIND="$(git -C "$CLONE" rev-list --count "$OLD_SHA..$TARGET")"

  git -C "$CLONE" merge-base --is-ancestor "$OLD_SHA" "$TARGET" \
    || refuse "not a fast-forward: $CLONE has commits that are not in $BRANCH; rebase or reset it manually"

  if ! git -C "$CLONE" diff --quiet "$OLD_SHA" "$TARGET" -- deploy/agent-process-segments.service; then
    refuse "deploy/agent-process-segments.service changed in the target; install the unit deliberately (see deploy/vps.md)"
  fi

  NPM_CI=0
  NPM_CI_REASON="package-lock.json and workspace package.json files are unchanged"
  if ! git -C "$CLONE" diff --quiet "$OLD_SHA" "$TARGET" -- package-lock.json 'src/*/package.json'; then
    NPM_CI=1
    NPM_CI_REASON="package-lock.json or a workspace package.json changed"
  fi

  detect_service_settings
  [[ -f "$DB" ]] || refuse "database not found at $DB"

  local health
  health="$(http_status /health)"
  [[ "$health" == "200" ]] \
    || refuse "$UNIT is active but /health returned $health at $(api_url /health)"

  HARNESS_BEFORE="$(models_harness)"
}

plan() {
  local master
  master="$(api_get /api/config | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        process.stdout.write(String(JSON.parse(body).master?.enabled ?? ""));
      } catch {
        // The plan is informational; an unreadable config prints no value.
      }
    });
  ' || true)"

  log "plan: clone      $CLONE"
  log "plan: unit       $UNIT"
  log "plan: branch     $BRANCH"
  log "plan: old HEAD   $(short_sha "$OLD_SHA")"
  log "plan: target     $(short_sha "$TARGET") ($BEHIND commit(s) ahead)"
  log "plan: database   $DB"
  log "plan: data       $DATA_DIR"
  log "plan: web        $WEB_DIR"
  log "plan: harness    ${HARNESS_BEFORE:-unknown}"
  if [[ "$NPM_CI" -eq 1 ]]; then
    log "plan: would run npm ci --include=dev ($NPM_CI_REASON)"
  else
    log "plan: would reuse node_modules ($NPM_CI_REASON)"
  fi
  log "plan: would pause master.enabled=${master:-unknown} and drain working turns"
  log "plan: would capture the database snapshot, dist trees, and node_modules"
  log "plan: would fast-forward the clone to $(short_sha "$TARGET")"
  log "plan: would run npm run build"
  log "plan: would restart $UNIT and verify health, build, database, and harness"
  log "plan: would restore master.enabled"
  if [[ "$NO_PRUNE" -eq 1 ]]; then
    log "plan: would skip pruning upgrade runs (--no-prune)"
  else
    local pruner preview status
    pruner="$(check_pruner)" || exit 2
    log "plan: would prune upgrade runs (--keep-runs $KEEP_RUNS --keep-days $KEEP_DAYS)"
    if preview="$(node "$pruner" --kind upgrade --root "$CUTOVER_ROOT" \
      --keep-runs "$KEEP_RUNS" --keep-days "$KEEP_DAYS" --dry-run 2>&1)"; then
      status=0
    else
      status=$?
    fi
    if [[ -n "$preview" ]]; then
      printf '%s\n' "$preview"
    fi
    if (( status != 0 )); then
      log "plan: WARNING: prune preview failed (exit $status)"
    fi
  fi
  log "dry run complete; nothing was changed"
}

detach_upgrade() {
  local pruner=""
  if [[ "$NO_PRUNE" -eq 0 ]]; then
    pruner="$(check_pruner)" || exit 2
  fi
  RUN_DIR="$UPGRADE_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
  prepare_run_dir "$RUN_DIR"
  cp "$ORIGINAL_SCRIPT" "$RUN_DIR/upgrade.sh"
  chmod +x "$RUN_DIR/upgrade.sh"
  if [[ -n "$pruner" ]]; then
    cp "$pruner" "$RUN_DIR/prune-cutover-runs.mjs"
  fi
  touch "$RUN_DIR/upgrade.log"
  write_state launched
  ln -sfn "$RUN_DIR" "$UPGRADE_ROOT/latest"
  log "launching detached upgrade in $RUN_DIR"

  local unit
  unit="aps-upgrade-$(date +%s)"
  local args=(--run --run-dir "$RUN_DIR" --home "$HOME" --clone "$CLONE" \
    --unit "$UNIT" --branch "$BRANCH" --wait-seconds "$WAIT_SECONDS" \
    --health-timeout "$HEALTH_TIMEOUT")
  [[ -n "$TO" ]] && args+=(--to "$TO")
  [[ -n "$REQUEST_ID" ]] && args+=(--request-id "$REQUEST_ID")
  [[ "$ALLOW_BUSY" -eq 1 ]] && args+=(--allow-busy)
  if [[ "$NO_PRUNE" -eq 1 ]]; then
    args+=(--no-prune)
  else
    args+=(--keep-runs "$KEEP_RUNS" --keep-days "$KEEP_DAYS")
  fi

  if ! systemd-run --user --unit="$unit" --collect --property=Type=oneshot \
    --setenv=HOME="$HOME" --setenv=PATH="$PATH" \
    --setenv=XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
    --working-directory="$HOME" \
    /bin/bash "$RUN_DIR/upgrade.sh" "${args[@]}"; then
    if [[ "$(cat "$RUN_DIR/state" 2>/dev/null || true)" == "launched" ]]; then
      write_state failed
      retention_after failed || true
    fi
    log "ERROR: the detached upgrade did not complete; read $RUN_DIR/upgrade.log"
    exit 1
  fi

  log "detached unit: $unit"
  log "follow: journalctl --user -u $unit -f"
  log "state:  $RUN_DIR/state"
  log "log:    $RUN_DIR/upgrade.log"
  ln -sfn "$RUN_DIR" "$UPGRADE_ROOT/latest"
}

capture_config() {
  api_get /api/config >"$RUN_DIR/config-before.json"
  MASTER_ENABLED="$(json_get "$RUN_DIR/config-before.json" master.enabled)"
  [[ "$MASTER_ENABLED" == "true" || "$MASTER_ENABLED" == "false" ]] \
    || die "could not read master.enabled from /api/config"
}

pause_and_drain() {
  if [[ -n "$REQUEST_ID" ]]; then
    api_get "/api/requests/$REQUEST_ID" >/dev/null \
      || die "request $REQUEST_ID not found at $(api_url "/api/requests/$REQUEST_ID")"
  fi

  api_patch_config '{"master":{"enabled":false}}'
  PAUSED=1
  log "master paused; waiting for active turns to drain"

  if [[ "$ALLOW_BUSY" -eq 1 ]]; then
    log "WARNING: --allow-busy is set; active turns may be interrupted"
    return 0
  fi

  local deadline=$((SECONDS + WAIT_SECONDS))
  local working=999
  while (( SECONDS < deadline )); do
    working="$(count_working)" || die "could not read /api/requests while draining"
    if [[ "$working" == "0" ]]; then
      sleep 2
      working="$(count_working)" || die "could not re-read /api/requests while draining"
      [[ "$working" == "0" ]] && break
    fi
    sleep 2
  done
  [[ "$working" == "0" ]] || die "timed out waiting for $working working turn(s) to drain"
  log "all active turns drained"
}

backup_db() {
  local dest="$RUN_DIR/db-backup.sqlite"
  rm -f "$dest"
  (
    cd "$CLONE"
    umask 077
    node - "$DB" "$dest" <<'NODE'
const Database = require('better-sqlite3');
const [dbPath, dest] = process.argv.slice(2);
const db = new Database(dbPath, { fileMustExist: true });
db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
db.close();
NODE
  )
  [[ -s "$dest" ]] || die "database snapshot was not written: $dest"
  chmod 600 "$dest"
  log "database snapshot: $dest"
}

backup_dist() {
  SERVER_DIST_BACKED_UP=0
  WEB_DIST_BACKED_UP=0
  mkdir -p "$RUN_DIR/dist-backup"
  if [[ -d "$CLONE/src/server/dist" ]]; then
    cp -a "$CLONE/src/server/dist" "$RUN_DIR/dist-backup/server"
    SERVER_DIST_BACKED_UP=1
  fi
  if [[ -d "$CLONE/src/web/dist" ]]; then
    cp -a "$CLONE/src/web/dist" "$RUN_DIR/dist-backup/web"
    WEB_DIST_BACKED_UP=1
  fi
}

restore_dist() {
  if [[ "$SERVER_DIST_BACKED_UP" -eq 1 ]]; then
    rm -rf "$CLONE/src/server/dist"
    cp -a "$RUN_DIR/dist-backup/server" "$CLONE/src/server/dist"
  else
    rm -rf "$CLONE/src/server/dist"
  fi
  if [[ "$WEB_DIST_BACKED_UP" -eq 1 ]]; then
    rm -rf "$CLONE/src/web/dist"
    cp -a "$RUN_DIR/dist-backup/web" "$CLONE/src/web/dist"
  else
    rm -rf "$CLONE/src/web/dist"
  fi
}

backup_node_modules() {
  NODE_MODULES_BACKED_UP=0
  [[ "$NPM_CI" -eq 1 ]] || return 0
  [[ -d "$CLONE/node_modules" ]] || return 0
  rm -rf "$RUN_DIR/node_modules.bak"
  cp -al "$CLONE/node_modules" "$RUN_DIR/node_modules.bak" 2>/dev/null \
    || cp -a "$CLONE/node_modules" "$RUN_DIR/node_modules.bak"
  NODE_MODULES_BACKED_UP=1
  log "node_modules snapshot: $RUN_DIR/node_modules.bak"
}

restore_node_modules() {
  [[ "$NODE_MODULES_BACKED_UP" -eq 1 ]] || return 0
  rm -rf "$CLONE/node_modules"
  cp -al "$RUN_DIR/node_modules.bak" "$CLONE/node_modules" 2>/dev/null \
    || cp -a "$RUN_DIR/node_modules.bak" "$CLONE/node_modules"
}

capture_state() {
  local out="$1" phase="$2"
  SNAP_OUT="$out" \
  SNAP_PHASE="$phase" \
  SNAP_CLONE="$CLONE" \
  SNAP_UNIT="$UNIT" \
  SNAP_BRANCH="$BRANCH" \
  SNAP_OLD_SHA="$OLD_SHA" \
  SNAP_TARGET="$TARGET" \
  SNAP_BEHIND="$BEHIND" \
  SNAP_NPM_CI="$NPM_CI" \
  SNAP_NPM_CI_REASON="$NPM_CI_REASON" \
  SNAP_MASTER="$MASTER_ENABLED" \
  SNAP_HEAD="$(git -C "$CLONE" rev-parse HEAD)" \
  SNAP_UNIT_ENV="$(unit_prop Environment)" \
  SNAP_ACTIVE_ENTERED="$(unit_prop ActiveEnterTimestamp)" \
  SNAP_MAIN_PID="$(unit_prop MainPID)" \
  SNAP_HEALTH="$(http_status /health)" \
  SNAP_NOTIFICATIONS="$(http_status /api/notifications/status)" \
  SNAP_HARNESS="$(models_harness)" \
  SNAP_REQUEST_DIRS="$REQUEST_DIRS" \
  node - <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const env = process.env;
const runDir = path.dirname(env.SNAP_OUT);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const sha = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

const clone = env.SNAP_CLONE;
const dbFile = path.join(runDir, env.SNAP_PHASE === 'before' ? 'db-before.json' : 'db-after.json');
const db = readJson(dbFile);

fs.writeFileSync(
  env.SNAP_OUT,
  JSON.stringify(
    {
      phase: env.SNAP_PHASE,
      recordedAt: new Date().toISOString(),
      clone,
      unit: env.SNAP_UNIT,
      branch: env.SNAP_BRANCH,
      oldSha: env.SNAP_OLD_SHA,
      target: env.SNAP_TARGET,
      commitsAhead: Number(env.SNAP_BEHIND),
      head: env.SNAP_HEAD,
      npmCi: env.SNAP_NPM_CI === '1',
      npmCiReason: env.SNAP_NPM_CI_REASON,
      masterEnabledBefore: env.SNAP_MASTER === 'true',
      unitEnvironment: env.SNAP_UNIT_ENV,
      activeEnteredTimestamp: env.SNAP_ACTIVE_ENTERED,
      mainPid: env.SNAP_MAIN_PID,
      dist: {
        server: sha(path.join(clone, 'src/server/dist/app.js')),
        web: sha(path.join(clone, 'src/web/dist/index.html')),
      },
      http: {
        health: env.SNAP_HEALTH,
        notificationsStatus: env.SNAP_NOTIFICATIONS,
      },
      modelsHarness: env.SNAP_HARNESS || null,
      requestDirs: Number(env.SNAP_REQUEST_DIRS),
      dbIntegrity: db ? db.integrity : null,
      dbCounts: db ? db.counts : null,
    },
    null,
    2,
  ),
);
NODE
}

capture_before() {
  inspect_db "$DB" "$RUN_DIR/db-before.json" "$CLONE"
  backup_db
  backup_dist
  REQUEST_DIRS="$(request_dir_count "$DATA_DIR")"
  capture_state "$RUN_DIR/before.json" before
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    if [[ "$(http_status /health)" == "200" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

upgrade_clone() {
  log "fast-forwarding to $(short_sha "$TARGET") ($BEHIND commit(s))"
  git -C "$CLONE" merge --ff-only "$TARGET" >>"$RUN_DIR/upgrade.log" 2>&1
  MERGED=1

  local head
  head="$(git -C "$CLONE" rev-parse HEAD)"
  [[ "$head" == "$TARGET" ]] \
    || die "HEAD is $(short_sha "$head") after the fast-forward, expected $(short_sha "$TARGET")"
  log "clone is now at $(short_sha "$head")"

  backup_node_modules
  if [[ "$NPM_CI" -eq 1 ]]; then
    log "installing dependencies: npm ci --include=dev ($NPM_CI_REASON)"
    ( cd "$CLONE" && npm ci --include=dev ) >>"$RUN_DIR/upgrade.log" 2>&1
  else
    log "reusing node_modules ($NPM_CI_REASON)"
  fi

  log "building"
  ( cd "$CLONE" && npm run build ) >>"$RUN_DIR/upgrade.log" 2>&1
  log "build finished"
}

verify_live() {
  unit_active "$UNIT" || die "$UNIT is not active after the restart"
  wait_for_health || die "$UNIT did not become healthy after the restart"

  local head
  head="$(git -C "$CLONE" rev-parse HEAD)"
  [[ "$head" == "$TARGET" ]] \
    || die "HEAD is $(short_sha "$head") after the restart, expected $(short_sha "$TARGET")"

  local cwd
  cwd="$(main_process_cwd)"
  if [[ -n "$cwd" ]]; then
    [[ "$cwd" == "$CLONE" ]] \
      || die "main process cwd is '$cwd', expected '$CLONE'"
  else
    log "WARNING: could not read the main process cwd; skipping that check"
  fi

  local entered entered_epoch
  entered="$(unit_prop ActiveEnterTimestamp)"
  entered_epoch="$(date -d "$entered" +%s 2>/dev/null || true)"
  if [[ -n "$entered_epoch" ]]; then
    (( entered_epoch >= RESTART_EPOCH )) \
      || die "$UNIT ActiveEnterTimestamp ($entered) predates this upgrade's restart"
  else
    log "WARNING: could not parse ActiveEnterTimestamp '$entered'; skipping that check"
  fi

  if git -C "$CLONE" grep -q "'/api/notifications/status'" "$TARGET" -- src/server/src/http/server.ts; then
    local notifications
    notifications="$(http_status /api/notifications/status)"
    [[ "$notifications" == "200" ]] \
      || die "/api/notifications/status returned $notifications; the new build is not serving"
    log "new-code probe passed: /api/notifications/status 200"
  else
    log "target has no /api/notifications/status route; skipping the new-code probe"
  fi

  local harness
  harness="$(models_harness)"
  if [[ -n "$HARNESS_BEFORE" ]]; then
    [[ "$harness" == "$HARNESS_BEFORE" ]] \
      || die "/api/models harness is '${harness:-missing}', expected '$HARNESS_BEFORE'"
  fi

  inspect_db "$DB" "$RUN_DIR/db-after.json" "$CLONE"
  compare_db_not_lower "$RUN_DIR/db-before.json" "$RUN_DIR/db-after.json"

  local request_dirs
  request_dirs="$(request_dir_count "$DATA_DIR")"
  (( request_dirs >= REQUEST_DIRS )) \
    || die "request directory count dropped from $REQUEST_DIRS to $request_dirs"

  if command -v journalctl >/dev/null 2>&1 \
    && journalctl --user -u "$UNIT" --since "$RESTART_MARKER" --no-pager \
      >"$RUN_DIR/journal-after.txt" 2>/dev/null; then
    if grep -q 'legacy SBOX_' "$RUN_DIR/journal-after.txt"; then
      die "$UNIT logged a legacy SBOX_* warning after the restart"
    fi
  else
    log "WARNING: could not read the journal for the new start; skipping the SBOX_* check"
  fi

  capture_state "$RUN_DIR/after.json" after
  log "live verification passed"
}

restore_master() {
  if [[ "$PAUSED" -ne 1 ]]; then
    return 0
  fi
  api_patch_config "{\"master\":{\"enabled\":${MASTER_ENABLED}}}"
  api_get /api/config >"$RUN_DIR/config-after.json"
  json_equal_without_path "$RUN_DIR/config-before.json" "$RUN_DIR/config-after.json" \
    || die "restored config does not match the pre-upgrade config"
  PAUSED=0
  log "master.enabled restored to $MASTER_ENABLED"
}

rollback() {
  if [[ "$ROLLED_BACK" -eq 1 ]]; then
    return 0
  fi
  ROLLED_BACK=1
  local phase="failed"
  set +e
  log "rolling back"

  if [[ "$RESTARTED" -eq 1 ]]; then
    git -C "$CLONE" reset --hard "$OLD_SHA" >>"$RUN_DIR/upgrade.log" 2>&1
    restore_node_modules
    restore_dist
    log "restarting $UNIT on $(short_sha "$OLD_SHA")"
    systemctl --user restart "$UNIT"
    if wait_for_health; then
      log "rolled back; $UNIT is healthy again on $(short_sha "$OLD_SHA")"
      restore_master
      write_state rolled_back
      phase="rolled_back"
    else
      log "ERROR: $UNIT did not become healthy after the rollback"
      write_state failed
    fi
  else
    if [[ "$MERGED" -eq 1 ]]; then
      git -C "$CLONE" reset --hard "$OLD_SHA" >>"$RUN_DIR/upgrade.log" 2>&1
      restore_node_modules
      restore_dist
      log "restored $CLONE to $(short_sha "$OLD_SHA") before restarting anything"
    fi
    restore_master
    write_state failed
  fi

  if [[ -d "$RUN_DIR" ]]; then
    log "backups kept in $RUN_DIR"
    if [[ -f "$RUN_DIR/db-backup.sqlite" ]]; then
      log "database snapshot: $RUN_DIR/db-backup.sqlite"
      log "to restore it manually: systemctl --user stop $UNIT && cp \"$RUN_DIR/db-backup.sqlite\" \"$DB\" && systemctl --user start $UNIT"
      log "migrations are additive, so the previous build can usually read the upgraded database without a restore"
    fi
  fi
  retention_after "$phase"
  set -e
}

on_error() {
  local rc=$?
  local line="$1"
  # set -E inherits this trap into subshells. Only the top-level shell rolls back;
  # a subshell exits with the failing status so the parent's trap runs once.
  if [[ "${BASH_SUBSHELL:-0}" -gt 0 ]]; then
    exit "$rc"
  fi
  set +e
  log "failed at line $line (exit $rc)"
  rollback
  exit "$rc"
}

on_signal() {
  local signal="$1"
  log "received $signal"
  rollback
  exit 130
}

run_upgrade() {
  if [[ "$NO_PRUNE" -eq 0 ]]; then
    check_pruner >/dev/null || exit 2
  fi
  prepare_run_dir "$RUN_DIR"
  touch "$RUN_DIR/upgrade.log"
  write_state running
  log "starting upgrade run in $RUN_DIR"

  trap 'on_error $LINENO' ERR
  trap 'on_signal INT' INT
  trap 'on_signal TERM' TERM

  check_preflight
  if [[ "$OLD_SHA" == "$TARGET" ]]; then
    log "already up to date: $CLONE is at $(short_sha "$TARGET") ($BRANCH)"
    write_state success
    ln -sfn "$RUN_DIR" "$UPGRADE_ROOT/latest"
    retention_after success
    return 0
  fi

  capture_config
  pause_and_drain
  capture_before
  upgrade_clone

  log "restarting $UNIT"
  RESTART_MARKER="$(date -u +%FT%TZ)"
  RESTART_EPOCH="$(date +%s)"
  systemctl --user restart "$UNIT"
  RESTARTED=1

  verify_live
  restore_master
  rm -rf "$RUN_DIR/node_modules.bak"
  write_state success
  retention_after success
  log "upgrade finished; state success"
  log "verify: systemctl --user is-active $UNIT && curl -fsS $(api_url /health)"
}

read_count() {
  local flag="$1" value="$2" parsed
  if [[ ! "$value" =~ ^[0-9]{1,6}$ ]]; then
    printf '%s needs a non-negative integer (maximum 100000)\n' "$flag" >&2
    exit 2
  fi
  parsed=$((10#$value))
  if (( parsed > 100000 )); then
    printf '%s must be at most 100000\n' "$flag" >&2
    exit 2
  fi
  printf '%s' "$parsed"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --detach) DETACH=1; shift ;;
    --request-id) REQUEST_ID="$2"; shift 2 ;;
    --home) HOME_ARG="$2"; shift 2 ;;
    --clone) CLONE_ARG="$2"; shift 2 ;;
    --unit) UNIT="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --wait-seconds) WAIT_SECONDS="$2"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT="$2"; shift 2 ;;
    --allow-busy) ALLOW_BUSY=1; shift ;;
    --keep-runs)
      [[ $# -ge 2 ]] || { printf '%s\n' '--keep-runs needs a value' >&2; exit 2; }
      KEEP_RUNS="$(read_count --keep-runs "$2")"
      shift 2 ;;
    --keep-days)
      [[ $# -ge 2 ]] || { printf '%s\n' '--keep-days needs a value' >&2; exit 2; }
      KEEP_DAYS="$(read_count --keep-days "$2")"
      shift 2 ;;
    --no-prune) NO_PRUNE=1; shift ;;
    --run) INTERNAL_RUN=1; shift ;;
    --run-dir) RUN_DIR_ARG="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

HOME="$(normalize_path "$HOME_ARG")"
export HOME
CUTOVER_ROOT="$HOME/.aps-cutover"
UPGRADE_ROOT="$CUTOVER_ROOT/upgrades"

if [[ "$DRY_RUN" -eq 1 && "$DETACH" -eq 1 ]]; then
  printf '%s\n' '--dry-run and --detach cannot be combined' >&2
  exit 2
fi
if [[ "$INTERNAL_RUN" -eq 1 ]]; then
  [[ -n "$RUN_DIR_ARG" ]] || { printf '%s\n' '--run needs --run-dir' >&2; exit 2; }
  RUN_DIR="$(normalize_path "$RUN_DIR_ARG")"
else
  RUN_DIR=""
fi

if [[ "$INTERNAL_RUN" -eq 1 ]]; then
  run_upgrade
  exit 0
fi

check_preflight

if [[ "$OLD_SHA" == "$TARGET" ]]; then
  log "already up to date: $CLONE is at $(short_sha "$TARGET") ($BRANCH)"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  plan
  exit 0
fi

if [[ "$DETACH" -eq 1 ]]; then
  detach_upgrade
  exit 0
fi

printf '%s\n' "Refusing to restart $UNIT without --detach or --dry-run." >&2
printf '%s\n' "Run --dry-run first, then --detach; see deploy/vps.md." >&2
exit 2
