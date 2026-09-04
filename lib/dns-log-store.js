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

/**
 * ไล่อ่านทีละบรรทัดแบบสตรีม โดยไม่โหลดทั้งวันเข้าหน่วยความจำ
 *
 * ทำไมต้องสตรีม: วัดบนเครื่องจริง วันที่มี 342,109 แถว การอ่านทั้งวันเข้ามาเป็น array
 * ใช้ heap ~295 MB ขณะที่ PM2 ตั้ง max_memory_restart ไว้ 500M และ process ปกติใช้ 93 MB
 * แค่สอง query พร้อมกันก็ทะลุลิมิตและ PM2 จะรีสตาร์ตกลางคำขอ
 * แบบสตรีมใช้หน่วยความจำคงที่ไม่ว่าไฟล์จะใหญ่แค่ไหน
 *
 * onRow คืน false เพื่อสั่งหยุดอ่านกลางคันได้
 */
function scanDay(dateStr, onRow) {
    return new Promise((resolve, reject) => {
        const live = livePath(dateStr);
        const sealed = sealedPath(dateStr);
        let stream;

        try {
            if (fs.existsSync(live)) {
                stream = fs.createReadStream(live, { encoding: 'utf8' });
            } else if (fs.existsSync(sealed)) {
                stream = fs.createReadStream(sealed).pipe(zlib.createGunzip());
                stream.setEncoding('utf8');
            } else {
                return resolve(0);
            }
        } catch (e) {
            return reject(e);
        }

        let buf = '';
        let count = 0;
        let stopped = false;

        const handleLine = (line) => {
            if (!line) return;
            let row;
            try { row = JSON.parse(line); } catch (_) { return; }   // ข้ามบรรทัดเสีย
            count++;
            if (onRow(row) === false) stopped = true;
        };

        stream.on('data', (chunk) => {
            if (stopped) return;
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                handleLine(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                if (stopped) { stream.destroy(); return; }
            }
        });
        stream.on('error', (e) => reject(e));
        stream.on('close', () => { if (stopped) resolve(count); });
        stream.on('end', () => {
            if (!stopped && buf) handleLine(buf);
            resolve(count);
        });
    });
}

/**
 * เปิดสตรีมของไฟล์วันนั้น (ไฟล์สด หรือไฟล์ปิดผนึกที่ต้องคลายบีบอัด)
 * คืน null ถ้าวันนั้นไม่มีไฟล์
 */
function openDayStream(dateStr) {
    const live = livePath(dateStr);
    const sealed = sealedPath(dateStr);
    if (fs.existsSync(live)) return fs.createReadStream(live, { encoding: 'utf8' });
    if (fs.existsSync(sealed)) {
        const s = fs.createReadStream(sealed).pipe(zlib.createGunzip());
        s.setEncoding('utf8');
        return s;
    }
    return null;
}

/**
 * ไล่อ่านทีละแถวแบบ async iterator
 *
 * ต่างจาก scanDay ตรงที่ผู้เรียก await ระหว่างกลางได้ ซึ่งจำเป็นตอนส่งออก
 * เพราะต้องรอเขียนลง response (backpressure) ก่อนอ่านแถวถัดไป
 * ถ้าใช้ callback แบบ scanDay จะ await ข้างในไม่ได้ ต้องกองทั้งวันไว้ก่อน
 * ซึ่งคือปัญหาหน่วยความจำที่ตั้งใจจะหนีมาพอดี
 */
// คืนเป็น "ชุด" ไม่ใช่ทีละแถว
//
// async generator มีค่าใช้จ่ายต่อการ yield หนึ่งครั้งพอสมควร (แต่ละครั้งคือ promise)
// วัดจริงกับวันที่มี 580,000 แถว: yield ทีละแถวใช้เวลา 46 วินาที ขณะที่ข้อมูลชุดเดียวกัน
// อ่านแบบ callback ใช้ 8 วินาที — คืนเป็นชุดตามก้อนที่สตรีมส่งมาทำให้จำนวน yield
// ลดจากหลักแสนเหลือหลักพัน โดยยังหยุดรอ backpressure ระหว่างชุดได้เหมือนเดิม
async function* iterDay(dateStr) {
    const stream = openDayStream(dateStr);
    if (!stream) return;

    let buf = '';
    for await (const chunk of stream) {
        buf += chunk;
        let nl;
        const batch = [];
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { batch.push(JSON.parse(line)); } catch (_) { /* ข้ามบรรทัดเสีย */ }
        }
        if (batch.length) yield batch;
    }
    if (buf) {
        try { yield [JSON.parse(buf)]; } catch (_) { /* บรรทัดท้ายไม่ครบ */ }
    }
}

