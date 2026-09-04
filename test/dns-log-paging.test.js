/**
 * เทสต์การแบ่งหน้าของ dns-log-store เมื่อมีหลายวันและแต่ละวันใหญ่
 *
 * ที่มา: 2026-09-04 หน้า "ประวัติเว็บไซต์ที่เข้าชม" บนโปรดักชันตอบ 504 Gateway time-out
 * หน้านั้นเปิดมาแบบไม่กรองอะไรเลย (ไม่มีช่วงวัน ไม่มีคำค้น) ซึ่งกลายเป็นคำขอที่แพงที่สุด
 * ที่เป็นไปได้ เพราะโค้ดเดิมสแกนไฟล์ "ทุกวัน" ในช่วง (สูงสุด MAX_SCAN_DAYS วัน
 * วันละ ~342,000 แถว) เพียงเพื่อจะนับยอดรวม ทั้งที่หน้าแรกต้องการแค่ 100 แถวล่าสุด
 *
 * สิ่งที่เทสต์นี้ยึดไว้:
 *   1. หน้าแรกแบบไม่กรอง ต้องเปิดไฟล์อ่านแค่วันเดียว (readDays === 1)
 *   2. ยอดรวมยังต้องถูกต้อง แม้จะไม่ได้เปิดไฟล์วันที่เหลือ (มาจากดัชนี)
 *   3. หน้าลึกต้องข้ามวันที่ไม่เกี่ยวได้ทั้งวัน โดยไม่เปิดไฟล์
 *   4. เมื่อมีคำค้น ต้องยอมสแกนทุกวันตามเดิม เพราะดัชนีไม่รู้ว่าตรงกี่แถว
 *   5. ลำดับและการไม่ซ้ำกันระหว่างหน้าต้องไม่เปลี่ยนไปจากเดิม
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const store = require('../lib/dns-log-store');

const INDEX_FILE = path.join(store.LIVE_DIR, 'index.json');

// ยอดรวมมาจากดัชนี ไม่ใช่การนับจากไฟล์ เทสต์จึงต้องล้างทั้งไฟล์และรายการในดัชนี
// ไม่งั้นรันครั้งที่สองจะได้ยอดสะสมของครั้งก่อน (เจอตอนเขียนเทสต์นี้ครั้งแรก)
function forgetDays(days) {
    days.forEach((d) => { try { fs.unlinkSync(store.livePath(d)); } catch (_) {} });
    try {
        const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
        days.forEach((d) => delete idx[d]);
        fs.writeFileSync(INDEX_FILE, JSON.stringify(idx));
    } catch (_) { /* ยังไม่มีดัชนี = ไม่มีอะไรต้องล้าง */ }
}

// ใช้ปีที่ไม่มีทางชนกับข้อมูลจริงหรือเทสต์อื่น
const DAYS = ['2017-03-01', '2017-03-02', '2017-03-03'];
const PER_DAY = 500;

function seed() {
    forgetDays(DAYS);
    for (let d = 0; d < DAYS.length; d++) {
        const day = DAYS[d];
        const rows = [];
        for (let i = 0; i < PER_DAY; i++) {
            // 03:00 น. ไทย = 20:00Z ของวันก่อนหน้า — เขียนเป็น UTC ให้ตกวันไทยที่ต้องการ
            const hh = String(3 + Math.floor(i / 100)).padStart(2, '0');
            const mm = String(i % 60).padStart(2, '0');
            const ss = String((i * 7) % 60).padStart(2, '0');
            rows.push({
                id: `${day}-${i}`,
                queryTime: `${day}T${hh}:${mm}:${ss}.000Z`,
                username: 'rm' + (100 + (i % 5)),
                ipAddress: '10.0.0.' + (i % 250),
                macAddress: 'AA:BB:CC:00:00:01',
                domain: (i % 50 === 0 ? 'needle.example.com' : 'site' + (i % 30) + '.com'),
                siteName: 'A4-Residence'
            });
        }
        store.appendRows(rows);
    }
}

function cleanup() {
    forgetDays(DAYS);
}

seed();

const FROM = DAYS[0];
const TO = DAYS[DAYS.length - 1];
const TOTAL = DAYS.length * PER_DAY;

