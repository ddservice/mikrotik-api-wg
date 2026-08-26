// ============================================================
// backup.js - Export log tables to CSV and upload to
// Cloudflare R2 (S3-compatible) and Google Drive / NAS via rclone.
// Meant to run as a nightly cron job or manually.
//
// Usage:
//   node backup.js
//
// Config: reads the env block from ecosystem.config.js or process.env.
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Load env from ecosystem.config.js (single source of truth already used by PM2)
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

// Cloudflare R2 Configuration
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '78059e3268d79b09600de14776ad345a';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'd2f634ec540b296b0fb6323254aee1e6b59788d9ea9702318cf8603f344c0d64';
const R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://b8fd2913de1c592db914b68e01d645c8.r2.cloudflarestorage.com';
const R2_BUCKET = process.env.R2_BUCKET || 'ddservicedb';
const R2_SITE_NAME = process.env.R2_SITE_NAME || 'Mikrotikapi-db';

// Optional rclone remotes (e.g. "nas,gdrive")
const RCLONE_REMOTES = (process.env.BACKUP_RCLONE_REMOTES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const RCLONE_DEST_DIR = process.env.BACKUP_RCLONE_DEST_DIR || `${R2_BUCKET}/${R2_SITE_NAME}`;

function csvEscape(val) {
    return `"${String(val === undefined || val === null ? '' : val).replace(/"/g, '""')}"`;
}

function writeCsv(filePath, headers, rows, rowMapper) {
    const lines = ['\uFEFF' + headers.join(',')];
    for (const row of rows) {
        lines.push(rowMapper(row).map(csvEscape).join(','));
    }
    fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
    console.log(`[backup] Wrote ${rows.length} rows -> ${filePath}`);
}

// AWS SigV4 S3 Upload for Cloudflare R2 (Native Node.js, Zero External Deps)
function getSignatureKey(key, dateStamp, regionName, serviceName) {
    const kDate = crypto.createHmac('sha256', 'AWS4' + key).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(regionName).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
    return crypto.createHmac('sha256', kService).update('aws4_request').digest();
}

function uploadFileToR2(filePath, objectKey) {
    return new Promise((resolve, reject) => {
        const fileContent = fs.readFileSync(filePath);
        const endpointUrl = new URL(R2_ENDPOINT);
        const endpointHost = endpointUrl.hostname;
        const region = 'auto';
        const service = 's3';

        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);
        const payloadHash = crypto.createHash('sha256').update(fileContent).digest('hex');

        // Path-style S3 URI: /<bucket>/<key>
        const canonicalUri = '/' + encodeURI(R2_BUCKET + '/' + objectKey);
        const canonicalHeaders = 'host:' + endpointHost + '\n' + 'x-amz-content-sha256:' + payloadHash + '\n' + 'x-amz-date:' + amzDate + '\n';
        const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
        const canonicalRequest = 'PUT\n' + canonicalUri + '\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + payloadHash;

        const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
        const stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + credentialScope + '\n' + crypto.createHash('sha256').update(canonicalRequest).digest('hex');
        const signingKey = getSignatureKey(R2_SECRET_ACCESS_KEY, dateStamp, region, service);
        const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

        const authorizationHeader = 'AWS4-HMAC-SHA256 Credential=' + R2_ACCESS_KEY_ID + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

        const req = https.request({
            hostname: endpointHost,
            path: canonicalUri,
            method: 'PUT',
            headers: {
                'Host': endpointHost,
                'x-amz-date': amzDate,
                'x-amz-content-sha256': payloadHash,
                'Authorization': authorizationHeader,
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Length': fileContent.length
            }
        }, (res) => {
            let resBody = '';
            res.on('data', chunk => resBody += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`[R2] Uploaded: ${R2_BUCKET}/${objectKey} (${fileContent.length} bytes)`);
                    resolve();
                } else {
                    reject(new Error(`R2 Upload HTTP ${res.statusCode}: ${resBody || res.statusMessage}`));
                }
            });
        });

        req.on('error', reject);
        req.write(fileContent);
        req.end();
    });
}

