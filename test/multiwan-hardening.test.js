/**
 * เทสต์จากการตรวจเชิงลึกรอบสุดท้าย
 *
 * ทุกข้อในไฟล์นี้มาจากคำถามว่า "ถ้าเราท์เตอร์ไม่ได้เป็นอย่างที่เราคิด จะเกิดอะไรขึ้น"
 * ซึ่งเป็นคำถามที่ตอบไม่ได้ด้วยการอ่านโค้ด เพราะโค้ดกับตัวจำลองเขียนโดยคนเดียวกัน
 * และเข้าใจผิดเหมือนกันได้
 */

const assert = require('assert');
const an = require('../lib/multiwan-analyze');
const mwPlan = require('../lib/multiwan-plan');
const apply = require('../lib/multiwan-apply');

function state(over = {}) {
    return Object.assign({
        interfaces: [{ name: 'ether2' }, { name: 'pppoe-out1' }],
        pppoeClients: [{ '.id': '*A', name: 'pppoe-out1', running: 'true',
                         'default-route-distance': '1' }],
        dhcpClients: [{ '.id': '*B', interface: 'ether2', status: 'bound',
                        gateway: '192.168.1.1', 'default-route-distance': '1' }],
        routes: [], mangle: [], nat: [], addresses: [],
        dns: [{ servers: '203.113.1.1', 'allow-remote-requests': 'false' }],
        dhcpNetworks: [{ '.id': '*N1', address: '192.168.88.0/24',
                         gateway: '192.168.88.1', 'dns-server': '203.113.1.1' }],
        filter: [], ifaceLists: [], ifaceListMembers: []
    }, over);
}

const withDns = (st) => mwPlan.buildFailoverPlan(an.analyzeState(st || state()),
    { dnsResilience: true });

describe('hardening — กฎที่อ้าง interface list WAN ที่อาจไม่มีอยู่', () => {
    it('ตรวจได้ว่า list WAN ยังไม่มี และสมาชิกยังไม่ครบ', () => {
        const a = an.analyzeState(state());
        assert.strictEqual(a.wanList.exists, false);
        assert.deepStrictEqual(a.wanList.missingMembers.sort(), ['ether2', 'pppoe-out1']);
    });

    it('ไม่มี list = ต้องสร้างให้ก่อน ไม่งั้นกฎปิดกั้นไม่ match อะไรเลย', () => {
        // นี่คือกรณีอันตราย: กฎถูกสร้างสำเร็จ แต่ไม่ match แปลว่าเราท์เตอร์
        // เป็น open resolver ทั้งที่หน้าจอบอกว่าปิดกั้นแล้ว
        const steps = withDns().steps;
        const mk = steps.find((s) => s.id === 'wan-list');
        assert.ok(mk, 'ต้องมีขั้นสร้าง list');
        assert.ok(steps.findIndex((s) => s.id === 'wan-list') <
                  steps.findIndex((s) => s.id === 'dns-block-wan'),
            'ต้องสร้าง list ก่อนสร้างกฎที่อ้างถึงมัน');
    });

    it('เพิ่มทุก WAN เข้าเป็นสมาชิกของ list', () => {
        const ids = withDns().steps.map((s) => s.id);
        assert.ok(ids.includes('wan-list-member-pppoe-out1'));
        assert.ok(ids.includes('wan-list-member-ether2'));
    });

    it('list มีอยู่แล้วและสมาชิกครบ = ไม่แตะซ้ำ', () => {
        const st = state({
            ifaceLists: [{ name: 'WAN' }],
            ifaceListMembers: [{ list: 'WAN', interface: 'pppoe-out1' },
                               { list: 'WAN', interface: 'ether2' }]
        });
        const ids = withDns(st).steps.map((s) => s.id);
        assert.ok(!ids.includes('wan-list'));
        assert.ok(!ids.some((i) => i.startsWith('wan-list-member-')));
    });

    it('list กับ member ที่สร้างเองต้องถอนคืนได้ และ rollback script ครอบคลุม', () => {
        const p = withDns();
        p.steps.filter((s) => s.id.startsWith('wan-list')).forEach((s) => {
            assert.ok(s.undo, s.id + ' ไม่มีวิธีย้อนกลับ');
            assert.ok(String(s.apply.args.comment).includes(mwPlan.TAG));
        });
        const sc = mwPlan.buildRollbackScript(p);
        assert.ok(sc.includes('/interface list member remove'));
        assert.ok(sc.includes('/interface list remove'));
    });
});

