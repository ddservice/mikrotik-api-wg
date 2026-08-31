/**
 * เทสต์ Multi-WAN กรณี 3 lines ขึ้นไป และของที่เพิ่มเข้ามารอบนี้
 *
 * สามอย่างที่ต้องมั่นใจ:
 *  1. เลือกรูปแบบให้เองได้ถูกเมื่อมีมากกว่า 2 lines (ไม่ใช่แค่รองรับได้)
 *  2. รู้ว่าตอนนี้ traffic วิ่งบน line ไหน — ไม่งั้นสาขาจะวิ่งบน backup เงียบ ๆ เป็นสัปดาห์
 *  3. อ่าน WAN IP ได้ครบ เพราะเป็นสิ่งแรกที่ต้องใช้เวลาโทรแจ้ง ISP
 */

const assert = require('assert');
const an = require('../lib/multiwan-analyze');
const mwPlan = require('../lib/multiwan-plan');

/** ขึ้นบรรทัดใหม่ — เขียนแบบนี้เพื่อเลี่ยงปัญหา escape ตอนแก้ไฟล์ด้วยสคริปต์ */
const NEWLINE = String.fromCharCode(10);

/** สาขาที่มี 3 WAN: PPPoE + DHCP อีกสองเส้น */
function state3(over = {}) {
    return Object.assign({
        interfaces: [{ name: 'ether1' }, { name: 'ether2' }, { name: 'ether3' },
                     { name: 'bridge-lan' }, { name: 'pppoe-out1' }],
        pppoeClients: [{ '.id': '*A', name: 'pppoe-out1', interface: 'ether1',
                         running: 'true', 'default-route-distance': '1',
                         'local-address': '101.51.20.33' }],
        dhcpClients: [
            { '.id': '*B', interface: 'ether2', status: 'bound', gateway: '192.168.1.1',
              address: '192.168.1.50/24', 'default-route-distance': '1' },
            { '.id': '*C', interface: 'ether3', status: 'bound', gateway: '192.168.8.1',
              address: '192.168.8.100/24', 'default-route-distance': '1' }
        ],
        routes: [], mangle: [], nat: [], addresses: []
    }, over);
}

describe('multiwan 3 lines — ตรวจพบและอ่าน IP', () => {
    it('เจอครบทั้ง 3 lines', () => {
        const r = an.analyzeState(state3());
        assert.strictEqual(r.usable.length, 3);
        assert.strictEqual(r.canFailover, true);
    });

    it('อ่าน WAN IP ได้ทุก line — PPPoE จาก local-address, DHCP จาก address', () => {
        const r = an.analyzeState(state3());
        const byName = {};
        r.wans.forEach((w) => { byName[w.interface] = w; });
        assert.strictEqual(byName['pppoe-out1'].address, '101.51.20.33');
        assert.strictEqual(byName.ether2.address, '192.168.1.50', 'ต้องตัด /24 ออก');
        assert.strictEqual(byName.ether3.address, '192.168.8.100');
    });

    it('ถ้า client ไม่ได้บอก IP มา ให้ไปหาจาก /ip/address', () => {
        const s = state3();
        delete s.dhcpClients[0].address;
        s.addresses = [{ address: '10.20.30.40/24', interface: 'ether2' }];
        const r = an.analyzeState(s);
        assert.strictEqual(r.wans.find((w) => w.interface === 'ether2').address, '10.20.30.40');
    });
});

