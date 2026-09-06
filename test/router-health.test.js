/**
 * เทสต์ lib/router-health.js — ตัวตัดสินว่าเราท์เตอร์มีเรื่องต้องจัดการไหม
 *
 * มีผู้เรียกสองทางที่ต้องได้คำตอบตรงกันเสมอ: ปุ่ม "ตรวจเลย" ที่คนกด กับงานรายวัน
 * ที่ส่งเข้า Telegram เอง — จึงต้องเป็นตรรกะชุดเดียว และต้องคุมด้วยเทสต์
 *
 * สิ่งที่สำคัญที่สุดคือ **ต้องไม่เตือนพร่ำเพรื่อ** เราท์เตอร์ปกติต้องเงียบสนิท
 * ถ้าเตือนทุกวันทั้งที่ไม่มีอะไร คนจะปิดการแจ้งเตือนทิ้ง แล้ววันที่มีเรื่องจริง
 * ก็จะไม่มีใครเห็นเหมือนกัน — แย่กว่าไม่มีระบบเตือนเลย
 */

const assert = require('assert');
const rh = require('../lib/router-health');

// เราท์เตอร์ที่สุขภาพดี: RAM เหลือเยอะ ดิสก์ว่าง CPU ต่ำ ไม่ร้อน log สะอาด
function healthy(over) {
    return Object.assign({
        resource: {
            version: '7.24.1', 'board-name': 'hEX', uptime: '8w1d',
            'cpu-load': '3', 'free-memory': '900000000', 'total-memory': '1000000000',
            'free-hdd-space': '100000000', 'total-hdd-space': '128000000'
        },
        health: { temperature: '42' },
        logs: [{ time: '10:00:00', topics: 'system,info', message: 'user admin logged in via api' }],
        ifaces: [{ name: 'ether1', type: 'ether', running: 'true', disabled: 'false' }],
        leases: [{ address: '192.168.88.10', status: 'bound' }]
    }, over);
}

describe('router-health — เราท์เตอร์ปกติต้องเงียบ', () => {
    it('ไม่มีเรื่องต้องเตือนเลย', () => {
        const r = rh.analyzeHealth(healthy());
        assert.strictEqual(r.healthy, true);
        assert.strictEqual(r.findings.length, 0,
            'ถ้าเราท์เตอร์ปกติยังเตือน คนจะปิดการแจ้งเตือนทิ้งภายในสัปดาห์เดียว');
    });

    it('ไม่ส่งข้อความ Telegram เมื่อไม่มีเรื่องร้ายแรง', () => {
        assert.strictEqual(rh.formatAlert('A4', rh.analyzeHealth(healthy())), null);
    });

    it('มีแต่ระดับ "ควรดู" ก็ยังไม่ส่ง — ไม่ควรเด้งเข้าโทรศัพท์ทุกวัน', () => {
        const r = rh.analyzeHealth(healthy({ resource: Object.assign(healthy().resource, { 'cpu-load': '75' }) }));
        assert.strictEqual(r.counts.warning, 1);
        assert.strictEqual(r.counts.critical, 0);
        assert.strictEqual(rh.formatAlert('A4', r), null);
    });

    it('state ว่างเปล่าก็ไม่พัง', () => {
        const r = rh.analyzeHealth({});
        assert.strictEqual(r.healthy, true);
        assert.ok(r.router);
    });

    it('รับ null ได้', () => {
        assert.doesNotThrow(() => rh.analyzeHealth(null));
    });
});