describe('hardening — place-before บนรายการ filter ที่ยังว่าง', () => {
    it('ยังไม่มี filter rule เลย = ต้องไม่ส่ง place-before (RouterOS จะ error)', () => {
        const st = withDns().steps.find((s) => s.id === 'dns-block-wan');
        assert.ok(!('place-before' in st.apply.args),
            'ส่ง place-before=0 บนรายการว่างจะได้ no such item');
    });

    it('มี filter rule อยู่แล้ว = ต้องแทรกไว้บนสุด', () => {
        const st = withDns(state({ filter: [{ '.id': '*F1', chain: 'input' }] }))
            .steps.find((s) => s.id === 'dns-block-wan');
        assert.strictEqual(st.apply.args['place-before'], '0');
    });
});

describe('hardening — ต้องพิสูจน์ว่าตัวถอนถูกสร้างจริง', () => {
    function makePlan() {
        return mwPlan.buildFailoverPlan(an.analyzeState(state()));
    }

    /** เราท์เตอร์ที่รับคำสั่งสร้าง scheduler แต่ไม่ได้เก็บไว้จริง */
    function silentlyDrops() {
        const calls = [];
        return {
            calls,
            async exec(cmd, args = {}) {
                calls.push({ cmd, args });
                if (cmd === '/ping') return [{ received: '1' }];
                if (cmd === '/system/scheduler/print') return [];   // หายไปเฉย ๆ
                if (cmd.endsWith('/add')) return [{ '.id': '*X1' }];
                return [];
            }
        };
    }

    it('scheduler หายไปหลังสร้าง = หยุดทันที ไม่ลงต่อโดยไม่มีตาข่ายรับ', async () => {
        const c = silentlyDrops();
        const r = await apply.applyFailover({ client: c, plan: makePlan() });

        assert.strictEqual(r.success, false);
        assert.strictEqual(r.preflight, true);
        assert.strictEqual(r.applied, 0);
        assert.ok(r.error.includes('ตัวถอน'));

        const wroteRoutes = c.calls.filter((x) => x.cmd.includes('/ip/route/'));
        assert.strictEqual(wroteRoutes.length, 0, 'ห้ามแตะ routing table เลย');
    });

    it('สคริปต์ข้างในไม่ครบ = หยุด และลบตัวที่ไม่สมบูรณ์ทิ้ง ไม่ทิ้งขยะ', async () => {
        // เคสที่เป็นไปได้จริง: RouterOS บางรุ่นไม่รับ on-event หลายบรรทัดผ่าน API
        const calls = [];
        const c = {
            calls,
            async exec(cmd, args = {}) {
                calls.push({ cmd, args });
                if (cmd === '/ping') return [{ received: '1' }];
                if (cmd === '/system/scheduler/print') {
                    return [{ '.id': '*S1', name: mwPlan.ROLLBACK_NAME, 'on-event': '' }];
                }
                if (cmd.endsWith('/add')) return [{ '.id': '*X1' }];
                return [];
            }
        };
        const r = await apply.applyFailover({ client: c, plan: makePlan() });

        assert.strictEqual(r.preflight, true);
        assert.ok(r.error.includes('ไม่ครบ'));
        const removed = calls.filter((x) => x.cmd === '/system/scheduler/remove');
        assert.strictEqual(removed.length, 1, 'ต้องเก็บกวาดตัวที่ไม่สมบูรณ์');
    });

    it('ทุกอย่างปกติ = ผ่านการตรวจแล้วลงต่อได้', async () => {
        const scheduler = [];
        const c = {
            async exec(cmd, args = {}) {
                if (cmd === '/ping') return [{ received: '1' }, { received: '1' }];
                if (cmd === '/system/scheduler/add') {
                    scheduler.push({ '.id': '*S1', name: args.name, 'on-event': args['on-event'] });
                    return [{ '.id': '*S1' }];
                }
                if (cmd === '/system/scheduler/print') return scheduler.slice();
                if (cmd === '/system/scheduler/remove') { scheduler.length = 0; return []; }
                if (cmd.endsWith('/add')) return [{ '.id': '*X1' }];
                return [];
            }
        };
        const r = await apply.applyFailover({ client: c, plan: makePlan() });
        assert.strictEqual(r.success, true);
    });
});