async function main() {
    const today = new Date().toISOString().slice(0, 10);
    const scratchDir = path.join(require('os').tmpdir(), `mikrotik-backup-${today}`);
    fs.mkdirSync(scratchDir, { recursive: true });

    try {
        console.log(`[backup] Starting daily backup for ${today} ...`);
        const [activityLogs, hotspotLogs, dnsLogs, pppoeLogs] = await Promise.all([
            db.getAllLogsRaw(),
            db.getAllHotspotLogsRaw(),
            db.getAllDnsQueryLogsRaw(),
            db.getAllPppoeUsageLogsRaw()
        ]);

        const filesToUpload = [
            { file: `activity_logs_${today}.csv`, headers: ['เวลา', 'ผู้ใช้งาน', 'การกระทำ', 'รายละเอียด'], data: activityLogs, mapper: r => [r.timestamp, r.username, r.action, r.details] },
            { file: `hotspot_logs_${today}.csv`, headers: ['เวลาเข้าใช้', 'เวลาออก', 'ผู้ใช้', 'IP', 'MAC', 'ไซต์งาน', 'สถานะ', 'ดาวน์โหลด', 'อัปโหลด'], data: hotspotLogs, mapper: r => [r.loginTime, r.logoutTime, r.username, r.ipAddress, r.macAddress, r.siteName, r.status, r.bytesIn, r.bytesOut] },
            { file: `dns_query_logs_${today}.csv`, headers: ['เวลา', 'ผู้ใช้', 'IP', 'MAC', 'โดเมน', 'ไซต์งาน'], data: dnsLogs, mapper: r => [r.queryTime, r.username, r.ipAddress, r.macAddress, r.domain, r.siteName] },
            { file: `pppoe_usage_logs_${today}.csv`, headers: ['เวลาเข้าใช้', 'เวลาออก', 'ห้อง', 'IP', 'ไซต์งาน', 'สถานะ', 'ดาวน์โหลด', 'อัปโหลด'], data: pppoeLogs, mapper: r => [r.loginTime, r.logoutTime, r.username, r.ipAddress, r.siteName, r.status, r.bytesIn, r.bytesOut] }
        ];

        for (const item of filesToUpload) {
            writeCsv(path.join(scratchDir, item.file), item.headers, item.data, item.mapper);
        }

        // 1. Upload to Cloudflare R2 (Direct Native S3 API)
        if (R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_ENDPOINT) {
            console.log(`[backup] Uploading CSVs directly to Cloudflare R2 (${R2_BUCKET}/${R2_SITE_NAME}/${today}/) ...`);
            for (const item of filesToUpload) {
                const localPath = path.join(scratchDir, item.file);
                const r2Key = `${R2_SITE_NAME}/${today}/${item.file}`;
                await uploadFileToR2(localPath, r2Key);
            }
            console.log(`[backup] Successfully uploaded all CSVs to Cloudflare R2!`);
        }

        // 2. Upload via rclone if configured (e.g. NAS/GDrive)
        if (RCLONE_REMOTES.length > 0) {
            for (const remote of RCLONE_REMOTES) {
                const dest = `${remote}:${RCLONE_DEST_DIR}/${today}`;
                console.log(`[backup] Uploading via rclone to ${dest} ...`);
                try {
                    execSync(`rclone copy "${scratchDir}" "${dest}"`, { encoding: 'utf8', stdio: 'inherit' });
                    console.log(`[backup] Upload to ${remote} complete.`);
                } catch (rcloneErr) {
                    console.warn(`[backup] Warning: rclone upload to ${remote} failed:`, rcloneErr.message);
                }
            }
        }

        fs.rmSync(scratchDir, { recursive: true, force: true });
        console.log('[backup] Backup completed successfully. Scratch dir cleaned up.');
    } catch (e) {
        console.error('[backup] FAILED:', e.message);
        console.error(`[backup] Local files (if any) left at: ${scratchDir}`);
        process.exit(1);
    }
}

main();
