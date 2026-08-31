/**
 * เทสต์ DNS resilience — กับดักที่ทำให้ failover "ดูเหมือนไม่ทำงาน"
 *
 * ลูกข่ายได้ DNS ของ ISP สายหลักมาทาง DHCP พอสายหลักตาย เส้นทางสลับสำเร็จ
 * แต่ลูกค้าเปิดเว็บไม่ได้ เพราะ resolver นั้นเข้าถึงได้เฉพาะสายที่ตายไปแล้ว
 *
 * ขั้นนี้เป็นขั้นเดียวในระบบที่เปลี่ยนสิ่งที่ลูกข่ายได้รับจริง จึงต้องปิดไว้
 * เป็นค่าเริ่มต้นและต้องพิสูจน์ได้ว่าปิดจริง
 */

const assert = require('assert');
const an = require('../lib/multiwan-analyze');
const mwPlan = require('../lib/multiwan-plan');

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
                         gateway: '192.168.88.1', 'dns-server': '203.113.1.1' }]
    }, over);
}

describe('multiwan-dns — ตรวจว่ามีกับดักหรือไม่', () => {
    it('แจก DNS ของ ISP และเราท์เตอร์ไม่ได้เป็น resolver = เสี่ยง', () => {
        const d = an.analyzeState(state()).dns;
        assert.strictEqual(d.atRisk, true);
        assert.strictEqual(d.routerIsResolver, false);
        assert.deepStrictEqual(d.riskyNetworks, ['192.168.88.0/24']);
    });

    it('ตั้งครบถูกต้องแล้ว = ไม่เสี่ยง ไม่ต้องแตะอะไร', () => {
        const d = an.analyzeState(state({
            dns: [{ servers: '1.1.1.1', 'allow-remote-requests': 'true' }],
            dhcpNetworks: [{ '.id': '*N1', address: '192.168.88.0/24',
                             gateway: '192.168.88.1', 'dns-server': '192.168.88.1' }]
        })).dns;
        assert.strictEqual(d.atRisk, false);
    });

    it('ไม่ได้ตั้ง dns-server เลย = ลูกข่ายได้ของ ISP = เสี่ยง', () => {
        const d = an.analyzeState(state({
            dhcpNetworks: [{ '.id': '*N1', address: '192.168.88.0/24', gateway: '192.168.88.1' }]
        })).dns;
        assert.strictEqual(d.atRisk, true);
    });

    it('เตือนในรายการ warnings ด้วย ไม่ใช่ซ่อนไว้ใน field', () => {
        const r = an.analyzeState(state());
        assert.ok(r.warnings.some((w) => w.code === 'dns-not-resilient'));
    });
});

describe('multiwan-dns — ต้องปิดไว้เป็นค่าเริ่มต้น', () => {
    it('ไม่เปิด option = ไม่มีขั้น DNS สักขั้น', () => {
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state()));
        assert.strictEqual(p.steps.filter((s) => s.id.startsWith('dns-')).length, 0);
    });

    it('ไม่เปิด option = ไม่แตะ DHCP หรือ firewall เลย', () => {
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state()));
        assert.ok(!p.steps.some((s) => s.apply.cmd.includes('dhcp-server')));
        assert.ok(!p.steps.some((s) => s.apply.cmd.includes('firewall/filter')));
        assert.ok(!p.steps.some((s) => s.apply.cmd.includes('/ip/dns')));
    });
});

