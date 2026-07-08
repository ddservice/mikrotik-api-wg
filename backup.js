// ============================================================
// backup.js - Export Supabase log tables to CSV and upload to
// Google Drive / NAS via rclone. Meant to run as a cron job
// (not under PM2 - it's a one-shot batch job, not a service).
//
// Usage:
//   node backup.js
//
// Config: reads the same env block PM2 uses (ecosystem.config.js),
// so no separate secrets file is needed. Falls back to whatever is
// already in process.env if a key is set there instead (e.g. if you
// prefer exporting vars directly in the crontab line).
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or JSON-file mode,
// which needs nothing extra), BACKUP_RCLONE_REMOTES (comma-separated
// rclone remote names, e.g. "gdrive,nas" - configure each remote once
// via `rclone config` before relying on this script).
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load env from ecosystem.config.js (single source of truth already used
// by PM2), without requiring a separate dotenv dependency. Explicit env
// vars already set (e.g. by the crontab line) take precedence.
try {
    const ecosystemConfig = require('./ecosystem.config.js');
    const envFromConfig = (ecosystemConfig.apps && ecosystemConfig.apps[0] && ecosystemConfig.apps[0].env) || {};
    for (const key of Object.keys(envFromConfig)) {
        if (process.env[key] === undefined) process.env[key] = envFromConfig[key];
    }
} catch (e) {
    console.warn('[backup] Could not load ecosystem.config.js, relying on process.env only:', e.message);
}

const db = process.env.SUPABASE_URL ? require('./db-supabase') : require('./db');
console.log(`[backup] Using DB: ${process.env.SUPABASE_URL ? 'Supabase (PostgreSQL)' : 'Local JSON files'}`);

const RCLONE_REMOTES = (process.env.BACKUP_RCLONE_REMOTES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const RCLONE_DEST_DIR = process.env.BACKUP_RCLONE_DEST_DIR || 'Mikrotik_Logs';

function csvEscape(val) {
    return `"${String(val === undefined || val === null ? '' : val).replace(/"/g, '""')}"`;
}

function writeCsv(filePath, headers, rows, rowMapper) {
    const lines = ['﻿' + headers.join(',')];
    for (const row of rows) {
        lines.push(rowMapper(row).map(csvEscape).join(','));
    }
    fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
    console.log(`[backup] Wrote ${rows.length} rows -> ${filePath}`);
}

async function main() {
    const today = new Date().toISOString().slice(0, 10);
    const scratchDir = path.join(require('os').tmpdir(), `mikrotik-backup-${today}`);
    fs.mkdirSync(scratchDir, { recursive: true });

    try {
        const [activityLogs, hotspotLogs, dnsLogs, pppoeLogs] = await Promise.all([
            db.getAllLogsRaw(),
            db.getAllHotspotLogsRaw(),
            db.getAllDnsQueryLogsRaw(),
            db.getAllPppoeUsageLogsRaw()
        ]);

        writeCsv(
            path.join(scratchDir, `activity_logs_${today}.csv`),
            ['เวลา', 'ผู้ใช้งาน', 'การกระทำ', 'รายละเอียด'],
            activityLogs,
            r => [r.timestamp, r.username, r.action, r.details]
        );

        writeCsv(
            path.join(scratchDir, `hotspot_logs_${today}.csv`),
            ['เวลาเข้าใช้', 'เวลาออก', 'ผู้ใช้', 'IP', 'MAC', 'ไซต์งาน', 'สถานะ', 'ดาวน์โหลด', 'อัปโหลด'],
            hotspotLogs,
            r => [r.loginTime, r.logoutTime, r.username, r.ipAddress, r.macAddress, r.siteName, r.status, r.bytesIn, r.bytesOut]
        );

        writeCsv(
            path.join(scratchDir, `dns_query_logs_${today}.csv`),
            ['เวลา', 'ผู้ใช้', 'IP', 'MAC', 'โดเมน', 'ไซต์งาน'],
            dnsLogs,
            r => [r.queryTime, r.username, r.ipAddress, r.macAddress, r.domain, r.siteName]
        );

        writeCsv(
            path.join(scratchDir, `pppoe_usage_logs_${today}.csv`),
            ['เวลาเข้าใช้', 'เวลาออก', 'ห้อง', 'IP', 'ไซต์งาน', 'สถานะ', 'ดาวน์โหลด', 'อัปโหลด'],
            pppoeLogs,
            r => [r.loginTime, r.logoutTime, r.username, r.ipAddress, r.siteName, r.status, r.bytesIn, r.bytesOut]
        );

        if (RCLONE_REMOTES.length === 0) {
            console.warn('[backup] BACKUP_RCLONE_REMOTES not set - CSVs written locally only, nothing uploaded:', scratchDir);
            return;
        }

        for (const remote of RCLONE_REMOTES) {
            const dest = `${remote}:${RCLONE_DEST_DIR}/${today}`;
            console.log(`[backup] Uploading to ${dest} ...`);
            execSync(`rclone copy "${scratchDir}" "${dest}"`, { encoding: 'utf8', stdio: 'inherit' });
            console.log(`[backup] Upload to ${remote} complete.`);
        }

        fs.rmSync(scratchDir, { recursive: true, force: true });
        console.log('[backup] Done, scratch dir cleaned up.');
    } catch (e) {
        console.error('[backup] FAILED:', e.message);
        console.error(`[backup] Local files (if any) left at: ${scratchDir}`);
        process.exit(1);
    }
}

main();
