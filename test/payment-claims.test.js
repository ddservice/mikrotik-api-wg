/**
 * เทสต์ lib/line-verify.js และ lib/payment-claims.js
 *
 * ที่มา (2026-09-06): เปิดรับสลิปแจ้งชำระเงินผ่าน LINE
 *
 * สองเรื่องที่เทสต์ชุดนี้มีไว้กัน:
 *   1. webhook ไม่เคยตรวจลายเซ็นเลย — พอมันเริ่มสร้างรายการทางการเงิน
 *      ใครก็ได้ที่รู้ URL จะยิงรายการปลอมเข้ามาได้
 *   2. อนุมัติซ้ำ = บันทึกเงินซ้ำและต่ออายุให้ฟรีอีกรอบ
 */

const assert = require('assert');
const lv = require('../lib/line-verify');
const pc = require('../lib/payment-claims');

const SECRET = 'channel-secret-สำหรับเทสต์';

describe('line-verify — ลายเซ็น webhook', () => {
    it('ลายเซ็นที่ถูกต้องผ่าน', () => {
        const body = JSON.stringify({ events: [{ type: 'message' }] });
        assert.strictEqual(lv.verifySignature(body, lv.signBody(body, SECRET), SECRET), true);
    });

    it('body ต่างไปแม้ตัวอักษรเดียวต้องไม่ผ่าน', () => {
        const body = JSON.stringify({ events: [] });
        const sig = lv.signBody(body, SECRET);
        assert.strictEqual(lv.verifySignature(body + ' ', sig, SECRET), false);
    });

    it('secret ผิดไม่ผ่าน', () => {
        const body = '{"a":1}';
        assert.strictEqual(lv.verifySignature(body, lv.signBody(body, 'อื่น'), SECRET), false);
    });

    it('ไม่มีลายเซ็น ไม่มี secret หรือไม่มี body = ไม่ผ่าน ไม่ใช่ผ่านไปเลย', () => {
        const body = '{"a":1}';
        assert.strictEqual(lv.verifySignature(body, '', SECRET), false);
        assert.strictEqual(lv.verifySignature(body, lv.signBody(body, SECRET), ''), false);
        assert.strictEqual(lv.verifySignature(null, 'x', SECRET), false);
    });

    it('ลายเซ็นความยาวไม่เท่ากันต้องไม่ทำให้ throw', () => {
        // timingSafeEqual โยน error ถ้าความยาวไม่ตรง ต้องกันไว้ก่อน
        assert.strictEqual(lv.verifySignature('{}', 'สั้น', SECRET), false);
    });

    it('Buffer กับ string ให้ผลเหมือนกัน', () => {
        const body = Buffer.from('{"ก":"ข"}', 'utf8');
        const sig = lv.signBody(body, SECRET);
        assert.strictEqual(lv.verifySignature(body, sig, SECRET), true);
        assert.strictEqual(lv.verifySignature(body.toString('utf8'), sig, SECRET), true);
    });
});

describe('payment-claims — รับสลิปเข้ามา', () => {
    const imgEvent = {
        type: 'message', timestamp: Date.UTC(2026, 8, 6, 3, 0, 0),
        message: { type: 'image', id: '5566' },
        source: { userId: 'U123' }
    };

    it('อ่าน event รูปภาพเป็นรายการแจ้งชำระ', () => {
        const c = pc.claimFromEvent(imgEvent, { username: 'rm301', siteId: 's1', siteName: 'A4' });
        assert.strictEqual(c.messageId, '5566');
        assert.strictEqual(c.username, 'rm301');
        assert.strictEqual(c.status, 'pending');
    });

    it('ยังไม่ผูกบัญชีก็ยังต้องรับเรื่องไว้ ไม่ใช่ทิ้ง', () => {
        // ทิ้งไปเท่ากับลูกค้าจ่ายเงินแล้วไม่มีใครรู้
        const c = pc.claimFromEvent(imgEvent, null);
        assert.ok(c);
        assert.strictEqual(c.username, null);
        assert.strictEqual(c.status, 'pending');
    });

    it('ข้อความตัวอักษรไม่ใช่การแจ้งชำระ', () => {
        assert.strictEqual(pc.claimFromEvent(
            { type: 'message', message: { type: 'text', text: 'สวัสดี' } }, null), null);
    });

    it('event ประเภทอื่นและ event ที่ไม่มี id ต้องไม่ผ่าน', () => {
        assert.strictEqual(pc.claimFromEvent({ type: 'follow' }, null), null);
        assert.strictEqual(pc.claimFromEvent(
            { type: 'message', message: { type: 'image' } }, null), null);
        assert.strictEqual(pc.claimFromEvent(null, null), null);
    });

    it('ข้อความตอบกลับบอกชัดว่ายังไม่ได้ต่ออายุ', () => {
        // ลูกค้าที่คิดว่าต่ออายุแล้วจะไม่ตามเรื่อง แล้วเน็ตดับตอนกลางคืน
        const withRoom = pc.ackMessage({ username: 'rm301' });
        assert.ok(withRoom.includes('ยังไม่ได้ต่ออายุ'));
        const noRoom = pc.ackMessage({ username: null });
        assert.ok(noRoom.includes('ผูกบัญชี'));
        assert.ok(noRoom.includes('ยังไม่ได้ต่ออายุ'));
    });
});

