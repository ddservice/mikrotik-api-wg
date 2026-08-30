/**
 * lib/log-archive.js — ปิดวันของ log ตาม พรบ. คอมพิวเตอร์ ม.26 แล้วผนึกด้วย SHA-256
 *
 * ทำไมต้องมี: ระบบเก็บ log ครบตามกฎหมายอยู่แล้ว แต่ "พิสูจน์ไม่ได้ว่าไม่ถูกแก้"
 * การ export CSV เมื่อไรก็ได้ไม่ใช่หลักฐาน — ถ้ามีคนแก้ตัวเลขระหว่างทางก็ไม่มีใครรู้
 * โมดูลนี้ทำให้เกิดสิ่งที่ยืนยันได้: ไฟล์ที่ปิดผนึกแล้ว + ค่า hash ที่ตรวจซ้ำได้เอง
 *
 * หลักการสำคัญ: archive เฉพาะ "วันที่ปิดแล้ว" (เมื่อวานหรือก่อนหน้า) เท่านั้น
 * วันปัจจุบันยังมี log เขียนเพิ่มเรื่อย ๆ ค่า hash จะเปลี่ยนตลอด จึงไม่มีความหมาย
 *
 * ค่า SHA-256 คำนวณจากไฟล์ .gz โดยตรง ผู้รับไฟล์รัน `sha256sum <file>` เทียบได้ทันที
 * ไม่ต้องแตกไฟล์หรือใช้เครื่องมือพิเศษ
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const r2 = require('./r2');
// bangkokToday/shiftDate ย้ายไป lib/time.js — ตรรกะเวลาต้องมีที่มาเดียว
// ไม่งั้นแก้ที่หนึ่งแล้วอีกที่ยังผิดอยู่ (บทเรียนจากบั๊กปิดผนึกผิดวัน 2026-08-30)
const { bangkokToday, shiftDate } = require('./time');
const dnsStore = require('./dns-log-store');

const ARCHIVE_DIR = path.join(__dirname, '..', 'archives');
const R2_SITE_NAME = process.env.R2_SITE_NAME || 'Mikrotikapi-db';

const LOG_TYPES = {
    dns: {
        label: 'ประวัติเข้าเว็บ (DNS)',
        // DNS ย้ายไปเก็บเป็นไฟล์รายวันแล้ว (lib/dns-log-store.js) จึงอ่านจากไฟล์ของวันนั้น
        // ตรง ๆ แทนที่จะถามฐานข้อมูล — เร็วกว่ามากและไม่ติดเพดาน 1000 แถวของ PostgREST
        // ถ้าวันนั้นยังไม่มีไฟล์ (ข้อมูลยุคเก่า) ค่อยถอยไปอ่านจากฐานข้อมูลให้
        fetchDay: (db, dateStr) => {
            const rows = dnsStore.readDay(dateStr);
            return rows.length ? rows : null;
        },
        fetch: (db, opts) => db.getDnsQueryLogs(opts),
        timeField: 'queryTime'
    },
    hotspot: {
        label: 'ประวัติใช้งาน Hotspot',
        fetch: (db, opts) => db.getHotspotLogs(opts),
        timeField: 'loginTime'
    }
};

// PostgREST (ที่ Supabase ใช้) จำกัดจำนวนแถวต่อ request ไว้ 1000 เป็นค่าเริ่มต้น
// ต่อให้ขอ range กว้างกว่านั้นก็ได้กลับมาแค่ 1000
//
// เดิมตั้ง 5000 แล้วเชื่อค่า `pages` ที่ server คำนวณจาก limit ที่ขอไป
// วันที่มี 1200 แถวจึงได้ pages = 1 -> วนรอบเดียวแล้วหยุด เก็บไปแค่ 1000
// ไฟล์ปิดผนึกจะขาดข้อมูลเงียบ ๆ ซึ่งสำหรับงานตามกฎหมายแย่กว่าไม่มีไฟล์เลย
const PAGE_SIZE = 1000;

/**
 * ดึง log ของวันเดียวออกมาทั้งหมด
 * เงื่อนไขหยุดยึดจากจำนวนที่เก็บได้จริงเทียบกับ total ไม่ใช่ค่า pages
 * และหยุดทันทีถ้าได้ batch ที่ไม่เต็มหน้า (แปลว่าหมดแล้ว)
 */
