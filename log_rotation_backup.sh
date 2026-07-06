#!/bin/bash

# ==============================================================================
# MikroTik Hotspot Log Rotation & Cloud Backup Script
# Concept: "Keep short on server, back up on Cloud"
# Designed for Ubuntu Server (40GB Disk)
# ==============================================================================

# --- CONFIGURATION ---
# Path to raw logs from Rsyslog
LOG_DIR="/var/log/mikrotik"
LOG_PREFIX="hotspot-log" # Expected log name format: hotspot-log-YYYY-MM-DD.log

# Rclone Configurations
RCLONE_REMOTE="gdrive"
RCLONE_DEST_DIR="Mikrotik_Logs"

# ClickHouse Configurations
CH_HOST="localhost"
CH_PORT="9000"       # Native client port (default is 9000). Use 8123 for HTTP client.
CH_USER="default"
CH_PASS=""
CH_DB="default"
CH_TABLE="hotspot_logs"
CH_TIME_COLUMN="log_time" # ClickHouse table time column (e.g. timestamp or log_time)

# Error Notification Configurations (LINE Notify)
# Leave blank to disable
LINE_NOTIFY_TOKEN=""

# --- SYSTEM VARIABLES ---
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d)
CURRENT_MONTH=$(date -d "yesterday" +%Y-%m)
RAW_LOG_FILE="${LOG_DIR}/${LOG_PREFIX}-${YESTERDAY}.log"
ARCHIVE_NAME="${LOG_PREFIX}-${YESTERDAY}.tar.gz"
ARCHIVE_PATH="${LOG_DIR}/${ARCHIVE_NAME}"
CLOUD_FOLDER="${RCLONE_DEST_DIR}/${CURRENT_MONTH}"

# Log script execution (saves log in the same folder as the script)
SCRIPT_LOG="$(cd "$(dirname "$0")" && pwd)/log_rotation_backup.log"

# Ensure script log file exists and is writable
touch "$SCRIPT_LOG"
exec >> "$SCRIPT_LOG" 2>&1

echo "========================================================"
echo "Starting Log Rotation and Backup: $(date)"
echo "Target Date (Yesterday): ${YESTERDAY}"
echo "========================================================"

# --- FUNCTION: Send LINE Notify / Syslog ---
send_notification() {
    local message="$1"
    if [ -n "$LINE_NOTIFY_TOKEN" ]; then
        curl -s -X POST -H "Authorization: Bearer ${LINE_NOTIFY_TOKEN}" \
            -F "message=${message}" \
            https://notify-api.line.me/api/notify > /dev/null
    fi
    # Log to system syslog
    logger -t log-rotation-backup "ERROR: ${message}"
}

# --- STEP 1: Compress Yesterday's Raw Log ---
if [ -f "$RAW_LOG_FILE" ]; then
    echo "Raw log file found: ${RAW_LOG_FILE}"
    echo "Compressing into ${ARCHIVE_PATH}..."
    
    # Compress raw log
    tar -czf "$ARCHIVE_PATH" -C "$LOG_DIR" "${LOG_PREFIX}-${YESTERDAY}.log"
    
    if [ $? -eq 0 ]; then
        echo "Compression completed successfully."
        # Verify archive size and existence
        if [ -s "$ARCHIVE_PATH" ]; then
            # Delete original raw text log immediately to free up space
            rm -f "$RAW_LOG_FILE"
            echo "Raw text log deleted to reclaim disk space."
        else
            err_msg="Archive file created but is empty (0 bytes): ${ARCHIVE_NAME}"
            echo "Error: ${err_msg}"
            send_notification "Log Rotation Error: ${err_msg}"
            exit 1
        fi
    else
        err_msg="Failed to compress ${RAW_LOG_FILE}!"
        echo "Error: ${err_msg}"
        send_notification "Log Rotation Error: ${err_msg}"
        exit 1
    fi
else
    # Log file might not exist if there was no traffic yesterday.
    echo "Warning: Raw log file not found for ${YESTERDAY}: ${RAW_LOG_FILE}"
fi

# --- STEP 2: Upload to Cloud (Google Drive) via Rclone ---
if [ -f "$ARCHIVE_PATH" ]; then
    echo "Uploading ${ARCHIVE_NAME} to Google Drive (${CLOUD_FOLDER})..."
    
    # Using 'rclone move' which deletes local file ONLY after successful upload
    rclone move "$ARCHIVE_PATH" "${RCLONE_REMOTE}:${CLOUD_FOLDER}/"
    
    if [ $? -eq 0 ]; then
        echo "Upload succeeded. File moved to Cloud successfully."
    else
        err_msg="Rclone upload failed for ${ARCHIVE_NAME}!"
        echo "Error: ${err_msg}"
        send_notification "Log Backup Error: ${err_msg}"
        exit 1
    fi
fi

# --- STEP 3: ClickHouse Data Retention Policy (Keep logs for last 7 days) ---
echo "Executing ClickHouse Data Retention Policy (Drop older than 7 days)..."
CH_QUERY="ALTER TABLE ${CH_DB}.${CH_TABLE} DELETE WHERE ${CH_TIME_COLUMN} < today() - 7"

# Execute ClickHouse query
# Try clickhouse-client first. If it's not installed or fails, try HTTP endpoint.
if command -v clickhouse-client >/dev/null 2>&1; then
    if [ -z "$CH_PASS" ]; then
        clickhouse-client --host "$CH_HOST" --port "$CH_PORT" --user "$CH_USER" --query "$CH_QUERY"
    else
        clickhouse-client --host "$CH_HOST" --port "$CH_PORT" --user "$CH_USER" --password "$CH_PASS" --query "$CH_QUERY"
    fi
    CH_STATUS=$?
else
    # Fallback to ClickHouse HTTP API
    echo "clickhouse-client not found. Falling back to HTTP API..."
    HTTP_URL="http://${CH_HOST}:8123/"
    if [ -n "$CH_PASS" ]; then
        curl -s -u "${CH_USER}:${CH_PASS}" --data-binary "${CH_QUERY}" "$HTTP_URL"
    else
        curl -s --data-binary "${CH_QUERY}" "$HTTP_URL"
    fi
    CH_STATUS=$?
fi

if [ $CH_STATUS -eq 0 ]; then
    echo "ClickHouse retention policy executed successfully."
else
    err_msg="Failed to run ClickHouse retention query!"
    echo "Warning: ${err_msg}"
    send_notification "ClickHouse warning: ${err_msg}"
fi

echo "Log rotation and backup completed successfully at $(date)"
echo "--------------------------------------------------------"
