/**
 * เทสต์ lib/pppoe-iface.js
 *
 * ที่มา: /ppp/active/print ไม่มี bytes-in/out ต้องไปหาจาก interface แบบไดนามิก
 * ที่ RouterOS สร้างให้แต่ละ session ซึ่งตั้งชื่อไม่เหมือนกันทุกรุ่น
 * ถ้าหาไม่เจอ ยอดใช้งานของห้องจะเป็น 0 ทั้งที่ลูกค้าใช้เน็ตอยู่ — ซึ่งเคยเกิดจริง
 * และทำให้บันทึกการใช้งาน PPPoE เป็น 0 ไปหลายเดือน (2026-07-13)
 */

const assert = require('assert');
const { resolvePppoeIface, pppoeIfaceCandidates } = require('../lib/pppoe-iface');

describe('lib/pppoe-iface — pppoeIfaceCandidates', () => {
    it('เสนอรูปแบบที่พบจริงเป็นตัวแรก', () => {
        assert.strictEqual(pppoeIfaceCandidates('rm101')[0], '<pppoe-rm101>');
    });
    it('ครอบคลุมรูปแบบที่ไม่มีวงเล็บด้วย', () => {
        assert.ok(pppoeIfaceCandidates('rm101').includes('pppoe-rm101'));
    });
    it('ชื่อว่าง -> ไม่มีตัวเลือก', () => {
        assert.deepStrictEqual(pppoeIfaceCandidates(''), []);
        assert.deepStrictEqual(pppoeIfaceCandidates(null), []);
    });
});

describe('lib/pppoe-iface — resolvePppoeIface', () => {
    const iface = (name, rx, tx) => ({ name, 'rx-byte': String(rx), 'tx-byte': String(tx) });

    it('เจอรูปแบบ <pppoe-USER> (รูปแบบที่ยืนยันกับ A4 แล้ว)', () => {
        const m = new Map([['<pppoe-rm101>', iface('<pppoe-rm101>', 123, 456)]]);
        assert.strictEqual(resolvePppoeIface(m, 'rm101')['rx-byte'], '123');
    });

    it('เจอรูปแบบ pppoe-USER', () => {
        const m = new Map([['pppoe-rm102', iface('pppoe-rm102', 7, 8)]]);
        assert.strictEqual(resolvePppoeIface(m, 'rm102')['tx-byte'], '8');
    });

    it('ใช้ได้กับ object ธรรมดา ไม่ใช่แค่ Map', () => {
        const o = { '<pppoe-rm103>': iface('<pppoe-rm103>', 9, 10) };
        assert.strictEqual(resolvePppoeIface(o, 'rm103')['rx-byte'], '9');
    });

    it('หาแบบยืดหยุ่นเมื่อชื่อไม่ตรงรูปแบบใดเลย', () => {
        const m = new Map([['pppoe-out-rm104-dyn', iface('pppoe-out-rm104-dyn', 11, 12)]]);
        assert.strictEqual(resolvePppoeIface(m, 'rm104')['rx-byte'], '11');
    });

    it('ไม่หยิบ interface ของห้องอื่นมาให้ผิดห้อง', () => {
        const m = new Map([
            ['<pppoe-rm201>', iface('<pppoe-rm201>', 1, 1)],
            ['<pppoe-rm202>', iface('<pppoe-rm202>', 2, 2)]
        ]);
        assert.strictEqual(resolvePppoeIface(m, 'rm202')['rx-byte'], '2');
    });

    it('ไม่เจอ -> null (ไม่ใช่คืน interface มั่ว ๆ)', () => {
        const m = new Map([['ether1', iface('ether1', 1, 1)]]);
        assert.strictEqual(resolvePppoeIface(m, 'rm999'), null);
    });

    it('ชื่อว่าง -> null', () => {
        assert.strictEqual(resolvePppoeIface(new Map(), ''), null);
        assert.strictEqual(resolvePppoeIface(new Map(), null), null);
    });

    it('ไม่หยิบ interface ที่ชื่อมี username แต่ไม่ใช่ pppoe', () => {
        const m = new Map([['bridge-rm105', iface('bridge-rm105', 5, 5)]]);
        assert.strictEqual(resolvePppoeIface(m, 'rm105'), null);
    });
});