/**
 * อ่านทั้งวันกลับมาเป็น array
 * ใช้เฉพาะกับวันที่รู้ว่าเล็ก หรือในเทสต์ — เส้นทางที่ผู้ใช้เรียกให้ใช้ scanDay แทน
 */
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
async function query(options = {}) {
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
    let readDays = 0;   // จำนวนวันที่ต้องเปิดไฟล์อ่านจริง (ไม่ใช่จำนวนวันในช่วง)

    // เก็บเฉพาะแถวที่ต้องใช้จริง (skip + limit) แทนที่จะเก็บทั้งวันไว้เรียง
    //
    // ต้องเรียงตามเวลาจริง ไม่ใช่ยึดลำดับในไฟล์ — ไฟล์เขียนต่อท้ายตามลำดับที่ poller
    // อ่านมาเจอ ซึ่งส่วนใหญ่เรียงตามเวลาแต่ไม่เสมอไป เพราะบัฟเฟอร์ของเราท์เตอร์ถูกอ่านซ้ำ
    // แถวที่มาถึงช้าจึงถูกเขียนต่อท้ายทั้งที่เวลาเก่ากว่า (เทสต์จับได้ 2026-08-30)
    //
    // เรียงทีละวันแล้วไล่วันจากใหม่ไปเก่า — ทุกแถวของวันที่ใหม่กว่าย่อมใหม่กว่าทุกแถว
    // ของวันก่อนหน้าเสมอ ลำดับรวมจึงถูกต้อง และหน่วยความจำคงที่ไม่ว่าไฟล์จะใหญ่แค่ไหน
    // เก็บแค่ (skip + limit) แถวที่ใหม่ที่สุดของแต่ละวัน พอสำหรับหน้าที่ขอพอดี
    // ส่วนที่เก่ากว่านั้นภายในวันเดียวกันมีลำดับเกินหน้าที่ขออยู่แล้ว จึงทิ้งได้
    let rank = 0;   // ลำดับในผลรวมทั้งหมด (นับจาก 0) ไล่จากใหม่ไปเก่า

    // ถ้าไม่มีเงื่อนไขกรองเลย จำนวนแถวของแต่ละวันอ่านได้จากดัชนีโดยไม่ต้องเปิดไฟล์
    // ซึ่งทำให้ข้ามวันที่ไม่เกี่ยวกับหน้าที่ขอได้ทั้งวัน — ดูเหตุผลในลูปข้างล่าง
    const unfiltered = !q && !opts.username && !opts.siteName;
    const idx = unfiltered ? readIndex() : null;

    for (const day of days) {
        // จำนวนแถวของวันนี้แบบไม่ต้องอ่านไฟล์ (null = ไม่รู้ ต้องสแกน)
        const known = unfiltered && idx[day] && typeof idx[day].rows === 'number' ? idx[day].rows : null;

        // ข้ามทั้งวันโดยไม่เปิดไฟล์ ในสองกรณีที่รู้จำนวนแถวอยู่แล้ว:
        //   1) ได้แถวครบหน้าที่ขอแล้ว วันที่เหลือมีผลแค่กับยอดรวมเท่านั้น
        //   2) ทั้งวันอยู่ก่อนหน้าที่ขอ (rank + known <= skip)
        //
        // นี่คือเหตุผลที่หน้าแรกแบบไม่กรองอะไรเลยต้องเร็ว: หน้านั้นต้องการแค่ 100 แถวล่าสุด
        // ซึ่งอยู่ในไฟล์วันเดียว แต่ของเดิมสแกนทุกวันในช่วง (สูงสุด MAX_SCAN_DAYS วัน
        // วันละ ~342,000 แถว) เพียงเพื่อนับยอดรวม จนคำขอเดียวใช้เวลาหลายสิบวินาที
        // และโดน Cloudflare ตัดที่ 100 วินาทีเป็น 504 (พบจริงบนโปรดักชัน 2026-09-04)
        if (known !== null && (collected.length >= limit || rank + known <= skip)) {
            total += known;
            rank += known;
            continue;
        }

        // ต้องการแถวลำดับ [skip, skip+limit) ของผลรวม ซึ่งภายในวันนี้คือ [skip-rank, ...)
        // จึงเก็บแค่ (skip - rank + limit) แถวที่ใหม่ที่สุดของวันนี้พอ — วันก่อน ๆ ที่กิน
        // ลำดับไปแล้วช่วยให้เก็บน้อยลงเรื่อย ๆ แทนที่จะใช้ค่าเดียวกันหมดทุกวัน
        const want = Math.max(0, skip - rank) + limit;

        const top = [];         // แถวที่ใหม่ที่สุดของวันนี้ เรียงใหม่->เก่า ยาวไม่เกิน want
        let dayMatches = 0;
        readDays++;

        await scanDay(day, (r) => {
            if (!matches(r, opts)) return;
            dayMatches++;

            const t = String(r.queryTime);
            if (top.length === want && t <= String(top[top.length - 1].queryTime)) return;

            // แทรกเข้าตำแหน่งที่ถูกด้วย binary search แทนการ sort ใหม่ทั้งชุดทุกครั้ง
            //
            // ของเดิมเรียก top.sort() ทุกแถวที่ผ่านเงื่อนไข ซึ่งเป็น O(want·log want)
            // การเปรียบเทียบผ่าน callback ต่อหนึ่งแถว วัดจริงกับ 342,109 แถวและ want=2000
            // (หน้า 20) ใช้เวลา 11.4 วินาที — แทรกแบบ binary search เหลือ log2(want)
            // การเปรียบเทียบ ที่เหลือเป็นการเลื่อนหน่วยความจำซึ่งเร็วกว่ามาก
            let lo = 0;
            let hi = top.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (String(top[mid].queryTime) > t) lo = mid + 1;
                else hi = mid;
            }
            top.splice(lo, 0, r);
            if (top.length > want) top.pop();
        });

        total += dayMatches;

        for (const r of top) {
            if (rank >= skip && collected.length < limit) collected.push(r);
            rank++;
        }
        // แถวที่เกิน want ของวันนี้ยังกินลำดับอยู่ก่อนวันถัดไป ต้องนับด้วย
        rank += dayMatches - top.length;
    }

    return {
        logs: collected,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 0,
        truncated,                       // บอกหน้าเว็บว่าช่วงที่ขอกว้างเกินกว่าที่อ่านจริง
        scannedDays: days.length,
        readDays,                        // เปิดไฟล์อ่านจริงกี่วัน — ตัวชี้วัดว่าคำขอนี้แพงแค่ไหน
        source: 'file'
    };
}

