#!/usr/bin/env bash
# ============================================================
# vps-harden-ports-and-pm2.sh
# One-shot hardening after the 2026-08-13 multi-site outage.
# Makes port ownership + PM2 process list durable across reboot.
#
# Run as ddservice on the VPS:
#   bash /home/ddservice/mikrotik/scripts/vps-harden-ports-and-pm2.sh
# ============================================================
set -euo pipefail

echo "=== VPS harden: ports + PM2 (MikroTik must stay on 3001) ==="

# ---- helpers ----
ensure_listen() {
  local port="$1"
  ss -lntp 2>/dev/null | grep -q ":${port} " && return 0
  ss -lntp 2>/dev/null | grep -q ":${port}$" && return 0
  return 1
}

# ---- 1) MikroTik ecosystem: fork + absolute cwd + never load placeholder Supabase ----
MIKRO="/home/ddservice/mikrotik"
if [ -f "$MIKRO/ecosystem.config.js" ]; then
  python3 - <<'PY'
from pathlib import Path
p = Path('/home/ddservice/mikrotik/ecosystem.config.js')
t = p.read_text()
import re
# Always fork — never leave cluster from a bad bak / old ecosystem
if re.search(r"exec_mode:\s*['\"][^'\"]+['\"]", t):
    t = re.sub(r"exec_mode:\s*['\"][^'\"]+['\"]", "exec_mode: 'fork'", t)
elif "instances: 1," in t:
    t = t.replace("instances: 1,", "instances: 1,\n            exec_mode: 'fork',", 1)
else:
    t = t.replace("script: 'server.js',", "script: 'server.js',\n            instances: 1,\n            exec_mode: 'fork',", 1)
t = t.replace("cwd: './'", "cwd: '/home/ddservice/mikrotik'")
# Comment placeholder secrets so JSON fallback stays intentional until real keys are set
# (handles both indented and already-partially-commented lines)
t = re.sub(
    r"^(\s*)(?://\s*)?SUPABASE_URL:\s*'https://YOUR_PROJECT_ID\.supabase\.co'\s*,?\s*$",
    r"\1// SUPABASE_URL: 'https://YOUR_PROJECT_ID.supabase.co',",
    t,
    flags=re.M,
)
t = re.sub(
    r"^(\s*)(?://\s*)?SUPABASE_SERVICE_KEY:\s*'eyJ[^']*YOUR_SERVICE_ROLE_KEY'\s*,?\s*$",
    r"\1// SUPABASE_SERVICE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.YOUR_SERVICE_ROLE_KEY',",
    t,
    flags=re.M,
)
if "script: 'server.js'" not in t and 'script: "server.js"' not in t:
    raise SystemExit('REFUSING: mikrotik ecosystem is not script:server.js')
p.write_text(t)
print('[ok] mikrotik ecosystem hardened')
PY
  # Restart mikrotik only if not already fork+online on 3001
  MODE=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); a=next((x for x in d if x.get('name')=='mikrotik-dashboard'),None); print((a or {}).get('pm2_env',{}).get('exec_mode',''))" || true)
  if [ "$MODE" != "fork_mode" ] && [ "$MODE" != "fork" ]; then
    pm2 delete mikrotik-dashboard 2>/dev/null || true
    (cd "$MIKRO" && pm2 start ecosystem.config.js)
  fi
fi

# ---- 2) cnxhaircutz on 3002 (localhost only — nginx fronts it) ----
CNX="/var/www/cnxhaircutz"
if [ -d "$CNX" ]; then
  NEED_CNX=0
  if ! pm2 describe cnxhaircutz >/dev/null 2>&1; then NEED_CNX=1; fi
  if ! ensure_listen 3002; then NEED_CNX=1; fi
  # Force rebind if listening on 0.0.0.0 instead of 127.0.0.1
  if ss -lntp 2>/dev/null | grep -E '0\.0\.0\.0:3002|\*:3002' | grep -vq '127.0.0.1:3002'; then NEED_CNX=1; fi
  if [ "$NEED_CNX" = 1 ]; then
    pm2 delete cnxhaircutz 2>/dev/null || true
    PORT=3002 HOSTNAME=127.0.0.1 NODE_ENV=production \
      pm2 start npm --name cnxhaircutz --cwd "$CNX" -- start -- -H 127.0.0.1 -p 3002
  fi
  echo "[ok] cnxhaircutz managed (expect 127.0.0.1:3002)"
