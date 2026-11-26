#!/usr/bin/env bash
# Cut a live, self-hosted Agent Process Segments brain over from the legacy
# Sandbox Harness unit, clone, and paths to the APS names.
#
# The script is intentionally conservative: it refuses to move when both the old
# and new locations exist, it never overwrites a destination, and it keeps a
# rollback copy of the systemd unit and drop-ins. Running it from inside the
# brain unit requires --detach, because stopping that unit kills its cgroup.
#
# Usage:
#   deploy/cutover-vps.sh --dry-run
#   deploy/cutover-vps.sh --detach --request-id <request-id>
#
# Run --help for every option.

set -Eeuo pipefail

ORIGINAL_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

HOME_ARG="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
OLD_CLONE=""
NEW_CLONE=""
REQUEST_ID=""
WAIT_SECONDS=1800
DRY_RUN=0
DETACH=0
ALLOW_BUSY=0
INTERNAL_RUN=0
RUN_DIR_ARG=""
KEEP_RUNS=10
KEEP_DAYS=30
NO_PRUNE=0

OLD_UNIT="sandbox-harness"
NEW_UNIT="agent-process-segments"
DEFAULT_BRANCH="main"

usage() {
  cat <<'EOF'
Usage: deploy/cutover-vps.sh [options]

Moves a live Sandbox Harness install to the Agent Process Segments unit and
paths. Run --dry-run first. Use --detach when the caller is inside the live
brain unit; the detached run survives the unit stop.

Options:
  --dry-run             Print the plan and change nothing.
  --detach              Copy this script to a stable run directory and launch it
                        in a transient systemd user unit. Required from inside
                        the brain service.
  --request-id ID       Request to associate with the cutover. It is used to
                        confirm the request exists; the script drains all
                        working turns, not only this one.
  --home DIR            Home directory that owns the clone and XDG paths.
  --old-clone DIR       Legacy clone directory. Defaults to ~/AgentProcessSegments
                        when it exists, otherwise ~/sandbox-harness.
  --new-clone DIR       New clone directory. Defaults to ~/agent-process-segments.
  --wait-seconds N      Maximum seconds to wait for active turns to drain
                        (default 1800). Zero means fail immediately if busy.
  --allow-busy          Do not wait for active turns. This kills in-flight work;
                        use only when the operator accepts that.
  --keep-runs N         Keep the N newest cutover run directories (default 10).
  --keep-days D         Keep run directories modified within D days (default 30).
                        Zero disables the age rule.
  --no-prune            Do not prune older run directories before or after the
                        cutover. Use this when you schedule `npm run prune:cutover`
                        yourself.
  --help                Show this help.

A real cutover prunes older run directories under ~/.aps-cutover/runs before it
starts and after it writes a terminal state, keeping the current run and the
`latest` target. Use --keep-runs/--keep-days to tune it or --no-prune to opt out.

The run writes ~/.aps-cutover/runs/<UTC>/ with cutover.log, before.json,
after.json, config-before.json, state, and a backup of the old systemd unit.
EOF
}

log() {
  local line
  line="$(date -u +%FT%TZ) $*"
  printf '%s\n' "$line"
  if [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]]; then
    printf '%s\n' "$line" >>"$RUN_DIR/cutover.log"
  fi
}

die() {
  log "ERROR: $*"
  return 1
}

write_state() {
  if [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]]; then
    printf '%s\n' "$1" >"$RUN_DIR/state"
  fi
}

pruner_path() {
  local clone
  if [[ -n "${NEW_CLONE:-}" && -d "${NEW_CLONE:-}" ]]; then
    clone="$NEW_CLONE"
  else
    clone="$OLD_CLONE"
  fi
  printf '%s' "$clone/scripts/prune-cutover-runs.mjs"
}

check_pruner() {
  local pruner
  pruner="$(pruner_path)"
  if [[ ! -f "$pruner" ]]; then
    printf 'cutover pruner not found: %s; pull the clone or pass --no-prune\n' "$pruner" >&2
    log "ERROR: cutover pruner not found: $pruner; pull the clone or pass --no-prune"
    return 1
  fi
  printf '%s' "$pruner"
}

point_latest() {
  [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]] || return 0
  mkdir -p "$RUN_ROOT" || {
    log "WARNING: could not create $RUN_ROOT; leaving $RUN_ROOT/latest unchanged"
    return 1
  }
  ln -sfn "$RUN_DIR" "$RUN_ROOT/latest" || {
    log "WARNING: could not point $RUN_ROOT/latest at $RUN_DIR"
    return 1
  }
  return 0
}

post_run_prune() {
  local phase="$1"
  [[ -n "${RUN_DIR:-}" && -d "$RUN_DIR" ]] || return 0
  point_latest || return 0
  if [[ "$NO_PRUNE" -eq 1 ]]; then
    log "pruning skipped (--no-prune)"
    return 0
  fi
  local pruner
  pruner="$(pruner_path)"
  if [[ ! -f "$pruner" ]]; then
    log "WARNING: cutover pruner not found: $pruner; skipping post-$phase prune"
    return 0
  fi
  local output status
  if output="$(node "$pruner" --root "$RUN_ROOT" --keep-runs "$KEEP_RUNS" --keep-days "$KEEP_DAYS" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  log "prune $phase (--keep-runs $KEEP_RUNS --keep-days $KEEP_DAYS)"
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output" >>"$RUN_DIR/cutover.log"
    printf '%s\n' "$output"
  fi
  if (( status != 0 )); then
    log "WARNING: prune $phase failed (exit $status); older run directories may remain"
  fi
  return 0
}

