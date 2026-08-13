#!/usr/bin/env bash
# ============================================================
# backup-pre-rewrite.sh — snapshot production BEFORE rewrite
# Run on VPS as user ddservice:
#   bash /home/ddservice/mikrotik/scripts/backup-pre-rewrite.sh
# ============================================================
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
ROOT="${BACKUP_ROOT:-/home/ddservice}"
APP="${APP_DIR:-/home/ddservice/mikrotik}"
OUT="${ROOT}/backups/mikrotik-pre-rewrite-${STAMP}"

mkdir -p "$OUT"
echo "[backup] Writing to $OUT"

# 1) App tree (code + local db JSON — includes secrets; keep private)
tar -C "$(dirname "$APP")" \
  --exclude='mikrotik/node_modules' \
  --exclude='mikrotik/.next' \
  --exclude='mikrotik/logs/*.log' \
  --exclude='mikrotik/backups' \
  -czf "$OUT/mikrotik-app.tgz" "$(basename "$APP")"
echo "[backup] app archive OK"

# 2) Explicit copies of critical secrets/config
mkdir -p "$OUT/secrets"
cp -a "$APP/ecosystem.config.js" "$OUT/secrets/ecosystem.config.js" 2>/dev/null || true
cp -a "$APP/db/config.json" "$OUT/secrets/db-config.json" 2>/dev/null || true
cp -a "$APP/db/users.json" "$OUT/secrets/db-users.json" 2>/dev/null || true
cp -a "$ROOT/db-config.json.bak" "$OUT/secrets/db-config.json.bak" 2>/dev/null || true
cp -a "$ROOT/db-users.json.bak" "$OUT/secrets/db-users.json.bak" 2>/dev/null || true
cp -a "$ROOT/ecosystem.config.js.bak" "$OUT/secrets/ecosystem.config.js.bak" 2>/dev/null || true

# 3) Nginx site configs for this VPS
mkdir -p "$OUT/nginx"
if [ -d /etc/nginx/sites-enabled ]; then
  sudo cp -a /etc/nginx/sites-enabled/. "$OUT/nginx/sites-enabled/" 2>/dev/null || \
    cp -a /etc/nginx/sites-enabled/. "$OUT/nginx/sites-enabled/" 2>/dev/null || true
fi

# 4) PM2 process list
pm2 save >/dev/null 2>&1 || true
cp -a "$HOME/.pm2/dump.pm2" "$OUT/pm2-dump.pm2" 2>/dev/null || true
pm2 list > "$OUT/pm2-list.txt" 2>/dev/null || true
ss -lntp > "$OUT/listening-ports.txt" 2>/dev/null || true
sudo docker ps -a > "$OUT/docker-ps.txt" 2>/dev/null || docker ps -a > "$OUT/docker-ps.txt" 2>/dev/null || true

# 5) Git revision pointer
if [ -d "$APP/.git" ]; then
  git -C "$APP" rev-parse HEAD > "$OUT/git-HEAD.txt" 2>/dev/null || true
  git -C "$APP" status -sb > "$OUT/git-status.txt" 2>/dev/null || true
  git -C "$APP" log -5 --oneline > "$OUT/git-log.txt" 2>/dev/null || true
fi

# 6) Manifest
{
  echo "created_at=$STAMP"
  echo "app_dir=$APP"
  echo "purpose=pre-rewrite snapshot (Express stable)"
  echo "restore_app=tar -xzf mikrotik-app.tgz -C $(dirname "$APP")"
} > "$OUT/MANIFEST.txt"

chmod -R go-rwx "$OUT" 2>/dev/null || true
du -sh "$OUT" "$OUT"/* 2>/dev/null | sed 's/^/[backup] /'
echo "[backup] DONE: $OUT"
echo "[backup] Keep this folder offline/private — it contains router credentials & hashes."