describe('multiwan 3 lines — เลือกรูปแบบให้เอง', () => {
    it('สองเส้นเร็วใกล้กัน + หนึ่งเส้นช้ามาก = PCC เฉพาะสองเส้นแรก ที่เหลือเป็น backup', () => {
        // เคสที่พบบ่อยจริง: ไฟเบอร์สองเส้น + 5G สำรอง
        const r = an.analyzeState(state3(), {
            speeds: { 'pppoe-out1': 500, ether2: 500, ether3: 50 }
        });
        assert.strictEqual(r.recommendation.mode, an.MODE.PCC);
        assert.deepStrictEqual(r.recommendation.pccGroup.sort(), ['ether2', 'pppoe-out1']);
        assert.deepStrictEqual(r.recommendation.backupOnly, ['ether3'],
            'เส้นที่ช้ากว่าเกิน 4 เท่าต้องไม่ถูกดึงเข้ากลุ่มแบ่งโหลด');
    });

    it('ความเร็วต่างกันหมด = failover ล้วน เรียงจากเร็วไปช้า', () => {
        const r = an.analyzeState(state3(), {
            speeds: { 'pppoe-out1': 500, ether2: 100, ether3: 50 }
        });
        assert.strictEqual(r.recommendation.mode, an.MODE.FAILOVER);
        assert.deepStrictEqual(r.recommendation.order, ['pppoe-out1', 'ether2', 'ether3']);
    });

    it('ไม่รู้ bandwidth = failover และไม่เดา PCC', () => {
        const r = an.analyzeState(state3());
        assert.strictEqual(r.recommendation.mode, an.MODE.FAILOVER);
        assert.ok(r.recommendation.rejected.because.some((b) => b.includes('bandwidth')));
    });

    it('เหตุผลต้องพูดถึง FastTrack เพราะเป็นข้อแลกเปลี่ยนหลักของ PCC', () => {
        const fo = an.analyzeState(state3());
        assert.ok(fo.recommendation.why.some((w) => w.includes('FastTrack')));
        const pcc = an.analyzeState(state3(), {
            speeds: { 'pppoe-out1': 500, ether2: 500, ether3: 500 }
        });
        assert.ok(pcc.recommendation.why.some((w) => w.includes('FastTrack')));
    });

    it('line ที่เร็วที่สุดได้เป็น primary แม้จะไม่ใช่ตัวแรกที่เจอ', () => {
        const r = an.analyzeState(state3(), {
            speeds: { 'pppoe-out1': 50, ether2: 100, ether3: 900 }
        });
        assert.strictEqual(r.recommendation.order[0], 'ether3');
    });
});

describe('multiwan 3 lines — แผนต้องได้ distance 1/2/3', () => {
    it('ทั้ง 3 lines ได้ distance ไล่ลำดับ และ check host ไม่ซ้ำกัน', () => {
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state3()));
        ['pppoe-out1', 'ether2', 'ether3'].forEach((n, i) => {
            assert.strictEqual(
                p.steps.find((s) => s.id === 'default-' + n).apply.args.distance,
                String(i + 1));
        });
        const hosts = Object.values(p.checkHosts);
        assert.strictEqual(new Set(hosts).size, 3, 'check host ต้องคนละตัวทุก line');
    });

    it('default route เดิมของทั้ง 3 ถูกดันไป 10/11/12 ซึ่งไกลกว่าของใหม่ทั้งหมด', () => {
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state3()));
        const bumped = p.steps.filter((s) => s.id.startsWith('distance-'))
            .map((s) => Number(s.apply.args['default-route-distance']));
        assert.deepStrictEqual(bumped, [10, 11, 12]);
        assert.ok(Math.min(...bumped) > 3);
    });
});

describe('multiwan — ขั้นกัน DHCP gateway เปลี่ยน', () => {
    it('มี scheduler sync ให้ทุก line ที่เป็น DHCP และไม่มีให้ PPPoE', () => {
        // PPPoE ชี้ gateway ด้วยชื่อ interface อยู่แล้ว จึงไม่มีปัญหานี้
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state3()));
        const sync = p.steps.filter((s) => s.id.startsWith('dhcp-sync-'));
        assert.strictEqual(sync.length, 2);
        assert.ok(!p.steps.some((s) => s.id === 'dhcp-sync-pppoe-out1'));
    });

    it('สคริปต์ sync อ่าน gateway ปัจจุบันแล้วแก้ host-check route ให้ตรง', () => {
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state3()));
        const sc = p.steps.find((s) => s.id === 'dhcp-sync-ether2').apply.args['on-event'];
        assert.ok(sc.includes('/ip dhcp-client get'), 'ต้องอ่าน gateway จาก dhcp-client');
        assert.ok(sc.includes(mwPlan.TAG + ' check ether2'), 'ต้องแก้ route ของ line ตัวเอง');
        assert.ok(sc.includes('/ip route set'), 'ต้อง set ไม่ใช่ add ซ้ำ');
    });
});

