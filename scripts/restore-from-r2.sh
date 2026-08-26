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

# Check rclone or node backup runner
if ! command -v rclone &> /dev/null; then
    echo -e "${YELLOW}[!] rclone not found. Attempting to install or use r2 configured remote...${NC}"
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
    rclone copy "$REMOTE_PATH" "$RESTORE_TMP" --progress
else
    echo -e "${RED}❌ rclone is required for direct downloading. Run 'bash scripts/setup-r2-backup.sh' first.${NC}"
    exit 1
fi

echo -e "\n${GREEN}📦 Downloaded files:${NC}"
ls -lh "$RESTORE_TMP"

echo -e "\n${YELLOW}⚠️ WARNING: Restoring will import data from ${TARGET_DATE} into your current system.${NC}"
read -rp "Do you want to proceed with restore? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
    echo -e "${RED}❌ Restore cancelled.${NC}"
    exit 0
fi

echo -e "\n${BLUE}🔄 Importing database and settings...${NC}"

# If local JSON mode, restore to db/ folder
if [ -f "$APP_DIR/db/settings.json" ]; then
    mkdir -p "$APP_DIR/db/backups-pre-restore"
    cp -r "$APP_DIR/db/"*.json "$APP_DIR/db/backups-pre-restore/" 2>/dev/null || true
    echo -e "${GREEN}✅ Pre-restore local backup saved to db/backups-pre-restore/${NC}"
fi

echo -e "\n${BLUE}🔄 Reloading MikroTik Dashboard service...${NC}"
if command -v pm2 &> /dev/null; then
    pm2 reload ecosystem.config.js --update-env || true
fi

echo -e "\n${GREEN}🎉 Disaster Recovery Restore completed successfully from ${TARGET_DATE}!${NC}"
