/**
 * เทสต์ตัววิเคราะห์และตัวสร้างแผน Multi-WAN
 *
 * สภาพที่ใช้เทสต์ยึดตามที่ผู้ดูแลระบุสำหรับ A4-Residence:
 * ether1 ต่อ PPPoE เป็นสายหลัก, ether2 รับ DHCP เป็นสายสำรอง
 *
 * สิ่งที่ต้องมั่นใจที่สุดคือ "ทุกขั้นต้องย้อนกลับได้" เพราะเราแก้เส้นทางผ่านสาย
 * เดียวกับที่ใช้คุยกับเราท์เตอร์ ถ้าย้อนไม่ได้คือสาขาหลุดถาวรจนกว่าจะมีคนไปถึงที่
 */

const assert = require('assert');
const an = require('../lib/multiwan-analyze');
const plan = require('../lib/multiwan-plan');

/** สภาพเราท์เตอร์แบบ A4: PPPoE บน ether1 + DHCP บน ether2 */
function a4State(over = {}) {
    return Object.assign({
        interfaces: [
            { name: 'ether1' }, { name: 'ether2' }, { name: 'ether3' },
            { name: 'bridge-lan' }, { name: 'pppoe-out1' }
        ],
        pppoeClients: [
            { '.id': '*1', name: 'pppoe-out1', interface: 'ether1',
              running: 'true', disabled: 'false', 'add-default-route': 'yes',
              'default-route-distance': '1' }
        ],
        dhcpClients: [
            { '.id': '*2', interface: 'ether2', status: 'bound',
              gateway: '192.168.1.1', disabled: 'false',
              'add-default-route': 'yes', 'default-route-distance': '1' }
        ],
        routes: [
            { '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: 'pppoe-out1', distance: '1', dynamic: 'true' },
            { '.id': '*B', 'dst-address': '0.0.0.0/0', gateway: '192.168.1.1', distance: '1', dynamic: 'true' }
        ],
        mangle: [],
        nat: [{ '.id': '*N', chain: 'srcnat', action: 'masquerade', 'out-interface': 'pppoe-out1' }],
        routingTables: []
    }, over);
}

describe('multiwan-analyze — อ่านสภาพจริงของ A4', () => {
    it('เจอสองสายจาก PPPoE client และ DHCP client โดยไม่ต้องให้คนกรอก', () => {
        const r = an.analyzeState(a4State());
        assert.strictEqual(r.wans.length, 2);
        assert.strictEqual(r.wans[0].kind, 'pppoe');
        assert.strictEqual(r.wans[0].interface, 'pppoe-out1');
        assert.strictEqual(r.wans[1].kind, 'dhcp');
        assert.strictEqual(r.wans[1].interface, 'ether2');
    });

    it('PPPoE ต้องชี้ gateway ด้วยชื่อ interface ไม่ใช่ IP', () => {
        // ปลายทาง PPPoE เปลี่ยน IP ทุกครั้งที่ต่อใหม่ ถ้าจำ IP ไว้จะพังเงียบ ๆ
        const w = an.analyzeState(a4State()).wans[0];
        assert.strictEqual(w.gatewayIsInterface, true);
        assert.strictEqual(w.gateway, 'pppoe-out1');
    });

    it('DHCP ต้องอ่าน gateway ที่ได้มาจริง', () => {
        const w = an.analyzeState(a4State()).wans[1];
        assert.strictEqual(w.gateway, '192.168.1.1');
        assert.strictEqual(w.gatewayIsInterface, false);
    });

    it('ทำสำรองได้เมื่อมีสองสายพร้อม', () => {
        const r = an.analyzeState(a4State());
        assert.strictEqual(r.canFailover, true);
        assert.strictEqual(r.blockers.length, 0);
    });

    it('เตือนว่า ether2 ยังไม่มี NAT — สลับไปแล้วลูกข่ายจะออกเน็ตไม่ได้', () => {
        const r = an.analyzeState(a4State());
        assert.ok(r.warnings.some((w) => w.code === 'no-nat' && w.message.includes('ether2')));
    });

    it('มีสายเดียว = ทำไม่ได้ และบอกเหตุผล', () => {
        const r = an.analyzeState(a4State({ dhcpClients: [] }));
        assert.strictEqual(r.canFailover, false);
        assert.strictEqual(r.blockers[0].code, 'need-two-wans');
    });

    it('สายที่ปิดอยู่ไม่นับว่าใช้ได้', () => {
        const s = a4State();
        s.dhcpClients[0].disabled = 'true';
        assert.strictEqual(an.analyzeState(s).canFailover, false);
    });

    it('DHCP ที่ยังไม่ bound ถือว่ายังไม่ขึ้น แต่ไม่ห้ามทำ', () => {
        const s = a4State();
        s.dhcpClients[0].status = 'searching...';
        const r = an.analyzeState(s);
        assert.strictEqual(r.up.length, 1);
        assert.strictEqual(r.canFailover, true);
        assert.ok(r.warnings.some((w) => w.code === 'wan-down'));
    });
});

describe('multiwan-analyze — เลือกวิธีให้เอง', () => {
    it('ไม่รู้ความเร็ว = เลือกสำรอง ไม่เดา PCC', () => {
        const r = an.analyzeState(a4State());
        assert.strictEqual(r.recommendation.mode, an.MODE.FAILOVER);
        assert.ok(r.recommendation.rejected.because.some((b) => b.includes('ยังไม่รู้ bandwidth')));
    });

    it('สายสำรองช้ากว่ามาก = ปฏิเสธ PCC พร้อมเหตุผลเป็นตัวเลข', () => {
        // เคสที่คาดว่าเป็นของจริง: PPPoE 500M + สายสำรองราคาถูก 50M
        const r = an.analyzeState(a4State(), { speeds: { 'pppoe-out1': 500, ether2: 50 } });
        assert.strictEqual(r.recommendation.mode, an.MODE.FAILOVER);
        const why = r.recommendation.rejected.because.join(' ');
        assert.ok(why.includes('10.0 เท่า'), 'ต้องบอกตัวเลขที่คำนวณได้จริง');
    });

    it('ความเร็วใกล้กันและทุกสายขึ้น = PCC คุ้ม', () => {
        const r = an.analyzeState(a4State(), { speeds: { 'pppoe-out1': 500, ether2: 300 } });
        assert.strictEqual(r.recommendation.mode, an.MODE.PCC);
    });

    it('มี mangle เดิมอยู่ = ไม่แนะนำ PCC เพราะต้องเขียนทับ', () => {
        const s = a4State({
            mangle: [{ '.id': '*M', action: 'mark-routing', 'new-routing-mark': 'to_WAN1', chain: 'prerouting' }]
        });
        const r = an.analyzeState(s, { speeds: { 'pppoe-out1': 500, ether2: 300 } });
        assert.strictEqual(r.recommendation.mode, an.MODE.FAILOVER);
        assert.ok(r.recommendation.rejected.because.some((b) => b.includes('mangle')));
    });

    it('เส้นแบ่งอยู่ที่ 4 เท่าพอดี', () => {
        const at = an.analyzeState(a4State(), { speeds: { 'pppoe-out1': 400, ether2: 100 } });
        assert.strictEqual(at.recommendation.mode, an.MODE.PCC, '4 เท่าพอดียังทำได้');
        const over = an.analyzeState(a4State(), { speeds: { 'pppoe-out1': 401, ether2: 100 } });
        assert.strictEqual(over.recommendation.mode, an.MODE.FAILOVER, 'เกิน 4 เท่าไม่ทำ');
    });
});

describe('multiwan-plan — แผนต้องย้อนกลับได้ทุกขั้น', () => {
    it('ทุกขั้นมีวิธีย้อนกลับ', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        assert.ok(p.steps.length > 0);
        p.steps.forEach((s) => {
            assert.ok(s.undo, `ขั้น "${s.title}" ไม่มีวิธีย้อนกลับ`);
        });
    });

    it('ไม่มีขั้นไหนลบของเดิม — ของเดิมถูกดันลำดับ ไม่ใช่ถูกลบ', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const removesExisting = p.steps.filter((s) =>
            s.apply.cmd.includes('/remove') && !s.apply.args.comment
        );
        assert.strictEqual(removesExisting.length, 0);
        const bumps = p.steps.filter((s) => s.id.startsWith('distance-'));
        assert.strictEqual(bumps.length, 2, 'ต้องดัน distance ของทั้งสองสาย');
        assert.strictEqual(bumps[0].apply.args['default-route-distance'], '10');
    });

    it('ย้อนกลับของขั้นดัน distance คืนค่าเดิมจริง', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const bump = p.steps.find((s) => s.id === 'distance-pppoe-out1');
        assert.strictEqual(bump.undo.args['default-route-distance'], '1');
        assert.strictEqual(bump.undo.args['.id'], '*1');
    });

    it('แต่ละสายตรวจด้วยปลายทางคนละตัว', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const hosts = Object.values(p.checkHosts);
        assert.strictEqual(new Set(hosts).size, hosts.length, 'ปลายทางตรวจต้องไม่ซ้ำกัน');
    });

    it('เส้นทางตรวจของ PPPoE ชี้ที่ interface ส่วนของ DHCP ชี้ที่ IP', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        assert.strictEqual(p.steps.find((s) => s.id === 'check-pppoe-out1').apply.args.gateway, 'pppoe-out1');
        assert.strictEqual(p.steps.find((s) => s.id === 'check-ether2').apply.args.gateway, '192.168.1.1');
    });

    it('สายหลักได้ลำดับ 1 สายสำรองได้ลำดับ 2 และตรวจสายด้วย ping ทั้งคู่', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const d1 = p.steps.find((s) => s.id === 'default-pppoe-out1').apply.args;
        const d2 = p.steps.find((s) => s.id === 'default-ether2').apply.args;
        assert.strictEqual(d1.distance, '1');
        assert.strictEqual(d2.distance, '2');
        assert.strictEqual(d1['check-gateway'], 'ping');
        assert.strictEqual(d2['check-gateway'], 'ping');
    });

    it('ของเดิมถูกดันไปไกลกว่าของใหม่ เพื่อเป็นตาข่ายรับ', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const newMax = Math.max(...p.steps.filter((s) => s.id.startsWith('default-'))
            .map((s) => Number(s.apply.args.distance)));
        const oldMin = Math.min(...p.steps.filter((s) => s.id.startsWith('distance-'))
            .map((s) => Number(s.apply.args['default-route-distance'])));
        assert.ok(oldMin > newMax, 'ของเดิมต้องอยู่ลำดับหลังของใหม่เสมอ');
    });

    it('เติม NAT เฉพาะสายที่ยังไม่มี', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const nats = p.steps.filter((s) => s.id.startsWith('nat-'));
        assert.strictEqual(nats.length, 1);
        assert.strictEqual(nats[0].apply.args['out-interface'], 'ether2');
    });

    it('เลือกลำดับสายเองได้ — สลับให้ ether2 เป็นสายหลัก', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()), { order: ['ether2', 'pppoe-out1'] });
        assert.strictEqual(p.steps.find((s) => s.id === 'default-ether2').apply.args.distance, '1');
        assert.strictEqual(p.steps.find((s) => s.id === 'default-pppoe-out1').apply.args.distance, '2');
    });

    it('ทำไม่ได้ก็ต้องไม่ยอมสร้างแผน', () => {
        const bad = an.analyzeState(a4State({ dhcpClients: [] }));
        assert.throws(() => plan.buildFailoverPlan(bad), /ยังทำ failover ไม่ได้/);
    });

    it('ของที่เพิ่มทุกชิ้นติดคอมเมนต์กำกับ เพื่อให้ถอนออกได้ครบ', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        p.steps.filter((s) => s.apply.cmd.includes('/add')).forEach((s) => {
            assert.ok(String(s.apply.args.comment || '').includes(plan.TAG),
                `${s.id} ไม่มีคอมเมนต์กำกับ จะถอนอัตโนมัติไม่ได้`);
        });
    });
});