describe('dns-log-store — หน้าแรกแบบไม่กรอง ต้องไม่สแกนทุกวัน', () => {
    it('เปิดไฟล์อ่านแค่วันเดียว แต่ยอดรวมยังถูกต้อง', async () => {
        const r = await store.query({ from: FROM, to: TO, page: 1, limit: 100 });
        assert.strictEqual(r.logs.length, 100);
        assert.strictEqual(r.total, TOTAL, 'ยอดรวมต้องนับครบทุกวันจากดัชนี');
        assert.strictEqual(r.readDays, 1, 'หน้าแรกต้องเปิดไฟล์แค่วันล่าสุดวันเดียว');
        assert.strictEqual(r.scannedDays, DAYS.length, 'แต่ยังต้องรู้ว่ามีทั้งหมดกี่วันในช่วง');
    });

    it('แถวที่ได้เป็นแถวใหม่ที่สุดจริง ๆ และเรียงใหม่ไปเก่า', async () => {
        const r = await store.query({ from: FROM, to: TO, page: 1, limit: 10 });
        const times = r.logs.map((x) => x.queryTime);
        assert.deepStrictEqual(times, [...times].sort().reverse());
        // ทุกแถวต้องมาจากวันล่าสุด เพราะวันล่าสุดมีตั้ง 500 แถว
        r.logs.forEach((x) => assert.ok(x.id.startsWith(DAYS[2]), 'ต้องมาจากวันล่าสุด'));
    });

    it('หน้าลึกข้ามวันที่ไม่เกี่ยวได้ทั้งวัน', async () => {
        // แถวลำดับ 1000-1099 อยู่ในวันที่เก่าที่สุด — ไม่ต้องเปิดไฟล์สองวันแรกเลย
        const r = await store.query({ from: FROM, to: TO, page: 11, limit: 100 });
        assert.strictEqual(r.logs.length, 100);
        assert.strictEqual(r.readDays, 1, 'ควรเปิดแค่วันที่หน้านั้นตกอยู่');
        r.logs.forEach((x) => assert.ok(x.id.startsWith(DAYS[0])));
    });

    it('หน้าที่คาบเกี่ยวสองวัน ต้องเปิดสองวันและได้ครบ 100 แถว', async () => {
        // ลำดับ 450-549 คร่อมรอยต่อวันล่าสุดกับวันกลาง
        const r = await store.query({ from: FROM, to: TO, page: 1, limit: 100 });
        const r5 = await store.query({ from: FROM, to: TO, page: 5, limit: 100 });
        assert.strictEqual(r5.logs.length, 100);
        assert.ok(r5.readDays >= 1);
        const ids1 = new Set(r.logs.map((x) => x.id));
        assert.ok(!r5.logs.some((x) => ids1.has(x.id)), 'หน้า 1 กับ 5 ต้องไม่ซ้ำกัน');
    });

    it('เลยจำนวนแถวที่มี คืนลิสต์ว่างแต่ยอดรวมยังถูก', async () => {
        const r = await store.query({ from: FROM, to: TO, page: 999, limit: 100 });
        assert.deepStrictEqual(r.logs, []);
        assert.strictEqual(r.total, TOTAL);
    });
});

describe('dns-log-store — มีเงื่อนไขกรอง ยังต้องสแกนครบเพื่อความถูกต้อง', () => {
    it('ค้นด้วยโดเมน ต้องอ่านทุกวันและนับได้ตรง', async () => {
        const r = await store.query({ from: FROM, to: TO, search: 'needle', page: 1, limit: 100 });
        // ทุก ๆ 100 แถวมี needle 1 แถว (i % 50 === 0 -> 10 แถวต่อวัน)
        assert.strictEqual(r.total, DAYS.length * (PER_DAY / 50));
        assert.strictEqual(r.readDays, DAYS.length, 'มีคำค้น = ดัชนีช่วยไม่ได้ ต้องอ่านทุกวัน');
        r.logs.forEach((x) => assert.strictEqual(x.domain, 'needle.example.com'));
    });

    it('กรองตาม username ก็ต้องอ่านทุกวันเช่นกัน', async () => {
        const r = await store.query({ from: FROM, to: TO, username: 'rm101', page: 1, limit: 50 });
        assert.strictEqual(r.total, DAYS.length * (PER_DAY / 5));
        assert.strictEqual(r.readDays, DAYS.length);
    });

    it('กรองที่ไม่ตรงอะไรเลย คืนศูนย์ ไม่โยน error', async () => {
        const r = await store.query({ from: FROM, to: TO, search: 'ไม่มีทางเจอ', page: 1, limit: 100 });
        assert.strictEqual(r.total, 0);
        assert.deepStrictEqual(r.logs, []);
    });
});

describe('dns-log-store — ผลลัพธ์ต้องเท่าเดิมกับการไล่อ่านทุกวันแบบตรงไปตรงมา', () => {
    it('รวม 3 หน้าแรกแล้วต้องได้ 300 แถวใหม่สุดโดยไม่ซ้ำกัน', async () => {
        const ids = [];
        for (let p = 1; p <= 3; p++) {
            const r = await store.query({ from: FROM, to: TO, page: p, limit: 100 });
            r.logs.forEach((x) => ids.push(x.id));
        }
        assert.strictEqual(ids.length, 300);
        assert.strictEqual(new Set(ids).size, 300, 'ต้องไม่มี id ซ้ำข้ามหน้า');
    });
});

process.on('exit', cleanup);