describe('router-health — เกณฑ์แต่ละอย่าง', () => {
    const mem = (freePct) => healthy({
        resource: Object.assign(healthy().resource, {
            'free-memory': String(freePct * 10000000), 'total-memory': '1000000000'
        })
    });

    it('RAM เหลือ 5% = ร้ายแรง', () => {
        const r = rh.analyzeHealth(mem(5));
        assert.strictEqual(r.counts.critical, 1);
        assert.ok(r.findings[0].title.includes('หน่วยความจำ'));
    });
    it('RAM เหลือ 20% = ควรดู', () => {
        assert.strictEqual(rh.analyzeHealth(mem(20)).counts.warning, 1);
    });
    it('RAM เหลือ 40% = ไม่เตือน', () => {
        assert.strictEqual(rh.analyzeHealth(mem(40)).healthy, true);
    });

    it('ดิสก์เหลือน้อยกว่า 10% = ร้ายแรง', () => {
        const r = rh.analyzeHealth(healthy({
            resource: Object.assign(healthy().resource, { 'free-hdd-space': '5000000', 'total-hdd-space': '128000000' })
        }));
        assert.ok(r.findings.some((f) => f.severity === 'critical' && f.title.includes('พื้นที่')));
    });

    it('CPU 95% = ร้ายแรง, 75% = ควรดู, 40% = เงียบ', () => {
        const at = (v) => rh.analyzeHealth(healthy({
            resource: Object.assign(healthy().resource, { 'cpu-load': String(v) })
        }));
        assert.strictEqual(at(95).counts.critical, 1);
        assert.strictEqual(at(75).counts.warning, 1);
        assert.strictEqual(at(40).healthy, true);
    });

    it('อุณหภูมิ 75°C = ร้ายแรง, 65°C = ควรดู, 45°C = เงียบ', () => {
        const at = (v) => rh.analyzeHealth(healthy({ health: { temperature: String(v) } }));
        assert.strictEqual(at(75).counts.critical, 1);
        assert.strictEqual(at(65).counts.warning, 1);
        assert.strictEqual(at(45).healthy, true);
    });

    it('ไม่มีค่าอุณหภูมิ (บางรุ่นไม่มีเซ็นเซอร์) = ไม่เตือน ไม่ใช่เตือนว่า 0 องศา', () => {
        const r = rh.analyzeHealth(healthy({ health: {} }));
        assert.strictEqual(r.healthy, true);
        assert.strictEqual(r.router.temperature, null);
    });

    it('เตือนเฉพาะพอร์ตที่เคยใช้แต่สายหลุด ไม่เตือนพอร์ตที่ไม่เคยใช้', () => {
        // เคสจริงจากหน้างาน (2026-09-06): ether3/ether4 ไม่ได้เสียบสายไว้ตั้งแต่แรก
        // ขึ้นเตือนทั้งที่ไม่ใช่ปัญหา — พอร์ตที่ไม่เคยมีลิงก์ ไม่มี traffic ไม่มี comment
        // ต้องถือว่า "ไม่ได้ใช้" ไม่ใช่ "สายหลุด"
        const r = rh.analyzeHealth(healthy({
            ifaces: [
                { name: 'ether1', type: 'ether', running: 'true', disabled: 'false' },
                // ไม่เคยใช้ — ไม่มีหลักฐานใด ๆ ว่าเคยทำงาน
                { name: 'ether3', type: 'ether', running: 'false', disabled: 'false',
                  'rx-byte': '0', 'tx-byte': '0' },
                // เคยใช้จริง (last-link-up-time + traffic) แล้วสายหลุด
                { name: 'ether4', type: 'ether', running: 'false', disabled: 'false',
                  'last-link-up-time': 'sep/05/2026 18:48:03', 'rx-byte': '120000', 'tx-byte': '90000' },
                // มี comment กำกับว่าใช้ = ถือว่าตั้งใจใช้ แม้ไม่เคยลิงก์
                { name: 'ether7', type: 'ether', running: 'false', disabled: 'false',
                  comment: 'กล้องวงจรปิด' },
                // ปิดไว้เอง = ไม่ใช่ปัญหา
                { name: 'ether9', type: 'ether', running: 'false', disabled: 'true',
                  'last-link-up-time': 'sep/05/2026 10:00:00' }
            ]
        }));
        const f = r.findings.find((x) => x.title.includes('สายหลุด'));
        assert.ok(f, 'ต้องมีการเตือนพอร์ตที่เคยใช้แต่สายหลุด');
        assert.ok(f.detail.includes('ether4'), 'พอร์ตที่เคยใช้แล้วหลุดต้องขึ้น');
        assert.ok(f.detail.includes('ether7'), 'พอร์ตที่มี comment ต้องขึ้น');
        assert.ok(!f.detail.includes('ether3'), 'พอร์ตที่ไม่เคยใช้ต้องไม่ขึ้น');
        assert.ok(!f.detail.includes('ether9'), 'พอร์ตที่ปิดไว้เองต้องไม่ขึ้น');
    });

    it('พอร์ตที่ไม่เคยใช้ทั้งหมด = ไม่มีการเตือนพอร์ตเลย', () => {
        const r = rh.analyzeHealth(healthy({
            ifaces: [
                { name: 'ether1', type: 'ether', running: 'true', disabled: 'false' },
                { name: 'ether3', type: 'ether', running: 'false', disabled: 'false' },
                { name: 'ether4', type: 'ether', running: 'false', disabled: 'false' }
            ]
        }));
        assert.ok(!r.findings.some((x) => x.title.includes('สายหลุด') || x.title.includes('สัญญาณ')),
            'ether ที่ไม่ได้เสียบสายไว้ ไม่ควรทำให้เกิดการเตือน');
    });

    it('มี lease แต่ไม่มีตัวไหน bound = ควรดู', () => {
        const r = rh.analyzeHealth(healthy({ leases: [{ address: '1.1.1.1', status: 'waiting' }] }));
        assert.ok(r.findings.some((f) => f.title.includes('DHCP')));
    });

    it('ไม่มี lease เลย = ไม่เตือน (สาขาที่ไม่ได้ใช้ DHCP)', () => {
        assert.strictEqual(rh.analyzeHealth(healthy({ leases: [] })).healthy, true);
    });
});