describe('multiwan-dns — เมื่อเปิด option', () => {
    function withDns() {
        return mwPlan.buildFailoverPlan(an.analyzeState(state()), { dnsResilience: true });
    }

    it('เปิดให้เราท์เตอร์เป็น resolver พร้อม upstream สาธารณะ', () => {
        const st = withDns().steps.find((s) => s.id === 'dns-resolver');
        assert.ok(st);
        assert.strictEqual(st.apply.args['allow-remote-requests'], 'yes');
        assert.ok(st.apply.args.servers.includes('1.1.1.1'));
    });

    it('ปิดกั้น DNS จาก WAN ทั้ง UDP และ TCP เสมอ — ห้ามเป็น open resolver', () => {
        // เปิด allow-remote-requests โดยไม่ปิดกั้นขาเข้า = เราท์เตอร์ถูกใช้ขยาย
        // กำลังโจมตี DDoS ใส่คนอื่นได้ สองอย่างนี้ต้องมาคู่กันเสมอ
        const steps = withDns().steps;
        const udp = steps.find((s) => s.id === 'dns-block-wan');
        const tcp = steps.find((s) => s.id === 'dns-block-wan-tcp');
        assert.ok(udp && tcp, 'ต้องมีทั้ง UDP และ TCP');
        [udp, tcp].forEach((s) => {
            assert.strictEqual(s.apply.args.chain, 'input');
            assert.strictEqual(s.apply.args['dst-port'], '53');
            assert.strictEqual(s.apply.args.action, 'drop');
            assert.strictEqual(s.apply.args['in-interface-list'], 'WAN');
        });
    });

    it('การปิดกั้นต้องมาหลังการเปิด resolver ในลำดับการลง', () => {
        const ids = withDns().steps.map((s) => s.id);
        assert.ok(ids.indexOf('dns-resolver') < ids.indexOf('dns-block-wan'));
    });

    it('สั่ง DHCP แจก IP ของเราท์เตอร์เองเป็น DNS', () => {
        const st = withDns().steps.find((s) => s.id === 'dns-dhcp-*N1');
        assert.ok(st);
        assert.strictEqual(st.apply.args['dns-server'], '192.168.88.1');
    });

    it('network ที่ตั้งถูกอยู่แล้วต้องไม่ถูกแตะซ้ำ', () => {
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state({
            dhcpNetworks: [{ '.id': '*N1', address: '192.168.88.0/24',
                             gateway: '192.168.88.1', 'dns-server': '192.168.88.1' }]
        })), { dnsResilience: true });
        assert.ok(!p.steps.some((s) => s.id.startsWith('dns-dhcp-')));
    });

    it('ทุกขั้น DNS ย้อนกลับได้ และคืนค่าเดิมจริง', () => {
        const steps = withDns().steps.filter((s) => s.id.startsWith('dns-'));
        assert.ok(steps.length > 0);
        steps.forEach((s) => assert.ok(s.undo, s.id + ' ไม่มีวิธีย้อนกลับ'));

        const res = steps.find((s) => s.id === 'dns-resolver');
        assert.strictEqual(res.undo.args['allow-remote-requests'], 'no');
        assert.strictEqual(res.undo.args.servers, '203.113.1.1');

        const dhcp = steps.find((s) => s.id === 'dns-dhcp-*N1');
        assert.strictEqual(dhcp.undo.args['dns-server'], '203.113.1.1');
    });

    it('firewall rule ที่เพิ่มติดคอมเมนต์กำกับ เพื่อให้ถอนออกได้ครบ', () => {
        withDns().steps.filter((s) => s.id.startsWith('dns-block')).forEach((s) => {
            assert.ok(String(s.apply.args.comment).includes(mwPlan.TAG));
        });
    });

    it('rollback script ถอน firewall rule ออกด้วย', () => {
        assert.ok(mwPlan.buildRollbackScript(withDns()).includes('/ip firewall filter remove'));
    });
});

