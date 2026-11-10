#!/usr/bin/env bash
# Azure App Service (Linux, Python 3.12) startup command: "bash startup.sh".
# Oryx has already activated the app's virtualenv and cd'ed into the app folder when this runs.
set -euo pipefail
cd "$(dirname "$0")"

# 1) Create tables and load the hierarchy + user accounts (idempotent: existing data is kept).
#    Several instances may start at the same moment on a fresh database; a loser of that race
#    simply retries and then finds the data already present.
if [ "${SEED_ON_STARTUP:-true}" != "false" ]; then
  for attempt in 1 2 3 4 5; do
    if python -m app.seed; then
      break
    fi
    if [ "$attempt" -eq 5 ]; then
      echo "startup: seeding failed after $attempt attempts" >&2
      exit 1
    fi
    echo "startup: seed attempt $attempt failed, retrying in $((attempt * 5))s" >&2
    sleep $((attempt * 5))
  done
fi

# 2) Serve the app.
exec gunicorn app.main:app \
  -k uvicorn.workers.UvicornWorker \
  -w "${WEB_CONCURRENCY:-3}" \
  -b "0.0.0.0:${PORT:-8000}" \
  --timeout 180 \
  --graceful-timeout 30 \
  --keep-alive 5 \
  --access-logfile - \
  --error-logfile -
