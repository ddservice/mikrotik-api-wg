/**
 * lib/dns-log-store.js — เก็บประวัติเข้าเว็บ (DNS) เป็นไฟล์รายวัน แทนแถวใน Postgres
 *
 * ทำไมถึงย้ายออกจากฐานข้อมูล: วัดจริงเมื่อ 2026-08-30 ได้ 342,109 รายการ/วัน
 * ซึ่งกินพื้นที่ใน Postgres ~85 MB/วัน แค่ 7 วันก็เกินโควตาฟรี 500 MB แล้ว
 * แต่ข้อมูลชุดเดียวกันเมื่อเก็บเป็น JSONL แล้ว gzip เหลือ 5.8 MB/วัน — เล็กกว่า 15 เท่า
 * ทั้ง 90 วันรวมทุกสาขาใช้แค่ ~0.5 GB ซึ่งอยู่ในดิสก์ VPS และโควตาฟรีของ R2 ได้สบาย
 *
 * ปัญหาจริงจึงไม่ใช่ "ข้อมูลเยอะเกินไป" แต่เป็น "เก็บผิดรูปแบบ" — ข้อมูลนี้เขียนครั้งเดียว
 * อ่านนาน ๆ ที และค้นตามช่วงวันเสมอ ซึ่งเป็นลักษณะของไฟล์ ไม่ใช่ของตารางที่ต้องมี index
 *
 * รูปแบบ:
 *   dns-logs/YYYY-MM-DD.jsonl        วันที่ยังไม่ปิด — เขียนต่อท้ายอย่างเดียว
 *   archives/YYYY-MM-DD-dns.jsonl.gz วันที่ปิดแล้ว — บีบอัดและมี SHA-256 กำกับ
 *   dns-logs/index.json              จำนวนแถวต่อวัน ใช้ตอบ "มีกี่รายการ" โดยไม่ต้องอ่านไฟล์
 *
 * วันถูกตัดตามเวลาไทย ไม่ใช่ UTC เพราะไฟล์ปิดผนึกรายวันต้องตรงกับวันตามปฏิทินจริง
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { bangkokToday, shiftDate } = require('./time');

const ROOT = path.join(__dirname, '..');
const LIVE_DIR = path.join(ROOT, 'dns-logs');
const ARCHIVE_DIR = path.join(ROOT, 'archives');
const INDEX_FILE = path.join(LIVE_DIR, 'index.json');

// กันการค้นที่กินเวลานานเกินไปจนหน้าเว็บค้าง — ค้นทีละช่วงสั้น ๆ เป็นเรื่องปกติอยู่แล้ว
// เพราะการขอ log ตามกฎหมายมักระบุช่วงวันมาชัดเจน
const MAX_SCAN_DAYS = Number(process.env.DNS_MAX_SCAN_DAYS || 31);

function ensureDir(d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function livePath(dateStr) {
    return path.join(LIVE_DIR, dateStr + '.jsonl');
}

function sealedPath(dateStr) {
    return path.join(ARCHIVE_DIR, dateStr + '-dns.jsonl.gz');
}

/** วันตามเวลาไทยของ timestamp หนึ่ง ๆ */
function dayOf(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return bangkokToday();
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

// ---------- ดัชนีจำนวนแถวต่อวัน ----------

function readIndex() {
    try {
        return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) || {};
    } catch (_) {
        return {};   // ดัชนีเสียหาย = นับใหม่จากไฟล์ได้ ไม่ใช่เรื่องคอขาดบาดตาย
    }
}

function writeIndex(idx) {
    try {
        ensureDir(LIVE_DIR);
        const tmp = INDEX_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(idx));
        fs.renameSync(tmp, INDEX_FILE);
    } catch (e) {
        console.warn('[DnsStore] เขียนดัชนีไม่สำเร็จ:', e.message);
    }
}

// ---------- เขียน ----------

/**
 * เขียนแถวใหม่ต่อท้ายไฟล์ของวันนั้น
 * แถวถูกแยกตาม queryTime ของตัวเอง ไม่ใช่เวลาที่เรียกฟังก์ชัน — แถวที่ข้ามเที่ยงคืน
 * จึงไปอยู่ในไฟล์ของวันที่ถูกต้อง
 */
