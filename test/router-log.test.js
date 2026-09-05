/**
 * เทสต์ lib/router-log.js — ตัวแปล log ของ RouterOS เป็นภาษาคน
 *
 * สิ่งที่ยึด: การเตือนต้องบอกให้ครบสามอย่าง — เกิดอะไรขึ้น แปลว่าอะไร ทำอะไรต่อ
 * การเตือนที่บอกแค่ว่าเจออะไรแต่ทำอะไรต่อไม่ได้ สุดท้ายจะไม่มีใครอ่าน
 * และเมื่อของจริงเกิดขึ้นก็จะถูกกลบไปกับเสียงรบกวน
 */

const assert = require('assert');
const rl = require('../lib/router-log');

describe('router-log — จัดระดับจาก topics', () => {
    it('error / critical = ร้ายแรง', () => {
        assert.strictEqual(rl.severityFromTopics('system,error'), rl.SEVERITY.CRITICAL);
        assert.strictEqual(rl.severityFromTopics('critical'), rl.SEVERITY.CRITICAL);
    });
    it('warning = เตือน', () => {
        assert.strictEqual(rl.severityFromTopics('dhcp,warning'), rl.SEVERITY.WARNING);
    });
    it('ทั่วไป = แค่ข้อมูล', () => {
        assert.strictEqual(rl.severityFromTopics('system,info'), rl.SEVERITY.INFO);
        assert.strictEqual(rl.severityFromTopics(''), rl.SEVERITY.INFO);
    });
});

describe('router-log — แปลข้อความที่เจอบ่อยจริง', () => {
    const cases = [
        ['login failure for user admin from 203.0.113.9 via winbox', 'login-failure'],
        ['dhcp alert on bridge-lan: discovered unknown dhcp server, mac AA:BB:CC:DD:EE:FF', 'rogue-dhcp'],
        ['ether1: link down', 'link-down'],
        ['pppoe-out1: authentication failed', 'pppoe-auth-failed'],
        ['pppoe-out1: disconnected', 'pppoe-down'],
        ['router was rebooted without proper shutdown', 'reboot'],
        ['bridge-lan: received packet with own address as source address', 'bridge-loop'],
        ['out of memory, dropping connection', 'out-of-memory']
    ];

    cases.forEach(([msg, code]) => {
        it(`"${msg.slice(0, 42)}..." -> ${code}`, () => {
            const r = rl.classify({ message: msg, topics: 'system', time: '10:00:00' });
            assert.strictEqual(r.code, code);
        });
    });

    it('ทุกกฎต้องตอบครบสามข้อ: เกิดอะไร / แปลว่าอะไร / ทำอะไรต่อ', () => {
        rl.RULES.forEach((rule) => {
            assert.ok(rule.title && rule.title.length > 5, rule.code + ' ขาดหัวข้อ');
            assert.ok(rule.meaning && rule.meaning.length > 15, rule.code + ' ขาดคำอธิบาย');
            assert.ok(rule.action && rule.action.length > 15,
                rule.code + ' ขาดคำแนะนำว่าต้องทำอะไร — การเตือนที่ทำอะไรต่อไม่ได้ไม่ควรมี');
        });
    });

    it('ข้อความที่ไม่รู้จัก ไม่เดา — คืน code เป็น null แต่ยังจัดระดับตาม topics ได้', () => {
        const r = rl.classify({ message: 'something we have never seen', topics: 'system,error' });
        assert.strictEqual(r.code, null);
        assert.strictEqual(r.severity, rl.SEVERITY.CRITICAL, 'topics บอกว่า error ก็ต้องเชื่อ');
        assert.strictEqual(r.action, null, 'ไม่รู้จักก็ต้องไม่แนะนำมั่ว');
    });

    it('กฎบอกว่าร้ายแรงกว่า topics ให้ใช้ของกฎ', () => {
        // topics เป็นแค่ info แต่ DHCP แปลกปลอมคือเรื่องใหญ่เสมอ
        const r = rl.classify({ message: 'dhcp alert on bridge: discovered unknown dhcp server', topics: 'dhcp,info' });
        assert.strictEqual(r.severity, rl.SEVERITY.CRITICAL);
    });
});

describe('router-log — สรุปเป็นเรื่อง ไม่ใช่เป็นบรรทัด', () => {
    function many(msg, n, topics) {
        return Array.from({ length: n }, (_, i) => ({
            message: msg, topics: topics || 'system,error', time: '10:' + String(i % 60).padStart(2, '0') + ':00'
        }));
    }

    it('เรื่องเดียวกันหลายร้อยบรรทัด ยุบเหลือรายการเดียวพร้อมจำนวน', () => {
        const s = rl.summarize(many('login failure for user admin from 203.0.113.9 via winbox', 250));
        assert.strictEqual(s.total, 250);
        assert.strictEqual(s.groups.length, 1);
        assert.strictEqual(s.groups[0].count, 250);
    });

    it('เดารหัสรัว ๆ ต้องถูกยกระดับเป็นร้ายแรง — ต่างจากพิมพ์ผิดสองครั้ง', () => {
        const few = rl.summarize(many('login failure for user admin from 1.2.3.4 via winbox', 2, 'system,info'));
        assert.strictEqual(few.groups[0].severity, rl.SEVERITY.WARNING);
        assert.ok(!few.groups[0].escalated);

        const lots = rl.summarize(many('login failure for user admin from 1.2.3.4 via winbox', 60, 'system,info'));
        assert.strictEqual(lots.groups[0].severity, rl.SEVERITY.CRITICAL);
        assert.ok(lots.groups[0].escalated);
        assert.ok(lots.groups[0].meaning.includes('60'), 'ต้องบอกจำนวนครั้งในคำอธิบาย');
    });

    it('เรียงร้ายแรงขึ้นก่อน แล้วค่อยเรียงตามจำนวน', () => {
        const s = rl.summarize([
            ...many('ether5: link down', 3, 'interface,info'),
            ...many('out of memory', 1, 'system,info'),
            ...many('ether9: link down', 1, 'interface,info')
        ]);
        assert.strictEqual(s.groups[0].code, 'out-of-memory', 'ร้ายแรงต้องมาก่อนแม้จะเกิดครั้งเดียว');
    });

    it('บอกได้ว่ามีเรื่องที่ต้องลงมือทำหรือไม่', () => {
        assert.strictEqual(rl.summarize(many('ether1: link down', 1, 'interface,info')).needsAttention, false);
        assert.strictEqual(rl.summarize(many('out of memory', 1, 'system,info')).needsAttention, true);
    });

    it('log ว่าง = ไม่มีอะไรต้องทำ ไม่ใช่ error', () => {
        const s = rl.summarize([]);
        assert.strictEqual(s.total, 0);
        assert.strictEqual(s.groups.length, 0);
        assert.strictEqual(s.needsAttention, false);
    });

    it('รับค่าที่ไม่ใช่อาร์เรย์ได้โดยไม่พัง', () => {
        assert.strictEqual(rl.summarize(null).total, 0);
        assert.strictEqual(rl.summarize(undefined).total, 0);
    });

    it('นับเวลาแรกและเวลาล่าสุดของแต่ละเรื่อง', () => {
        const s = rl.summarize([
            { message: 'ether1: link down', topics: 'interface', time: '09:00:00' },
            { message: 'ether1: link down', topics: 'interface', time: '11:30:00' }
        ]);
        assert.strictEqual(s.groups[0].firstTime, '09:00:00');
        assert.strictEqual(s.groups[0].lastTime, '11:30:00');
    });
});
