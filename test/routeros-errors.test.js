/**
 * เทสต์ lib/routeros-errors.js
 *
 * ข้อความ error ที่ดีต้องบอกสามอย่าง: เกิดอะไร ทำไม และต้องทำอะไรต่อ
 * ของดิบจากอุปกรณ์บอกแค่อย่างแรก ("not enough permissions (9)")
 */

const assert = require('assert');
const e = require('../lib/routeros-errors');

describe('lib/routeros-errors — จับ error เรื่องสิทธิ์', () => {
    it('จับข้อความจริงที่ RouterOS ส่งมา', () => {
        assert.ok(e.isPermissionError(new Error('not enough permissions (9)')));
        assert.ok(e.isPermissionError('permission denied'));
    });
    it('ไม่จับ error อื่น', () => {
        assert.ok(!e.isPermissionError(new Error('timeout')));
        assert.ok(!e.isPermissionError(''));
        assert.ok(!e.isPermissionError(null));
    });
});

describe('lib/routeros-errors — explain', () => {
    it('บอกครบว่าใคร ขาดอะไร และไปแก้ที่ไหน', () => {
        const msg = e.explain(new Error('not enough permissions (9)'),
            { task: 'upgrade', username: 'ddserviceapi', siteName: 'A4-Residence' });
        assert.ok(msg.includes('ddserviceapi'), 'ต้องบอกชื่อผู้ใช้');
        assert.ok(msg.includes('A4-Residence'), 'ต้องบอกสาขา');
        assert.ok(msg.includes('reboot'), 'ต้องบอกสิทธิ์ที่ขาด');
        assert.ok(msg.includes('WinBox'), 'ต้องบอกวิธีไปแก้');
        assert.ok(msg.includes('not enough permissions'), 'ต้องคงข้อความดิบไว้ให้อ้างอิงได้');
    });

    it('อธิบายว่าทำไมงานนี้ถึงต้องใช้สิทธิ์นั้น', () => {
        const msg = e.explain('not enough permissions (9)', { task: 'upgrade' });
        assert.ok(msg.includes('รีบูต'), 'ต้องอธิบายว่าอัปเกรดแล้วเราท์เตอร์รีบูตเอง');
    });

    it('งานต่างกันบอกสิทธิ์ต่างกัน', () => {
        assert.ok(e.explain('permission denied', { task: 'backup' }).includes('sensitive'));
        assert.ok(e.explain('permission denied', { task: 'user' }).includes('policy'));
    });

    it('รหัสผ่านผิด ชี้ไปที่หน้าตั้งค่า', () => {
        const msg = e.explain(new Error('invalid user name or password (6)'));
        assert.ok(msg.includes('ตั้งค่า'));
    });

    it('ต่อไม่ได้ ชี้ไปที่เครื่องมือวินิจฉัย', () => {
        ['timeout', 'ECONNREFUSED', 'EHOSTUNREACH'].forEach((raw) => {
            assert.ok(e.explain(new Error(raw)).includes('วินิจฉัย'), raw);
        });
    });

    it('error อื่นคืนตามเดิม ไม่แต่งเติม', () => {
        assert.strictEqual(e.explain(new Error('some other failure')), 'some other failure');
    });

    it('ค่าว่างไม่ทำให้พัง', () => {
        assert.doesNotThrow(() => e.explain(null));
        assert.doesNotThrow(() => e.explain(undefined));
        assert.ok(e.explain('').length > 0);
    });
});
