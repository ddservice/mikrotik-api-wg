/**
 * เทสต์ lib/billing.js
 *
 * ที่มา (2026-09-06): ย้ายวันครบกำหนดค่าเช่าจากช่อง comment บนเราท์เตอร์
 * มาเป็นตารางจริง และเพิ่มการบันทึกการชำระเงิน
 *
 * สามเรื่องที่ต้องไม่พลาด เพราะพลาดแล้วเป็นเรื่องเงินของคนอื่น:
 *   1. บวกเดือนแล้ววันต้องไม่เลื่อนสะสม (31 ม.ค. + 1 เดือน ต้องไม่กลายเป็น 3 มี.ค.)
 *   2. จ่ายช้าแล้วต้องไม่ได้เดือนนั้นยาวขึ้นฟรี
 *   3. เขียน comment กลับลงเราท์เตอร์แล้วข้อความเดิมของพนักงานต้องไม่หาย
 */

const assert = require('assert');
const b = require('../lib/billing');

describe('billing — บวกเดือนแบบที่คนคิด', () => {
    it('เดือนปกติ', () => {
        assert.strictEqual(b.addMonths('2026-03-15', 1), '2026-04-15');
    });

    it('31 ม.ค. + 1 เดือน = 28 ก.พ. ไม่ใช่ 3 มี.ค.', () => {
        // ถ้าปล่อยให้ Date เลื่อนเอง วันครบกำหนดจะเลื่อนสะสมไปเรื่อย ๆ ทุกเดือนสั้น
        assert.strictEqual(b.addMonths('2026-01-31', 1), '2026-02-28');
    });

    it('ปีอธิกสุรทิน', () => {
        assert.strictEqual(b.addMonths('2028-01-31', 1), '2028-02-29');
    });

    it('ข้ามปี', () => {
        assert.strictEqual(b.addMonths('2026-12-20', 1), '2027-01-20');
    });

    it('หลายเดือนพร้อมกัน', () => {
        assert.strictEqual(b.addMonths('2026-01-31', 3), '2026-04-30');
    });

    it('วันที่ไม่ถูกรูปแบบ = null ไม่ใช่เดา', () => {
        assert.strictEqual(b.addMonths('31/01/2026', 1), null);
        assert.strictEqual(b.addMonths('', 1), null);
    });
});

describe('billing — วันครบกำหนดใหม่หลังรับชำระ', () => {
    it('ต่อจากวันครบกำหนดเดิม ไม่ใช่จากวันที่จ่าย', () => {
        // จ่ายช้า 5 วัน ต้องไม่ได้เดือนนั้นยาวขึ้น 5 วันฟรี
        const r = b.nextDueDate({ currentDue: '2026-09-01', paidOn: '2026-09-06', months: 1 });
        assert.strictEqual(r.dueDate, '2026-10-01');
        assert.strictEqual(r.resetFromPayment, false);
    });

    it('จ่ายก่อนกำหนดก็ยังต่อจากกำหนดเดิม', () => {
        const r = b.nextDueDate({ currentDue: '2026-09-30', paidOn: '2026-09-06', months: 1 });
        assert.strictEqual(r.dueDate, '2026-10-30');
    });

    it('ค้างเกินหนึ่งรอบ = เริ่มนับจากวันที่จ่าย และบอกว่าข้ามให้', () => {
        // ไล่บวกจากของเดิมจะได้วันที่ยังอยู่ในอดีต จ่ายแล้วยังขึ้นว่าค้างอยู่ดี
        const r = b.nextDueDate({ currentDue: '2026-05-01', paidOn: '2026-09-06', months: 1 });
        assert.strictEqual(r.dueDate, '2026-10-06');
        assert.strictEqual(r.resetFromPayment, true);
    });

    it('ห้องที่ไม่เคยมีวันครบกำหนด = นับจากวันที่จ่าย', () => {
        const r = b.nextDueDate({ currentDue: null, paidOn: '2026-09-06', months: 1 });
        assert.strictEqual(r.dueDate, '2026-10-06');
        assert.strictEqual(r.resetFromPayment, true);
    });

    it('จ่ายล่วงหน้าหลายเดือน', () => {
        const r = b.nextDueDate({ currentDue: '2026-09-01', paidOn: '2026-09-06', months: 6 });
        assert.strictEqual(r.dueDate, '2027-03-01');
        assert.strictEqual(r.months, 6);
    });

    it('จำนวนเดือนถูกจำกัดช่วง ไม่ให้พิมพ์ผิดกลายเป็นสิบปี', () => {
        assert.strictEqual(b.nextDueDate({ currentDue: '2026-09-01', paidOn: '2026-09-06', months: 999 }).months, 24);
        assert.strictEqual(b.nextDueDate({ currentDue: '2026-09-01', paidOn: '2026-09-06', months: 0 }).months, 1);
    });
});