function appendRows(rows) {
    if (!rows || !rows.length) return 0;
    ensureDir(LIVE_DIR);

    const byDay = new Map();
    for (const r of rows) {
        const day = dayOf(r.queryTime);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(JSON.stringify({
            id: r.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
            queryTime: r.queryTime,
            username: r.username || '',
            ipAddress: r.ipAddress || '',
            macAddress: r.macAddress || '',
            domain: r.domain || '',
            siteName: r.siteName || ''
        }));
    }

    const idx = readIndex();
    let written = 0;
    for (const [day, lines] of byDay.entries()) {
        try {
            // เขียนครั้งเดียวต่อวัน ไม่ใช่ต่อแถว — ลด syscall และทำให้ batch หนึ่งไม่ขาดกลางคัน
            fs.appendFileSync(livePath(day), lines.join('\n') + '\n');
            idx[day] = idx[day] || { rows: 0 };
            idx[day].rows += lines.length;
            written += lines.length;
        } catch (e) {
            console.error('[DnsStore] เขียนไฟล์วันที่ ' + day + ' ไม่สำเร็จ:', e.message);
        }
    }
    writeIndex(idx);
    return written;
}

// ---------- อ่าน ----------

/** อ่านทั้งวันกลับมาเป็น array (ลองไฟล์สด ก่อนไปหาไฟล์ที่ปิดผนึกแล้ว) */
function readDay(dateStr) {
    let raw = null;
    try {
        if (fs.existsSync(livePath(dateStr))) {
            raw = fs.readFileSync(livePath(dateStr), 'utf8');
        } else if (fs.existsSync(sealedPath(dateStr))) {
            raw = zlib.gunzipSync(fs.readFileSync(sealedPath(dateStr))).toString('utf8');
        }
    } catch (e) {
        console.warn('[DnsStore] อ่านวันที่ ' + dateStr + ' ไม่สำเร็จ:', e.message);
        return [];
    }
    if (!raw) return [];

    const out = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch (_) { /* ข้ามบรรทัดที่เสีย ไม่ทิ้งทั้งไฟล์ */ }
    }
    return out;
}

function hasDay(dateStr) {
    return fs.existsSync(livePath(dateStr)) || fs.existsSync(sealedPath(dateStr));
}

/** รายชื่อวันที่มีข้อมูล เรียงจากเก่าไปใหม่ */
function listDays() {
    const days = new Set();
    for (const [dir, re] of [[LIVE_DIR, /^(\d{4}-\d{2}-\d{2})\.jsonl$/],
                             [ARCHIVE_DIR, /^(\d{4}-\d{2}-\d{2})-dns\.jsonl\.gz$/]]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            const m = re.exec(f);
            if (m) days.add(m[1]);
        }
    }
    return [...days].sort();
}

function matches(row, opts) {
    if (opts.username && row.username !== opts.username) return false;
    if (opts.siteName && row.siteName !== opts.siteName) return false;
    if (opts.q) {
        const q = opts.q;
        if (!(String(row.username).toLowerCase().includes(q) ||
              String(row.ipAddress).toLowerCase().includes(q) ||
              String(row.macAddress).toLowerCase().includes(q) ||
              String(row.domain).toLowerCase().includes(q))) return false;
    }
    return true;
}

/**
 * ค้นหาแบบเดียวกับ db.getDnsQueryLogs — คืนรูปแบบเดียวกันเป๊ะเพื่อให้หน้าเว็บไม่ต้องแก้
 *
 * ไล่อ่านจากวันใหม่ไปเก่า เพราะผลลัพธ์เรียงจากใหม่ไปเก่าอยู่แล้ว หน้าแรก ๆ
 * จึงได้คำตอบโดยไม่ต้องอ่านทั้งช่วง
 */
