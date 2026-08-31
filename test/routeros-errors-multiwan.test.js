/**
 * เทสต์คำแนะนำสิทธิ์ของงาน Multi-WAN
 *
 * งานนี้แก้ mangle/route/NAT ซึ่งต้องมีสิทธิ์มากกว่างานอ่านทั่วไป ถ้าเราท์เตอร์
 * ปฏิเสธแล้วเราโยนข้อความดิบ "not enough permissions (9)" ออกไป คนอ่านจะไม่รู้ว่า
 * ต้องไปเพิ่มสิทธิ์อะไรที่ไหน — เป็นปัญหาเดียวกับที่เจอตอนกดอัปเกรด 1 คลิก
 */
const assert = require('assert');
const { explain, POLICY_HINTS } = require('../lib/routeros-errors');

describe('routeros-errors — งาน multiwan', () => {
    it('มีคำแนะนำสิทธิ์ของงาน multiwan', () => {
        assert.ok(POLICY_HINTS.multiwan, 'ต้องมีคีย์ multiwan');
        assert.deepStrictEqual(POLICY_HINTS.multiwan.need, ['write', 'policy']);
    });

    it('แปล error สิทธิ์ไม่พอให้บอกสิทธิ์ที่ต้องมีและที่ที่ต้องไปแก้', () => {
        const msg = explain(new Error('not enough permissions (9)'), {
            task: 'multiwan', username: 'ddserviceapi', siteName: 'A4-Residence'
        });
        assert.ok(msg.includes('ddserviceapi'), 'ต้องบอกว่าเป็นสิทธิ์ของผู้ใช้คนไหน');
        assert.ok(msg.includes('A4-Residence'), 'ต้องบอกว่าสาขาไหน');
        assert.ok(msg.includes('write'), 'ต้องบอกสิทธิ์ที่ขาด');
        assert.ok(msg.includes('WinBox'), 'ต้องบอกวิธีไปแก้');
        assert.ok(msg.includes('not enough permissions'), 'ต้องคงข้อความดิบไว้ให้อ้างอิงได้');
    });
});
