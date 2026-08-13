#!/usr/bin/env bash
# Recover OTHER VPS sites without touching MikroTik (3001) or invest3 (3005).
# Run as ddservice on the VPS. Review each step before running destructive docker recreate.
set -euo pipefail

echo "=== listening ports (do not steal 3001 / 3005) ==="
ss -lntp | grep -E '3001|3002|3005|3011|4000|5000' || true

echo "=== PM2 (MikroTik should stay online on 3001, fork mode) ==="
pm2 list || true

echo "=== Docker ==="
sudo docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || docker ps -a

echo
echo "=== cnxhaircutz.ddserviceth.com expects 127.0.0.1:3002 ==="
if ss -lntp | grep -q ':3002'; then
  echo "3002 already listening"
else
  echo "3002 is FREE — find and start the cnxhaircutz app on 3002 ONLY"
  echo "Hints:"
  echo "  ls /home/ddservice"
  echo "  ls /home/ddservice/*/package.json 2>/dev/null"
  echo "  pm2 list   # look for a deleted/stopped cnx* app"
  echo "  grep -RIn '3002' /home/ddservice --include='ecosystem*.js' --include='*.json' 2>/dev/null | head"
  echo "Then start THAT app bound to 3002. Do NOT change mikrotik-dashboard."
fi

echo
echo "=== minimalcnx (was on 3001 — must move to 3011) ==="
echo "If minimalcnx container maps 3001, stop it and re-run on 127.0.0.1:3011->3000"
echo "Then set nginx minimal*.conf proxy_pass to 127.0.0.1:3011"
echo "Never start minimalcnx on 3001 while MikroTik owns 3001."

echo
echo "=== sop5 -> 5000, pems -> 4000 ==="
echo "Start those apps on their own ports; reload nginx after."

echo
echo "Test:"
echo "  curl -skI -H 'Host: cnxhaircutz.ddserviceth.com' https://127.0.0.1/ | head -5"
echo "  curl -skI -H 'Host: api.ddserviceth.com' https://127.0.0.1/ | head -5"
