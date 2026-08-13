#!/usr/bin/env bash
# Fail fast if something other than MikroTik is about to bind 3001,
# or if ecosystem points at next. Run before pm2 start on VPS.
set -euo pipefail
ECO="${1:-/home/ddservice/mikrotik/ecosystem.config.js}"
if [ ! -f "$ECO" ]; then
  echo "missing $ECO" >&2
  exit 1
fi
if grep -E "next/dist/bin/next|args:.*start -p" "$ECO" >/dev/null; then
  echo "REFUSE: ecosystem points at Next.js — production must use script: server.js" >&2
  exit 2
fi
if ! grep -E "script: ['\"]server\.js['\"]" "$ECO" >/dev/null; then
  echo "REFUSE: ecosystem script is not server.js" >&2
  exit 3
fi
if grep -E "PORT:\s*3000\b" "$ECO" >/dev/null; then
  echo "REFUSE: PORT 3000 collides with other VPS apps — use 3001" >&2
  exit 4
fi
if grep "YOUR_PROJECT_ID" "$ECO" >/dev/null; then
  echo "WARN: placeholder SUPABASE_* still present — comment them out or set real keys (do not --update-env yet)" >&2
fi
echo "preflight OK: $ECO"
