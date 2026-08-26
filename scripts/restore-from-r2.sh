#!/bin/bash
# ============================================================
# scripts/restore-from-r2.sh — 1-Click Disaster Recovery from Cloudflare R2
# Bucket: ddservicedb
# Folder: Mikrotikapi-db/<YYYY-MM-DD>
#
# Usage:
#   bash scripts/restore-from-r2.sh            # Restore latest backup
#   bash scripts/restore-from-r2.sh 2026-08-26 # Restore specific date
#   bash scripts/restore-from-r2.sh list       # List available snapshots
# ============================================================

set -euo pipefail

R2_BUCKET="ddservicedb"
R2_SITE_FOLDER="Mikrotikapi-db"
RESTORE_TMP="/tmp/mikrotik-r2-restore"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}  🔄 MikroTik Dashboard — Cloudflare R2 Disaster Recovery   ${NC}"
echo -e "${BLUE}============================================================${NC}"

# Ensure rclone is configured for R2
RCLONE_CONF_DIR="$HOME/.config/rclone"
RCLONE_CONF_FILE="$RCLONE_CONF_DIR/rclone.conf"
if [ ! -f "$RCLONE_CONF_FILE" ] || ! grep -q '\[r2\]' "$RCLONE_CONF_FILE" 2>/dev/null; then
    mkdir -p "$RCLONE_CONF_DIR"
    cat << 'EOF' >> "$RCLONE_CONF_FILE"

[r2]
type = s3
provider = Cloudflare
access_key_id = 78059e3268d79b09600de14776ad345a
secret_access_key = d2f634ec540b296b0fb6323254aee1e6b59788d9ea9702318cf8603f344c0d64
endpoint = https://b8fd2913de1c592db914b68e01d645c8.r2.cloudflarestorage.com
acl = private
EOF
    chmod 600 "$RCLONE_CONF_FILE"
    echo -e "${GREEN}✅ Auto-configured rclone R2 remote in $RCLONE_CONF_FILE${NC}"
fi

TARGET_DATE="${1:-}"

# Mode 1: List snapshots
if [ "$TARGET_DATE" = "list" ] || [ "$TARGET_DATE" = "-l" ]; then
    echo -e "\n${YELLOW}📅 Listing available backup snapshots in R2 (${R2_BUCKET}/${R2_SITE_FOLDER}):${NC}"
    if command -v rclone &> /dev/null; then
        rclone lsd "r2:${R2_BUCKET}/${R2_SITE_FOLDER}" || true
    fi
    exit 0
fi

# Mode 2: Find latest date if not specified
if [ -z "$TARGET_DATE" ]; then
    echo -e "\n${YELLOW}🔍 Searching for latest backup snapshot in Cloudflare R2...${NC}"
    if command -v rclone &> /dev/null; then
        LATEST_DIR=$(rclone lsd "r2:${R2_BUCKET}/${R2_SITE_FOLDER}" | awk '{print $NF}' | sort -r | head -n 1)
        if [ -n "$LATEST_DIR" ]; then
            TARGET_DATE="$LATEST_DIR"
            echo -e "${GREEN}✅ Found latest snapshot: ${TARGET_DATE}${NC}"
        fi
    fi
fi

if [ -z "$TARGET_DATE" ]; then
    TARGET_DATE=$(date '+%Y-%m-%d')
    echo -e "${YELLOW}ℹ️ Defaulting to today's date: ${TARGET_DATE}${NC}"
fi

REMOTE_PATH="r2:${R2_BUCKET}/${R2_SITE_FOLDER}/${TARGET_DATE}"
echo -e "\n${BLUE}📥 Downloading backup files from: ${REMOTE_PATH}${NC}"
mkdir -p "$RESTORE_TMP"
rm -rf "${RESTORE_TMP:?}"/*

if command -v rclone &> /dev/null; then
    rclone copy "$REMOTE_PATH" "$RESTORE_TMP" --progress || true
else
    echo -e "${RED}❌ rclone is required for direct downloading. Please install via: sudo apt update && sudo apt install -y rclone${NC}"
    exit 1
fi

echo -e "\n${GREEN}📦 Downloaded files:${NC}"
ls -lh "$RESTORE_TMP" 2>/dev/null || echo "No files found in $RESTORE_TMP"

echo -e "\n${BLUE}🔄 Restoring database files into db/ ...${NC}"
mkdir -p "$APP_DIR/db/backups-pre-restore"
cp -r "$APP_DIR/db/"*.json "$APP_DIR/db/backups-pre-restore/" 2>/dev/null || true

# Copy downloaded JSON files into db/
if [ -d "$RESTORE_TMP" ]; then
    cp -r "$RESTORE_TMP/"*.json "$APP_DIR/db/" 2>/dev/null || true
    echo -e "${GREEN}✅ Copied restored JSON files into $APP_DIR/db/${NC}"
fi

echo -e "\n${BLUE}🔄 Reloading MikroTik Dashboard service...${NC}"
if command -v pm2 &> /dev/null; then
    pm2 reload ecosystem.config.js --update-env || true
fi

echo -e "\n${GREEN}🎉 Disaster Recovery Restore completed successfully from ${TARGET_DATE}!${NC}"