async function fetchDay(db, type, dateStr) {
    const def = LOG_TYPES[type];

    // ชนิดที่เก็บเป็นไฟล์อยู่แล้ว อ่านตรงจากไฟล์ ไม่ต้องแบ่งหน้า
    if (def.fetchDay) {
        const direct = def.fetchDay(db, dateStr);
        if (direct && direct.length) return direct;
    }

    const rows = [];
    const seen = new Set();
    let page = 1;
    let total = null;

    for (;;) {
        const res = await def.fetch(db, { from: dateStr, to: dateStr, page, limit: PAGE_SIZE });
        const batch = (res && res.logs) || [];
        if (total === null && res && typeof res.total === 'number') total = res.total;

        for (const r of batch) {
            // กัน record ซ้ำข้ามหน้า — การเรียงลำดับที่มีค่าเวลาซ้ำกันอาจสลับตำแหน่งได้
            const key = r.id || JSON.stringify(r);
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push(r);
        }

        if (!batch.length || batch.length < PAGE_SIZE) break;
        if (total !== null && rows.length >= total) break;

        page++;
        if (page > 1000) {   // กันวนไม่รู้จบถ้า backend ตอบผิดปกติ
            console.warn(`[LogArchive] ${dateStr}/${type}: หยุดที่ 1,000 หน้าเพื่อกันวนไม่รู้จบ`);
            break;
        }
    }

    if (total !== null && rows.length !== total) {
        // เตือนดัง ๆ ไฟล์ที่ไม่ครบใช้เป็นหลักฐานไม่ได้
        console.warn(`[LogArchive] ${dateStr}/${type}: ได้ ${rows.length} แถว แต่ระบบบอกว่ามี ${total} แถว`);
    }
    return rows;
}

/**
 * สร้าง archive ของ log ชนิดหนึ่งสำหรับวันหนึ่ง
 * คืน null ถ้าวันนั้นไม่มี log เลย (ไม่สร้างไฟล์เปล่า)
 */
async function buildArchive(db, type, dateStr, { createdBy = 'System Auto' } = {}) {
    if (!LOG_TYPES[type]) throw new Error('ชนิด log ไม่ถูกต้อง: ' + type);
    if (dateStr >= bangkokToday()) {
        throw new Error(`archive ได้เฉพาะวันที่ปิดแล้ว — ${dateStr} ยังเป็นวันปัจจุบันหรืออนาคต`);
    }

    const rows = await fetchDay(db, type, dateStr);
    if (!rows.length) return null;

    // JSONL: หนึ่งเรคคอร์ดต่อบรรทัด อ่านทีละบรรทัดได้โดยไม่ต้องโหลดทั้งไฟล์
    // และถ้าไฟล์เสียหายบางส่วน บรรทัดที่เหลือยังอ่านได้ ต่างจาก JSON ก้อนเดียว
    const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const gz = zlib.gzipSync(Buffer.from(jsonl, 'utf8'), { level: 9 });
    const sha256 = crypto.createHash('sha256').update(gz).digest('hex');

    const fileName = `${dateStr}-${type}.jsonl.gz`;
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const localPath = path.join(ARCHIVE_DIR, fileName);
    fs.writeFileSync(localPath, gz);

    // อัปขึ้น R2 แบบ best-effort — ถ้าอัปไม่ได้ก็ยังมีไฟล์บน VPS และ manifest ในฐานข้อมูล
    let r2Key = null;
    if (r2.isConfigured()) {
        try {
            r2Key = await r2.putObject(`${R2_SITE_NAME}/log-archives/${fileName}`, gz, 'application/gzip');
        } catch (e) {
            console.warn('[LogArchive] อัปขึ้น R2 ไม่สำเร็จ:', e.message);
        }
    }

    const record = {
        id: `${dateStr}_${type}`,
        archiveDate: dateStr,
        logType: type,
        siteName: 'ALL',
        recordCount: rows.length,
        fileName,
        fileSize: gz.length,
        sha256,
        storageR2Key: r2Key,
        storageLocal: localPath,
        createdBy
    };

    await db.saveLogArchive(record);

    // ปิดผนึกและบันทึกทะเบียนเรียบร้อยแล้ว จึงลบไฟล์สดของวันนั้นได้
    // ลำดับนี้สำคัญ: ถ้าลบก่อนบันทึกสำเร็จ ข้อมูลจะหายโดยไม่มีอะไรทดแทน
    if (type === 'dns') dnsStore.dropLiveFile(dateStr);

    console.log(`[LogArchive] ${fileName} — ${rows.length} รายการ, ${gz.length} bytes, sha256 ${sha256.slice(0, 12)}…`);
    return record;
}

/**
 * ปิดวันของทุกชนิด log สำหรับวันที่ระบุ (ค่าเริ่มต้น = เมื่อวาน)
 * ข้ามวันที่ทำไปแล้ว เพื่อให้เรียกซ้ำได้โดยไม่สร้างซ้ำ
 */
async function archiveDay(db, dateStr, opts = {}) {
    const target = dateStr || shiftDate(bangkokToday(), -1);
    const results = [];
    for (const type of Object.keys(LOG_TYPES)) {
        try {
            const existing = await db.getLogArchive(`${target}_${type}`);
            if (existing && !opts.force) {
                results.push({ type, skipped: 'มีอยู่แล้ว' });
                continue;
            }
            const rec = await buildArchive(db, type, target, opts);
            results.push(rec ? { type, ...rec } : { type, skipped: 'ไม่มี log ในวันนั้น' });
        } catch (e) {
            console.error(`[LogArchive] ${target}/${type} ล้มเหลว:`, e.message);
            results.push({ type, error: e.message });
        }
    }
    return { date: target, results };
}