describe('hardening — ห้ามลงทับของที่ติดตั้งอยู่แล้ว', () => {
    /** สภาพหลังติดตั้งไปแล้วรอบหนึ่ง */
    function installed() {
        return state({
            routes: [
                { comment: mwPlan.TAG + ' default pppoe-out1 d=1 orig=1',
                  distance: '1', active: 'true', 'dst-address': '0.0.0.0/0' }
            ],
            pppoeClients: [{ '.id': '*A', name: 'pppoe-out1', running: 'true',
                             'default-route-distance': '10' }],
            dhcpClients: [{ '.id': '*B', interface: 'ether2', status: 'bound',
                            gateway: '192.168.1.1', 'default-route-distance': '11' }]
        });
    }

    it('ติดตั้งอยู่แล้ว = ปฏิเสธ ไม่ยอมสร้างแผน', () => {
        // ที่เจอตอนทดสอบ: กด apply ซ้ำไม่กี่ครั้งได้ route 30 เส้น netwatch 5 ตัว
        assert.throws(
            () => mwPlan.buildFailoverPlan(an.analyzeState(installed())),
            /ติดตั้ง Multi-WAN failover ไว้อยู่แล้ว/
        );
    });

    it('บอกให้กด Remove ก่อน และบอกด้วยว่าทำไม', () => {
        try {
            mwPlan.buildFailoverPlan(an.analyzeState(installed()));
            assert.fail('ควรจะโยน error');
        } catch (e) {
            assert.strictEqual(e.alreadyInstalled, true);
            assert.ok(e.message.includes('Remove'));
            assert.ok(e.message.includes('ถอนคืนค่าเดิมไม่ได้'),
                'ต้องบอกผลเสียจริง ไม่ใช่แค่ห้าม');
        }
    });

    it('ยังไม่ติดตั้ง = สร้างแผนได้ตามปกติ', () => {
        assert.ok(mwPlan.buildFailoverPlan(an.analyzeState(state())).steps.length > 0);
    });
});

describe('hardening — ถอนออกต้องเก็บ interface list ที่สร้างเองด้วย', () => {
    it('ลบสมาชิกก่อนลบ list และไม่แตะของลูกค้า', async () => {
        const calls = [];
        const c = {
            async exec(cmd, args = {}) {
                calls.push({ cmd, args });
                if (cmd === '/interface/list/member/print') {
                    return [{ '.id': '*M1', comment: mwPlan.TAG + ' wan member' },
                            { '.id': '*M2', comment: 'สมาชิกของลูกค้า' }];
                }
                if (cmd === '/interface/list/print') {
                    return [{ '.id': '*L1', comment: mwPlan.TAG + ' wan list' },
                            { '.id': '*L2', name: 'LAN' }];
                }
                if (cmd === '/ip/route/print') return [];
                if (cmd === '/ip/firewall/nat/print') return [];
                if (cmd === '/ip/firewall/filter/print') return [];
                if (cmd === '/tool/netwatch/print') return [];
                if (cmd === '/system/scheduler/print') return [];
                if (cmd === '/system/script/print') return [];
                return [];
            }
        };
        const r = await apply.removeAll(c, []);

        assert.strictEqual(r.listMembers, 1);
        assert.strictEqual(r.lists, 1);

        const iMem = calls.findIndex((x) => x.cmd === '/interface/list/member/remove');
        const iList = calls.findIndex((x) => x.cmd === '/interface/list/remove');
        assert.ok(iMem < iList, 'ต้องลบสมาชิกก่อน ไม่งั้น RouterOS ปฏิเสธเพราะยังมีของอ้างอยู่');

        const removedLists = calls.filter((x) => x.cmd === '/interface/list/remove')
            .map((x) => x.args['.id']);
        assert.ok(!removedLists.includes('*L2'), 'ห้ามลบ list ของลูกค้า');
    });
});
