#!/usr/bin/env python3
"""Producer snippet: push structured entries and raw lines to a log-viewer
stream from Python (stdlib only, no dependencies).

    LOG_VIEWER_BASE=http://127.0.0.1:5178 \
    LOG_VIEWER_SERVICE_KEY=… \
    python3 python.py myapp

The stream key is a server-to-server credential — keep it in your secret
store, never in browser code or embed URLs. See docs/api.md.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

BASE = os.environ.get("LOG_VIEWER_BASE", "http://127.0.0.1:5178").rstrip("/")
KEY = os.environ.get("LOG_VIEWER_SERVICE_KEY", "")
CHANNEL = sys.argv[1] if len(sys.argv) > 1 else "myapp"


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={
            "content-type": "application/json",
            **({"x-stream-key": KEY} if KEY else {}),
        },
    )
    with urllib.request.urlopen(r) as res:
        return json.loads(res.read())


ch = urllib.request.quote(CHANNEL, safe="")

# 1. Create the stream (idempotent; 201 created, 200 already exists).
created = req("PUT", f"/api/v1/streams/{ch}")
print("stream:", created["id"], "created:", created.get("created"))

# 2a. Append raw lines — parsed with the stream's detected/custom format.
req("POST", f"/api/v1/streams/{ch}/entries", {
    "lines": ["2026-07-13 10:00:00,000 [Main] INFO App - service ready"],
})

# 2b. Append structured entries (only the mapped fields are retained).
ack = req("POST", f"/api/v1/streams/{ch}/entries", {
    "entries": [{
        "time": datetime.now(timezone.utc).isoformat(),
        "level": "WARN",
        "thread": "Main",
        "logger": "App",
        "message": "slow response requestId=abc123",
    }],
})
print("ack:", ack["count"], "entries,", ack["stats"], "per-level totals")

# 3. On shutdown, release the stream (idempotent).
# req("DELETE", f"/api/v1/streams/{ch}")
