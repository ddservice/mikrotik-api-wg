/**
 * เทสต์ lib/time.js
 *
 * ทุกเคสที่นี่มาจากบั๊กที่เกิดขึ้นจริงบน production ไม่ใช่เคสสมมติ:
 *   - bangkokToday คืนวันผิดไปหนึ่งวันก่อน 07:00 -> ปิดผนึกผิดวันทุกคืน (2026-08-30)
 *   - query_time เก็บเวลาที่บันทึกแทนเวลาที่ query จริง (2026-08-29)
 */

const assert = require('assert');
const t = require('../lib/time');

describe('lib/time — bangkokNow / bangkokToday', () => {
    // เคสสำคัญ: ก่อน 07:00 น. เวลาไทย วันที่ตาม UTC จะเป็นวันก่อนหน้า
    // วิธีคำนวณแบบเก่าจึงคืนวันผิด ซึ่งคือช่วงที่งาน 02:00 ทำงานพอดี
    const cases = [
        ['2026-08-29T19:00:00Z', '2026-08-30', '02:00', 'ตีสองวันที่ 30 (ช่วงที่บั๊กเดิมพัง)'],
        ['2026-08-29T23:59:00Z', '2026-08-30', '06:59', 'หนึ่งนาทีก่อนขอบเขตที่บั๊กเดิมหาย'],
        ['2026-08-30T00:00:00Z', '2026-08-30', '07:00', 'ขอบเขตพอดี'],
        ['2026-08-30T09:00:00Z', '2026-08-30', '16:00', 'กลางวัน'],
        ['2026-08-30T16:59:00Z', '2026-08-30', '23:59', 'ก่อนเที่ยงคืนหนึ่งนาที'],
        ['2026-08-30T17:00:00Z', '2026-08-31', '00:00', 'เที่ยงคืนพอดี ต้องขึ้นวันใหม่'],
        ['2026-12-31T17:00:00Z', '2027-01-01', '00:00', 'ข้ามปี']
    ];

    cases.forEach(([iso, wantDate, wantHHMM, desc]) => {
        it(`${desc} -> ${wantDate} ${wantHHMM}`, () => {
            const r = t.bangkokNow(new Date(iso));
            assert.strictEqual(r.dateStr, wantDate, 'dateStr');
            assert.strictEqual(r.hhmm, wantHHMM, 'hhmm');
        });
    });

    it('minutes ตรงกับ hhmm', () => {
        const r = t.bangkokNow(new Date('2026-08-30T09:30:00Z'));  // 16:30 ไทย
        assert.strictEqual(r.minutes, 16 * 60 + 30);
    });

    it('bangkokToday ตรงกับ bangkokNow().dateStr', () => {
        const at = new Date('2026-08-29T19:00:00Z');
        assert.strictEqual(t.bangkokToday(at), t.bangkokNow(at).dateStr);
    });

    it('bangkokToday ตอนตีสองต้องเป็นวันปัจจุบัน ไม่ใช่เมื่อวาน', () => {
        // นี่คือบั๊กตัวจริง: แบบเดิมคืน 2026-08-29
        assert.strictEqual(t.bangkokToday(new Date('2026-08-29T19:00:00Z')), '2026-08-30');
    });
});

describe('lib/time — shiftDate', () => {
    it('ถอยหลังหนึ่งวัน', () => assert.strictEqual(t.shiftDate('2026-08-30', -1), '2026-08-29'));
    it('ข้ามต้นเดือน', () => assert.strictEqual(t.shiftDate('2026-09-01', -1), '2026-08-31'));
    it('ข้ามปี', () => assert.strictEqual(t.shiftDate('2027-01-01', -1), '2026-12-31'));
    it('ปีอธิกสุรทิน', () => assert.strictEqual(t.shiftDate('2028-03-01', -1), '2028-02-29'));
    it('เดินหน้าได้', () => assert.strictEqual(t.shiftDate('2026-08-30', 7), '2026-09-06'));
});

describe('lib/time — parseHHMMToMinutes', () => {
    it('09:00 -> 540', () => assert.strictEqual(t.parseHHMMToMinutes('09:00'), 540));
    it('9:05 -> 545 (ชั่วโมงหลักเดียว)', () => assert.strictEqual(t.parseHHMMToMinutes('9:05'), 545));
    it('00:00 -> 0', () => assert.strictEqual(t.parseHHMMToMinutes('00:00'), 0));
    it('23:59 -> 1439', () => assert.strictEqual(t.parseHHMMToMinutes('23:59'), 1439));
    it('ตัดช่องว่างหัวท้าย', () => assert.strictEqual(t.parseHHMMToMinutes('  08:30 '), 510));
    it('รูปแบบผิด -> null', () => assert.strictEqual(t.parseHHMMToMinutes('ไม่ใช่เวลา'), null));
    it('ค่าว่าง -> null', () => assert.strictEqual(t.parseHHMMToMinutes(''), null));
    it('ชั่วโมงเกิน 23 -> null', () => assert.strictEqual(t.parseHHMMToMinutes('25:00'), null));
    it('นาทีเกิน 59 -> null', () => assert.strictEqual(t.parseHHMMToMinutes('10:75'), null));
});

