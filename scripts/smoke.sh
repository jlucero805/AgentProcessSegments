#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PORT=7399

SBOX_DB="$WORK/harness.sqlite" \
SBOX_DATA_DIR="$WORK/data" \
SBOX_PORT=$PORT \
node "$ROOT/src/server/dist/app.js" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

for _ in {1..40}; do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

echo "health: $(curl -s "http://127.0.0.1:$PORT/health")"
echo "create: $(curl -s -X POST "http://127.0.0.1:$PORT/api/requests" -H 'content-type: application/json' -d '{"title":"Boot check","body":"real socket"}')"
echo "intake: $(curl -s "http://127.0.0.1:$PORT/api/requests?view=intake")"
echo "models: $(curl -s "http://127.0.0.1:$PORT/api/models" | head -c 160)"
echo "bad:    $(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/requests" -H 'content-type: application/json' -d '{"title":""}')"
echo "missing:$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/requests/nope")"