describe('router-health — เอาเรื่องจาก log มารวมด้วย', () => {
    it('DHCP แปลกปลอมใน log กลายเป็นเรื่องร้ายแรง พร้อมวิธีแก้', () => {
        const r = rh.analyzeHealth(healthy({
            logs: [{ time: '10:00:00', topics: 'dhcp,warning',
                     message: 'dhcp alert on bridge-lan: discovered unknown dhcp server' }]
        }));
        const f = r.findings.find((x) => x.title.includes('DHCP server แปลกปลอม'));
        assert.ok(f);
        assert.strictEqual(f.severity, 'critical');
        assert.ok(f.action && f.action.length > 10, 'ต้องบอกวิธีแก้');
    });

    it('เรียงร้ายแรงขึ้นก่อนเสมอ', () => {
        const r = rh.analyzeHealth(healthy({
            resource: Object.assign(healthy().resource, { 'cpu-load': '75' }),
            logs: [{ time: '10:00:00', topics: 'system,info', message: 'out of memory' }]
        }));
        assert.strictEqual(r.findings[0].severity, 'critical');
    });

    it('log ท่วมก็ไม่ให้ล้นรายการ', () => {
        const many = [];
        for (let i = 0; i < 40; i++) {
            many.push({ time: '10:00:00', topics: 'system,error', message: 'unknown problem number ' + i });
        }
        const r = rh.analyzeHealth(healthy({ logs: many }));
        assert.ok(r.findings.length <= rh.THRESHOLDS.maxLogGroups + 2,
            'ต้องจำกัดจำนวน ไม่งั้นเรื่องอื่นจะถูกกลบ (ได้ ' + r.findings.length + ')');
    });
});

describe('router-health — ข้อความแจ้งเตือน', () => {
    const bad = () => rh.analyzeHealth(healthy({
        resource: Object.assign(healthy().resource, { 'free-memory': '50000000', 'total-memory': '1000000000', 'cpu-load': '75' })
    }));

    it('มีชื่อสาขา เรื่อง และวิธีแก้', () => {
        const text = rh.formatAlert('EstiaHotel', bad());
        assert.ok(text.includes('EstiaHotel'));
        assert.ok(text.includes('หน่วยความจำ'));
        assert.ok(text.includes('➜'), 'ต้องมีบรรทัดวิธีแก้');
    });

    it('บอกด้วยว่ามีเรื่องระดับ "ควรดู" อีกกี่เรื่อง แต่ไม่ลงรายละเอียด', () => {
        const text = rh.formatAlert('A4', bad());
        assert.ok(/มีอีก \d+ เรื่อง/.test(text));
        assert.ok(!text.includes('CPU ทำงานหนัก'), 'ระดับควรดูไม่ควรอยู่ในข้อความหลัก');
    });
});
