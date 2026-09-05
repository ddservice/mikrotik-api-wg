/**
 * เทสต์: เราท์เตอร์ที่มีคนตั้ง PCC / mark-routing ไว้ด้วยมืออยู่แล้ว
 *
 * ที่มา: 2026-09-05 หน้า Multi-WAN รายงานกับสาขาหนึ่งว่า
 *   "มี mangle rule ที่ทำ mark-routing / PCC อยู่แล้ว 6 rules — ต้องตรวจก่อนว่าจะ conflict หรือไม่"
 *   "มี active default route อยู่ 6 routes — ต้องตั้ง distance ให้ชัด"
 * ทั้งสองเป็นแค่ warning ปุ่มติดตั้งจึงยังกดได้
 *
 * ทำไมต้องเป็น blocker ไม่ใช่ warning: traffic ที่ถูกติด routing-mark จะไปใช้ routing table
 * ของ mark นั้น ไม่ใช่ตาราง main ที่ failover เขียน default route ลงไป ติดตั้งทับจึง
 * "สำเร็จทุกขั้น" แต่ traffic ของลูกค้าไม่ได้เดินตามนั้นเลย และตอนสายหลักตาย traffic
 * ที่ถูก mark ก็ยังวิ่งไปสายที่ตายแล้ว
 *
 * ที่แย่ที่สุดคือขั้นตรวจสอบหลังติดตั้งจะผ่านด้วย เพราะ ping ยืนยันออกจากตัวเราท์เตอร์เอง
 * ซึ่งไม่โดนกฎ mangle ชุดนี้ — เข้าข่าย "รายงานว่าสำเร็จทั้งที่ไม่ได้ทำอะไร"
 * ซึ่ง repo นี้เจอมาหลายรอบแล้วและแย่กว่าติดตั้งไม่สำเร็จไปตรง ๆ
 */

const assert = require('assert');
const an = require('../lib/multiwan-analyze');