describe('billing — comment ที่เขียนกลับลงเราท์เตอร์', () => {
    it('เก็บข้อความเดิมของพนักงานไว้', () => {
        assert.strictEqual(b.buildComment('คุณสมชาย 081-234-5678', '2026-10-01'),
                           'คุณสมชาย 081-234-5678 ครบกำหนด 2026-10-01');
    });

    it('แทนวันครบกำหนดเดิม ไม่ใช่ต่อท้ายเพิ่ม', () => {
        // ต่อท้ายเรื่อย ๆ จะได้ comment ที่มีหลายวันที่ แล้ว parser จะอ่านตัวแรกที่เจอ
        const out = b.buildComment('คุณสมชาย ครบกำหนด 2026-09-01', '2026-10-01');
        assert.strictEqual(out, 'คุณสมชาย ครบกำหนด 2026-10-01');
        assert.strictEqual((out.match(/\d{4}-\d{2}-\d{2}/g) || []).length, 1);
    });

    it('ลบวันที่ลอย ๆ ที่ไม่มีคำนำหน้าด้วย', () => {
        assert.strictEqual(b.buildComment('คุณมานี 01/09/2026', '2026-10-01'),
                           'คุณมานี ครบกำหนด 2026-10-01');
    });

    it('comment ว่างก็ใช้ได้ ไม่มีช่องว่างนำหน้า', () => {
        assert.strictEqual(b.buildComment('', '2026-10-01'), 'ครบกำหนด 2026-10-01');
        assert.strictEqual(b.buildComment(null, '2026-10-01'), 'ครบกำหนด 2026-10-01');
    });

    it('ผลลัพธ์ต้องอ่านกลับได้ด้วย lib/expiry — ไม่งั้นวงจรขาด', () => {
        const ex = require('../lib/expiry');
        const c = b.buildComment('คุณสมชาย', '2026-10-01');
        assert.strictEqual(ex.parseExpiry(c), b.dueDateToEpoch('2026-10-01'));
    });
});

describe('billing — สรุปยอด', () => {
    const rooms = [
        { username: 'rm101', rent: 3000, dueDate: '2026-10-01' },
        { username: 'rm102', rent: 3000, dueDate: '2026-08-01' },   // ค้าง
        { username: 'rm103', rent: 3500, dueDate: null },           // ไม่เคยตั้งวันครบกำหนด
        { username: 'rm104', rent: 3000, dueDate: '2026-10-05', active: false } // ห้องว่าง
    ];
    const payments = [
        { username: 'rm101', amount: 3000, paidOn: '2026-09-01' },
        { username: 'rm102', amount: 1500, paidOn: '2026-09-03' },
        { username: 'rm101', amount: 3000, paidOn: '2026-08-01' }   // เดือนก่อน
    ];

    it('นับเฉพาะการชำระในเดือนที่ถาม', () => {
        const s = b.summariseRevenue(rooms, payments, '2026-09', '2026-09-06');
        assert.strictEqual(s.collected, 4500);
        assert.strictEqual(s.paymentCount, 2);
    });

    it('ยอดที่ควรได้ ไม่นับห้องว่าง', () => {
        const s = b.summariseRevenue(rooms, payments, '2026-09', '2026-09-06');
        assert.strictEqual(s.expected, 9500);
        assert.strictEqual(s.roomCount, 3);
    });

    it('ห้องที่ไม่มีวันครบกำหนดนับเป็นค้างด้วย', () => {
        // จุดสำคัญ: ปล่อยไว้เท่ากับห้องนั้นไม่เคยถูกตามเก็บและไม่มีใครรู้
        const s = b.summariseRevenue(rooms, payments, '2026-09', '2026-09-06');
        assert.strictEqual(s.overdueCount, 2);
        assert.strictEqual(s.noDueDateCount, 1);
        assert.deepStrictEqual(s.overdue.map((o) => o.username).sort(), ['rm102', 'rm103']);
    });

    it('บอกว่าค้างมากี่วัน', () => {
        const s = b.summariseRevenue(rooms, payments, '2026-09', '2026-09-06');
        const rm102 = s.overdue.find((o) => o.username === 'rm102');
        assert.strictEqual(rm102.daysOverdue, 36);
        // ห้องที่ไม่มีวันครบกำหนด บอกจำนวนวันไม่ได้ ต้องเป็น null ไม่ใช่ 0
        assert.strictEqual(s.overdue.find((o) => o.username === 'rm103').daysOverdue, null);
    });

    it('ไม่มีห้องเลยก็ไม่พัง', () => {
        const s = b.summariseRevenue([], [], '2026-09', '2026-09-06');
        assert.strictEqual(s.collected, 0);
        assert.strictEqual(s.overdueCount, 0);
    });
});