pre_launch_prune() {
  local buffer="$1"
  if [[ "$NO_PRUNE" -eq 1 ]]; then
    return 0
  fi
  local pruner output status
  pruner="$(check_pruner)" || exit 2
  if output="$(node "$pruner" --root "$RUN_ROOT" --keep-runs "$KEEP_RUNS" --keep-days "$KEEP_DAYS" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$output" >"$buffer"
  if (( status != 0 )); then
    printf 'WARNING: prune before launch failed (exit %d)\n' "$status" >>"$buffer"
  fi
  return 0
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

normalize_path() {
  realpath -m "$1"
}

unit_active() {
  [[ "$(systemctl --user is-active "$1" 2>/dev/null || true)" == "active" ]]
}

unit_loaded() {
  systemctl --user show "$1" -p LoadState --value 2>/dev/null | grep -qx loaded
}

api_url() {
  printf 'http://127.0.0.1:%s%s' "$PORT" "$1"
}

api_get() {
  curl -fsS --max-time 10 "$(api_url "$1")"
}

api_patch_config() {
  curl -fsS --max-time 10 -X PATCH -H 'content-type: application/json' \
    -d "$1" "$(api_url /api/config)" >/dev/null
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

compare_db_counts() {
  local before="$1"
  local after="$2"
  node -e '
    const fs = require("node:fs");
    const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (before.integrity !== "ok" || after.integrity !== "ok") {
      console.error(`integrity before=${before.integrity} after=${after.integrity}`);
      process.exit(1);
    }
    for (const [table, count] of Object.entries(before.counts)) {
      if (after.counts[table] !== count) {
        console.error(`table ${table}: before=${count} after=${after.counts[table] ?? "missing"}`);
        process.exit(1);
      }
    }
  ' "$before" "$after"
}

pair_label() {
  local label="$1" from="$2" to="$3"
  local have_from=0 have_to=0
  [[ -e "$from" ]] && have_from=1
  [[ -e "$to" ]] && have_to=1
  if [[ $have_from -eq 1 && $have_to -eq 1 ]]; then
    die "$label exists at both $from and $to; refusing to split state"
  fi
  if [[ $have_from -eq 0 && $have_to -eq 0 ]]; then
    die "$label exists at neither $from nor $to; not a complete legacy install"
  fi
  if [[ $have_from -eq 0 && $have_to -eq 1 ]]; then
    die "$label was already moved to $to while other legacy paths remain; inspect manually"
  fi
}

same_device() {
  local old="$1" new_parent="$2" label="$3"
  local old_dev new_dev
  old_dev="$(stat -c '%d' "$old")"
  new_dev="$(stat -c '%d' "$new_parent")"
  [[ "$old_dev" == "$new_dev" ]] || die "$label cannot be renamed across filesystems ($old_dev != $new_dev)"
}

collect_unit_env() {
  local text=""
  if unit_loaded "$OLD_UNIT" || [[ -f "$HOME/.config/systemd/user/$OLD_UNIT.service" ]]; then
    text+="$(systemctl --user show "$OLD_UNIT" -p Environment --value 2>/dev/null || true)"$'\n'
  fi
  if [[ -f "$HOME/.config/systemd/user/$OLD_UNIT.service" ]]; then
    text+="$(cat "$HOME/.config/systemd/user/$OLD_UNIT.service")"$'\n'
  fi
  if [[ -d "$HOME/.config/systemd/user/$OLD_UNIT.service.d" ]]; then
    local file
    for file in "$HOME/.config/systemd/user/$OLD_UNIT.service.d"/*.conf; do
      [[ -f "$file" ]] && text+="$(cat "$file")"$'\n'
    done
  fi
  printf '%s' "$text"
}

detect_service_settings() {
  local text
  text="$(collect_unit_env)"
  text="$(printf '%s
' "$text" | sed 's/^[[:space:]]*#.*$//')"

  HARNESS_RAW="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_HARNESS=[^[:space:]]+' | tail -1 | cut -d= -f2- || true)"
  HARNESS_BIN_RAW="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_HARNESS_BIN=[^[:space:]]+' | tail -1 | cut -d= -f2- || true)"
  HARNESS_BIN_RAW="${HARNESS_BIN_RAW//%h/$HOME}"
  PORT="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_PORT=[0-9]+' | tail -1 | cut -d= -f2 || true)"
  PORT="${PORT:-7391}"
  HOST="$(printf '%s\n' "$text" | grep -oE '(SBOX|APS)_HOST=[^[:space:]]+' | tail -1 | cut -d= -f2- || true)"
  HOST="${HOST:-127.0.0.1}"

  local harness="${HARNESS_RAW:-claude}"
  local bin="${HARNESS_BIN_RAW:-}"
  if [[ -z "$bin" ]]; then
    if [[ "$harness" == "claude" ]]; then
      bin="$(command -v claude || true)"
    else
      bin="$(command -v "$harness" || true)"
    fi
  fi
  if [[ -z "$bin" || ! -x "$bin" ]]; then
    die "harness '$harness' has no executable (set SBOX_HARNESS_BIN/APS_HARNESS_BIN or install it)"
  fi
  HARNESS="$harness"
  HARNESS_BIN="$bin"
}

check_preflight() {
  require_cmd systemctl
  require_cmd curl
  require_cmd git
  require_cmd node
  require_cmd npm
  require_cmd sha256sum
  require_cmd cmp
  require_cmd find
  require_cmd stat

  systemctl --user show-environment >/dev/null 2>&1 || die "systemd user manager is not available"

  if [[ -n "${XDG_CONFIG_HOME:-}" && "$XDG_CONFIG_HOME" != "$HOME/.config" ]]; then
    die "XDG_CONFIG_HOME=$XDG_CONFIG_HOME is outside the supported layout"
  fi
  if [[ -n "${XDG_STATE_HOME:-}" && "$XDG_STATE_HOME" != "$HOME/.local/state" ]]; then
    die "XDG_STATE_HOME=$XDG_STATE_HOME is outside the supported layout"
  fi

  OLD_DATA="$HOME/.sandbox-harness"
  NEW_DATA="$HOME/.agent-process-segments"
  OLD_CONFIG_DIR="$HOME/.config/sandbox-harness"
  NEW_CONFIG_DIR="$HOME/.config/agent-process-segments"
  OLD_STATE_DIR="$HOME/.local/state/sandbox-harness"
  NEW_STATE_DIR="$HOME/.local/state/agent-process-segments"
  OLD_CONFIG="$OLD_CONFIG_DIR/config.json"
  NEW_CONFIG="$NEW_CONFIG_DIR/config.json"
  OLD_PROCESS="$OLD_CONFIG_DIR/process.json"
  NEW_PROCESS="$NEW_CONFIG_DIR/process.json"
  OLD_ERROR_LOG="$OLD_STATE_DIR/errors.log"
  NEW_ERROR_LOG="$NEW_STATE_DIR/errors.log"
  OLD_DB="$OLD_CLONE/sandbox-harness.sqlite"
  NEW_DB="$NEW_CLONE/agent-process-segments.sqlite"

  if [[ -e "$NEW_CLONE" && ! -e "$OLD_CLONE" ]]; then
    if [[ -e "$NEW_DATA" && -e "$NEW_CONFIG_DIR" && -e "$NEW_STATE_DIR" && -e "$NEW_DB" \
      && ! -e "$OLD_DATA" && ! -e "$OLD_CONFIG_DIR" && ! -e "$OLD_STATE_DIR" ]]; then
      ALREADY_MIGRATED=1
      return 0
    fi
    die "new clone exists but the migrated data/config/state/database set is incomplete"
  fi

  [[ -d "$OLD_CLONE" ]] || die "legacy clone not found: $OLD_CLONE"
  [[ ! -e "$NEW_CLONE" ]] || die "new clone already exists: $NEW_CLONE"
  git -C "$OLD_CLONE" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "legacy clone is not a git worktree: $OLD_CLONE"
  local branch dirty
  branch="$(git -C "$OLD_CLONE" symbolic-ref --short HEAD 2>/dev/null || true)"
  [[ "$branch" == "$DEFAULT_BRANCH" ]] || die "legacy clone is on '$branch', expected '$DEFAULT_BRANCH'"
  dirty="$(git -C "$OLD_CLONE" status --porcelain 2>/dev/null || true)"
  [[ -z "$dirty" ]] || die "legacy clone has local changes; commit or discard them first"

  [[ -f "$OLD_CLONE/deploy/agent-process-segments.service" ]] \
    || die "missing deploy/agent-process-segments.service in $OLD_CLONE (pull the runtime rename first)"
  [[ -f "$OLD_CLONE/scripts/migrate-paths.mjs" ]] \
    || die "missing scripts/migrate-paths.mjs in $OLD_CLONE (pull the runtime rename first)"

  pair_label "data directory" "$OLD_DATA" "$NEW_DATA"
  pair_label "config directory" "$OLD_CONFIG_DIR" "$NEW_CONFIG_DIR"
  pair_label "state directory" "$OLD_STATE_DIR" "$NEW_STATE_DIR"
  pair_label "database" "$OLD_DB" "$NEW_DB"

  same_device "$OLD_CLONE" "$(dirname "$NEW_CLONE")" "clone"
  same_device "$OLD_DATA" "$(dirname "$NEW_DATA")" "data directory"
  same_device "$OLD_CONFIG_DIR" "$(dirname "$NEW_CONFIG_DIR")" "config directory"
  same_device "$OLD_STATE_DIR" "$(dirname "$NEW_STATE_DIR")" "state directory"
  same_device "$OLD_DB" "$(dirname "$NEW_CLONE")" "database"

  detect_service_settings

  [[ -f "$OLD_CONFIG" ]] || die "missing $OLD_CONFIG"
  [[ -f "$OLD_PROCESS" ]] || die "missing $OLD_PROCESS"
  [[ -f "$OLD_ERROR_LOG" ]] || die "missing $OLD_ERROR_LOG"

  inspect_db "$OLD_DB" "$WORK_DIR/db-preflight.json" "$OLD_CLONE"

  if unit_active "$OLD_UNIT"; then
    OLD_ACTIVE=1
    api_get /api/config >"$WORK_DIR/config-preflight.json" \
      || die "the old unit is active but http://127.0.0.1:$PORT/api/config is unreachable"
    MASTER_ENABLED="$(json_get "$WORK_DIR/config-preflight.json" master.enabled)"
    [[ "$MASTER_ENABLED" == "true" || "$MASTER_ENABLED" == "false" ]] \
      || die "could not read master.enabled from /api/config"
  else
    OLD_ACTIVE=0
    MASTER_ENABLED="false"
  fi

  if unit_active "$NEW_UNIT"; then
    die "both $OLD_UNIT and $NEW_UNIT are active; inspect manually"
  fi
}

plan() {
  log "plan: old clone   ${OLD_CLONE}"
  log "plan: new clone   ${NEW_CLONE}"
  log "plan: old unit    ${OLD_UNIT}"
  log "plan: new unit    ${NEW_UNIT}"
  log "plan: harness     ${HARNESS} (${HARNESS_BIN})"
  log "plan: port        ${PORT}"
  log "plan: data        ${OLD_DATA} -> ${NEW_DATA}"
  log "plan: config      ${OLD_CONFIG_DIR} -> ${NEW_CONFIG_DIR}"
  log "plan: state       ${OLD_STATE_DIR} -> ${NEW_STATE_DIR}"
  log "plan: database    ${OLD_DB} -> ${NEW_DB}"
  log "plan: would pause master.enabled=${MASTER_ENABLED} and drain working turns"
  log "plan: would stop and disable ${OLD_UNIT}"
  log "plan: would capture authoritative database counts and integrity"
  log "plan: would fetch/pull ${DEFAULT_BRANCH} and run npm run build"
  log "plan: would move the clone ${OLD_CLONE} -> ${NEW_CLONE}"
  log "plan: would move data directory ${OLD_DATA} -> ${NEW_DATA}"
  log "plan: would move config directory ${OLD_CONFIG_DIR} -> ${NEW_CONFIG_DIR}"
  log "plan: would move state directory ${OLD_STATE_DIR} -> ${NEW_STATE_DIR}"
  log "plan: would move database ${OLD_DB} -> ${NEW_DB}"
  log "plan: would repair registered git worktrees"
  log "plan: would back up the old unit/drop-ins"
  log "plan: would install ${NEW_UNIT}.service and migrate the harness drop-in"
  log "plan: would start ${NEW_UNIT} and verify health, environment, database, and UI"
  log "plan: would restore master.enabled=${MASTER_ENABLED}"
  if [[ "$NO_PRUNE" -eq 1 ]]; then
    log "plan: would skip pruning (--no-prune)"
  else
    local pruner preview status
    pruner="$(check_pruner)" || exit 2
    log "plan: would prune cutover runs (--keep-runs $KEEP_RUNS --keep-days $KEEP_DAYS)"
    if preview="$(node "$pruner" --root "$RUN_ROOT" --keep-runs "$KEEP_RUNS" --keep-days "$KEEP_DAYS" --dry-run 2>&1)"; then
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
  log "plan: dry run complete; nothing was changed"
}

detach_cutover() {
  local prune_buffer="$WORK_DIR/prune-before.log"
  pre_launch_prune "$prune_buffer"

  RUN_DIR="${RUN_ROOT}/runs/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$RUN_DIR/backup/systemd"
  cp "$ORIGINAL_SCRIPT" "$RUN_DIR/cutover.sh"
  chmod +x "$RUN_DIR/cutover.sh"
  write_state launched
  if [[ "$NO_PRUNE" -eq 1 ]]; then
    log "pruning skipped (--no-prune)"
  else
    log "prune before launch (--keep-runs $KEEP_RUNS --keep-days $KEEP_DAYS)"
    if [[ -f "$prune_buffer" ]]; then
      cat "$prune_buffer" >>"$RUN_DIR/cutover.log"
      cat "$prune_buffer"
    fi
  fi
  log "launching detached cutover in $RUN_DIR"
  local unit
  unit="aps-cutover-$(date +%s)"
  local args=(--run --run-dir "$RUN_DIR" --home "$HOME" --old-clone "$OLD_CLONE" --new-clone "$NEW_CLONE" --wait-seconds "$WAIT_SECONDS")
  [[ -n "$REQUEST_ID" ]] && args+=(--request-id "$REQUEST_ID")
  [[ "$ALLOW_BUSY" -eq 1 ]] && args+=(--allow-busy)
  if [[ "$NO_PRUNE" -eq 1 ]]; then
    args+=(--no-prune)
  else
    args+=(--keep-runs "$KEEP_RUNS" --keep-days "$KEEP_DAYS")
  fi
  systemd-run --user --unit="$unit" --collect --property=Type=oneshot \
    --setenv=HOME="$HOME" --setenv=PATH="$PATH" --working-directory="$HOME" \
    /bin/bash "$RUN_DIR/cutover.sh" "${args[@]}"
  log "detached unit: $unit"
  log "follow: journalctl --user -u $unit -f"
  log "state:  $RUN_DIR/state"
  ln -sfn "$RUN_DIR" "$RUN_ROOT/latest"
}

pause_and_drain() {
  PAUSED=0
  if [[ "$OLD_ACTIVE" -ne 1 ]]; then
    log "old unit is not active; skipping master pause and drain"
    return 0
  fi
  if [[ -n "$REQUEST_ID" ]]; then
    curl -fsS --max-time 10 "$(api_url "/api/requests/$REQUEST_ID")" >/dev/null \
      || die "request $REQUEST_ID not found at http://127.0.0.1:$PORT"
  fi

  api_get /api/config >"$RUN_DIR/config-before.json"
  MASTER_ENABLED="$(json_get "$RUN_DIR/config-before.json" master.enabled)"
  [[ "$MASTER_ENABLED" == "true" || "$MASTER_ENABLED" == "false" ]] \
    || die "could not read master.enabled"
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
    if ! working="$(count_working)"; then
      die "could not read /api/requests while draining"
    fi
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

capture_before() {
  inspect_db "$OLD_DB" "$RUN_DIR/db-before.json" "$OLD_CLONE"
  cp "$OLD_ERROR_LOG" "$RUN_DIR/errors.log.before"
  CONFIG_HASH="$(sha "$OLD_CONFIG")"
  PROCESS_HASH="$(sha "$OLD_PROCESS")"
  REQUEST_DIRS="$(request_dir_count "$OLD_DATA")"
  node - "$RUN_DIR/db-before.json" "$RUN_DIR/before.json" \
    "$HEAD_SHA" "$CONFIG_HASH" "$PROCESS_HASH" "$REQUEST_DIRS" \
    "$OLD_CLONE" "$OLD_DB" "$OLD_DATA" <<'NODE'
const fs = require('node:fs');
const [dbPath, outPath, head, configHash, processHash, requestDirs, clone, db, data] =
  process.argv.slice(2);
const inspected = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      head,
      clone,
      db,
      data,
      configHash,
      processHash,
      requestDirs: Number(requestDirs),
      dbIntegrity: inspected.integrity,
      dbCounts: inspected.counts,
    },
    null,
    2,
  ),
);
NODE
}

capture_worktrees() {
  git -C "$OLD_CLONE" worktree list --porcelain \
    | awk '/^worktree /{print substr($0, 10)}' >"$RUN_DIR/worktrees.before"
}

repair_worktrees() {
  local path translated repaired=0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    translated="$path"
    if [[ "$translated" == "$OLD_CLONE/"* ]]; then
      translated="$NEW_CLONE${translated#"$OLD_CLONE"}"
    fi
    if [[ "$translated" == "$HOME/.sandbox-harness/"* ]]; then
      translated="$NEW_DATA${translated#"$HOME/.sandbox-harness"}"
    fi
    [[ "$translated" == "$NEW_CLONE" ]] && continue
    if [[ -e "$translated/.git" ]]; then
      if git -C "$NEW_CLONE" worktree repair "$translated" >>"$RUN_DIR/cutover.log" 2>&1; then
        repaired=$((repaired + 1))
      else
        log "WARNING: could not repair worktree $translated"
      fi
    fi
  done <"$RUN_DIR/worktrees.before"
  git -C "$NEW_CLONE" worktree prune >>"$RUN_DIR/cutover.log" 2>&1 || true
  log "repaired $repaired git worktree(s)"
}

backup_dist() {
  DIST_BACKED_UP=0
  if [[ -d "$OLD_CLONE/src/server/dist" || -d "$OLD_CLONE/src/web/dist" ]]; then
    install -d "$RUN_DIR/dist"
    [[ -d "$OLD_CLONE/src/server/dist" ]] && cp -a "$OLD_CLONE/src/server/dist" "$RUN_DIR/dist/server"
    [[ -d "$OLD_CLONE/src/web/dist" ]] && cp -a "$OLD_CLONE/src/web/dist" "$RUN_DIR/dist/web"
    DIST_BACKED_UP=1
  fi
}

restore_dist() {
  if [[ "$DIST_BACKED_UP" -eq 1 && "$MOVED" -eq 0 && "$STOPPED" -eq 0 ]]; then
    if [[ -d "$RUN_DIR/dist/server" ]]; then
      rm -rf "$OLD_CLONE/src/server/dist"
      cp -a "$RUN_DIR/dist/server" "$OLD_CLONE/src/server/dist"
    fi
    if [[ -d "$RUN_DIR/dist/web" ]]; then
      rm -rf "$OLD_CLONE/src/web/dist"
      cp -a "$RUN_DIR/dist/web" "$OLD_CLONE/src/web/dist"
    fi
    log "restored the pre-build dist directories"
  fi
}

backup_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  install -d "$RUN_DIR/backup/systemd"
  if [[ -f "$unit_dir/$OLD_UNIT.service" ]]; then
    cp -a "$unit_dir/$OLD_UNIT.service" "$RUN_DIR/backup/systemd/"
  fi
  if [[ -d "$unit_dir/$OLD_UNIT.service.d" ]]; then
    cp -a "$unit_dir/$OLD_UNIT.service.d" "$RUN_DIR/backup/systemd/"
  fi
  if [[ -f "$unit_dir/$NEW_UNIT.service" ]]; then
    cp -a "$unit_dir/$NEW_UNIT.service" "$RUN_DIR/backup/systemd/$NEW_UNIT.service.previous"
  fi
  if [[ -d "$unit_dir/$NEW_UNIT.service.d" ]]; then
    cp -a "$unit_dir/$NEW_UNIT.service.d" "$RUN_DIR/backup/systemd/$NEW_UNIT.service.d.previous"
  fi
}

install_unit() {
  local unit_dir="$HOME/.config/systemd/user"
  install -d "$unit_dir" "$unit_dir/$NEW_UNIT.service.d"
  cp "$NEW_CLONE/deploy/agent-process-segments.service" "$unit_dir/$NEW_UNIT.service"

  if [[ -n "$HARNESS_RAW" ]]; then
    {
      printf '[Service]\n'
      printf 'Environment=APS_HARNESS=%s\n' "$HARNESS"
      printf 'Environment=APS_HARNESS_BIN=%s\n' "$HARNESS_BIN"
    } >"$unit_dir/$NEW_UNIT.service.d/harness.conf"
  fi
  if [[ "$HOST" != "127.0.0.1" ]]; then
    printf '[Service]\nEnvironment=APS_HOST=%s\n' "$HOST" \
      >"$unit_dir/$NEW_UNIT.service.d/host.conf"
  fi
  if [[ "$PORT" != "7391" ]]; then
    printf '[Service]\nEnvironment=APS_PORT=%s\n' "$PORT" \
      >"$unit_dir/$NEW_UNIT.service.d/port.conf"
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now "$NEW_UNIT"
}

wait_for_health() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 2 "$(api_url /health)" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

verify_live() {
  unit_active "$NEW_UNIT" || die "$NEW_UNIT is not active"
  wait_for_health || die "$NEW_UNIT did not become healthy"

  local pid cwd
  pid="$(systemctl --user show "$NEW_UNIT" -p MainPID --value)"
  [[ -n "$pid" && "$pid" != "0" ]] || die "$NEW_UNIT has no main process"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$NEW_CLONE" ]] || die "main process cwd is '$cwd', expected '$NEW_CLONE'"

  local unit_env
  unit_env="$(systemctl --user show "$NEW_UNIT" -p Environment --value)"
  printf '%s' "$unit_env" | grep -q 'APS_DB=' || die "new unit has no APS_DB"
  printf '%s' "$unit_env" | grep -q 'APS_DATA_DIR=' || die "new unit has no APS_DATA_DIR"
  if printf '%s' "$unit_env" | grep -q 'SBOX_'; then
    die "new unit still exposes SBOX_* environment"
  fi

  local proc_env
  proc_env="$(tr '\0' '\n' <"/proc/$pid/environ")"
  printf '%s' "$proc_env" | grep -q 'APS_HARNESS=' || die "new process has no APS_HARNESS"
  if printf '%s' "$proc_env" | grep -q '^SBOX_'; then
    die "new process still has SBOX_* environment"
  fi

  local models harness source deadline
  deadline=$((SECONDS + 60))
  harness=""
  source=""
  while (( SECONDS < deadline )); do
    models="$(api_get /api/models)"
    harness="$(printf '%s' "$models" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(s).harness||"")))')"
    source="$(printf '%s' "$models" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(s).source||"")))')"
    [[ "$harness" == "$HARNESS" && "$source" == "probe" ]] && break
    sleep 2
  done
  [[ "$harness" == "$HARNESS" ]] || die "/api/models harness is '$harness', expected '$HARNESS'"
  [[ "$source" == "probe" ]] || die "/api/models source is '$source', expected 'probe'"

  local title
  title="$(api_get / | grep -o '<title>[^<]*</title>' | head -1 || true)"
  [[ "$title" == "<title>Agent Process Segments</title>" ]] \
    || die "unexpected UI title: ${title:-missing}"

  local request_count before_count
  request_count="$(api_get /api/requests | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(s).length)))')"
  before_count="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).dbCounts.requests))' "$RUN_DIR/before.json")"
  [[ "$request_count" == "$before_count" ]] \
    || die "request count is $request_count, expected $before_count"

  inspect_db "$NEW_DB" "$RUN_DIR/db-after.json" "$NEW_CLONE"
  compare_db_counts "$RUN_DIR/db-before.json" "$RUN_DIR/db-after.json"

  local process_hash new_request_dirs
  process_hash="$(sha "$NEW_PROCESS")"
  [[ "$process_hash" == "$PROCESS_HASH" ]] || die "process.json changed during cutover"
  new_request_dirs="$(request_dir_count "$NEW_DATA")"
  [[ "$new_request_dirs" == "$REQUEST_DIRS" ]] \
    || die "request directory count is $new_request_dirs, expected $REQUEST_DIRS"
  if [[ -f "$NEW_ERROR_LOG" ]]; then
    cmp -s -n "$(stat -c '%s' "$RUN_DIR/errors.log.before")" \
      "$RUN_DIR/errors.log.before" "$NEW_ERROR_LOG" \
      || die "errors.log lost its pre-cutover prefix"
  else
    die "errors.log is missing at $NEW_ERROR_LOG"
  fi

  if [[ -f "$RUN_DIR/config-before.json" ]]; then
    api_get /api/config >"$RUN_DIR/config-after-paused.json"
    node -e '
      const fs = require("node:fs");
      const util = require("node:util");
      const left = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const right = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      left.master = { ...left.master, enabled: false };
      right.master = { ...right.master, enabled: false };
      delete left.path;
      delete right.path;
      if (!util.isDeepStrictEqual(left, right)) {
        console.error("config trees differ after cutover");
        process.exit(1);
      }
    ' "$RUN_DIR/config-before.json" "$RUN_DIR/config-after-paused.json"
  fi

  node - "$RUN_DIR/before.json" "$RUN_DIR/db-after.json" "$RUN_DIR/after.json" \
    "$HEAD_SHA" "$harness" "$source" "$request_count" <<'NODE'
const fs = require('node:fs');
const [beforePath, dbPath, outPath, head, harness, source, requestCount] =
  process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
const afterDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      head,
      harness,
      source,
      requestCount: Number(requestCount),
      before,
      db: afterDb,
      verifiedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
NODE
  log "live verification passed"
}

restore_master() {
  if [[ "$PAUSED" -ne 1 ]]; then
    return 0
  fi
  api_patch_config "{\"master\":{\"enabled\":${MASTER_ENABLED}}}"
  api_get /api/config >"$RUN_DIR/config-after.json"
  json_equal_without_path "$RUN_DIR/config-before.json" "$RUN_DIR/config-after.json" \
    || die "restored config does not match the pre-cutover config"
  PAUSED=0
  log "master.enabled restored to $MASTER_ENABLED"
}

remove_old_unit() {
  local unit_dir="$HOME/.config/systemd/user"
  rm -f "$unit_dir/$OLD_UNIT.service"
  rm -rf "$unit_dir/$OLD_UNIT.service.d"
  rm -f "$unit_dir/default.target.wants/$OLD_UNIT.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

pick_existing() {
  if [[ -e "$1" ]]; then
    printf '%s' "$1"
  else
    printf '%s' "$2"
  fi
}

rollback() {
  set +e
  log "rolling back"
  if [[ "$NEW_STARTED" -eq 1 ]]; then
    systemctl --user stop "$NEW_UNIT" >/dev/null 2>&1 || true
    systemctl --user disable "$NEW_UNIT" >/dev/null 2>&1 || true
  fi

  local unit_dir="$HOME/.config/systemd/user"
  if [[ "$MOVED" -eq 1 || "$STOPPED" -eq 1 ]]; then
    install -d "$unit_dir/$OLD_UNIT.service.d"
    if [[ -f "$RUN_DIR/backup/systemd/$OLD_UNIT.service" ]]; then
      cp -a "$RUN_DIR/backup/systemd/$OLD_UNIT.service" "$unit_dir/$OLD_UNIT.service"
    fi
    if [[ -d "$RUN_DIR/backup/systemd/$OLD_UNIT.service.d" ]]; then
      cp -a "$RUN_DIR/backup/systemd/$OLD_UNIT.service.d/." "$unit_dir/$OLD_UNIT.service.d/"
    fi
    if [[ "$MOVED" -eq 1 ]]; then
      local rb_db rb_data rb_config rb_process rb_error
      rb_db="$(pick_existing "$NEW_DB" "$NEW_CLONE/sandbox-harness.sqlite")"
      rb_data="$(pick_existing "$NEW_DATA" "$OLD_DATA")"
      rb_config="$(pick_existing "$NEW_CONFIG" "$OLD_CONFIG")"
      rb_process="$(pick_existing "$NEW_PROCESS" "$OLD_PROCESS")"
      rb_error="$(pick_existing "$NEW_ERROR_LOG" "$OLD_ERROR_LOG")"
      {
        printf '[Service]\n'
        printf 'WorkingDirectory=%s\n' "$NEW_CLONE"
        printf 'Environment=SBOX_DB=%s\n' "$rb_db"
        printf 'Environment=SBOX_WEB_DIR=%s\n' "$NEW_CLONE/src/web/dist"
        printf 'Environment=SBOX_DOCS_DIR=%s\n' "$NEW_CLONE/docs"
        printf 'Environment=SBOX_DATA_DIR=%s\n' "$rb_data"
        printf 'Environment=SBOX_CONFIG=%s\n' "$rb_config"
        printf 'Environment=SBOX_PROCESS=%s\n' "$rb_process"
        printf 'Environment=SBOX_ERROR_LOG=%s\n' "$rb_error"
        printf 'Environment=SBOX_HARNESS=%s\n' "$HARNESS"
        printf 'Environment=SBOX_HARNESS_BIN=%s\n' "$HARNESS_BIN"
      } >"$unit_dir/$OLD_UNIT.service.d/zz-rollback.conf"
    fi
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user enable --now "$OLD_UNIT" >/dev/null 2>&1 || true
    if ! wait_for_health; then
      log "WARNING: rollback unit did not become healthy; inspect journalctl --user -u $OLD_UNIT"
    fi
    write_state rolled-back
  else
    write_state failed
  fi

  restore_dist
  if [[ "$PAUSED" -eq 1 ]]; then
    api_patch_config "{\"master\":{\"enabled\":${MASTER_ENABLED}}}" >/dev/null 2>&1 || true
  fi
  if [[ "$MOVED" -eq 1 || "$STOPPED" -eq 1 ]]; then
    post_run_prune rolled-back || true
  else
    post_run_prune failed || true
  fi
  log "rollback finished; backup: $RUN_DIR/backup"
  set -e
}

on_error() {
  local rc=$?
  local line="$1"
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

run_cutover() {
  if [[ "$NO_PRUNE" -eq 0 ]]; then
    check_pruner >/dev/null || exit 2
  fi
  mkdir -p "$RUN_DIR/backup/systemd"
  touch "$RUN_DIR/cutover.log"
  write_state running
  log "starting cutover run in $RUN_DIR"

  PAUSED=0
  STOPPED=0
  MOVED=0
  NEW_STARTED=0
  ALREADY_MIGRATED=0
  OLD_ACTIVE=0
  MASTER_ENABLED=false
  DIST_BACKED_UP=0

  trap 'on_error $LINENO' ERR
  trap 'on_signal INT' INT
  trap 'on_signal TERM' TERM

  check_preflight
  if [[ "$ALREADY_MIGRATED" -eq 1 ]]; then
    log "already migrated: $NEW_CLONE exists and the legacy paths are gone"
    if ! unit_active "$NEW_UNIT"; then
      die "paths are migrated but $NEW_UNIT is not active; inspect the previous run and start it manually"
    fi
    write_state success
    trap - ERR INT TERM
    post_run_prune success || true
    return 0
  fi

  pause_and_drain

  # Build only after the drain so no turn can spawn a half-written MCP server.
  log "fetching and building $DEFAULT_BRANCH"
  git -C "$OLD_CLONE" fetch origin --prune
  git -C "$OLD_CLONE" pull --ff-only origin "$DEFAULT_BRANCH"
  HEAD_SHA="$(git -C "$OLD_CLONE" rev-parse HEAD)"
  backup_dist
  ( cd "$OLD_CLONE" && npm run build ) >>"$RUN_DIR/cutover.log" 2>&1
  log "built $HEAD_SHA"

  capture_worktrees

  log "stopping $OLD_UNIT"
  systemctl --user stop "$OLD_UNIT"
  STOPPED=1
  local deadline=$((SECONDS + 30))
  while unit_active "$OLD_UNIT" && (( SECONDS < deadline )); do
    sleep 1
  done
  unit_active "$OLD_UNIT" && die "$OLD_UNIT did not stop"
  systemctl --user disable "$OLD_UNIT" >/dev/null 2>&1 || true
  deadline=$((SECONDS + 15))
  while curl -fsS --max-time 1 "$(api_url /health)" >/dev/null 2>&1 && (( SECONDS < deadline )); do
    sleep 1
  done
  if curl -fsS --max-time 1 "$(api_url /health)" >/dev/null 2>&1; then
    die "port $PORT is still serving after $OLD_UNIT stopped"
  fi

  capture_before
  log "moving clone $OLD_CLONE -> $NEW_CLONE"
  mv "$OLD_CLONE" "$NEW_CLONE"
  MOVED=1

  log "migrating runtime paths"
  local clean_env=(env -u SBOX_DB -u SBOX_DATA_DIR -u SBOX_CONFIG -u SBOX_PROCESS -u SBOX_ERROR_LOG -u APS_DB -u APS_DATA_DIR -u APS_CONFIG -u APS_PROCESS -u APS_ERROR_LOG)
  ( cd "$NEW_CLONE" && "${clean_env[@]}" node scripts/migrate-paths.mjs --dry-run --home "$HOME" --cwd "$NEW_CLONE" ) >>"$RUN_DIR/cutover.log" 2>&1
  ( cd "$NEW_CLONE" && "${clean_env[@]}" node scripts/migrate-paths.mjs --home "$HOME" --cwd "$NEW_CLONE" ) >>"$RUN_DIR/cutover.log" 2>&1
  log "path migration completed"

  [[ -e "$NEW_DB" && -e "$NEW_DATA" && -e "$NEW_CONFIG_DIR" && -e "$NEW_STATE_DIR" ]] \
    || die "migration did not create the expected new paths"
  [[ ! -e "$OLD_DATA" && ! -e "$OLD_CONFIG_DIR" && ! -e "$OLD_STATE_DIR" ]] \
    || die "legacy data/config/state paths still exist after migration"
  [[ ! -e "$NEW_CLONE/sandbox-harness.sqlite" ]] \
    || die "legacy database name still exists after migration"

  repair_worktrees
  backup_systemd

  log "installing $NEW_UNIT"
  NEW_STARTED=1
  install_unit
  verify_live
  restore_master

  remove_old_unit
  write_state success
  trap - ERR INT TERM
  post_run_prune success || true
  log "cutover complete; state=$RUN_DIR/state log=$RUN_DIR/cutover.log"
}

# ---- argument parsing ----------------------------------------------------

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
    --request-id)
      [[ $# -ge 2 && -n "$2" ]] || { printf '%s\n' '--request-id needs a value' >&2; exit 2; }
      REQUEST_ID="$2"; shift 2 ;;
    --home)
      [[ $# -ge 2 && -n "$2" ]] || { printf '%s\n' '--home needs a directory' >&2; exit 2; }
      HOME_ARG="$2"; shift 2 ;;
    --old-clone)
      [[ $# -ge 2 && -n "$2" ]] || { printf '%s\n' '--old-clone needs a directory' >&2; exit 2; }
      OLD_CLONE="$2"; shift 2 ;;
    --new-clone)
      [[ $# -ge 2 && -n "$2" ]] || { printf '%s\n' '--new-clone needs a directory' >&2; exit 2; }
      NEW_CLONE="$2"; shift 2 ;;
    --wait-seconds)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { printf '%s\n' '--wait-seconds needs a non-negative integer' >&2; exit 2; }
      WAIT_SECONDS="$2"; shift 2 ;;
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
    --run-dir)
      [[ $# -ge 2 && -n "$2" ]] || { printf '%s\n' '--run-dir needs a directory' >&2; exit 2; }
      RUN_DIR_ARG="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

HOME="$(normalize_path "$HOME_ARG")"
export HOME
OLD_CLONE="$(normalize_path "${OLD_CLONE:-$HOME/AgentProcessSegments}")"
if [[ ! -d "$OLD_CLONE" && "$OLD_CLONE" == "$HOME/AgentProcessSegments" && -d "$HOME/sandbox-harness" ]]; then
  OLD_CLONE="$HOME/sandbox-harness"
fi
NEW_CLONE="$(normalize_path "${NEW_CLONE:-$HOME/agent-process-segments}")"
RUN_ROOT="$HOME/.aps-cutover"

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

# A private scratch directory is used for read-only preflight snapshots.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aps-cutover-work.XXXXXX")"
cleanup_work() { rm -rf "$WORK_DIR"; }
trap cleanup_work EXIT

ALREADY_MIGRATED=0
OLD_ACTIVE=0
MASTER_ENABLED=false

if [[ "$INTERNAL_RUN" -eq 1 ]]; then
  run_cutover
  exit 0
fi

check_preflight
if [[ "$ALREADY_MIGRATED" -eq 1 ]]; then
  log "already migrated: $NEW_CLONE exists and the legacy paths are gone"
  if ! unit_active "$NEW_UNIT"; then
    log "ERROR: paths are migrated but $NEW_UNIT is not active; inspect the previous run and start it manually"
    exit 1
  fi
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  plan
  exit 0
fi

if [[ "$DETACH" -eq 1 ]]; then
  detach_cutover
  exit 0
fi

printf '%s\n' "Refusing to run a live cutover without --detach or --dry-run." >&2
printf '%s\n' "Run --dry-run first, then --detach; see deploy/vps.md." >&2
exit 2