/**
 * เติม archive ย้อนหลังที่ยังขาด — ใช้ตอนเปิดใช้ฟีเจอร์นี้ครั้งแรก
 * ไล่ถอยหลังจากเมื่อวานไปตามจำนวนวันที่กำหนด
 */
async function backfill(db, days = 30, opts = {}) {
    const out = [];
    let d = shiftDate(bangkokToday(), -1);
    for (let i = 0; i < days; i++) {
        out.push(await archiveDay(db, d, opts));
        d = shiftDate(d, -1);
    }
    return out;
}

/**
 * งานประจำคืน: ปิดเมื่อวาน แล้วไล่เก็บวันที่ยังขาดย้อนหลังด้วย
 *
 * เดิมทำแค่ "เมื่อวาน" วันเดียว ถ้าคืนไหนเครื่องดับ งานล้ม หรือคำนวณวันผิด
 * (อย่างบั๊ก bangkokToday ที่เจอ 2026-08-30) วันนั้นจะไม่มีไฟล์ปิดผนึกตลอดไป
 * เพราะไม่มีอะไรย้อนกลับไปทำให้ สำหรับหลักฐานตาม ม.26 ช่องว่างแบบนี้อุดทีหลังไม่ได้
 *
 * ไล่ย้อนหลังไม่กี่วันจึงทำให้ระบบซ่อมตัวเองได้ วันที่ทำไปแล้วถูกข้ามอยู่แล้ว
 * (archiveDay เช็ค getLogArchive ก่อน) จึงไม่มีภาระเพิ่มในคืนปกติ
 */
async function runNightly(db, { lookbackDays = 7, createdBy = 'System Auto' } = {}) {
    const results = [];
    let d = shiftDate(bangkokToday(), -1);
    for (let i = 0; i < lookbackDays; i++) {
        const r = await archiveDay(db, d, { createdBy });
        results.push(r);
        d = shiftDate(d, -1);
    }

    const made = results.flatMap((r) =>
        (r.results || []).filter((x) => x.sha256).map((x) => `${r.date}/${x.type}`));
    const failed = results.flatMap((r) =>
        (r.results || []).filter((x) => x.error).map((x) => `${r.date}/${x.type}: ${x.error}`));
    return { results, made, failed };
}

/**
 * ตรวจสอบความถูกต้องของไฟล์ archive: อ่านไฟล์จริงแล้วคำนวณ hash ใหม่
 * เทียบกับค่าที่บันทึกไว้ตอนสร้าง — ถ้าไม่ตรงแปลว่าไฟล์ถูกแก้หรือเสียหาย
 */
async function verifyArchive(db, id) {
    const rec = await db.getLogArchive(id);
    if (!rec) throw new Error('ไม่พบ archive นี้');

    const check = async (buf, source) => {
        const actual = crypto.createHash('sha256').update(buf).digest('hex');
        return { source, ok: actual === rec.sha256, actual, size: buf.length };
    };

    const checks = [];
    if (rec.storageLocal && fs.existsSync(rec.storageLocal)) {
        checks.push(await check(fs.readFileSync(rec.storageLocal), 'VPS'));
    }
    if (rec.storageR2Key && r2.isConfigured()) {
        try {
            checks.push(await check(await r2.getObject(rec.storageR2Key), 'Cloudflare R2'));
        } catch (e) {
            checks.push({ source: 'Cloudflare R2', ok: false, error: e.message });
        }
    }

    if (!checks.length) throw new Error('ไม่พบไฟล์ทั้งบน VPS และ R2 — archive นี้สูญหาย');
    return { id, expected: rec.sha256, fileName: rec.fileName, checks, ok: checks.every((c) => c.ok) };
}

/** อ่านไฟล์ archive กลับมาเป็น Buffer สำหรับส่งให้ผู้ใช้ดาวน์โหลด */
async function readArchiveFile(db, id) {
    const rec = await db.getLogArchive(id);
    if (!rec) throw new Error('ไม่พบ archive นี้');
    if (rec.storageLocal && fs.existsSync(rec.storageLocal)) {
        return { buffer: fs.readFileSync(rec.storageLocal), record: rec };
    }
    if (rec.storageR2Key && r2.isConfigured()) {
        return { buffer: await r2.getObject(rec.storageR2Key), record: rec };
    }
    throw new Error('ไม่พบไฟล์ทั้งบน VPS และ R2');
}

module.exports = {
    ARCHIVE_DIR,
    LOG_TYPES,
    bangkokToday,
    shiftDate,
    buildArchive,
    archiveDay,
    backfill,
    runNightly,
    verifyArchive,
    readArchiveFile
};
