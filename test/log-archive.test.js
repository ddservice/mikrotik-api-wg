/**
 * เทสต์ lib/log-archive.js — ตัวปิดผนึกหลักฐานตาม พรบ. ม.26
 *
 * โมดูลนี้เป็นตัวที่ทำให้ log "พิสูจน์ได้ว่าไม่ถูกแก้" ถ้ามันพังเงียบ ๆ จะไม่มีใครรู้
 * จนกว่าจะถึงวันที่ต้องส่งหลักฐานจริง ซึ่งสายเกินไปแล้ว และเคยพังมาแล้วสองแบบ:
 *
 *   1. 2026-08-29 — PostgREST คืนแถวได้สูงสุด 1000 ต่อ request แต่โค้ดเชื่อค่า `pages`
 *      ที่คำนวณจาก limit ที่ขอไป วันที่มี 1200 แถวจึงถูกปิดผนึกไปแค่ 1000 แถว
 *      ไฟล์ดูสมบูรณ์ทุกอย่างแต่ขาดหลักฐาน
 *   2. 2026-08-30 — bangkokToday() คืนวัน UTC งานตอนตี 2 จึงปิดผนึกผิดวันมาตลอด
 *      และวันที่ถูกข้ามไปไม่มีอะไรย้อนกลับไปทำให้
 *
 * เทสต์นี้จึงยึดสองอย่างนั้นเป็นหลัก บวกกับข้อที่สำคัญที่สุด: verify ต้อง "จับได้"
 * เมื่อไฟล์ถูกแก้ ไม่ใช่แค่ผ่านเมื่อไฟล์ปกติ
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const archive = require('../lib/log-archive');

// ใช้ปีที่ไม่มีทางชนกับข้อมูลจริงหรือเทสต์อื่น
const DAY = '2015-06-10';
const DAY2 = '2015-06-09';
const EMPTY_DAY = '2015-06-01';   // วันที่ไม่มีเทสต์ไหนสร้างไฟล์ไว้เลย
const made = [];

function trackFile(p) { made.push(p); return p; }

function cleanup() {
    made.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
}

/** db ปลอมที่เก็บทุกอย่างไว้ในหน่วยความจำ */
function fakeDb({ hotspotRows = [], pageCap = 1000 } = {}) {
    const archives = new Map();
    return {
        archives,
        saved: [],
        getHotspotLogs({ from, to, page, limit }) {
            const all = hotspotRows.filter((r) => String(r.loginTime).slice(0, 10) >= from
                                               && String(r.loginTime).slice(0, 10) <= to);
            // เลียนแบบ PostgREST: ต่อให้ขอมากกว่า pageCap ก็ได้กลับมาแค่ pageCap
            const eff = Math.min(limit, pageCap);
            const start = (page - 1) * eff;
            return Promise.resolve({ logs: all.slice(start, start + eff), total: all.length });
        },
        getDnsQueryLogs() { return Promise.resolve({ logs: [], total: 0 }); },
        saveLogArchive(rec) { archives.set(rec.id, rec); this.saved.push(rec); return Promise.resolve(rec); },
        getLogArchive(id) { return Promise.resolve(archives.get(id) || null); }
    };
}

function rows(n, day = DAY) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: 'h' + i, loginTime: `${day}T03:00:00.000Z`, username: 'u' + i, siteName: 'A4-Residence' });
    }
    return out;
}

