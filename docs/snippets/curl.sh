#!/usr/bin/env bash
# Producer snippet: full stream lifecycle with curl.
#
#   LOG_VIEWER_BASE=http://127.0.0.1:5178 LOG_VIEWER_SERVICE_KEY=… ./curl.sh myapp
#
# The stream key is a server-to-server credential — keep it in your secret
# store, never in browser code or embed URLs. See docs/api-v1.md.
set -euo pipefail

BASE="${LOG_VIEWER_BASE:-http://127.0.0.1:5178}"
CHANNEL="${1:-myapp}"

AUTH=()
if [ -n "${LOG_VIEWER_SERVICE_KEY:-}" ]; then
  AUTH=(-H "x-stream-key: $LOG_VIEWER_SERVICE_KEY")
fi

# 0. Discover the deployment (limits, auth mode) — optional but recommended.
curl -fsS "$BASE/api/v1/capabilities"

# 1. Create the stream (idempotent; 201 created, 200 already exists).
curl -fsS -X PUT "$BASE/api/v1/streams/$CHANNEL" "${AUTH[@]}"

# 2a. Append raw lines — parsed with the stream's detected/custom format.
curl -fsS -X POST "$BASE/api/v1/streams/$CHANNEL/entries" \
  "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"lines":["2026-07-13 10:00:00,000 [Main] INFO App - service ready"]}'

# 2b. Append structured entries (only the mapped fields are retained).
curl -fsS -X POST "$BASE/api/v1/streams/$CHANNEL/entries" \
  "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"entries":[{"time":"2026-07-13T10:00:01Z","level":"WARN","thread":"Main","logger":"App","message":"slow response requestId=abc123"}]}'

# 3. On shutdown, release the stream (idempotent).
# curl -fsS -X DELETE "$BASE/api/v1/streams/$CHANNEL" "${AUTH[@]}"
