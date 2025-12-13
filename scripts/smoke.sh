#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PORT="${PORT:-3333}"
HOST="${HOST:-localhost}"
BASE_URL="http://${HOST}:${PORT}"

MODEL_ID="${MODEL_ID:-gpt-5.2}"

MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-20}"
CURL_MAX_TIME_SECONDS="${CURL_MAX_TIME_SECONDS:-60}"

PID_FILE="${PID_FILE:-/tmp/codex-bridge.pid}"
LOG_FILE="${LOG_FILE:-/tmp/codex-bridge.log}"

SSE_FILE="${SSE_FILE:-$(mktemp -t codex-bridge-sse.XXXXXX)}"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE" || true
  fi
}

trap cleanup EXIT

cd "$ROOT_DIR"

if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then
  echo "ERROR: port ${PORT} is already in use" >&2
  echo "Tip: stop the existing process or run with a different PORT." >&2
  exit 1
fi

rm -f "$LOG_FILE" "$SSE_FILE" "$PID_FILE" || true

# Start server detached so we can run curl in this script.
nohup env NODE_OPTIONS= npm start >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

echo "Started server pid=$(cat "$PID_FILE") url=${BASE_URL}"

# Wait for /health
end=$((SECONDS + MAX_WAIT_SECONDS))
until curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; do
  if (( SECONDS >= end )); then
    echo "ERROR: server did not become ready within ${MAX_WAIT_SECONDS}s" >&2
    echo "--- server log tail ---" >&2
    tail -n 200 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.25
done

echo "Server READY"

# Streaming smoke test
curl -N --max-time "$CURL_MAX_TIME_SECONDS" "${BASE_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL_ID}\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Write exactly 2 short sentences about TypeScript.\"}]}" \
  | tee "$SSE_FILE" >/dev/null || true

# Assertions
DELTA_LINES="$(grep -E -c '\"delta\"\s*:\s*\{[^}]*\"content\"' "$SSE_FILE" || true)"
DONE_LINES="$(grep -c 'data: \[DONE\]' "$SSE_FILE" || true)"

echo "delta_content_lines=${DELTA_LINES}"
echo "done_lines=${DONE_LINES}"

echo "--- SSE head ---"
sed -n '1,20p' "$SSE_FILE" || true

echo "--- SSE tail ---"
tail -n 20 "$SSE_FILE" || true

if [[ "$DELTA_LINES" -lt 1 ]]; then
  echo "ERROR: did not observe any choices[0].delta.content chunks" >&2
  echo "--- server log tail ---" >&2
  tail -n 200 "$LOG_FILE" >&2 || true
  exit 1
fi

if [[ "$DONE_LINES" -lt 1 ]]; then
  echo "ERROR: did not observe terminal data: [DONE]" >&2
  echo "--- server log tail ---" >&2
  tail -n 200 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "OK: streaming smoke test passed"
