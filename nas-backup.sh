#!/bin/sh
# ============================================================
# nas-backup.sh - PULL-based backup for NAS devices that live on
# an internal-only network (Synology DSM, QNAP QTS, or any generic
# Linux box with cron). The NAS cannot be reached FROM the VPS, so
# instead of the VPS pushing data in, this script runs ON the NAS
# and reaches OUT to the dashboard's public HTTPS API to download
# CSV exports - only outbound traffic is needed, nothing has to be
# opened/forwarded on the NAS or the internal network.
#
# It reuses the dashboard's existing authenticated CSV export
# routes (same ones the "Export CSV" buttons in the web UI call):
#   /api/logs/export-csv          (admin only)
#   /api/hotspot-logs/export-csv  (admin, co-admin)
#   /api/dns-logs/export-csv      (admin, co-admin)
#   /api/pppoe-usage/export-csv   (admin, co-admin)
# No new backend code is required - login once via /api/auth/login
# to get a Bearer token, then GET each export route with it.
#
# Compatible with: Synology DSM (Task Scheduler -> user-defined
# script), QNAP QTS (Task Scheduler / crontab over SSH), and any
# generic Linux/BSD NAS with cron. Uses only POSIX sh + curl (both
# present on DSM/QTS by default) - no jq, no bash-only syntax.
#
# Setup:
#   1. Create a dedicated dashboard account for this script instead
#      of reusing a personal login (Settings -> User Management),
#      role "admin" or "co-admin" depending which exports you need.
#   2. Copy nas-backup.conf.example to nas-backup.conf next to this
#      script and fill in APP_URL / APP_USERNAME / APP_PASSWORD.
#   3. chmod +x nas-backup.sh
#   4. Schedule it (see bottom of this file for platform-specific
#      instructions).
# ============================================================

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# ---- Config: env vars win, falling back to nas-backup.conf ----
if [ -f "$SCRIPT_DIR/nas-backup.conf" ]; then
    # shellcheck disable=SC1090
    . "$SCRIPT_DIR/nas-backup.conf"
fi

APP_URL="${APP_URL:-}"                     # e.g. https://api.ddserviceth.com
APP_USERNAME="${APP_USERNAME:-}"
APP_PASSWORD="${APP_PASSWORD:-}"
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"     # local copies older than this get pruned
SITE_FILTER="${SITE_FILTER:-}"             # optional: only back up one site's logs
ENCRYPT_BACKUPS="${ENCRYPT_BACKUPS:-false}" # true/false - gpg-encrypt CSVs at rest
GPG_PASSPHRASE="${GPG_PASSPHRASE:-}"       # required if ENCRYPT_BACKUPS=true

if [ -z "$APP_URL" ] || [ -z "$APP_USERNAME" ] || [ -z "$APP_PASSWORD" ]; then
    echo "[nas-backup] Missing APP_URL / APP_USERNAME / APP_PASSWORD - set them in nas-backup.conf or the environment." >&2
    exit 1
fi

if [ "$ENCRYPT_BACKUPS" = "true" ] && [ -z "$GPG_PASSPHRASE" ]; then
    echo "[nas-backup] ENCRYPT_BACKUPS=true but GPG_PASSPHRASE is not set." >&2
    exit 1
fi

TODAY=$(date +%Y-%m-%d)
OUT_DIR="$BACKUP_DIR/$TODAY"
mkdir -p "$OUT_DIR"

log() { echo "[nas-backup] $(date '+%Y-%m-%d %H:%M:%S') - $1"; }

# ---- Extract a JSON string field without depending on jq ----
json_field() {
    # $1 = raw json, $2 = field name
    echo "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

log "Logging in to $APP_URL as $APP_USERNAME ..."
LOGIN_RESPONSE=$(curl -sf -X POST "$APP_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$APP_USERNAME\",\"password\":\"$APP_PASSWORD\"}") \
    || { echo "[nas-backup] Login request failed - check APP_URL/network." >&2; exit 1; }

TOKEN=$(json_field "$LOGIN_RESPONSE" "token")
if [ -z "$TOKEN" ]; then
    echo "[nas-backup] Login did not return a token - check APP_USERNAME/APP_PASSWORD." >&2
    exit 1
fi
log "Login OK."

QS=""
if [ -n "$SITE_FILTER" ]; then
    QS="?site=$SITE_FILTER"
fi

# $1 = endpoint path, $2 = output filename
fetch_csv() {
    endpoint="$1"
    outfile="$OUT_DIR/$2"
    log "Downloading $endpoint ..."
    if curl -sf "$APP_URL$endpoint$QS" -H "Authorization: Bearer $TOKEN" -o "$outfile"; then
        log "  -> saved $outfile"
    else
        log "  -> FAILED (endpoint may require admin role, or account lacks access) - skipped"
        rm -f "$outfile"
        return 0
    fi

    if [ "$ENCRYPT_BACKUPS" = "true" ] && [ -f "$outfile" ]; then
        gpg --batch --yes --passphrase "$GPG_PASSPHRASE" --cipher-algo AES256 \
            --symmetric -o "$outfile.gpg" "$outfile" \
            && rm -f "$outfile" \
            && log "  -> encrypted to $outfile.gpg"
    fi
}

fetch_csv "/api/logs/export-csv"          "activity_log_$TODAY.csv"
fetch_csv "/api/hotspot-logs/export-csv"  "hotspot_traffic_log_$TODAY.csv"
fetch_csv "/api/dns-logs/export-csv"      "dns_visit_log_$TODAY.csv"
fetch_csv "/api/pppoe-usage/export-csv"   "pppoe_usage_log_$TODAY.csv"

# ---- Prune old local backup folders ----
log "Pruning backups older than $RETENTION_DAYS days ..."
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -exec rm -rf {} \;

log "Done. Backup written to $OUT_DIR"