describe('multiwan — netwatch ล้าง connection tracking ตอนสลับ', () => {
    it('เฝ้า check host ของ primary และล้าง conntrack เมื่อ down', () => {
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state3()));
        const nw = p.steps.find((s) => s.id === 'netwatch-flush');
        assert.ok(nw, 'ต้องมีขั้น netwatch');
        assert.strictEqual(nw.apply.args.host, p.checkHosts['pppoe-out1']);
        assert.ok(nw.apply.args['down-script'].includes('/ip firewall connection remove'));
    });

    it('rollback script ถอน netwatch ออกด้วย ไม่ทิ้งค้างไว้', () => {
        const p = mwPlan.buildFailoverPlan(an.analyzeState(state3()));
        assert.ok(mwPlan.buildRollbackScript(p).includes('/tool netwatch remove'));
    });
});

describe('multiwan — รู้ว่าตอนนี้วิ่งบน line ไหน', () => {
    it('ยังไม่ได้ติดตั้ง = null', () => {
        assert.strictEqual(an.activeFailoverWan([{ comment: 'route ของลูกค้า' }]), null);
    });

    it('ปกติ = ใช้ primary (distance 1)', () => {
        const r = an.activeFailoverWan([
            { comment: an.TAG + ' default pppoe-out1 d=1 orig=1', distance: '1', active: 'true' },
            { comment: an.TAG + ' default ether2 d=2 orig=1', distance: '2', active: 'true' }
        ]);
        assert.strictEqual(r.interface, 'pppoe-out1');
        assert.strictEqual(r.isPrimary, true);
    });

    it('primary ถูก check-gateway ตัดออก = รายงานว่าใช้ backup อยู่', () => {
        // นี่คือกรณีที่ต้องแจ้งเตือน — failover ทำงานแล้วแต่ไม่มีใครรู้
        const r = an.activeFailoverWan([
            { comment: an.TAG + ' default pppoe-out1 d=1 orig=1', distance: '1', active: 'false' },
            { comment: an.TAG + ' default ether2 d=2 orig=1', distance: '2', active: 'true' }
        ]);
        assert.strictEqual(r.interface, 'ether2');
        assert.strictEqual(r.isPrimary, false);
        assert.strictEqual(r.distance, 2);
    });

    it('เลือก distance ต่ำสุดที่ยัง active — ตรงกับที่ RouterOS ใช้จริง', () => {
        const r = an.activeFailoverWan([
            { comment: an.TAG + ' default a d=1 orig=1', distance: '1', active: 'false' },
            { comment: an.TAG + ' default c d=3 orig=1', distance: '3', active: 'true' },
            { comment: an.TAG + ' default b d=2 orig=1', distance: '2', active: 'true' }
        ]);
        assert.strictEqual(r.interface, 'b');
    });

    it('ไม่นับ route ที่ถูก disable ไว้', () => {
        const r = an.activeFailoverWan([
            { comment: an.TAG + ' default a d=1 orig=1', distance: '1', active: 'true', disabled: 'true' },
            { comment: an.TAG + ' default b d=2 orig=1', distance: '2', active: 'true' }
        ]);
        assert.strictEqual(r.interface, 'b');
    });
});