function query(options = {}) {
    const limit = parseInt(options.limit) || 100;
    const page = parseInt(options.page) || 1;
    const q = options.search ? String(options.search).trim().toLowerCase() : '';
    const opts = { q, username: options.username || '', siteName: options.siteName || '' };

    const all = listDays();
    let days = all;
    if (options.from) days = days.filter((d) => d >= String(options.from).slice(0, 10));
    if (options.to) days = days.filter((d) => d <= String(options.to).slice(0, 10));
    days.sort().reverse();   // ใหม่ก่อน

    let truncated = false;
    if (days.length > MAX_SCAN_DAYS) {
        days = days.slice(0, MAX_SCAN_DAYS);
        truncated = true;
    }

    const skip = (page - 1) * limit;
    const collected = [];
    let total = 0;

    for (const day of days) {
        // ต้องเรียงตามเวลาจริง ไม่ใช่ยึดลำดับในไฟล์
        //
        // ไฟล์เขียนต่อท้ายตามลำดับที่ poller อ่านมาเจอ ซึ่งส่วนใหญ่เรียงตามเวลาอยู่แล้ว
        // แต่ไม่เสมอไป: บัฟเฟอร์ของเราท์เตอร์ถูกอ่านซ้ำ แถวที่มาถึงช้าจึงถูกเขียนต่อท้าย
        // ทั้งที่เวลาเก่ากว่าแถวก่อนหน้า การกลับด้านลำดับไฟล์เฉย ๆ จึงให้ผลผิดลำดับ
        // (เทสต์จับได้ 2026-08-30)
        //
        // เรียงทีละวันแล้วไล่วันจากใหม่ไปเก่า — ทุกแถวของวันที่ใหม่กว่าย่อมใหม่กว่า
        // ทุกแถวของวันก่อนหน้าเสมอ ลำดับรวมจึงถูกต้องโดยไม่ต้องโหลดทั้งช่วงมาเรียงพร้อมกัน
        const rows = readDay(day);
        rows.sort((a, b) => String(b.queryTime).localeCompare(String(a.queryTime)));

        for (const r of rows) {
            if (!matches(r, opts)) continue;
            total++;
            if (total > skip && collected.length < limit) collected.push(r);
        }
    }

    return {
        logs: collected,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 0,
        truncated,                       // บอกหน้าเว็บว่าช่วงที่ขอกว้างเกินกว่าที่อ่านจริง
        scannedDays: days.length,
        source: 'file'
    };
}

/** จำนวนแถวรวมทุกวัน จากดัชนี — ไม่ต้องอ่านไฟล์ */
function stats() {
    const idx = readIndex();
    const days = listDays();
    let rows = 0;
    let bytes = 0;

    for (const d of days) {
        rows += (idx[d] && idx[d].rows) || 0;
        for (const p of [livePath(d), sealedPath(d)]) {
            try { if (fs.existsSync(p)) bytes += fs.statSync(p).size; } catch (_) {}
        }
    }
    return {
        days: days.length,
        oldest: days[0] || null,
        newest: days[days.length - 1] || null,
        rows,
        bytes
    };
}

// ---------- ปิดวัน / ลบของเก่า ----------

/**
 * อ่านไฟล์สดของวันหนึ่งเพื่อเอาไปปิดผนึก แล้วลบไฟล์สดทิ้งหลังปิดผนึกสำเร็จ
 * ต้องเรียกหลังจากไฟล์ .gz ถูกเขียนและบันทึกลงทะเบียนเรียบร้อยแล้วเท่านั้น
 */
function dropLiveFile(dateStr) {
    try {
        if (fs.existsSync(livePath(dateStr))) fs.unlinkSync(livePath(dateStr));
        return true;
    } catch (e) {
        console.warn('[DnsStore] ลบไฟล์สดของ ' + dateStr + ' ไม่สำเร็จ:', e.message);
        return false;
    }
}

/**
 * ลบข้อมูลที่เกินระยะเก็บ (ม.26 = 90 วัน)
 * ลบทั้งไฟล์สดและไฟล์ปิดผนึก เพราะการเก็บเกินกำหนดก็ผิดหลักการเช่นกัน
 */
function purgeOld(retentionDays = 90) {
    const cutoff = shiftDate(bangkokToday(), -retentionDays);
    const idx = readIndex();
    let removed = 0;
    let bytes = 0;

    for (const day of listDays()) {
        if (day >= cutoff) continue;
        for (const p of [livePath(day), sealedPath(day)]) {
            try {
                if (!fs.existsSync(p)) continue;
                bytes += fs.statSync(p).size;
                fs.unlinkSync(p);
                removed++;
            } catch (e) {
                console.warn('[DnsStore] ลบ ' + p + ' ไม่สำเร็จ:', e.message);
            }
        }
        delete idx[day];
    }
    writeIndex(idx);
    return { removedFiles: removed, freedBytes: bytes, cutoff };
}

module.exports = {
    LIVE_DIR,
    MAX_SCAN_DAYS,
    dayOf,
    livePath,
    sealedPath,
    appendRows,
    readDay,
    hasDay,
    listDays,
    query,
    stats,
    dropLiveFile,
    purgeOld
};