fi

# ---- 3) pems on 4000 with absolute standalone cwd (localhost only) ----
PEMS="/home/ddservice/TMHCCP5"
if [ -f "$PEMS/.next/standalone/server.js" ]; then
  if [ -f "$PEMS/ecosystem.config.js" ]; then
    python3 - <<'PY'
from pathlib import Path
p = Path('/home/ddservice/TMHCCP5/ecosystem.config.js')
t = p.read_text()
t2 = t.replace('cwd: "./.next/standalone"', "cwd: '/home/ddservice/TMHCCP5/.next/standalone'")
t2 = t2.replace("cwd: './.next/standalone'", "cwd: '/home/ddservice/TMHCCP5/.next/standalone'")
if t2 != t:
    p.write_text(t2)
    print('[ok] patched TMHCCP5 ecosystem cwd to absolute standalone path')
else:
    print('[ok] TMHCCP5 ecosystem cwd already absolute or different format')
PY
  fi
  NEED_PEMS=0
  if ! ensure_listen 4000; then NEED_PEMS=1; fi
  if ss -lntp 2>/dev/null | grep -E '0\.0\.0\.0:4000|\*:4000' | grep -vq '127.0.0.1:4000'; then NEED_PEMS=1; fi
  if [ "$NEED_PEMS" = 1 ]; then
    pm2 delete pems-platform 2>/dev/null || true
    set -a
    # shellcheck disable=SC1091
    [ -f "$PEMS/.env.production" ] && . "$PEMS/.env.production"
    set +a
    PORT=4000 HOSTNAME=127.0.0.1 NODE_ENV=production pm2 start server.js \
      --name pems-platform \
      --cwd "$PEMS/.next/standalone"
  fi
  # pems-stale-remind removed 2026-08-13 (unused LINE stale cron)
  echo "[ok] pems managed (expect 127.0.0.1:4000)"
fi

# ---- 4) sop5 production on 5000 (server.js only — not vite+dev; localhost) ----
SOP5="/home/ddservice/sop5"
if [ -f "$SOP5/server.js" ]; then
  NEED_SOP5_FIX=0
  if ! ensure_listen 5000; then NEED_SOP5_FIX=1; fi
  if ss -lntp 2>/dev/null | grep -E '0\.0\.0\.0:5000|\*:5000' | grep -vq '127.0.0.1:5000'; then NEED_SOP5_FIX=1; fi
  if pm2 describe sop5 >/dev/null 2>&1; then
    SCRIPT=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); a=next((x for x in d if x.get('name')=='sop5'),None); print((a or {}).get('pm2_env',{}).get('pm_exec_path',''))" || true)
    case "$SCRIPT" in
      *npm*) NEED_SOP5_FIX=1 ;;
    esac
  else
    NEED_SOP5_FIX=1
  fi
  if [ "$NEED_SOP5_FIX" = 1 ]; then
    pm2 delete sop5 2>/dev/null || true
    PORT=5000 HOST=127.0.0.1 NODE_ENV=production pm2 start server.js --name sop5 --cwd "$SOP5"
  fi
  echo "[ok] sop5 managed (expect 127.0.0.1:5000, server.js)"
fi