describe('payment-claims — ตรวจก่อนอนุมัติ', () => {
    const pending = { status: 'pending', username: 'rm301' };

    it('ข้อมูลครบ = ผ่าน', () => {
        const v = pc.validateApproval(pending, { amount: 3000, months: 1 });
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.username, 'rm301');
        assert.strictEqual(v.amount, 3000);
    });

    it('อนุมัติซ้ำไม่ได้ — ไม่งั้นบันทึกเงินซ้ำและต่ออายุให้ฟรีอีกรอบ', () => {
        const v = pc.validateApproval({ status: 'approved', username: 'rm301' }, { amount: 3000 });
        assert.strictEqual(v.ok, false);
        assert.ok(v.error.includes('อนุมัติ'));
    });

    it('รายการที่ปฏิเสธไปแล้วก็อนุมัติไม่ได้', () => {
        const v = pc.validateApproval({ status: 'rejected', username: 'rm301' }, { amount: 3000 });
        assert.strictEqual(v.ok, false);
    });

    it('ยังไม่รู้ห้อง = ต้องระบุตอนอนุมัติ', () => {
        const v = pc.validateApproval({ status: 'pending', username: null }, { amount: 3000 });
        assert.strictEqual(v.ok, false);
        assert.ok(v.error.includes('ห้องไหน'));
        // ระบุมาแล้วต้องผ่าน
        assert.strictEqual(
            pc.validateApproval({ status: 'pending', username: null },
                                { amount: 3000, username: 'rm302' }).ok, true);
    });

    it('จำนวนเงินต้องมากกว่า 0 และเป็นตัวเลข', () => {
        [0, -100, 'abc', null, undefined].forEach((amount) => {
            assert.strictEqual(pc.validateApproval(pending, { amount }).ok, false, String(amount));
        });
    });

    it('จำนวนเดือนอยู่ในช่วงที่สมเหตุสมผล', () => {
        assert.strictEqual(pc.validateApproval(pending, { amount: 100, months: 25 }).ok, false);
        assert.strictEqual(pc.validateApproval(pending, { amount: 100, months: 24 }).ok, true);
        // ไม่ระบุ = 1 เดือน
        assert.strictEqual(pc.validateApproval(pending, { amount: 100 }).months, 1);
    });

    it('ไม่มีรายการ = ไม่ผ่าน', () => {
        assert.strictEqual(pc.validateApproval(null, { amount: 100 }).ok, false);
    });
});

describe('payment-claims — เรียงลำดับ', () => {
    it('ค้างอยู่ขึ้นก่อน และในกลุ่มค้างเรียงเก่าสุดก่อน', () => {
        // ที่รอนานที่สุดคือคนที่จ่ายเงินไปแล้วและยังไม่ได้เน็ต
        const out = pc.sortClaims([
            { status: 'approved', receivedAt: '2026-09-06T10:00:00Z', messageId: 'a' },
            { status: 'pending', receivedAt: '2026-09-06T09:00:00Z', messageId: 'b' },
            { status: 'pending', receivedAt: '2026-09-05T09:00:00Z', messageId: 'c' },
            { status: 'rejected', receivedAt: '2026-09-06T11:00:00Z', messageId: 'd' }
        ]);
        assert.deepStrictEqual(out.map((c) => c.messageId), ['c', 'b', 'a', 'd']);
    });

    it('รายการว่างไม่พัง', () => {
        assert.deepStrictEqual(pc.sortClaims([]), []);
        assert.deepStrictEqual(pc.sortClaims(null), []);
    });
});

describe('payment-claims — ข้อความแจ้งผล', () => {
    it('อนุมัติแล้วบอกครบว่าได้อะไร', () => {
        const m = pc.approvedMessage({ username: 'rm301', amount: 3000, months: 1, dueDate: '2026-10-01' });
        ['rm301', '3,000', '2026-10-01'].forEach((x) => assert.ok(m.includes(x), x));
    });

    it('ปฏิเสธต้องมีเหตุผลเสมอ แม้ไม่ได้กรอกมา', () => {
        assert.ok(pc.rejectedMessage('ยอดไม่ตรง').includes('ยอดไม่ตรง'));
        assert.ok(pc.rejectedMessage('').includes('ไม่ระบุ'));
    });
});