describe('multiwan — ข้อความแจ้งเตือนหลังติดตั้งสำเร็จ', () => {
    function alert3() {
        const a = an.analyzeState(state3());
        const p = mwPlan.buildFailoverPlan(a);
        return mwPlan.buildSuccessAlert({
            siteName: 'A4-Residence', plan: p, mode: a.recommendation.title,
            checks: [{ interface: 'pppoe-out1', replies: 4, sent: 4 }]
        });
    }

    it('บอกชื่อสาขาและรูปแบบที่ติดตั้ง', () => {
        const t = alert3();
        assert.ok(t.includes('A4-Residence'));
        assert.ok(t.includes('Failover'));
    });

    it('มี WAN IP ของทุก line — เป็นสิ่งแรกที่ต้องใช้เวลาโทรแจ้ง ISP', () => {
        const t = alert3();
        assert.ok(t.includes('101.51.20.33'), 'IP ของ PPPoE');
        assert.ok(t.includes('192.168.1.50'), 'IP ของ ether2');
        assert.ok(t.includes('192.168.8.100'), 'IP ของ ether3');
    });

    it('บอก role ของแต่ละ line และ check host', () => {
        const t = alert3();
        assert.ok(t.includes('PRIMARY'));
        assert.ok(t.includes('BACKUP 1'));
        assert.ok(t.includes('BACKUP 2'));
        assert.ok(t.includes('8.8.8.8'));
    });

    it('อ่าน IP ไม่ได้ก็ต้องบอกตรง ๆ ไม่ใช่ปล่อยว่าง', () => {
        const s = state3();
        delete s.pppoeClients[0]['local-address'];
        const a = an.analyzeState(s);
        const t = mwPlan.buildSuccessAlert({ siteName: 'x', plan: mwPlan.buildFailoverPlan(a), mode: 'Failover' });
        assert.ok(t.includes('ยังอ่านไม่ได้'));
    });
});

describe('multiwan — commit ต้องไม่ลบของที่ต้องอยู่ถาวร', () => {
    const apply = require('../lib/multiwan-apply');

    /** เราท์เตอร์จำลองที่มี scheduler ทั้งตัว rollback และตัว sync */
    function client() {
        const scheduler = [
            { '.id': '*S1', name: mwPlan.ROLLBACK_NAME, comment: mwPlan.TAG + ' rollback' },
            { '.id': '*S2', name: mwPlan.TAG + '-dhcpsync-ether2', comment: mwPlan.TAG + ' sync ether2' },
            { '.id': '*S3', name: mwPlan.TAG + '-dhcpsync-ether3', comment: mwPlan.TAG + ' sync ether3' },
            { '.id': '*S4', name: 'scheduler-ของ-ลูกค้า', comment: 'ห้ามแตะ' }
        ];
        return {
            scheduler, calls: [],
            async exec(cmd, args = {}) {
                this.calls.push({ cmd, args });
                if (cmd === '/system/scheduler/print') return scheduler.slice();
                if (cmd === '/system/scheduler/remove') {
                    const i = scheduler.findIndex((x) => x['.id'] === args['.id']);
                    if (i >= 0) scheduler.splice(i, 1);
                    return [];
                }
                if (cmd === '/ip/route/print') return [];
                if (cmd === '/ip/firewall/nat/print') return [];
                if (cmd === '/tool/netwatch/print') return [];
                return [];
            }
        };
    }

    it('commit ลบเฉพาะ scheduler ตัว rollback — ตัว sync DHCP ต้องอยู่ต่อ', async () => {
        // บั๊กจริงที่เจอตอนรันกับเราท์เตอร์จำลอง: disarm เหมาลบทุกตัวที่ติดแท็กเดียวกัน
        // การป้องกัน DHCP gateway เปลี่ยนจึงหายไปทันทีที่ติดตั้งเสร็จ
        const c = client();
        const n = await apply.disarm(c);
        assert.strictEqual(n, 1);
        const left = c.scheduler.map((x) => x['.id']).sort();
        assert.deepStrictEqual(left, ['*S2', '*S3', '*S4']);
    });

    it('ถอนออกทั้งหมด = ลบ scheduler ของระบบนี้ทุกตัว แต่ไม่แตะของลูกค้า', async () => {
        const c = client();
        const n = await apply.removeAllSchedulers(c);
        assert.strictEqual(n, 3);
        assert.deepStrictEqual(c.scheduler.map((x) => x['.id']), ['*S4']);
    });

    it('removeAll รายงานจำนวน netwatch ที่ถอนด้วย', async () => {
        const c = client();
        c.exec = async function (cmd, args = {}) {
            this.calls.push({ cmd, args });
            if (cmd === '/system/scheduler/print') return c.scheduler.slice();
            if (cmd === '/tool/netwatch/print') {
                return [{ '.id': '*N1', comment: mwPlan.TAG + ' netwatch pppoe-out1' },
                        { '.id': '*N2', comment: 'netwatch ของลูกค้า' }];
            }
            if (cmd === '/ip/route/print') return [];
            if (cmd === '/ip/firewall/nat/print') return [];
            return [];
        };
        const r = await apply.removeAll(c, []);
        assert.strictEqual(r.netwatch, 1, 'ต้องถอนเฉพาะของระบบนี้');
        const removed = c.calls.filter((x) => x.cmd === '/tool/netwatch/remove').map((x) => x.args['.id']);
        assert.deepStrictEqual(removed, ['*N1']);
    });
});