# ---- 5) minimalcnx Docker permanently on 3011 (never 3001) ----
if command -v docker >/dev/null 2>&1; then
  BIND=$(sudo docker inspect minimalcnx --format '{{json .HostConfig.PortBindings}}' 2>/dev/null || true)
  if echo "$BIND" | grep -q '3001'; then
    echo "[fix] minimalcnx still bound to 3001 — recreating on 3011"
    sudo docker rm -f minimalcnx 2>/dev/null || true
    sudo docker run -d --name minimalcnx --restart unless-stopped \
      -p 127.0.0.1:3011:3000 minimalcnx:latest
  elif ! sudo docker ps --format '{{.Names}}' | grep -qx minimalcnx; then
    echo "[fix] minimalcnx not running — starting on 3011"
    sudo docker rm -f minimalcnx 2>/dev/null || true
    sudo docker run -d --name minimalcnx --restart unless-stopped \
      -p 127.0.0.1:3011:3000 minimalcnx:latest || true
  else
    echo "[ok] minimalcnx docker running"
  fi
fi
# nginx must proxy minimal* to 3011
for f in /etc/nginx/sites-enabled/minimal.conf /etc/nginx/sites-enabled/minimalcnx.conf; do
  if [ -f "$f" ]; then
    sudo sed -i 's|127.0.0.1:3001|127.0.0.1:3011|g' "$f"
  fi
done

# ---- 6) Write durable port map for operators ----
PORTS_DOC="/home/ddservice/VPS-PORTS.md"
cat > "$PORTS_DOC" <<'EOF'
# VPS port ownership (do not steal)

| Port | Bind | App | How it runs | Nginx host |
|------|------|-----|-------------|------------|
| 3001 | 127.0.0.1 | mikrotik-dashboard | PM2 `server.js` fork + HOST=127.0.0.1 | api.ddserviceth.com |
| 3002 | 127.0.0.1 | cnxhaircutz | PM2 `next start -H 127.0.0.1 -p 3002` | cnxhaircutz.ddserviceth.com |
| 3005 | 127.0.0.1 | invest3 / apexlink | Docker `127.0.0.1:3005->3000` | invest3.ddserviceth.com |
| 3011 | 127.0.0.1 | minimalcnx | Docker `127.0.0.1:3011->3000` | minimal*.ddserviceth.com |
| 4000 | 127.0.0.1 | pems-platform | PM2 standalone + HOSTNAME=127.0.0.1 | pems / tmhccp5 |
| 5000 | 127.0.0.1 | sop5 | PM2 `server.js` + HOST=127.0.0.1 | sop5.ddserviceth.com |
| 80/443 | public | nginx | reverse proxy only | all HTTPS sites |
| 22 | public | sshd | key-only (no password/root) | admin |

## Hard rules
1. Never point MikroTik PM2 at `next start`.
2. Never bind anything else to 3001.
3. Prefer `127.0.0.1` for Node/Next app ports — only nginx is public.
4. Never `pm2 reload ecosystem.config.js --update-env` with YOUR_PROJECT_ID placeholders.
5. After starting/stopping apps: `pm2 save` only when all critical apps are online.
6. Before risky deploys: `bash /home/ddservice/mikrotik/scripts/backup-pre-rewrite.sh`
7. Real Supabase secrets live only in VPS `ecosystem.config.js` (gitignored) + `/home/ddservice/backups/ecosystem.config.js.REAL.bak`.
8. `pems-stale-remind` was removed (2026-08-13) — do not recreate.
EOF
echo "[ok] wrote $PORTS_DOC"

# ---- 7) nginx reload + durable PM2 list ----
sudo nginx -t
sudo systemctl reload nginx
pm2 save
# ensure resurrect on boot if not already
pm2 startup systemd -u ddservice --hp /home/ddservice >/tmp/pm2-startup.out 2>&1 || true
# (user may need to run the sudo line printed once)

echo
echo "=== status ==="
pm2 list
ss -lntp | grep -E '3001|3002|3005|3011|4000|5000' || true
echo
for h in api.ddserviceth.com cnxhaircutz.ddserviceth.com sop5.ddserviceth.com pems.ddserviceth.com minimalcnx.ddserviceth.com invest3.ddserviceth.com; do
  printf '%-35s ' "$h"
  curl -skI --max-time 8 -H "Host: $h" https://127.0.0.1/ 2>/dev/null | head -1 || echo FAIL
done
echo
echo "DONE. Port map: $PORTS_DOC"
echo "If a site is still wrong, check: pm2 logs <name> --lines 40 --nostream"
