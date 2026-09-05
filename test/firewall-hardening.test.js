/**
 * เทสต์ lib/firewall-hardening.js
 *
 * ที่มา (2026-09-05): ตรวจชุดกฎความปลอดภัยแล้วพบว่ามัน "ติดตั้งสำเร็จ" ได้โดยไม่ป้องกันอะไรเลย
 * สองเรื่อง ทั้งคู่เป็นความล้มเหลวแบบเงียบ ซึ่งสำหรับฟีเจอร์ความปลอดภัยแย่กว่าไม่มี
 * เพราะคนจะเลิกมองหาปัญหาตรงนั้น
 *
 *   1. ใช้ /ip/firewall/filter/add เฉย ๆ = ต่อท้ายสุดของ chain
 *      RouterOS ไล่กฎบนลงล่างและหยุดที่กฎแรกที่ drop/accept
 *      เราท์เตอร์ที่ตั้งค่าแล้วปิดท้าย chain input ด้วย drop เกือบทุกตัว
 *      กฎที่ต่อท้ายหลังจากนั้นจึงไม่มีวันถูกเรียกใช้
 *
 *   2. กฎกัน DNS amplification อ้าง in-interface-list=WAN โดยไม่เคยสร้าง list นั้น
 *      RouterOS รับกฎที่อ้าง list ที่ไม่มีไปเฉย ๆ แล้วมันไม่ match อะไรเลย
 *      เราท์เตอร์จึงยังเป็น open DNS resolver ขณะที่หน้าจอบอกว่าป้องกันแล้ว
 */

const assert = require('assert');
const fw = require('../lib/firewall-hardening');

const someExisting = [
    { '.id': '*1', chain: 'input', action: 'accept', 'connection-state': 'established,related' },
    { '.id': '*2', chain: 'input', action: 'drop', comment: 'drop everything else' }
];

describe('firewall-hardening — ลำดับกฎต้องอยู่บนสุด', () => {
    it('เราท์เตอร์ที่มีกฎอยู่แล้ว ต้องแทรกไว้บนสุด ไม่ใช่ต่อท้าย', () => {
        const p = fw.planApply({ existingFilters: someExisting, wanInterfaces: ['ether1'] });
        const adds = p.steps.filter((s) => s.cmd === '/ip/firewall/filter/add');
        assert.strictEqual(p.placedFirst, true);
        adds.forEach((s) => assert.strictEqual(s.args['place-before'], '0',
            'ทุกกฎต้องแทรกบนสุด ไม่งั้นจะอยู่ใต้กฎ drop เดิมและไม่ถูกเรียก'));
    });

    it('ลำดับสุดท้ายบนเราท์เตอร์ต้องถูกต้อง — แทรกที่ 0 ทีละตัวจึงต้องไล่จากล่างขึ้นบน', () => {
        const p = fw.planApply({ existingFilters: someExisting, wanInterfaces: [] });
        const keys = p.steps.filter((s) => s.cmd === '/ip/firewall/filter/add').map((s) => s.key);
        // ส่งกลับหัว เพราะแต่ละตัวที่แทรกที่ 0 จะดันตัวก่อนหน้าลงไป
        assert.deepStrictEqual(keys, fw.RULES.map((r) => r.key).slice().reverse());

        // จำลองการแทรกจริงแล้วดูว่าลำดับบนเราท์เตอร์ออกมาถูก
        const chain = [];
        keys.forEach((k) => chain.unshift(k));
        assert.deepStrictEqual(chain, fw.RULES.map((r) => r.key),
            'ถ้าลำดับสลับ ทุก IP จะค้างที่ stage1 ตลอดกาลและไม่มีใครถูกแบนเลย');
    });

    it('chain ว่างเปล่า = ต่อท้ายตามปกติ ไม่ส่ง place-before', () => {
        // RouterOS ตอบ "no such item" ถ้าใช้ place-before=0 กับ chain ที่ยังไม่มีกฎ
        const p = fw.planApply({ existingFilters: [], wanInterfaces: ['ether1'] });
        assert.strictEqual(p.placedFirst, false);
        p.steps.filter((s) => s.cmd === '/ip/firewall/filter/add')
            .forEach((s) => assert.ok(!('place-before' in s.args)));
    });

    it('chain ว่าง = ลำดับที่ส่งต้องเรียงตามปกติ (ไม่กลับหัว)', () => {
        const p = fw.planApply({ existingFilters: [], wanInterfaces: [] });
        const keys = p.steps.filter((s) => s.cmd === '/ip/firewall/filter/add').map((s) => s.key);
        assert.deepStrictEqual(keys, fw.RULES.map((r) => r.key));
    });
});