// ขนาดหน้าต่างเรียงลำดับตอนส่งออก (จำนวนแถว)
// ต้องใหญ่กว่าระยะที่แถวหนึ่งจะหลุดตำแหน่งในไฟล์ได้มาก ๆ — ดูคำอธิบายใน exportAscending
const EXPORT_WINDOW = Number(process.env.DNS_EXPORT_WINDOW || 50000);

/**
 * ไล่ทุกแถวในช่วงที่ขอเพื่อส่งออก — ครบทุกวัน ไม่มีเพดาน MAX_SCAN_DAYS
 *
 * เพดาน 31 วันมีไว้กันหน้าเว็บค้างตอนกดดูเฉย ๆ ซึ่งคนละเรื่องกับการส่งออกหลักฐาน
 * ตามหมายเรียก ที่ขอมากี่วันต้องได้ครบเท่านั้น (ม.26 เก็บ 90 วัน) การตัดเหลือ 31 วัน
 * เงียบ ๆ ในไฟล์ที่ใช้เป็นหลักฐานคือความผิดพลาดที่มองไม่เห็นจนกว่าจะสาย
 *
 * **ไฟล์ส่งออกเรียงจากเก่าไปใหม่** ต่างจากหน้าเว็บที่เรียงใหม่ไปเก่า และนี่คือความตั้งใจ:
 *
 * การจะส่งออกแบบใหม่ไปเก่าได้ ต้องอ่านทั้งวันเข้าหน่วยความจำก่อนเพื่อกลับลำดับ
 * วัดจริงกับวันที่มี 580,000 แถว (ปริมาณจริงของโปรดักชันตอนนี้) วิธีนั้นดัน RSS ขึ้นไป
 * 404-465 MB ขณะที่ PM2 ตั้ง max_memory_restart ไว้ 500M — คือ PM2 จะฆ่า process
 * กลางคันแบบสุ่ม ซึ่งไม่ได้พังแค่ไฟล์ที่กำลังส่ง แต่ตัดทุก request ที่ค้างอยู่ตอนนั้นด้วย
 *
 * ไล่จากเก่าไปใหม่ทำให้อ่านไปส่งไปได้เลย ใช้หน่วยความจำคงที่ไม่ว่าจะกี่วันหรือวันละกี่แถว
 * และสำหรับเอกสารหลักฐาน การเรียงตามเวลาจากเก่าไปใหม่เป็นลำดับที่อ่านง่ายกว่าอยู่แล้ว
 *
 * ยังได้ลำดับเวลาที่ถูกต้องจริง ไม่ใช่แค่ลำดับในไฟล์: ลำดับในไฟล์คือลำดับที่ poller
 * อ่านมาเจอ ซึ่งเกือบเรียงตามเวลาแต่ไม่เป๊ะ เพราะบัฟเฟอร์ของเราท์เตอร์ถูกอ่านซ้ำ
 * แถวที่มาช้าจึงถูกเขียนต่อท้ายทั้งที่เวลาเก่ากว่า — แต่หลุดตำแหน่งได้ไม่เกินหนึ่งช่วง
 * บัฟเฟอร์ (~10 นาที หรือไม่กี่พันแถว) จึงเรียงด้วยหน้าต่างเลื่อนขนาด EXPORT_WINDOW
 * ซึ่งใหญ่กว่าระยะนั้นมาก ได้ลำดับที่ถูกต้องโดยถือไว้แค่ 2 หน้าต่างในหน่วยความจำ
 */
