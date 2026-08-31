/**
 * เทสต์ตัวลงมือจริงของ Multi-WAN failover
 *
 * ใช้เราท์เตอร์จำลองที่จดทุกคำสั่งที่ได้รับ เพื่อพิสูจน์สิ่งที่พิสูจน์ด้วยตาไม่ได้:
 * ลำดับการทำงานถูกต้อง และเมื่อพังจริงมันถอนคืนครบ
 *
 * เรื่องที่ต้องมั่นใจที่สุดคือ "ฝากตัวถอนก่อนแตะของ" — ถ้าลำดับสลับ แล้วเราหลุด
 * ระหว่างแก้ สาขาจะเสียถาวรจนกว่าจะมีคนขับรถไปถึงที่
 */

const assert = require('assert');
const an = require('../lib/multiwan-analyze');
const mwPlan = require('../lib/multiwan-plan');
const apply = require('../lib/multiwan-apply');

function a4State() {
    return {
        interfaces: [{ name: 'ether1' }, { name: 'ether2' }, { name: 'pppoe-out1' }],
        pppoeClients: [{ '.id': '*1', name: 'pppoe-out1', interface: 'ether1',
                         running: 'true', 'default-route-distance': '1' }],
        dhcpClients: [{ '.id': '*2', interface: 'ether2', status: 'bound',
                        gateway: '192.168.1.1', 'default-route-distance': '1' }],
        routes: [], mangle: [],
        nat: [{ chain: 'srcnat', action: 'masquerade', 'out-interface': 'pppoe-out1' }]
    };
}

function makePlan(order) {
    return mwPlan.buildFailoverPlan(an.analyzeState(a4State()), order ? { order } : {});
}

/**
 * เราท์เตอร์จำลอง
 * @param {object} o {pingReplies, failAt, schedulers}
 */
function fakeClient(o = {}) {
    const calls = [];
    let seq = 0;
    const schedulers = [];
    return {
        calls,
        schedulers,
        async exec(cmd, args = {}) {
            calls.push({ cmd, args });
            if (o.failAt && calls.length === o.failAt) {
                throw new Error('เราท์เตอร์ปฏิเสธคำสั่ง (จำลอง)');
            }
            if (cmd === '/system/scheduler/add') {
                // ต้องเก็บ on-event ไว้ด้วย เพราะระบบอ่านกลับมาตรวจว่าสคริปต์ครบจริง
                schedulers.push({
                    '.id': '*S' + (schedulers.length + 1),
                    name: args.name, comment: args.comment,
                    'on-event': args['on-event']
                });
                return [{ '.id': '*S' + schedulers.length }];
            }
            if (cmd === '/system/scheduler/print') return schedulers.slice();
            if (cmd === '/system/scheduler/remove') {
                const i = schedulers.findIndex((s) => s['.id'] === args['.id']);
                if (i >= 0) schedulers.splice(i, 1);
                return [];
            }
            if (cmd === '/ping') {
                const n = o.pingReplies == null ? 4 : o.pingReplies;
                return Array.from({ length: 4 }, (_, i) => ({ received: i < n ? '1' : '0' }));
            }
            if (cmd.endsWith('/add')) return [{ '.id': `*X${++seq}` }];
            return [];
        }
    };
}

const only = (c, s) => c.calls.filter((x) => x.cmd.includes(s));
const idxOf = (c, s) => c.calls.findIndex((x) => x.cmd.includes(s));

