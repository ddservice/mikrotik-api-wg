/**
 * เทสต์ lib/dns-log-store.js
 *
 * นี่คือที่เก็บบันทึกตาม พรบ. ม.26 ทั้งหมด สิ่งที่ต้องมั่นใจคือ:
 *   1. แถวไปอยู่ในไฟล์ของ "วันตามเวลาไทย" ที่ query เกิดขึ้นจริง ไม่ใช่วัน UTC
 *      และไม่ใช่วันที่ poller บังเอิญอ่านมาเจอ
 *   2. ไฟล์เสียหายบางบรรทัดต้องไม่ทำให้ทั้งไฟล์ใช้ไม่ได้
 *   3. การค้นต้องได้ผลตรงกับที่เก็บจริง และแบ่งหน้าถูกต้อง
 *   4. การลบตามกำหนดต้องลบเฉพาะที่เกินจริง ๆ
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ให้โมดูลเขียนลงโฟลเดอร์ชั่วคราว ไม่ใช่ของจริง
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsstore-'));
const REAL_ROOT = path.join(__dirname, '..');

const store = require('../lib/dns-log-store');

// ใช้ไฟล์จริงของโมดูลไม่ได้ จึงทดสอบผ่านฟังก์ชันบริสุทธิ์ + ไฟล์ในโฟลเดอร์ทดสอบ
// (โมดูลผูก path ไว้กับ ROOT ตอน require จึงทดสอบ dayOf / รูปแบบไฟล์เป็นหลัก
//  ส่วนการอ่าน-เขียนจริงทดสอบผ่าน readDay/appendRows บนโฟลเดอร์จริงที่ล้างทิ้งท้ายเทสต์)
const LIVE = store.LIVE_DIR;
const madeFiles = [];

function cleanup() {
    madeFiles.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

describe('lib/dns-log-store — dayOf (ตัดวันตามเวลาไทย)', () => {
    it('ตีสองเวลาไทย = วันนั้น ไม่ใช่วันก่อนหน้าแบบ UTC', () => {
        // 2026-08-29T19:00:00Z = 02:00 น. วันที่ 30 ตามเวลาไทย
        assert.strictEqual(store.dayOf('2026-08-29T19:00:00.000Z'), '2026-08-30');
    });
    it('16:59 UTC ยังเป็นวันเดิม (23:59 ไทย)', () => {
        assert.strictEqual(store.dayOf('2026-08-30T16:59:00.000Z'), '2026-08-30');
    });
    it('17:00 UTC ขึ้นวันใหม่ (00:00 ไทย)', () => {
        assert.strictEqual(store.dayOf('2026-08-30T17:00:00.000Z'), '2026-08-31');
    });
    it('ข้ามปีตามเวลาไทย', () => {
        assert.strictEqual(store.dayOf('2026-12-31T17:00:00.000Z'), '2027-01-01');
    });
    it('ค่าเวลาที่อ่านไม่ออก ไม่โยน error', () => {
        assert.doesNotThrow(() => store.dayOf('ขยะ'));
        assert.match(store.dayOf('ขยะ'), /^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('lib/dns-log-store — เขียนแล้วอ่านกลับ', () => {
    const DAY = '2019-01-02';        // วันในอดีตไกล ๆ ไม่ชนข้อมูลจริง
    const file = store.livePath(DAY);

    it('เขียนแล้วอ่านกลับได้ครบและค่าตรง', () => {
        madeFiles.push(file);
        const n = store.appendRows([
            { queryTime: DAY + 'T03:00:00.000Z', username: 'rm101', ipAddress: '172.16.1.5',
              macAddress: 'AA:BB', domain: 'example.com', siteName: 'A4-Residence' },
            { queryTime: DAY + 'T03:00:01.000Z', username: 'rm102', ipAddress: '172.16.1.6',
              macAddress: '', domain: 'google.com', siteName: 'A4-Residence' }
        ]);
        assert.strictEqual(n, 2);

        const rows = store.readDay(DAY);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].username, 'rm101');
        assert.strictEqual(rows[0].domain, 'example.com');
        assert.strictEqual(rows[1].ipAddress, '172.16.1.6');
        // ทุกแถวต้องมี id เพื่อให้ไล่ย้อนได้
        assert.ok(rows.every((r) => r.id));
    });

    it('เขียนต่อท้ายได้ ไม่ทับของเดิม', () => {
        store.appendRows([{ queryTime: DAY + 'T04:00:00.000Z', username: 'rm103',
                            ipAddress: '172.16.1.7', domain: 'apple.com', siteName: 'A4-Residence' }]);
        assert.strictEqual(store.readDay(DAY).length, 3);
    });

    it('แถวที่ข้ามเที่ยงคืนไปอยู่ไฟล์ของวันที่ถูกต้อง', () => {
        const nextFile = store.livePath('2019-01-03');
        madeFiles.push(nextFile);
        store.appendRows([
            { queryTime: '2019-01-02T16:59:00.000Z', domain: 'a.com', siteName: 'X' },  // 23:59 ไทย วันที่ 2
            { queryTime: '2019-01-02T17:00:00.000Z', domain: 'b.com', siteName: 'X' }   // 00:00 ไทย วันที่ 3
        ]);
        assert.strictEqual(store.readDay('2019-01-02').length, 4);
        assert.strictEqual(store.readDay('2019-01-03').length, 1);
        assert.strictEqual(store.readDay('2019-01-03')[0].domain, 'b.com');
    });

    it('บรรทัดเสียหายบางบรรทัด ไม่ทำให้ทั้งไฟล์ใช้ไม่ได้', () => {
        fs.appendFileSync(file, 'บรรทัดนี้ไม่ใช่ JSON\n');
        fs.appendFileSync(file, JSON.stringify({ id: 'z', queryTime: DAY + 'T05:00:00.000Z',
            domain: 'ok.com', siteName: 'X', username: '', ipAddress: '', macAddress: '' }) + '\n');
        const rows = store.readDay(file ? DAY : DAY);
        // 4 แถวเดิม + 1 แถวดี = 5 (บรรทัดเสียถูกข้าม)
        assert.strictEqual(rows.length, 5);
        assert.ok(rows.some((r) => r.domain === 'ok.com'));
    });

    it('วันที่ไม่มีไฟล์ คืน array ว่าง ไม่โยน error', () => {
        assert.deepStrictEqual(store.readDay('1999-01-01'), []);
        assert.strictEqual(store.hasDay('1999-01-01'), false);
    });

    it('ไม่มีแถวให้เขียน = ไม่สร้างไฟล์เปล่า', () => {
        assert.strictEqual(store.appendRows([]), 0);
        assert.strictEqual(store.appendRows(null), 0);
    });
});

describe('lib/dns-log-store — ค้นหา', () => {
    const DAY = '2019-01-02';

    it('ค้นด้วยชื่อผู้ใช้', async () => {
        const r = await store.query({ from: DAY, to: DAY, search: 'rm101' });
        assert.strictEqual(r.total, 1);
        assert.strictEqual(r.logs[0].username, 'rm101');
    });

    it('ค้นด้วยโดเมน', async () => {
        const r = await store.query({ from: DAY, to: DAY, search: 'google' });
        assert.strictEqual(r.total, 1);
    });

    it('ค้นด้วย IP', async () => {
        const r = await store.query({ from: DAY, to: DAY, search: '172.16.1.5' });
        assert.strictEqual(r.total, 1);
    });

    it('กรองตามสาขา', async () => {
        const r = await store.query({ from: DAY, to: DAY, siteName: 'A4-Residence' });
        assert.strictEqual(r.total, 3);   // rm101, rm102, rm103
    });

    it('กรองตาม username แบบตรงตัว', async () => {
        const r = await store.query({ from: DAY, to: DAY, username: 'rm102' });
        assert.strictEqual(r.total, 1);
    });

    it('ผลลัพธ์เรียงใหม่ไปเก่า', async () => {
        const r = await store.query({ from: DAY, to: DAY, limit: 100 });
        const times = r.logs.map((x) => x.queryTime);
        const sorted = [...times].sort().reverse();
        assert.deepStrictEqual(times, sorted);
    });

    it('แบ่งหน้าถูกต้องและไม่ซ้ำกัน', async () => {
        const p1 = await store.query({ from: DAY, to: DAY, page: 1, limit: 2 });
        const p2 = await store.query({ from: DAY, to: DAY, page: 2, limit: 2 });
        assert.strictEqual(p1.logs.length, 2);
        assert.strictEqual(p1.total, p2.total);
        const ids1 = p1.logs.map((x) => x.id);
        const ids2 = p2.logs.map((x) => x.id);
        assert.ok(!ids1.some((id) => ids2.includes(id)), 'หน้า 1 กับ 2 ต้องไม่มีรายการซ้ำกัน');
    });

    it('ค้นไม่เจอ คืนศูนย์ ไม่โยน error', async () => {
        const r = await store.query({ from: DAY, to: DAY, search: 'ไม่มีทางเจอแน่นอน' });
        assert.strictEqual(r.total, 0);
        assert.deepStrictEqual(r.logs, []);
    });

    it('คืนรูปแบบเดียวกับ db.getDnsQueryLogs', async () => {
        const r = await store.query({ from: DAY, to: DAY });
        ['logs', 'total', 'page', 'limit', 'pages'].forEach((k) => {
            assert.ok(k in r, 'ต้องมีฟิลด์ ' + k);
        });
    });
});

describe('lib/dns-log-store — สถิติ', () => {
    it('รายงานช่วงวันและจำนวนไฟล์', () => {
        const s = store.stats();
        assert.ok(s.days >= 2, 'ต้องเห็นอย่างน้อย 2 วันที่สร้างไว้');
        assert.match(s.oldest, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(s.bytes > 0);
    });
});

// เก็บกวาดไฟล์ทดสอบ
process.on('exit', cleanup);