describe('firewall-hardening — interface-list WAN ต้องมีจริงก่อนใช้', () => {
    it('ยังไม่มี list = สร้างให้ พร้อมใส่ขา WAN ที่ตรวจเจอ', () => {
        const p = fw.planApply({
            existingFilters: someExisting, wanInterfaces: ['pppoe-out1', 'ether2'],
            existingLists: [], existingMembers: []
        });
        assert.ok(p.steps.some((s) => s.cmd === '/interface/list/add' && s.args.name === 'WAN'));
        ['pppoe-out1', 'ether2'].forEach((i) => {
            assert.ok(p.steps.some((s) => s.cmd === '/interface/list/member/add' && s.args.interface === i),
                'ต้องใส่ ' + i + ' เข้า list');
        });
    });

    it('list กับสมาชิกมีอยู่แล้ว = ไม่สร้างซ้ำ', () => {
        const p = fw.planApply({
            existingFilters: someExisting, wanInterfaces: ['pppoe-out1'],
            existingLists: [{ name: 'WAN' }],
            existingMembers: [{ list: 'WAN', interface: 'pppoe-out1' }]
        });
        assert.ok(!p.steps.some((s) => s.cmd === '/interface/list/add'));
        assert.ok(!p.steps.some((s) => s.cmd === '/interface/list/member/add'));
    });

    it('สร้าง list ก่อนเพิ่มกฎที่อ้างถึงมันเสมอ', () => {
        const p = fw.planApply({ existingFilters: someExisting, wanInterfaces: ['ether1'] });
        const listIdx = p.steps.findIndex((s) => s.cmd === '/interface/list/add');
        const dnsIdx = p.steps.findIndex((s) => s.key && s.key.startsWith('block-dns'));
        assert.ok(listIdx >= 0 && dnsIdx > listIdx, 'ต้องมี list ก่อน ไม่งั้นกฎ DNS ไม่ match อะไรเลย');
    });

    it('หาขา WAN ไม่เจอ = ข้ามกฎ DNS และบอกเหตุผล ไม่ใส่กฎที่ไม่ทำงาน', () => {
        const p = fw.planApply({ existingFilters: someExisting, wanInterfaces: [] });
        assert.ok(!p.steps.some((s) => s.key && s.key.startsWith('block-dns')),
            'ใส่กฎที่อ้าง list ที่ไม่มีอยู่ = กฎที่ไม่ทำอะไร แต่ดูเหมือนป้องกันแล้ว');
        assert.ok(p.notes.some((n) => n.includes('open DNS resolver')));
    });
});

describe('firewall-hardening — ไม่ติดตั้งซ้ำ', () => {
    it('เจอคอมเมนต์ของกฎเดิม = ถือว่าติดตั้งแล้ว', () => {
        assert.strictEqual(fw.alreadyInstalled([{ comment: 'Drop Brute-Force Blacklisted IPs' }]), true);
    });
    it('เราท์เตอร์เปล่า = ยังไม่ติดตั้ง', () => {
        assert.strictEqual(fw.alreadyInstalled([]), false);
        assert.strictEqual(fw.alreadyInstalled(someExisting), false);
    });
});

describe('firewall-hardening — สคริปต์สำหรับวางเอง', () => {
    it('สร้าง interface-list WAN ให้ด้วย ไม่ใช่แค่ใช้เฉย ๆ', () => {
        const s = fw.buildScript(['pppoe-out1']);
        assert.ok(s.includes('/interface/list/add name=WAN'));
        assert.ok(s.includes('interface=pppoe-out1'));
        const listAt = s.indexOf('list/add name=WAN');
        const dnsAt = s.indexOf('in-interface-list=WAN');
        assert.ok(listAt >= 0 && dnsAt > listAt, 'ต้องสร้าง list ก่อนกฎที่อ้างถึง');
    });

    it('ไม่รู้ขา WAN = ใส่ตัวอย่างพร้อมบอกให้แก้ก่อนรัน', () => {
        const s = fw.buildScript([]);
        assert.ok(/EDIT THIS before running/.test(s));
        assert.ok(s.includes('interface=ether1'));
    });

    it('เตือนเรื่องลำดับกฎ เพราะสคริปต์ที่วางเองจะไปต่อท้าย chain', () => {
        const s = fw.buildScript(['ether1']);
        assert.ok(/ABOVE any existing/.test(s) || /ABOVE any drop rule/.test(s),
            'คนที่วางเองต้องรู้ว่าต้องลากกฎขึ้นบน ไม่งั้นกฎไม่ทำงาน');
    });

    it('มีกฎครบทุกข้อและค่าที่มีช่องว่างถูกครอบด้วยเครื่องหมายคำพูด', () => {
        const s = fw.buildScript(['ether1']);
        fw.RULES.forEach((r) => assert.ok(s.includes(r.args.comment.split(' ')[0]), r.key));
        assert.ok(s.includes('comment="Drop Invalid Packets (Input)"'));
    });

    it('พอร์ตที่เฝ้าครอบทั้ง WinBox, SSH, web และ API', () => {
        ['22', '8291', '80', '443', '8728'].forEach((p) =>
            assert.ok(fw.BRUTE_PORTS.includes(p), 'ขาดพอร์ต ' + p));
    });
});