describe('multiwan-apply — ลำดับความปลอดภัย', () => {
    it('สำรองค่าก่อน แล้วฝากตัวถอน แล้วค่อยแก้', async () => {
        const c = fakeClient();
        const r = await apply.applyFailover({ client: c, plan: makePlan() });
        assert.strictEqual(r.success, true);

        const iBackup = idxOf(c, '/system/backup/save');
        const iArm = idxOf(c, '/system/scheduler/add');
        const iFirstWrite = c.calls.findIndex((x) =>
            x.cmd.includes('/ip/route/add') || x.cmd.includes('client/set'));

        assert.ok(iBackup >= 0, 'ต้องสำรองค่า');
        assert.ok(iArm > iBackup, 'ฝากตัวถอนหลังสำรอง');
        assert.ok(iFirstWrite > iArm,
            'ต้องฝากตัวถอนก่อนแตะเส้นทาง ไม่งั้นหลุดกลางคันแล้วกู้ไม่ได้');
    });

    it('ตัวถอนที่ฝากไว้มีสคริปต์คืนค่าจริง ไม่ใช่ที่ว่างเปล่า', async () => {
        const c = fakeClient();
        await apply.applyFailover({ client: c, plan: makePlan() });
        const arm = only(c, '/system/scheduler/add')
            .find((x) => String(x.args.name || '').includes('rollback'));
        assert.ok(arm.args['on-event'].includes('/ip route remove'));
        assert.ok(arm.args['on-event'].includes('default-route-distance=1'));
        assert.strictEqual(arm.args.interval, '180s');
    });

    it('ผ่านแล้วต้องปลดตัวถอนออก แต่ scheduler ตัวอื่นต้องอยู่ต่อ', async () => {
        const c = fakeClient();
        const r = await apply.applyFailover({ client: c, plan: makePlan() });
        assert.strictEqual(r.success, true);
        assert.ok(!c.schedulers.some((s) => s.name === mwPlan.ROLLBACK_NAME),
            'ตัวถอนอัตโนมัติต้องถูกปลดหลัง commit');
        assert.ok(c.schedulers.some((s) => String(s.name).includes('dhcpsync')),
            'ตัว sync DHCP gateway ต้องอยู่ถาวร ไม่ใช่ถูกเหมาลบตอน commit');
    });

    it('ตรวจด้วย ping จากตัวเราท์เตอร์เอง ครบทุกสาย', async () => {
        const c = fakeClient();
        const r = await apply.applyFailover({ client: c, plan: makePlan() });
        // ping ไป 127.0.0.1 คือขั้นตรวจสิทธิ์ ไม่ใช่การตรวจสาย
        const probes = only(c, '/ping').filter((x) => x.args.address !== '127.0.0.1');
        assert.strictEqual(probes.length, 2);
        assert.strictEqual(r.checks.length, 2);
        assert.ok(r.checks.every((x) => x.ok));
    });

    it('ข้ามการสำรองได้เมื่อสั่ง แต่ยังต้องฝากตัวถอนอยู่ดี', async () => {
        const c = fakeClient();
        await apply.applyFailover({ client: c, plan: makePlan(), skipBackup: true });
        assert.strictEqual(only(c, '/system/backup/save').length, 0);
        // scheduler/add ถูกเรียกหลายครั้ง (ตัว rollback + ตัว sync gateway ของ DHCP)
        // ที่ต้องมีแน่ ๆ คือตัว rollback
        const arms = only(c, '/system/scheduler/add')
            .filter((x) => String(x.args.name || '').includes('rollback'));
        assert.strictEqual(arms.length, 1);
    });
});

describe('multiwan-apply — พังแล้วต้องถอนคืนได้', () => {
    it('สายหลักตรวจไม่ผ่าน = ถอนคืนทั้งหมด ไม่ปล่อยค้าง', async () => {
        // ping ตอบ 0 = ลงไปแล้วเน็ตใช้ไม่ได้ ซึ่งคือกรณีที่ต้องถอนที่สุด
        const c = fakeClient({ pingReplies: 0 });
        const r = await apply.applyFailover({ client: c, plan: makePlan() });

        assert.strictEqual(r.success, false);
        assert.strictEqual(r.rolledBack, true);
        assert.ok(r.error.includes('ตรวจไม่ผ่าน'));

        const added = only(c, '/ip/route/add').length;
        const removed = only(c, '/ip/route/remove').length;
        assert.strictEqual(removed, added, 'เพิ่มไปกี่เส้นต้องถอนคืนครบเท่านั้น');
    });

    it('ถอนคืนแล้วต้องคืนค่า distance เดิมด้วย ไม่ใช่แค่ลบเส้นทาง', async () => {
        const c = fakeClient({ pingReplies: 0 });
        await apply.applyFailover({ client: c, plan: makePlan() });
        const restore = c.calls.filter((x) =>
            x.cmd.includes('client/set') && x.args['default-route-distance'] === '1');
        assert.strictEqual(restore.length, 2, 'ต้องคืนค่าเดิมของทั้งสองสาย');
    });

    it('ถอนคืนตามลำดับย้อนกลับ — ของที่ลงทีหลังถูกถอนก่อน', async () => {
        const c = fakeClient({ pingReplies: 0 });
        await apply.applyFailover({ client: c, plan: makePlan() });
        const addIds = only(c, '/ip/route/add').map((_, i) => i);
        const removeOrder = only(c, '/ip/route/remove').map((x) => x.args['.id']);
        assert.ok(addIds.length > 1);
        // id ที่ถูกสร้างท้ายสุดต้องถูกลบเป็นตัวแรก
        const lastAdded = `*X${only(c, '/ip/route/add').length}`;
        assert.strictEqual(removeOrder[0], lastAdded);
    });

    it('คำสั่งกลางทางพัง = ถอนเฉพาะที่ลงไปแล้ว', async () => {
        // ให้พังที่คำสั่งที่ 5 ซึ่งอยู่ระหว่างการลงขั้นต่าง ๆ
        const c = fakeClient({ failAt: 5 });
        const r = await apply.applyFailover({ client: c, plan: makePlan() });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.rolledBack, true);
        assert.ok(r.applied < makePlan().steps.length, 'ต้องไม่นับขั้นที่ยังไม่ได้ลง');
    });

    it('สายสำรองตรวจไม่ผ่านแต่สายหลักผ่าน = ยังถือว่าสำเร็จ', async () => {
        // สายสำรองยังไม่พร้อมไม่ใช่เหตุให้ยกเลิก เพราะสายหลักยังทำงานปกติ
        const c = fakeClient();
        let n = 0;
        const orig = c.exec.bind(c);
        c.exec = async (cmd, args) => {
            if (cmd === '/ping') {
                c.calls.push({ cmd, args });
                // ping ตรวจสิทธิ์ต้องผ่านเสมอ ไม่นับเป็นการตรวจสาย
                if (args.address === '127.0.0.1') {
                    return [{ received: '1' }];
                }
                n++;
                const rep = n === 1 ? 4 : 0;   // สายหลักผ่าน สายสำรองไม่ผ่าน
                return Array.from({ length: 4 }, (_, i) => ({ received: i < rep ? '1' : '0' }));
            }
            return orig(cmd, args);
        };
        const r = await apply.applyFailover({ client: c, plan: makePlan() });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.checks[0].ok, true);
        assert.strictEqual(r.checks[1].ok, false);
    });
});