function state(over) {
    return Object.assign({
        interfaces: [{ name: 'ether1' }, { name: 'ether2' }, { name: 'bridge-lan' }, { name: 'pppoe-out1' }],
        pppoeClients: [
            { '.id': '*1', name: 'pppoe-out1', interface: 'ether1', running: 'true',
              disabled: 'false', 'add-default-route': 'yes', 'default-route-distance': '1' }
        ],
        dhcpClients: [
            { '.id': '*2', interface: 'ether2', status: 'bound', gateway: '192.168.1.1',
              disabled: 'false', 'add-default-route': 'yes', 'default-route-distance': '1' }
        ],
        routes: [
            { '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: 'pppoe-out1', distance: '1', dynamic: 'true', active: 'true' },
            { '.id': '*B', 'dst-address': '0.0.0.0/0', gateway: '192.168.1.1', distance: '1', dynamic: 'true', active: 'true' }
        ],
        mangle: [],
        nat: [{ '.id': '*N', chain: 'srcnat', action: 'masquerade', 'out-interface': 'pppoe-out1' }],
        addresses: []
    }, over);
}

// ชุด PCC แบบที่คนตั้งเองจริง ๆ: จับ connection ครึ่งหนึ่งลงแต่ละสาย แล้ว mark routing
const HAND_BUILT_PCC = [
    { '.id': '*M1', chain: 'prerouting', action: 'mark-connection', 'new-connection-mark': 'wan1_conn',
      'per-connection-classifier': 'both-addresses:2/0', 'in-interface': 'bridge-lan' },
    { '.id': '*M2', chain: 'prerouting', action: 'mark-connection', 'new-connection-mark': 'wan2_conn',
      'per-connection-classifier': 'both-addresses:2/1', 'in-interface': 'bridge-lan' },
    { '.id': '*M3', chain: 'prerouting', action: 'mark-routing', 'new-routing-mark': 'to_wan1',
      'connection-mark': 'wan1_conn', 'in-interface': 'bridge-lan' },
    { '.id': '*M4', chain: 'prerouting', action: 'mark-routing', 'new-routing-mark': 'to_wan2',
      'connection-mark': 'wan2_conn', 'in-interface': 'bridge-lan' },
    { '.id': '*M5', chain: 'prerouting', action: 'mark-routing', 'new-routing-mark': 'to_wan1',
      'src-address': '192.168.10.0/24', comment: 'VLAN10 ออกสายหลักเท่านั้น' },
    { '.id': '*M6', chain: 'prerouting', action: 'accept', 'connection-mark': 'wan1_conn' }
];

describe('multiwan — เจอ PCC เดิมต้องห้ามติดตั้ง ไม่ใช่แค่เตือน', () => {
    it('ไม่มี mangle = ติดตั้ง failover ได้', () => {
        const r = an.analyzeState(state());
        assert.strictEqual(r.canFailover, true);
    });

    it('มี mark-routing อยู่แล้ว = ห้ามติดตั้ง', () => {
        const r = an.analyzeState(state({ mangle: HAND_BUILT_PCC }));
        assert.strictEqual(r.canFailover, false, 'ถ้ายังกดติดตั้งได้ จะได้ระบบที่รายงานสำเร็จแต่ไม่มีผลจริง');
        assert.ok(r.blockers.some((b) => b.code === 'existing-mark-routing'));
    });

    it('เหตุผลต้องบอกว่าทำไม ไม่ใช่แค่ว่าเจออะไร', () => {
        const r = an.analyzeState(state({ mangle: HAND_BUILT_PCC }));
        const b = r.blockers.find((x) => x.code === 'existing-mark-routing');
        assert.ok(/routing table/.test(b.message), 'ต้องอธิบายว่า traffic ไปใช้ตารางอื่น');
        assert.ok(/ไม่มีผลจริง|สำเร็จ/.test(b.message), 'ต้องบอกว่าติดตั้งทับแล้วจะดูเหมือนสำเร็จ');
        assert.ok(/ปิดหรือลบ/.test(b.message), 'ต้องบอกว่าต้องทำอะไรต่อ');
    });

    it('กฎที่ถูก disable ไว้ ไม่นับว่าขวาง', () => {
        const disabled = HAND_BUILT_PCC.map((m) => Object.assign({}, m, { disabled: 'true' }));
        const r = an.analyzeState(state({ mangle: disabled }));
        assert.strictEqual(r.canFailover, true, 'กฎที่ปิดอยู่ไม่มีผลกับ traffic จึงไม่ควรขวาง');
    });

    it('mangle ที่ไม่เกี่ยวกับการเลือกเส้นทาง (เช่น mark-packet) ไม่ขวาง', () => {
        const r = an.analyzeState(state({
            mangle: [{ '.id': '*Q', chain: 'forward', action: 'mark-packet', 'new-packet-mark': 'qos-voip' }]
        }));
        assert.strictEqual(r.canFailover, true, 'QoS ไม่ได้แย่งการตัดสินใจเส้นทาง');
    });
});

describe('multiwan — บอกให้ครบว่าเจอกฎอะไร ไม่ใช่แค่จำนวน', () => {
    it('รายงานทีละกฎ พร้อม chain / action / mark / ขอบเขต', () => {
        const r = an.analyzeState(state({ mangle: HAND_BUILT_PCC }));
        // 6 กฎในชุดนี้ แต่นับเฉพาะที่แย่งการเลือกเส้นทางจริง = 5
        // ตัว *M6 เป็น action=accept ซึ่งไม่ได้ mark routing จึงไม่ขวาง failover
        assert.strictEqual(r.mangleDetail.length, 5);
        assert.ok(!r.mangleDetail.some((m) => m.id === '*M6'), 'accept ไม่ควรถูกนับว่าขวาง');

        const pcc = r.mangleDetail.find((m) => m.id === '*M1');
        assert.strictEqual(pcc.chain, 'prerouting');
        assert.strictEqual(pcc.pcc, 'both-addresses:2/0');
        assert.strictEqual(pcc.mark, 'wan1_conn');
        assert.ok(pcc.scope.includes('bridge-lan'), 'ต้องบอกว่ากฎนี้จับ traffic ก้อนไหน');
        assert.strictEqual(pcc.stealsRouting, true);
    });

    it('กฎที่ผูกกับ subnet เฉพาะ ต้องบอก subnet นั้นออกมา', () => {
        const r = an.analyzeState(state({ mangle: HAND_BUILT_PCC }));
        const vlan = r.mangleDetail.find((m) => m.id === '*M5');
        assert.ok(vlan.scope.includes('192.168.10.0/24'));
        assert.strictEqual(vlan.comment, 'VLAN10 ออกสายหลักเท่านั้น',
            'คอมเมนต์ของคนตั้งคือเบาะแสเจตนา ต้องไม่ตัดทิ้ง');
    });

    it('กฎที่ไม่ระบุเงื่อนไข ต้องบอกว่าโดนทุก traffic ไม่ใช่ปล่อยว่าง', () => {
        const r = an.analyzeState(state({
            mangle: [{ '.id': '*X', chain: 'prerouting', action: 'mark-routing', 'new-routing-mark': 'to_wan1' }]
        }));
        assert.strictEqual(r.mangleDetail[0].scope, 'ทุก traffic ที่ผ่าน chain นี้');
    });
});

describe('multiwan — เสนอ distance ให้ ไม่ใช่บอกให้ไปตั้งเอง', () => {
    it('เรียงตามความเร็วที่กรอกไว้ สายเร็วสุดเป็น primary', () => {
        const r = an.analyzeState(state(), { speeds: { 'pppoe-out1': 500, ether2: 100 } });
        assert.strictEqual(r.distancePlan.length, 2);
        assert.strictEqual(r.distancePlan[0].interface, 'pppoe-out1');
        assert.strictEqual(r.distancePlan[0].proposedDistance, 1);
        assert.strictEqual(r.distancePlan[0].role, 'primary');
        assert.strictEqual(r.distancePlan[1].interface, 'ether2');
        assert.strictEqual(r.distancePlan[1].proposedDistance, 2);
        assert.ok(r.distancePlan[0].reason.includes('500'));
    });

    it('สายช้ากว่าอยู่หลัง แม้จะเจอก่อนบนเราท์เตอร์', () => {
        const r = an.analyzeState(state(), { speeds: { 'pppoe-out1': 50, ether2: 500 } });
        assert.strictEqual(r.distancePlan[0].interface, 'ether2');
    });

    it('ไม่กรอกความเร็ว = ยังเสนอได้ แต่บอกตรง ๆ ว่าเรียงตามลำดับที่เจอ', () => {
        const r = an.analyzeState(state());
        assert.strictEqual(r.distancePlan.length, 2);
        assert.ok(r.distancePlan[0].reason.includes('ยังไม่ได้กรอกความเร็ว'));
    });

    it('รายงาน default route เดิมพร้อม distance เรียงจากน้อยไปมาก', () => {
        const r = an.analyzeState(state({
            routes: [
                { '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: 'ether2', distance: '5', active: 'true' },
                { '.id': '*B', 'dst-address': '0.0.0.0/0', gateway: 'pppoe-out1', distance: '1', active: 'true' }
            ]
        }));
        assert.strictEqual(r.defaultRouteDetail.length, 2);
        assert.strictEqual(r.defaultRouteDetail[0].distance, 1, 'distance ต่ำสุดต้องมาก่อน');
        assert.strictEqual(r.defaultRouteDetail[0].gateway, 'pppoe-out1');
        assert.strictEqual(r.defaultRouteDetail[0].active, true);
    });

    it('route ที่อยู่ใน routing table อื่น ต้องบอกชื่อตารางออกมา', () => {
        const r = an.analyzeState(state({
            routes: [
                { '.id': '*A', 'dst-address': '0.0.0.0/0', gateway: 'pppoe-out1', distance: '1', active: 'true' },
                { '.id': '*C', 'dst-address': '0.0.0.0/0', gateway: 'ether2', distance: '1',
                  active: 'true', 'routing-table': 'to_wan2' }
            ]
        }));
        const marked = r.defaultRouteDetail.find((x) => x.id === '*C');
        assert.strictEqual(marked.routingTable, 'to_wan2',
            'ตารางอื่นคือที่ที่ traffic ซึ่งถูก mark จะไปใช้ — ต้องมองเห็น');
    });
});
