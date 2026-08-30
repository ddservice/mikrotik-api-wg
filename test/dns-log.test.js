/**
 * เทสต์ lib/dns-log.js
 *
 * บรรทัดตัวอย่างคัดมาจาก log จริงของเราท์เตอร์ที่ใช้งานอยู่ (ROS 7.24.1, Suksawad-CMU)
 * ไม่ใช่ตัวอย่างที่แต่งขึ้น — สิ่งที่ต้องมั่นใจคือบรรทัด "done query:" ต้องไม่ถูกนับ
 * เป็น query ใหม่ ไม่งั้นจำนวนที่เก็บจะเกินจริงเท่าตัว
 */

const assert = require('assert');
const { parseDnsLogMessage } = require('../lib/dns-log');

describe('lib/dns-log — parseDnsLogMessage', () => {
    it('จับ "query from" ของจริงได้', () => {
        const r = parseDnsLogMessage('query from 172.16.1.164: #836227 easylist-downloads.adblockplus.org. A');
        assert.deepStrictEqual(r, { sourceIp: '172.16.1.164', domain: 'easylist-downloads.adblockplus.org' });
    });

    it('จับโดเมนที่มีหลายระดับได้', () => {
        const r = parseDnsLogMessage('query from 172.16.1.101: #837730 gateway.fe2.apple-dns.net. A');
        assert.deepStrictEqual(r, { sourceIp: '172.16.1.101', domain: 'gateway.fe2.apple-dns.net' });
    });

    it('แปลงโดเมนเป็นตัวพิมพ์เล็กเสมอ', () => {
        const r = parseDnsLogMessage('query from 10.0.0.5: #1 WWW.Google.COM. A');
        assert.strictEqual(r.domain, 'www.google.com');
    });

    it('รองรับรูปแบบ "resolving X from IP"', () => {
        const r = parseDnsLogMessage('resolving example.com from 192.168.1.10');
        assert.deepStrictEqual(r, { sourceIp: '192.168.1.10', domain: 'example.com' });
    });

    // นี่คือครึ่งหนึ่งของบรรทัดในบัฟเฟอร์จริง ถ้านับผิดจะได้จำนวนเกินจริงเท่าตัว
    it('ไม่นับบรรทัด "done query:" เป็น query ใหม่', () => {
        assert.strictEqual(parseDnsLogMessage('done query: #837729 gateway.fe2.apple-dns.net. 17.248.216.28'), null);
        assert.strictEqual(parseDnsLogMessage('done query: #836227 dns name exists, but no appropriate record'), null);
    });

    it('คืน null เมื่อไม่มีอะไรให้จับ', () => {
        assert.strictEqual(parseDnsLogMessage(''), null);
        assert.strictEqual(parseDnsLogMessage(null), null);
        assert.strictEqual(parseDnsLogMessage(undefined), null);
        assert.strictEqual(parseDnsLogMessage('user admin logged in from 10.0.0.1 via winbox'), null);
    });

    it('ไม่พังเมื่อได้ค่าที่ไม่ใช่สตริง', () => {
        assert.strictEqual(parseDnsLogMessage(12345), null);
        assert.doesNotThrow(() => parseDnsLogMessage({}));
    });

    it('เก็บเฉพาะระดับโดเมน ไม่มีเนื้อหา (ตามที่ ม.26 กำหนด)', () => {
        const r = parseDnsLogMessage('query from 172.16.1.50: #99 analytics.tiktokcdn.com. A');
        assert.deepStrictEqual(Object.keys(r).sort(), ['domain', 'sourceIp']);
    });
});
