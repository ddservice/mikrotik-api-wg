#!/bin/bash
# ============================================================
# scripts/setup-r2-backup.sh - Configure Cloudflare R2 for DB Backups
# Bucket: ddservicedb
# Site Folder: Mikrotikapi-db
# ============================================================

set -eu

echo "=== Setting up Cloudflare R2 Backup for Mikrotikapi-db ==="

RCLONE_CONF_DIR="$HOME/.config/rclone"
RCLONE_CONF_FILE="$RCLONE_CONF_DIR/rclone.conf"

mkdir -p "$RCLONE_CONF_DIR"

cat << 'EOF' > /tmp/r2_block.conf
[r2]
type = s3
provider = Cloudflare
access_key_id = 78059e3268d79b09600de14776ad345a
secret_access_key = d2f634ec540b296b0fb6323254aee1e6b59788d9ea9702318cf8603f344c0d64
endpoint = https://b8fd2913de1c592db914b68e01d645c8.r2.cloudflarestorage.com
acl = private
EOF

if [ ! -f "$RCLONE_CONF_FILE" ]; then
    cp /tmp/r2_block.conf "$RCLONE_CONF_FILE"
else
    sed -i '/^\[r2\]/,/^$/d' "$RCLONE_CONF_FILE" || true
    cat /tmp/r2_block.conf >> "$RCLONE_CONF_FILE"
fi
rm -f /tmp/r2_block.conf

chmod 600 "$RCLONE_CONF_FILE"
echo "[OK] rclone.conf configured successfully at $RCLONE_CONF_FILE"

# Test connection
if command -v rclone &> /dev/null; then
    echo "Testing connection to bucket ddservicedb..."
    if rclone lsd r2:ddservicedb &> /dev/null; then
        echo "[OK] Successfully connected to Cloudflare R2 bucket: ddservicedb"
    else
        echo "[WARNING] Could not list bucket ddservicedb. Please verify bucket exists."
    fi
else
    echo "[INFO] rclone not installed yet. Install via: sudo apt update && sudo apt install -y rclone"
fi

echo ""
echo "=== Next Steps ==="
echo "1. Set environment variables in ecosystem.config.js:"
echo "   BACKUP_RCLONE_REMOTES: 'r2',"
echo "   BACKUP_RCLONE_DEST_DIR: 'ddservicedb/Mikrotikapi-db'"
echo ""
echo "2. Run test backup now:"
echo "   node backup.js"