describe('multiwan-dns — ถอนแล้วต้องคืนค่าได้จริง', () => {
    const apply = require('../lib/multiwan-apply');

    function withDns() {
        return mwPlan.buildFailoverPlan(an.analyzeState(state()), { dnsResilience: true });
    }

    it('เก็บค่า DNS เดิมไว้บนเราท์เตอร์ ก่อนจะไปเปลี่ยนมัน', () => {
        // ค่า DNS เป็น "การตั้งค่า" ไม่ใช่ "รายการ" จึงติดคอมเมนต์กำกับไม่ได้
        // ถ้าไม่เก็บค่าเดิมไว้ ปุ่ม Remove จะถอนไม่กลับ — ช่องโหว่แบบเดียวกับ
        // บั๊ก default-route-distance ที่เคยเจอ
        const steps = withDns().steps;
        const save = steps.find((s) => s.id === 'dns-save-original');
        assert.ok(save, 'ต้องมีขั้นเก็บค่าเดิม');

        const iSave = steps.indexOf(save);
        const iChange = steps.findIndex((s) => s.id === 'dns-resolver');
        assert.ok(iSave < iChange, 'ต้องเก็บค่าเดิมก่อนไปเปลี่ยน');

        const src = save.apply.args.source;
        assert.ok(src.includes('203.113.1.1'), 'ต้องเก็บ upstream เดิม');
        assert.ok(src.includes('allow-remote-requests=no'), 'ต้องเก็บสถานะ resolver เดิม');
        assert.ok(src.includes('dns-server="203.113.1.1"'), 'ต้องเก็บ DNS ที่ DHCP เคยแจก');
    });

    it('removeAll รันสคริปต์คืนค่าก่อน แล้วค่อยลบสคริปต์ทิ้ง', async () => {
        const calls = [];
        const c = {
            async exec(cmd, args = {}) {
                calls.push({ cmd, args });
                if (cmd === '/system/script/print') {
                    return [{ '.id': '*S9', comment: mwPlan.TAG + ' dns restore' },
                            { '.id': '*S8', comment: 'สคริปต์ของลูกค้า ห้ามแตะ' }];
                }
                if (cmd === '/ip/route/print') return [];
                if (cmd === '/ip/firewall/nat/print') return [];
                if (cmd === '/ip/firewall/filter/print') return [];
                if (cmd === '/tool/netwatch/print') return [];
                if (cmd === '/system/scheduler/print') return [];
                return [];
            }
        };
        const r = await apply.removeAll(c, []);

        assert.strictEqual(r.dnsRestored, true);
        const iRun = calls.findIndex((x) => x.cmd === '/system/script/run');
        const iDel = calls.findIndex((x) => x.cmd === '/system/script/remove');
        assert.ok(iRun >= 0, 'ต้องรันสคริปต์คืนค่า');
        assert.ok(iRun < iDel, 'ต้องคืนค่าก่อนลบ ไม่งั้นค่าเดิมหายไปพร้อมตัวที่จะเอามาคืน');

        const deleted = calls.filter((x) => x.cmd === '/system/script/remove')
            .map((x) => x.args['.id']);
        assert.ok(!deleted.includes('*S8'), 'ห้ามลบสคริปต์ของลูกค้า');
    });

    it('คืนค่า DNS ไม่สำเร็จ ต้องไม่ทำให้การถอนที่เหลือหยุดกลางคัน', async () => {
        const c = {
            async exec(cmd) {
                if (cmd === '/system/script/print') {
                    return [{ '.id': '*S9', comment: mwPlan.TAG + ' dns restore' }];
                }
                if (cmd === '/system/script/run') throw new Error('script failed');
                if (cmd === '/ip/route/print') return [];
                if (cmd === '/ip/firewall/nat/print') return [];
                if (cmd === '/ip/firewall/filter/print') return [];
                if (cmd === '/tool/netwatch/print') return [];
                if (cmd === '/system/scheduler/print') return [];
                return [];
            }
        };
        const r = await apply.removeAll(c, []);
        assert.strictEqual(r.dnsRestored, false);
        assert.ok(r.dnsRestoreError, 'ต้องรายงานว่าคืนค่าไม่สำเร็จ ไม่ใช่เงียบ');
    });

    it('rollback script บนเราท์เตอร์ก็คืนค่า DNS ด้วย', () => {
        const sc = mwPlan.buildRollbackScript(withDns());
        const iRun = sc.indexOf('/system script run');
        const iDel = sc.indexOf('/system script remove');
        assert.ok(iRun >= 0 && iDel > iRun, 'ต้องรันคืนค่าก่อนลบสคริปต์');
    });
});