describe('multiwan-apply — ถอนด้วยมือทีหลัง', () => {
    it('คืนค่า distance เดิมจากที่ฝังไว้ ไม่ใช่ค่าที่ถูกดันไปแล้ว', async () => {
        // บั๊กจริงที่เจอตอนทดสอบกับเราท์เตอร์จำลอง: ตอนถอน ระบบอ่าน distance ปัจจุบัน
        // (ซึ่งคือ 10/11 ที่เราดันไปเอง) มาใช้เป็น "ค่าเดิม" แล้วเขียนทับด้วยตัวมันเอง
        // ผลคือถอนแล้วค่าไม่กลับ — ต้องอ่านจาก orig= ที่ฝังไว้ในคอมเมนต์แทน
        const c = {
            calls: [],
            async exec(cmd, args = {}) {
                this.calls.push({ cmd, args });
                if (cmd === '/ip/route/print') {
                    return [
                        { '.id': '*R1', comment: `${mwPlan.TAG} default pppoe-out1 d=1 orig=1` },
                        { '.id': '*R2', comment: `${mwPlan.TAG} default ether2 d=2 orig=3` }
                    ];
                }
                if (cmd === '/ip/firewall/nat/print') return [];
                if (cmd === '/system/scheduler/print') return [];
                return [];
            }
        };
        // จำลองสภาพ "หลังลงแล้ว" — distance ปัจจุบันถูกดันไปเป็น 10/11
        const wans = [
            { interface: 'pppoe-out1', kind: 'pppoe', id: '*1', defaultRouteDistance: 10 },
            { interface: 'ether2', kind: 'dhcp', id: '*2', defaultRouteDistance: 11 }
        ];
        await apply.removeAll(c, wans);

        const sets = c.calls.filter((x) => x.cmd.includes('client/set'));
        assert.strictEqual(sets.length, 2);
        assert.strictEqual(sets[0].args['default-route-distance'], '1',
            'ต้องคืนเป็น 1 ตามที่ฝังไว้ ไม่ใช่ 10 ที่เป็นค่าปัจจุบัน');
        assert.strictEqual(sets[1].args['default-route-distance'], '3',
            'ต้องคืนเป็น 3 ตามที่ฝังไว้ ไม่ใช่ 11');
    });

    it('ไม่มี orig= ฝังไว้ = กลับไปค่าตั้งต้นของ RouterOS', async () => {
        const c = {
            calls: [],
            async exec(cmd) {
                this.calls.push({ cmd });
                if (cmd === '/ip/route/print') return [{ '.id': '*R1', comment: `${mwPlan.TAG} default x d=1` }];
                if (cmd === '/ip/firewall/nat/print') return [];
                if (cmd === '/system/scheduler/print') return [];
                return [];
            }
        };
        c.exec = async function (cmd, args = {}) {
            this.calls.push({ cmd, args });
            if (cmd === '/ip/route/print') return [{ '.id': '*R1', comment: `${mwPlan.TAG} default x d=1` }];
            if (cmd === '/ip/firewall/nat/print') return [];
            if (cmd === '/system/scheduler/print') return [];
            return [];
        };
        await apply.removeAll(c, [{ interface: 'pppoe-out1', kind: 'pppoe', id: '*1', defaultRouteDistance: 10 }]);
        const set = c.calls.find((x) => x.cmd.includes('client/set'));
        assert.strictEqual(set.args['default-route-distance'], '1');
    });

    it('ถอนของที่ติดคอมเมนต์กำกับออกครบ และคืนค่า distance', async () => {
        const c = {
            calls: [],
            async exec(cmd, args = {}) {
                this.calls.push({ cmd, args });
                if (cmd === '/ip/route/print') {
                    return [
                        { '.id': '*R1', comment: `${mwPlan.TAG} check pppoe-out1` },
                        { '.id': '*R2', comment: `${mwPlan.TAG} default ether2 d=2` },
                        { '.id': '*R3', comment: 'เส้นทางของลูกค้าเอง ห้ามแตะ' }
                    ];
                }
                if (cmd === '/ip/firewall/nat/print') {
                    return [{ '.id': '*N1', comment: `${mwPlan.TAG} nat ether2` }];
                }
                if (cmd === '/system/scheduler/print') return [];
                return [];
            }
        };
        const wans = an.analyzeState(a4State()).usable;
        const r = await apply.removeAll(c, wans);

        assert.strictEqual(r.routes, 2);
        assert.strictEqual(r.nat, 1);
        const removedIds = c.calls.filter((x) => x.cmd === '/ip/route/remove')
            .map((x) => x.args['.id']);
        assert.ok(!removedIds.includes('*R3'), 'ห้ามแตะของที่ไม่ใช่ของเรา');
    });
});