describe('multiwan — สคริปต์ที่ฝากไว้บนเราท์เตอร์ต้องเดินจนจบเสมอ', () => {
    function plan2() {
        return mwPlan.buildFailoverPlan(an.analyzeState(state3()));
    }

    it('ทุกคำสั่งใน rollback script ถูกห่อด้วย on-error', () => {
        // สคริปต์ RouterOS หยุดทันทีที่คำสั่งใดพัง ถ้าไม่ห่อ แล้วคำสั่งกลางทางพัง
        // สคริปต์จะไปไม่ถึงบรรทัดที่ลบ scheduler ตัวเอง ผลคือมันยิงซ้ำตลอดไป
        const lines = mwPlan.buildRollbackScript(plan2()).trim().split(NEWLINE);
        lines.forEach((l) => {
            assert.ok(l.startsWith(':do {') && l.includes('on-error={}'),
                'บรรทัดนี้ไม่ได้ห่อ on-error: ' + l);
        });
    });

    it('บรรทัดสุดท้ายยังเป็นการลบ scheduler ตัวเอง', () => {
        const lines = mwPlan.buildRollbackScript(plan2()).trim().split(NEWLINE);
        assert.ok(lines[lines.length - 1].includes('/system scheduler remove'));
    });

    it('rollback ยังคืนค่า distance เดิมครบทุก line', () => {
        const sc = mwPlan.buildRollbackScript(plan2());
        assert.strictEqual((sc.match(/default-route-distance=1/g) || []).length, 3);
    });
});

describe('multiwan — netwatch ต้องไม่ล้าง conntrack เพราะ ping ตกครั้งเดียว', () => {
    it('ตรวจ routing table ก่อน ไม่ล้างทันทีที่ probe ตก', () => {
        // netwatch มองว่า down ตั้งแต่ probe ตกครั้งเดียว ถ้าล้างตามนั้นทันที
        // แพ็กเก็ตหายครั้งเดียวจะทำให้ลูกค้าทั้งสาขาหลุดพร้อมกันโดยไม่มีอะไรเสียจริง
        const nw = mwPlan.buildFailoverPlan(an.analyzeState(state3()))
            .steps.find((s) => s.id === 'netwatch-flush');
        const sc = nw.apply.args['down-script'];
        assert.ok(sc.includes('/ip route find'), 'ต้องดู route ก่อน');
        assert.ok(sc.includes('active] = false'), 'ต้องล้างเฉพาะตอน route ถูก deactivate จริง');
        const flushAt = sc.indexOf('/ip firewall connection remove');
        const checkAt = sc.indexOf('active] = false');
        assert.ok(checkAt >= 0 && checkAt < flushAt, 'การตรวจต้องมาก่อนการล้าง');
    });

    it('probe ไม่ถี่เกินจนอ่อนไหวต่อแพ็กเก็ตหายชั่วคราว', () => {
        const nw = mwPlan.buildFailoverPlan(an.analyzeState(state3()))
            .steps.find((s) => s.id === 'netwatch-flush');
        assert.strictEqual(nw.apply.args.interval, '10s');
        assert.strictEqual(nw.apply.args.timeout, '3s');
    });
});