describe('lib/time — parseUptimeToMs', () => {
    it('1w2d3h4m5s', () => {
        const want = ((7 + 2) * 24 * 3600 + 3 * 3600 + 4 * 60 + 5) * 1000;
        assert.strictEqual(t.parseUptimeToMs('1w2d3h4m5s'), want);
    });
    it('รูปแบบ HH:MM:SS', () => assert.strictEqual(t.parseUptimeToMs('01:30:00'), 5400000));
    it('Unlimited -> 0', () => assert.strictEqual(t.parseUptimeToMs('Unlimited'), 0));
    it('00:00:00 -> 0', () => assert.strictEqual(t.parseUptimeToMs('00:00:00'), 0));
    it('ค่าว่าง -> 0', () => assert.strictEqual(t.parseUptimeToMs(''), 0));
    it('undefined -> 0', () => assert.strictEqual(t.parseUptimeToMs(undefined), 0));
    it('เฉพาะวินาที', () => assert.strictEqual(t.parseUptimeToMs('45s'), 45000));
    it('uptime ยาวจากเราท์เตอร์จริง (8w1d2h13m12s)', () => {
        const want = ((8 * 7 + 1) * 24 * 3600 + 2 * 3600 + 13 * 60 + 12) * 1000;
        assert.strictEqual(t.parseUptimeToMs('8w1d2h13m12s'), want);
    });
});

describe('lib/time — parseRouterOsLogTime', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');   // 07:00 น. เวลาไทย

    it('รูปแบบจริงจาก ROS 7.24.1', () => {
        assert.strictEqual(t.parseRouterOsLogTime('2026-08-29 04:51:51', now), '2026-08-28T21:51:51.000Z');
    });
    it('รูปแบบเก่ามีปี', () => {
        assert.strictEqual(t.parseRouterOsLogTime('aug/29/2026 04:51:51', now), '2026-08-28T21:51:51.000Z');
    });
    it('รูปแบบเก่าไม่มีปี', () => {
        assert.strictEqual(t.parseRouterOsLogTime('aug/29 04:51:51', now), '2026-08-28T21:51:51.000Z');
    });
    it('เวลาอย่างเดียว = วันนี้ของเราท์เตอร์', () => {
        assert.strictEqual(t.parseRouterOsLogTime('04:51:51', now), '2026-08-28T21:51:51.000Z');
    });

    it('ปฏิเสธเวลาที่ล้ำหน้าเกิน 2 ชม. (นาฬิกาเราท์เตอร์เพี้ยน)', () => {
        assert.strictEqual(t.parseRouterOsLogTime('2026-08-29 23:00:00', now), null);
    });
    it('ปฏิเสธเวลาที่เก่ากว่า 7 วัน', () => {
        assert.strictEqual(t.parseRouterOsLogTime('2026-07-01 10:00:00', now), null);
    });
    it('ปฏิเสธเดือนที่ไม่รู้จัก', () => {
        assert.strictEqual(t.parseRouterOsLogTime('xyz/29 04:51:51', now), null);
    });
    it('ปฏิเสธค่าว่างและค่าที่อ่านไม่ออก', () => {
        assert.strictEqual(t.parseRouterOsLogTime('', now), null);
        assert.strictEqual(t.parseRouterOsLogTime('ขยะ', now), null);
        assert.strictEqual(t.parseRouterOsLogTime(null, now), null);
    });

    it('log ปลายธันวาคมที่อ่านตอนต้นมกราคม ต้องได้ปีที่แล้ว', () => {
        const jan = new Date('2027-01-02T00:00:00.000Z');
        assert.strictEqual(t.parseRouterOsLogTime('dec/31 20:00:00', jan), '2026-12-31T13:00:00.000Z');
    });

    it('ผลลัพธ์ต้องเป็น UTC ไม่ใช่เวลาไทย (ต่างกัน 7 ชม.)', () => {
        const iso = t.parseRouterOsLogTime('2026-08-29 04:51:51', now);
        const back = new Date(iso);
        assert.strictEqual(back.getUTCHours(), 21, 'ควรเป็น 21:51 UTC = 04:51 ไทย');
    });
});