async function exportAscending(options, formatRow, onLine) {
    const q = options.search ? String(options.search).trim().toLowerCase() : '';
    const opts = { q, username: options.username || '', siteName: options.siteName || '' };

    let days = listDays();
    if (options.from) days = days.filter((d) => d >= String(options.from).slice(0, 10));
    if (options.to) days = days.filter((d) => d <= String(options.to).slice(0, 10));
    days.sort();   // เก่าก่อน

    let written = 0;
    let buf = [];

    // ปล่อยแถวที่เก่าที่สุด n แถวออกไป (buf ต้องถูกเรียงมาแล้ว)
    // onLine คืนค่าที่ await ได้เฉพาะตอนที่ต้องรอ backpressure จริง ๆ
    // ที่เหลือคืน null — การ await ทุกแถวโดยไม่จำเป็นคือค่าใช้จ่ายที่มองไม่เห็นแต่แพงมาก
    // เมื่อมีหลักแสนแถว
    const flush = async (n) => {
        for (let i = 0; i < n; i++) {
            const s = buf[i];
            const p = onLine(s.slice(s.indexOf('\t') + 1));
            if (p) await p;
            written++;
        }
        buf = buf.slice(n);
    };

    for (const day of days) {
        for await (const batch of iterDay(day)) {
            for (const r of batch) {
                if (!matches(r, opts)) continue;
                // เก็บเป็น "คีย์ \t บรรทัด" สตริงเดียวต่อแถว ไม่ใช่ object — ประหยัดกว่ามาก
                buf.push(String(r.queryTime) + '\t' + formatRow(r));
            }
            if (buf.length >= EXPORT_WINDOW * 2) {
                buf.sort();
                await flush(EXPORT_WINDOW);
            }
        }
    }

    buf.sort();
    await flush(buf.length);
    return written;
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
 * บีบอัดไฟล์สดของวันหนึ่งเป็น .gz โดยไม่ต้องแปลงเป็น object
 *
 * ไฟล์สดเป็น JSONL อยู่แล้ว ซึ่งเป็นรูปแบบเดียวกับที่ไฟล์ปิดผนึกต้องการพอดี
 * จึงบีบอัดไบต์ตรง ๆ ได้เลย ไม่ต้อง parse แล้ว stringify กลับ
 * ประหยัดทั้งเวลาและหน่วยความจำ — วันที่มี 342,109 แถว ถ้า parse ทั้งหมดใช้ heap
 * ~295 MB ซึ่งเกือบชนลิมิต 500M ของ PM2 แต่วิธีนี้ใช้แค่ขนาดไฟล์กับผลลัพธ์
 *
 * คืน null ถ้าวันนั้นไม่มีไฟล์สด (เช่น ปิดผนึกไปแล้ว หรือไม่มีข้อมูล)
 */
function gzipLiveDay(dateStr) {
    const p = livePath(dateStr);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p);
    if (!raw.length) return null;

    // นับบรรทัดจากไบต์ตรง ๆ ไม่ต้องแปลงเป็นข้อความทั้งก้อน
    let rows = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i] === 0x0a) rows++;

    return { buffer: zlib.gzipSync(raw, { level: 9 }), rows };
}

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
    scanDay,
    readDay,
    gzipLiveDay,
    hasDay,
    listDays,
    query,
    exportAscending,
    iterDay,
    stats,
    dropLiveFile,
    purgeOld
};