describe('multiwan-apply — ตรวจสิทธิ์ก่อนแตะเราท์เตอร์', () => {
    /**
     * ขั้น verify ใช้ /ping ซึ่งต้องมีสิทธิ์ test
     * ถ้าไม่ตรวจก่อน จะลงครบทุกขั้นแล้วไปพังตอน verify แล้วถอนคืน —
     * ปลอดภัยแต่ทำให้เน็ตสาขาสะดุดโดยไม่จำเป็น
     */
    function noTestPolicy() {
        const calls = [];
        return {
            calls,
            async exec(cmd, args = {}) {
                calls.push({ cmd, args });
                if (cmd === '/ping') throw new Error('not enough permissions (9)');
                if (cmd === '/system/scheduler/print') return [];
                if (cmd.endsWith('/add')) return [{ '.id': '*X1' }];
                return [];
            }
        };
    }

    it('ไม่มีสิทธิ์ test = หยุดก่อน ไม่เขียนอะไรลงเราท์เตอร์เลย', async () => {
        const c = noTestPolicy();
        const r = await apply.applyFailover({ client: c, plan: makePlan() });

        assert.strictEqual(r.success, false);
        assert.strictEqual(r.preflight, true);
        assert.strictEqual(r.applied, 0);
        assert.strictEqual(r.rolledBack, false, 'ไม่มีอะไรให้ถอน เพราะยังไม่ได้ลง');

        const wrote = c.calls.filter((x) =>
            x.cmd.includes('/add') || x.cmd.includes('/set') || x.cmd.includes('/remove'));
        assert.strictEqual(wrote.length, 0, 'ห้ามมีคำสั่งเขียนใด ๆ ถูกส่งไป');
        assert.strictEqual(c.calls.filter((x) => x.cmd.includes('backup')).length, 0);
    });

    it('บอกสิทธิ์ที่ขาดและวิธีแก้ ไม่ใช่โยนข้อความดิบ', async () => {
        const r = await apply.applyFailover({ client: noTestPolicy(), plan: makePlan() });
        assert.ok(r.error.includes('test'), 'ต้องบอกว่าขาดสิทธิ์ test');
        assert.ok(r.error.includes('WinBox'), 'ต้องบอกว่าไปแก้ที่ไหน');
        assert.ok(r.error.includes('ยังไม่ได้แตะเราท์เตอร์'), 'ต้องบอกว่ายังปลอดภัยอยู่');
    });

    it('ping ไม่ผ่านเพราะสายล่ม (ไม่ใช่เรื่องสิทธิ์) ต้องไปต่อ ไม่หยุดที่ preflight', async () => {
        // สายล่มเป็นเรื่องที่ขั้น verify ต้องเป็นคนตัดสิน ไม่ใช่ตัวตรวจสิทธิ์
        const c = fakeClient({ pingReplies: 0 });
        const r = await apply.applyFailover({ client: c, plan: makePlan() });
        assert.ok(!r.preflight, 'ไม่ควรถูกตีความว่าเป็นปัญหาสิทธิ์');
        assert.strictEqual(r.rolledBack, true, 'ต้องลงแล้วถอนคืนตามปกติ');
    });
});
