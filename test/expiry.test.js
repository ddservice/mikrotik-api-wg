/**
 * เทสต์ lib/expiry.js
 *
 * ที่มา (2026-09-06): วันครบกำหนดของทุกห้องเช่าและทุกคูปองอยู่ใน comment ของเราท์เตอร์
 * ไฟล์นี้จึงเป็นสิ่งเดียวที่ทำให้ข้อมูลการเงินของธุรกิจอ่านออกได้ — และมันเคยอยู่ใน
 * server.js ซึ่งเทสต์ไม่ได้เลย
 *
 * สองเรื่องที่เทสต์ชุดนี้มีไว้กัน:
 *   1. บั๊กไทม์โซน — ของเดิมใช้เวลาของเครื่อง VPS ซึ่งไม่มีที่ไหนปักหมุดไว้
 *   2. บัญชีที่ไม่มีวันหมดอายุหายไปจากรายงานเงียบ ๆ = รายได้รั่วโดยไม่มีร่องรอย
 */

const assert = require('assert');
const ex = require('../lib/expiry');

// 2026-08-30 23:59:59 เวลาไทย = 2026-08-30T16:59:59Z
const AUG30_END_BKK = Date.UTC(2026, 7, 30, 16, 59, 59);

describe('expiry — อ่านวันที่ตามเวลาไทยเสมอ', () => {
    it('ไม่ระบุเวลา = สิ้นวันตามเวลาไทย ไม่ใช่สิ้นวันตามเครื่อง', () => {
        assert.strictEqual(ex.parseExpiry('หมดอายุ 2026-08-30'), AUG30_END_BKK);
    });

    it('ผลลัพธ์ต้องไม่เปลี่ยนตามไทม์โซนของเครื่อง — นี่คือบั๊กที่แก้', () => {
        // ของเดิมใช้ new Date(y,m,d,...) ซึ่งได้คนละค่าเมื่อเครื่องเป็น UTC กับเป็นเวลาไทย
        // ต่างกัน 7 ชั่วโมง = ห้องที่หมดอายุแล้วยังอ่านว่าใช้ได้จนถึงเช้าอีกวัน
        const before = process.env.TZ;
        const got = [];
        for (const tz of ['UTC', 'Asia/Bangkok', 'America/New_York']) {
            process.env.TZ = tz;
            got.push(ex.parseExpiry('2026-08-30'));
        }
        if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
        assert.strictEqual(new Set(got).size, 1, 'ค่าเปลี่ยนตามไทม์โซนของเครื่อง');
        assert.strictEqual(got[0], AUG30_END_BKK);
    });

    it('รูปแบบ DD/MM/YYYY', () => {
        assert.strictEqual(ex.parseExpiry('ครบกำหนด 30/08/2026'), AUG30_END_BKK);
    });

    it('ปี พ.ศ. แปลงเป็น ค.ศ.', () => {
        assert.strictEqual(ex.parseExpiry('30/08/2569'), AUG30_END_BKK);
    });

    it('รูปแบบของ MikroTik เอง', () => {
        assert.strictEqual(ex.parseExpiry('aug/30/2026'), AUG30_END_BKK);
    });

    it('ระบุเวลาเองได้', () => {
        assert.strictEqual(ex.parseExpiry('2026-08-30 14:30'),
                           Date.UTC(2026, 7, 30, 7, 30, 59));
    });

    it('วันที่ไม่มีอยู่จริงต้องไม่ผ่าน', () => {
        // 31 ก.พ. เดิมกลายเป็น 3 มี.ค. เงียบ ๆ เพราะ Date เลื่อนให้เอง
        assert.strictEqual(ex.parseExpiry('2026-02-31'), null);
    });

    it('ไม่มีวันที่ = null ไม่ใช่เดา', () => {
        assert.strictEqual(ex.parseExpiry('ห้อง 301 นายสมชาย'), null);
        assert.strictEqual(ex.parseExpiry(''), null);
        assert.strictEqual(ex.parseExpiry(null), null);
    });
});

describe('expiry — จัดสถานะ', () => {
    const now = Date.UTC(2026, 7, 25, 5, 0, 0);   // 25 ส.ค. เที่ยงวันไทย

    it('ยังไม่ถึงกำหนดและเหลือหลายวัน = active', () => {
        assert.strictEqual(ex.classify({ comment: '2026-09-30' }, now).status, 'active');
    });

    it('เหลือไม่เกิน 7 วัน = soon', () => {
        assert.strictEqual(ex.classify({ comment: '2026-08-30' }, now).status, 'soon');
    });

    it('เลยกำหนดแล้ว = expired', () => {
        assert.strictEqual(ex.classify({ comment: '2026-08-20' }, now).status, 'expired');
    });

    it('ถูกปิดใช้งานอยู่ = suspended ถึงจะยังไม่ถึงกำหนด', () => {
        assert.strictEqual(
            ex.classify({ comment: '2026-09-30', disabled: 'true' }, now).status, 'suspended');
    });

    it('เขียนว่าค้างชำระในคอมเมนต์ก็นับว่าถูกระงับ', () => {
        assert.strictEqual(ex.classify({ comment: 'ค้างชำระ 2026-09-30' }, now).status, 'suspended');
    });

    it('ไม่มีวันหมดอายุ = no-expiry ไม่ใช่ active', () => {
        // จุดสำคัญที่สุด: ถ้าเหมาเป็น active มันจะไม่โผล่ในรายงานไหนเลยตลอดไป
        // และไม่มีใครรู้ว่าห้องนี้ไม่เคยถูกตามเก็บเงิน
        const c = ex.classify({ name: 'rm301', comment: 'ห้อง 301' }, now);
        assert.strictEqual(c.status, 'no-expiry');
        assert.strictEqual(c.expiry, null);
        assert.strictEqual(c.daysLeft, null);
    });

    it('นับวันคงเหลือถูก', () => {
        assert.strictEqual(ex.classify({ comment: '2026-08-30' }, now).daysLeft, 5);
    });
});

describe('expiry — สรุปทั้งสาขา', () => {
    const now = Date.UTC(2026, 7, 25, 5, 0, 0);
    const rooms = [
        { name: 'rm101', comment: 'ครบกำหนด 2026-12-31' },
        { name: 'rm102', comment: 'ห้อง 102' },
        { name: 'rm103', comment: '2026-08-20' },
        { name: 'rm104', comment: '2026-08-27' },
        { name: 'rm105', comment: '2026-09-30', disabled: 'true' }
    ];

    it('นับครบทุกสถานะ', () => {
        const s = ex.summarise(rooms, now);
        assert.strictEqual(s.total, 5);
        assert.deepStrictEqual(s.counts,
            { expired: 1, soon: 1, 'no-expiry': 1, suspended: 1, active: 1 });
    });

    it('เรียงเรื่องด่วนขึ้นก่อน', () => {
        const s = ex.summarise(rooms, now);
        assert.deepStrictEqual(s.items.map((i) => i.name),
            ['rm103', 'rm104', 'rm102', 'rm105', 'rm101']);
    });

    it('needsAttention รวมห้องที่ไม่มีวันหมดอายุด้วย', () => {
        const s = ex.summarise(rooms, now);
        assert.deepStrictEqual(s.needsAttention.map((i) => i.name).sort(),
            ['rm102', 'rm103', 'rm104']);
    });

    it('ไม่มีบัญชีเลยก็ไม่พัง', () => {
        const s = ex.summarise([], now);
        assert.strictEqual(s.total, 0);
        assert.strictEqual(s.needsAttention.length, 0);
    });
});