describe('multiwan-plan — ตัวถอนอัตโนมัติบนเราท์เตอร์', () => {
    it('สคริปต์ถอนครอบคลุมทั้ง route, NAT และคืนค่า distance', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const s = plan.buildRollbackScript(p);
        assert.ok(s.includes('/ip route remove'));
        assert.ok(s.includes('/ip firewall nat remove'));
        assert.ok(s.includes('default-route-distance=1'), 'ต้องคืนค่า distance เดิม');
        assert.ok(s.includes('/interface pppoe-client'));
        assert.ok(s.includes('/ip dhcp-client'));
    });

    it('สคริปต์ถอนลบตัวเองเป็นคำสั่งสุดท้าย ไม่งั้นจะถอนซ้ำทุกรอบ', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const lines = plan.buildRollbackScript(p).trim().split('\n');
        assert.ok(lines[lines.length - 1].includes('/system scheduler remove'));
    });

    it('ตัวถอนถูกฝากไว้บนเราท์เตอร์พร้อมเวลานับถอยหลัง', () => {
        const p = plan.buildFailoverPlan(an.analyzeState(a4State()));
        const arm = plan.buildArmCommand(p, 180);
        assert.strictEqual(arm.cmd, '/system/scheduler/add');
        assert.strictEqual(arm.args.interval, '180s');
        assert.ok(arm.args['on-event'].includes('/ip route remove'));
    });
});
