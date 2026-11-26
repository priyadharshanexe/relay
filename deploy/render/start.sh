#!/bin/bash
# Render: migrate, then run the API, the worker and Caddy in one container.
# If any of them exits, the container exits and Render restarts it.
set -eu
python -m relay.db.migrate
if [ "${RELAY_DEMO_MODE:-false}" = "true" ]; then
    python -m relay.seed || echo "seed: skipped (already seeded?)" >&2
fi
uvicorn --factory relay.main:create_app --host 127.0.0.1 --port 8001 --no-access-log --proxy-headers --forwarded-allow-ips 127.0.0.1 &
python -m relay.worker &
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
wait -n
exit 1