describe('lib/log-archive — ต้องเก็บครบเกินเพดาน 1000 แถวของ PostgREST', () => {
    it('วันที่มี 1200 แถว ต้องได้ครบ 1200 ไม่ใช่ 1000', async () => {
        const db = fakeDb({ hotspotRows: rows(1200) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY, { createdBy: 'test' });
        trackFile(rec.storageLocal);
        assert.strictEqual(rec.recordCount, 1200, 'นี่คือบั๊กจริงเมื่อ 2026-08-29');
    });

    it('ข้อมูลในไฟล์ที่บีบอัดไว้ ต้องครบและอ่านกลับได้ทุกบรรทัด', async () => {
        const db = fakeDb({ hotspotRows: rows(1200) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY, { createdBy: 'test' });
        trackFile(rec.storageLocal);

        const text = zlib.gunzipSync(fs.readFileSync(rec.storageLocal)).toString('utf8');
        const lines = text.split('\n').filter(Boolean);
        assert.strictEqual(lines.length, 1200);
        // JSONL: ทุกบรรทัดต้อง parse ได้เอง ไม่ต้องพึ่งบรรทัดอื่น
        const first = JSON.parse(lines[0]);
        const last = JSON.parse(lines[1199]);
        assert.strictEqual(first.id, 'h0');
        assert.strictEqual(last.id, 'h1199');
    });

    it('จำนวนพอดี 1000 (ขอบเพดาน) ก็ต้องไม่ตกหล่นและไม่วนซ้ำ', async () => {
        const db = fakeDb({ hotspotRows: rows(1000) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY, { createdBy: 'test' });
        trackFile(rec.storageLocal);
        assert.strictEqual(rec.recordCount, 1000);
    });
});

describe('lib/log-archive — เงื่อนไขว่าวันไหนปิดผนึกได้', () => {
    it('ปฏิเสธวันปัจจุบัน — hash ของวันที่ยังเขียนอยู่ไม่มีความหมาย', async () => {
        const db = fakeDb({ hotspotRows: [] });
        await assert.rejects(
            () => archive.buildArchive(db, 'hotspot', archive.bangkokToday()),
            /วันปัจจุบันหรืออนาคต/
        );
    });

    it('ปฏิเสธวันในอนาคต', async () => {
        const db = fakeDb({ hotspotRows: [] });
        await assert.rejects(
            () => archive.buildArchive(db, 'hotspot', archive.shiftDate(archive.bangkokToday(), 5)),
            /วันปัจจุบันหรืออนาคต/
        );
    });

    it('ชนิด log ที่ไม่รู้จัก ต้องโยน error ไม่ใช่สร้างไฟล์เปล่า', async () => {
        const db = fakeDb();
        await assert.rejects(() => archive.buildArchive(db, 'ไม่มีชนิดนี้', DAY), /ชนิด log ไม่ถูกต้อง/);
    });

    it('วันที่ไม่มี log เลย = ไม่สร้างไฟล์ (คืน null)', async () => {
        // ใช้วันที่ไม่มีเทสต์อื่นแตะ ไม่งั้นจะไปเจอไฟล์ที่เทสต์ก่อนหน้าสร้างไว้
        const db = fakeDb({ hotspotRows: [] });
        const rec = await archive.buildArchive(db, 'hotspot', EMPTY_DAY);
        assert.strictEqual(rec, null);
        assert.ok(!fs.existsSync(path.join(archive.ARCHIVE_DIR, `${EMPTY_DAY}-hotspot.jsonl.gz`)),
            'ต้องไม่มีไฟล์เปล่าค้างไว้');
    });
});

describe('lib/log-archive — ตรวจสอบความถูกต้องของไฟล์ (SHA-256)', () => {
    it('ไฟล์ที่ไม่ถูกแตะ ต้องผ่าน', async () => {
        const db = fakeDb({ hotspotRows: rows(50) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY, { createdBy: 'test' });
        trackFile(rec.storageLocal);

        const res = await archive.verifyArchive(db, rec.id);
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.expected, rec.sha256);
        assert.ok(res.checks.some((c) => c.source === 'VPS' && c.ok));
    });

    it('hash ที่บันทึกไว้ตรงกับ sha256sum ของไฟล์จริง (ผู้รับตรวจเองได้)', async () => {
        const db = fakeDb({ hotspotRows: rows(50) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY, { createdBy: 'test' });
        trackFile(rec.storageLocal);

        const onDisk = crypto.createHash('sha256').update(fs.readFileSync(rec.storageLocal)).digest('hex');
        assert.strictEqual(onDisk, rec.sha256, 'hash ต้องเป็นของไฟล์ .gz เอง ไม่ใช่ของข้อมูลก่อนบีบอัด');
    });

    it('แก้ไฟล์ไปแค่ 1 ไบต์ ต้องจับได้ — นี่คือทั้งหมดที่ฟีเจอร์นี้มีไว้ทำ', async () => {
        const db = fakeDb({ hotspotRows: rows(50) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY, { createdBy: 'test' });
        trackFile(rec.storageLocal);

        const buf = fs.readFileSync(rec.storageLocal);
        buf[buf.length - 3] = buf[buf.length - 3] ^ 0xff;   // พลิกไบต์เดียว
        fs.writeFileSync(rec.storageLocal, buf);

        const res = await archive.verifyArchive(db, rec.id);
        assert.strictEqual(res.ok, false, 'ถ้าอันนี้ผ่าน แปลว่าการปิดผนึกไม่มีความหมายเลย');
        assert.notStrictEqual(res.checks[0].actual, rec.sha256);
    });

    it('ไฟล์หายไปจากทั้ง VPS และ R2 = บอกว่าสูญหาย ไม่ใช่รายงานว่าผ่าน', async () => {
        const db = fakeDb({ hotspotRows: rows(10) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY, { createdBy: 'test' });
        fs.unlinkSync(rec.storageLocal);
        await assert.rejects(() => archive.verifyArchive(db, rec.id), /สูญหาย/);
    });

    it('ไม่พบทะเบียน archive = โยน error', async () => {
        const db = fakeDb();
        await assert.rejects(() => archive.verifyArchive(db, 'ไม่มีอยู่จริง'), /ไม่พบ archive/);
    });
});

describe('lib/log-archive — เรียกซ้ำต้องไม่สร้างซ้ำ และงานกลางคืนต้องซ่อมวันที่ขาด', () => {
    it('archiveDay ซ้ำวันเดิม = ข้าม ไม่สร้างใหม่', async () => {
        const db = fakeDb({ hotspotRows: rows(20) });
        const first = await archive.archiveDay(db, DAY, { createdBy: 'test' });
        const rec = first.results.find((r) => r.sha256);
        trackFile(rec.storageLocal);

        const again = await archive.archiveDay(db, DAY, { createdBy: 'test' });
        const hotspot = again.results.find((r) => r.type === 'hotspot');
        assert.strictEqual(hotspot.skipped, 'มีอยู่แล้ว');
        assert.strictEqual(db.saved.length, 1, 'ต้องบันทึกทะเบียนครั้งเดียว');
    });

    it('force = สร้างทับได้ (ใช้ตอนไฟล์เดิมเสีย)', async () => {
        const db = fakeDb({ hotspotRows: rows(20) });
        const first = await archive.archiveDay(db, DAY, { createdBy: 'test' });
        trackFile(first.results.find((r) => r.sha256).storageLocal);
        await archive.archiveDay(db, DAY, { createdBy: 'test', force: true });
        assert.strictEqual(db.saved.length, 2);
    });

    it('วันที่ไม่มี log เลย รายงานว่าข้าม ไม่ใช่ error', async () => {
        const db = fakeDb({ hotspotRows: [] });
        const res = await archive.archiveDay(db, DAY);
        assert.ok(res.results.every((r) => r.skipped || r.error === undefined));
        assert.ok(res.results.some((r) => r.skipped === 'ไม่มี log ในวันนั้น'));
    });

    it('runNightly ไล่ย้อนหลังหลายวัน จึงเก็บวันที่คืนก่อนทำไม่สำเร็จได้', async () => {
        // จำลองว่ามี log ของ "เมื่อวาน" กับ "สองวันก่อน" แต่คืนที่แล้วไม่ได้รัน
        const y1 = archive.shiftDate(archive.bangkokToday(), -1);
        const y2 = archive.shiftDate(archive.bangkokToday(), -2);
        const db = fakeDb({ hotspotRows: [...rows(5, y1), ...rows(5, y2)] });

        const res = await archive.runNightly(db, { lookbackDays: 3, createdBy: 'test' });
        db.saved.forEach((r) => trackFile(r.storageLocal));

        assert.ok(res.made.includes(`${y1}/hotspot`), 'ต้องปิดผนึกเมื่อวาน');
        assert.ok(res.made.includes(`${y2}/hotspot`), 'และต้องย้อนไปเก็บวันที่ขาดด้วย');
        assert.strictEqual(res.failed.length, 0);
    });

    it('runNightly ไม่ปิดผนึกวันปัจจุบัน แม้จะมี log อยู่', async () => {
        const today = archive.bangkokToday();
        const db = fakeDb({ hotspotRows: rows(5, today) });
        const res = await archive.runNightly(db, { lookbackDays: 3, createdBy: 'test' });
        db.saved.forEach((r) => trackFile(r.storageLocal));
        assert.ok(!res.made.some((m) => m.startsWith(today)), 'วันที่ยังเขียนอยู่ต้องไม่ถูกปิดผนึก');
    });
});

describe('lib/log-archive — อ่านไฟล์กลับมาให้ดาวน์โหลด', () => {
    it('คืน buffer ที่ตรงกับไฟล์บนดิสก์', async () => {
        const db = fakeDb({ hotspotRows: rows(30, DAY2) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY2, { createdBy: 'test' });
        trackFile(rec.storageLocal);

        const { buffer, record } = await archive.readArchiveFile(db, rec.id);
        assert.strictEqual(record.id, rec.id);
        assert.strictEqual(crypto.createHash('sha256').update(buffer).digest('hex'), rec.sha256);
        assert.strictEqual(zlib.gunzipSync(buffer).toString('utf8').split('\n').filter(Boolean).length, 30);
    });

    it('ไม่มีไฟล์ทั้งสองที่ = โยน error ไม่ใช่คืน buffer ว่าง', async () => {
        const db = fakeDb({ hotspotRows: rows(5, DAY2) });
        const rec = await archive.buildArchive(db, 'hotspot', DAY2, { createdBy: 'test' });
        fs.unlinkSync(rec.storageLocal);
        await assert.rejects(() => archive.readArchiveFile(db, rec.id), /ไม่พบไฟล์/);
    });
});

process.on('exit', cleanup);
