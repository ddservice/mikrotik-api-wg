#!/usr/bin/env node
/**
 * cleanup-old-backups.js — ลบไฟล์เก่าเกินกำหนดทั้งบน VPS และ Cloudflare R2
 *
 * ครอบคลุม 3 ที่ (ก่อนหน้านี้ไม่มีการลบเลยสักที่ ของสะสมไปเรื่อย ๆ):
 *   1. logs/           — log ที่ PM2 หมุนไว้ (error__YYYY-MM-DD.log / out__...)
 *   2. backups/        — โฟลเดอร์ backup ในโปรเจกต์
 *   3. archives/       — ไฟล์ log ปิดผนึกรายวัน (พรบ. ม.26 เก็บ 90 วันเท่ากับในฐานข้อมูล)
 *   4. Cloudflare R2   — object ใต้ <R2_SITE_NAME>/YYYY-MM-DD/
 *
 * ปลอดภัยโดยออกแบบ:
 *   - ค่าเริ่มต้นเป็น dry-run ต้องใส่ --apply ถึงจะลบจริง
 *   - แตะเฉพาะไฟล์ที่ชื่อ/พาธเข้าแพตเทิร์นของ backup และ log ที่หมุนแล้วเท่านั้น
 *     ไม่แตะ out.log / error.log ที่ PM2 กำลังเขียนอยู่
 *   - ไม่แตะ ecosystem.config.js, db/*.json หรืออะไรก็ตามนอกโฟลเดอร์ที่ระบุ
 *   - เก็บ backup ล่าสุดไว้เสมออย่างน้อย MIN_KEEP ชุด แม้จะเก่ากว่ากำหนด
 *     (กันเคสระบบหยุดสำรองไปนานแล้วมาลบของเก่าทิ้งจนไม่เหลืออะไรเลย)
 *
 * ใช้:
 *   node scripts/cleanup-old-backups.js              # ดูว่าจะลบอะไร
 *   node scripts/cleanup-old-backups.js --apply      # ลบจริง
 *   node scripts/cleanup-old-backups.js --days 60 --apply
 *   node scripts/cleanup-old-backups.js --local-only --apply
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LOCAL_ONLY = args.includes('--local-only');
const R2_ONLY = args.includes('--r2-only');
const daysIdx = args.indexOf('--days');
const RETENTION_DAYS = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 90;

// เก็บชุดล่าสุดไว้เท่านี้เสมอ ต่อให้เก่ากว่ากำหนด
const MIN_KEEP = 3;

const CUTOFF = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_BUCKET = process.env.R2_BUCKET || 'ddservicedb';
const R2_SITE_NAME = process.env.R2_SITE_NAME || 'Mikrotikapi-db';

function human(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const u = ['KB', 'MB', 'GB'];
    let i = -1;
    do { bytes /= 1024; i++; } while (bytes >= 1024 && i < u.length - 1);
    return bytes.toFixed(1) + ' ' + u[i];
}

function ageDays(ms) {
    return Math.floor((Date.now() - ms) / 86400000);
}

// ---------------------------------------------------------------- local logs
// เฉพาะ log ที่ PM2 หมุนแล้ว (มี timestamp ในชื่อ) — out.log / error.log ที่กำลัง
// ถูกเขียนอยู่ต้องไม่โดนแตะ ไม่งั้น PM2 จะเขียนลง inode ที่ถูกลบไปแล้ว
const ROTATED_LOG = /^(out|error)__\d{4}-\d{2}-\d{2}.*\.log$/;

function cleanRotatedLogs() {
    const dir = path.join(ROOT, 'logs');
    if (!fs.existsSync(dir)) return { removed: 0, bytes: 0 };
    let removed = 0;
    let bytes = 0;
    const victims = [];
    for (const name of fs.readdirSync(dir)) {
        if (!ROTATED_LOG.test(name)) continue;
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.mtimeMs >= CUTOFF) continue;
        victims.push({ name, full, size: st.size, age: ageDays(st.mtimeMs) });
    }
    victims.sort((a, b) => a.age - b.age);
    for (const v of victims) {
        console.log(`   ${APPLY ? 'ลบ' : 'จะลบ'} logs/${v.name}  (${human(v.size)}, เก่า ${v.age} วัน)`);
        if (APPLY) fs.unlinkSync(v.full);
        removed++;
        bytes += v.size;
    }
    if (!victims.length) console.log('   ไม่มี log เก่าเกินกำหนด');
    return { removed, bytes };
}

// -------------------------------------------------------------- local backups
function dirSize(p) {
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    }
    return total;
}

function cleanLocalBackups() {
    const dir = path.join(ROOT, 'backups');
    if (!fs.existsSync(dir)) return { removed: 0, bytes: 0 };

    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .map((e) => {
            const full = path.join(dir, e.name);
            const st = fs.statSync(full);
            return { name: e.name, full, isDir: e.isDirectory(), mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime); // ใหม่สุดก่อน

    let removed = 0;
    let bytes = 0;
    const victims = [];
    entries.forEach((e, idx) => {
        if (idx < MIN_KEEP) return;          // เก็บชุดล่าสุดไว้เสมอ
        if (e.mtime >= CUTOFF) return;
        victims.push(e);
    });

    for (const v of victims) {
        const size = v.isDir ? dirSize(v.full) : fs.statSync(v.full).size;
        console.log(`   ${APPLY ? 'ลบ' : 'จะลบ'} backups/${v.name}  (${human(size)}, เก่า ${ageDays(v.mtime)} วัน)`);
        if (APPLY) fs.rmSync(v.full, { recursive: true, force: true });
        removed++;
        bytes += size;
    }
    if (!victims.length) {
        console.log(`   ไม่มี backup เก่าเกินกำหนด (เก็บชุดล่าสุดไว้ ${MIN_KEEP} ชุดเสมอ)`);
    }
    return { removed, bytes };
}

// ------------------------------------------------------------- local archives
// ไฟล์ปิดผนึกตั้งชื่อเป็น YYYY-MM-DD-<type>.jsonl.gz — ใช้วันที่ในชื่อไฟล์เป็นเกณฑ์
// ไม่ใช้ mtime เพราะการคัดลอกไฟล์หรือย้ายเครื่องจะทำให้ mtime เปลี่ยน
//
// เก็บ 90 วันเท่ากับที่ฐานข้อมูล purge log ดิบ — ถ้าเก็บ archive นานกว่านั้น
// จะมีไฟล์ที่อ้างถึงข้อมูลที่ไม่มีในระบบแล้ว ซึ่งสับสนเวลาตรวจสอบ
const ARCHIVE_NAME = /^(\d{4}-\d{2}-\d{2})-(dns|hotspot)\.jsonl\.gz$/;

function cleanLogArchives() {
    const dir = path.join(ROOT, 'archives');
    if (!fs.existsSync(dir)) {
        console.log('   ยังไม่มีโฟลเดอร์ archives/');
        return { removed: 0, bytes: 0 };
    }

    const files = fs.readdirSync(dir)
        .map((name) => {
            const m = ARCHIVE_NAME.exec(name);
            return m ? { name, date: m[1], full: path.join(dir, name) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.date < b.date ? 1 : -1));   // ใหม่สุดก่อน

    let removed = 0;
    let bytes = 0;
    const victims = files.filter((f, idx) =>
        idx >= MIN_KEEP && new Date(f.date + 'T00:00:00Z').getTime() < CUTOFF
    );

    for (const v of victims) {
        const size = fs.statSync(v.full).size;
        console.log(`   ${APPLY ? 'ลบ' : 'จะลบ'} archives/${v.name}  (${human(size)}, ${v.date})`);
        if (APPLY) fs.unlinkSync(v.full);
        removed++;
        bytes += size;
    }
    if (!victims.length) console.log(`   ไม่มีไฟล์ปิดผนึกเก่าเกินกำหนด (พบ ${files.length} ไฟล์)`);
    return { removed, bytes };
}

// ------------------------------------------------------------------ R2 (SigV4)
function signingKey(key, dateStamp, region, service) {
    const kDate = crypto.createHmac('sha256', 'AWS4' + key).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    return crypto.createHmac('sha256', kService).update('aws4_request').digest();
}

function r2Request(method, canonicalUri, queryString, body) {
    return new Promise((resolve, reject) => {
        const endpointUrl = new URL(R2_ENDPOINT);
        const host = endpointUrl.hostname;
        const region = 'auto';
        const service = 's3';
        const payload = body || '';
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);
        const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');

        const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
        const canonicalRequest = [method, canonicalUri, queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');

        const scope = `${dateStamp}/${region}/${service}/aws4_request`;
        const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
            crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
        const sig = crypto.createHmac('sha256', signingKey(R2_SECRET_ACCESS_KEY, dateStamp, region, service))
            .update(stringToSign).digest('hex');

        const headers = {
            Host: host,
            'x-amz-date': amzDate,
            'x-amz-content-sha256': payloadHash,
            Authorization: `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
        };
        if (payload) {
            headers['Content-Length'] = Buffer.byteLength(payload);
            headers['Content-Type'] = 'application/xml';
            headers['Content-MD5'] = crypto.createHash('md5').update(payload).digest('base64');
        }

        const req = https.request({
            hostname: host,
            path: canonicalUri + (queryString ? '?' + queryString : ''),
            method,
            headers,
            timeout: 20000
        }, (res) => {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) return resolve(b);
                reject(new Error(`R2 ${method} HTTP ${res.statusCode}: ${b.slice(0, 300)}`));
            });
        });
        req.on('timeout', () => req.destroy(new Error('R2 ไม่ตอบกลับภายใน 20 วินาที')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function listAllR2Objects(prefix) {
    const out = [];
    let token = null;
    do {
        const qs = [
            'list-type=2',
            'max-keys=1000',
            'prefix=' + encodeURIComponent(prefix)
        ];
        if (token) qs.push('continuation-token=' + encodeURIComponent(token));
        // R2/S3 ต้องเรียง query string ตามตัวอักษรตอนเซ็น
        qs.sort();
        const xml = await r2Request('GET', '/' + R2_BUCKET, qs.join('&'), '');
        const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
        const dates = [...xml.matchAll(/<LastModified>([^<]+)<\/LastModified>/g)].map((m) => m[1]);
        const sizes = [...xml.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => parseInt(m[1], 10));
        keys.forEach((k, i) => out.push({ key: k, lastModified: dates[i], size: sizes[i] || 0 }));
        const more = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
        token = more && t ? t[1] : null;
    } while (token);
    return out;
}

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function deleteR2Objects(keys) {
    // DeleteObjects รับได้ทีละ 1000 key
    for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const body = '<?xml version="1.0" encoding="UTF-8"?>' +
            '<Delete><Quiet>true</Quiet>' +
            batch.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('') +
            '</Delete>';
        await r2Request('POST', '/' + R2_BUCKET, 'delete=', body);
    }
}

// โฟลเดอร์บน R2 ตั้งชื่อเป็น <site>/YYYY-MM-DD/... — ใช้วันที่ในพาธเป็นเกณฑ์
// น่าเชื่อถือกว่า LastModified เพราะการอัปซ้ำ/ย้ายไฟล์จะทำให้ LastModified ขยับ
const DATE_IN_KEY = /\/(\d{4}-\d{2}-\d{2})\//;

async function cleanR2() {
    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ENDPOINT) {
        console.log('   ข้าม R2 — ยังไม่ได้ตั้งค่า R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT');
        return { removed: 0, bytes: 0 };
    }

    const prefix = R2_SITE_NAME + '/';
    const objects = await listAllR2Objects(prefix);
    console.log(`   พบ ${objects.length} object ใต้ ${R2_BUCKET}/${prefix}`);

    // จัดกลุ่มตามวันที่ในพาธ
    const byDate = new Map();
    for (const o of objects) {
        const m = DATE_IN_KEY.exec('/' + o.key.slice(prefix.length));
        const d = m ? m[1] : null;
        if (!d) continue; // ไม่เข้าแพตเทิร์นวันที่ = ไม่ใช่ backup ประจำวัน ไม่แตะ
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(o);
    }

    const dates = [...byDate.keys()].sort().reverse(); // ใหม่สุดก่อน
    const victims = [];
    dates.forEach((d, idx) => {
        if (idx < MIN_KEEP) return; // เก็บชุดล่าสุดไว้เสมอ
        if (new Date(d + 'T00:00:00Z').getTime() >= CUTOFF) return;
        victims.push(d);
    });

    if (!victims.length) {
        console.log(`   ไม่มี backup บน R2 เก่าเกินกำหนด (เก็บชุดล่าสุดไว้ ${MIN_KEEP} วันเสมอ)`);
        return { removed: 0, bytes: 0 };
    }

    let keys = [];
    let bytes = 0;
    for (const d of victims) {
        const group = byDate.get(d);
        const gb = group.reduce((a, o) => a + o.size, 0);
        console.log(`   ${APPLY ? 'ลบ' : 'จะลบ'} ${prefix}${d}/  (${group.length} ไฟล์, ${human(gb)})`);
        keys = keys.concat(group.map((o) => o.key));
        bytes += gb;
    }
    if (APPLY) await deleteR2Objects(keys);
    return { removed: keys.length, bytes };
}

// ---------------------------------------------------------------------- main
(async () => {
    console.log('');
    console.log(APPLY ? '*** โหมดลบจริง (--apply) ***' : '*** DRY RUN — ยังไม่ลบอะไร ใส่ --apply เพื่อลบจริง ***');
    console.log(`เก็บย้อนหลัง ${RETENTION_DAYS} วัน (ตัดที่ ${new Date(CUTOFF).toISOString().slice(0, 10)}) | เก็บชุดล่าสุดอย่างน้อย ${MIN_KEEP} ชุดเสมอ`);
    console.log('');

    let totalFiles = 0;
    let totalBytes = 0;

    if (!R2_ONLY) {
        console.log('=== 1) log ที่หมุนแล้วใน logs/ ===');
        const a = cleanRotatedLogs();
        totalFiles += a.removed; totalBytes += a.bytes;

        console.log('');
        console.log('=== 2) backups/ ในโปรเจกต์ ===');
        const b = cleanLocalBackups();
        totalFiles += b.removed; totalBytes += b.bytes;

        console.log('');
        console.log('=== 3) archives/ ไฟล์ log ปิดผนึก (พรบ. ม.26) ===');
        const c = cleanLogArchives();
        totalFiles += c.removed; totalBytes += c.bytes;
    }

    if (!LOCAL_ONLY) {
        console.log('');
        console.log('=== 4) Cloudflare R2 ===');
        try {
            const c = await cleanR2();
            totalFiles += c.removed; totalBytes += c.bytes;
        } catch (e) {
            console.log('   R2 ล้มเหลว:', e.message);
        }
    }

    console.log('');
    console.log(`สรุป: ${APPLY ? 'ลบแล้ว' : 'จะลบ'} ${totalFiles} รายการ คืนพื้นที่ ${human(totalBytes)}`);
    if (!APPLY) console.log('นี่คือ dry-run — ใส่ --apply เพื่อลบจริง');
    process.exit(0);
})().catch((e) => {
    console.error('ล้มเหลว:', e.message);
    process.exit(1);
});
