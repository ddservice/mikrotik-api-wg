/**
 * เทสต์ lib/site-diagnostics.js
 *
 * โมดูลนี้เป็นตัวตอบคำถาม "สาขาล่มเพราะอะไร" ซึ่งคนอ่านตอนตีสองแล้วต้องตัดสินใจทันที
 * สิ่งที่ต้องมั่นใจคือมันแยกให้ออกระหว่าง "อ่านไม่ได้" กับ "ไม่มีจริง" และไม่หยุด
 * ตรวจกลางคันเมื่อยังบอกอะไรได้มากกว่านั้น
 */

const assert = require('assert');
const sd = require('../lib/site-diagnostics');

// dump จริงจาก `wg show wg0 dump` (ตัดมาจากของ VPS จริง)
const REAL_DUMP = [
    'privkey\tRROe/+EO47I8EntyxINUgX8Q/LExWC9rzFBBgvdIICE=\t51820\toff',
    '3UAA1KHEvRmNedZC+9qK9t/Zrb18JcwWFTtt2tlkYxE=\t(none)\t49.49.1.148:13231\t10.10.88.2/32\t1788100000\t485000000\t17000000\t25',
    'M8pYCPRwDyVawjtvDFBR7RHRZLR5p0jbrbuSqQvtezY=\t(none)\t(none)\t10.10.88.3/32\t0\t0\t0\t25',
    'XEUYOsabqNiGwEqrmQI0H2DEZzimQ+dUwTsTu5TsHng=\t(none)\t223.204.81.248:13231\t10.10.88.4/32\t1788099000\t418000000\t15700000\t25'
].join('\n');

describe('lib/site-diagnostics — parseWgDump', () => {
    it('อ่าน peer ได้ครบและข้ามบรรทัดของ interface เอง', () => {
        const p = sd.parseWgDump(REAL_DUMP);
        assert.strictEqual(p.size, 3);
        assert.ok(p.has('10.10.88.2'));
        assert.ok(p.has('10.10.88.4'));
    });

    it('แปลง endpoint / handshake / ปริมาณข้อมูลถูกต้อง', () => {
        const p = sd.parseWgDump(REAL_DUMP).get('10.10.88.2');
        assert.strictEqual(p.endpoint, '49.49.1.148:13231');
        assert.strictEqual(p.handshake, 1788100000);
        assert.strictEqual(p.rx, 485000000);
    });

    it('(none) ถือว่าไม่มี endpoint', () => {
        assert.strictEqual(sd.parseWgDump(REAL_DUMP).get('10.10.88.3').endpoint, null);
    });

    it('ข้อความว่างหรืออ่านไม่ได้ คืน Map ว่าง ไม่โยน error', () => {
        [null, undefined, '', 'Unable to access interface: Operation not permitted'].forEach((v) => {
            assert.strictEqual(sd.parseWgDump(v).size, 0);
        });
    });
});

describe('lib/site-diagnostics — describeWgPeer', () => {
    const NOW = 1788100600000;   // 600 วินาทีหลัง handshake ของ 10.10.88.2

    it('ไม่มี peer = fail และบอกวิธีแก้', () => {
        const r = sd.describeWgPeer(undefined, '10.10.88.9', NOW);
        assert.strictEqual(r.status, 'fail');
        assert.ok(r.detail.includes('สคริปต์'), 'ควรบอกให้ไปสร้างสคริปต์');
    });

    it('มี peer แต่ไม่เคย handshake = warn (คนละเรื่องกับไม่มี peer)', () => {
        const p = sd.parseWgDump(REAL_DUMP).get('10.10.88.3');
        const r = sd.describeWgPeer(p, '10.10.88.3', NOW);
        assert.strictEqual(r.status, 'warn');
        assert.ok(r.detail.includes('ยังไม่เคย'));
    });

    it('handshake เก่าเกินเกณฑ์ = warn', () => {
        const p = sd.parseWgDump(REAL_DUMP).get('10.10.88.2');
        const r = sd.describeWgPeer(p, '10.10.88.2', NOW);
        assert.strictEqual(r.status, 'warn');
        assert.ok(r.detail.includes('keepalive'), 'ควรแนะนำให้ตรวจ keepalive');
    });

    it('handshake สด = ok', () => {
        const p = sd.parseWgDump(REAL_DUMP).get('10.10.88.2');
        const r = sd.describeWgPeer(p, '10.10.88.2', 1788100030000);   // 30 วิ
        assert.strictEqual(r.status, 'ok');
    });

    it('เส้นแบ่งอยู่ที่ WG_STALE_SECONDS พอดี', () => {
        const p = sd.parseWgDump(REAL_DUMP).get('10.10.88.2');
        const base = 1788100000;
        assert.strictEqual(sd.describeWgPeer(p, 'x', (base + sd.WG_STALE_SECONDS) * 1000).status, 'ok');
        assert.strictEqual(sd.describeWgPeer(p, 'x', (base + sd.WG_STALE_SECONDS + 1) * 1000).status, 'warn');
    });
});

describe('lib/site-diagnostics — usesWireguard', () => {
    it('ดูจาก connectionType', () => {
        assert.ok(sd.usesWireguard({ connectionType: 'wireguard', host: 'x' }));
    });
    it('ดูจาก host ในวง 10.10.88.x', () => {
        assert.ok(sd.usesWireguard({ host: '10.10.88.3' }));
    });
    it('ดูจาก wireguardIp', () => {
        assert.ok(sd.usesWireguard({ host: 'a.example.com', wireguardIp: '10.10.88.5' }));
    });
    it('สาขาต่อตรงไม่นับ', () => {
        assert.ok(!sd.usesWireguard({ host: 'b4a00a4696aa.sn.mynetname.net', connectionType: 'direct' }));
    });
});

describe('lib/site-diagnostics — diagnose (ไล่ทีละชั้น)', () => {
    const okRouter = async (fn) => fn({
        exec: async (cmd) => {
            if (cmd === '/system/resource/print') {
                return [{ version: '7.24.1', 'board-name': 'hEX', uptime: '4d', 'cpu-load': '2' }];
            }
            return [{ name: 'TestRouter' }];
        }
    });

    it('ตั้งค่าไม่ครบ = หยุดที่ชั้น 1 ไม่ไปต่อ', async () => {
        const r = await sd.diagnose({ config: { host: '', username: '' }, runOnRouter: okRouter });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.steps.length, 1);
        assert.strictEqual(r.steps[0].status, 'fail');
    });

    it('ชื่อโฮสต์แปลงไม่ได้ = หยุดที่ชั้น 2', async () => {
        const r = await sd.diagnose({
            config: { name: 'x', host: 'ไม่มีจริง.invalid', port: 8728, username: 'u' },
            runOnRouter: okRouter
        });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.steps.length, 2);
        assert.strictEqual(r.steps[1].status, 'fail');
        assert.ok(r.steps[1].detail.includes('DDNS'), 'ควรบอกให้ตรวจ DDNS');
    });

    it('พอร์ตปิด = หยุดที่ชั้น 4 และบอกให้ตรวจ /ip service', async () => {
        const r = await sd.diagnose({
            // พอร์ต 9 (discard) บน localhost ปกติไม่มีอะไรฟัง
            config: { name: 'x', host: '127.0.0.1', port: 9, username: 'u', password: 'p' },
            runOnRouter: okRouter
        });
        assert.strictEqual(r.success, false);
        const last = r.steps[r.steps.length - 1];
        assert.ok(last.step.startsWith('4.'));
        assert.ok(last.detail.includes('/ip service'));
    });

    it('อ่าน wg ไม่ได้ = warn ว่า "ข้าม" ไม่ใช่ fail ว่า "ไม่มี peer"', async () => {
        const r = await sd.diagnose({
            config: { name: 'x', host: '10.10.88.3', port: 9, username: 'u', password: 'p',
                      connectionType: 'wireguard', wireguardIp: '10.10.88.3' },
            runOnRouter: okRouter,
            readWgDump: () => { throw new Error('Operation not permitted'); }
        });
        const wg = r.steps.find((s) => s.step.startsWith('3.'));
        assert.strictEqual(wg.status, 'warn');
        assert.ok(wg.detail.includes('ข้าม'), 'ต้องบอกว่าข้าม ไม่ใช่บอกว่าไม่มี peer');
    });

    it('สาขาต่อตรงไม่ต้องมีชั้น WireGuard', async () => {
        const r = await sd.diagnose({
            config: { name: 'x', host: '127.0.0.1', port: 9, username: 'u', password: 'p', connectionType: 'direct' },
            runOnRouter: okRouter
        });
        assert.ok(!r.steps.some((s) => s.step.startsWith('3.')));
    });

    it('ไม่มีรหัสผ่านก็ยังตรวจต่อ แต่เตือนไว้ในชั้น 1', async () => {
        const r = await sd.diagnose({
            config: { name: 'x', host: '127.0.0.1', port: 9, username: 'u', password: '' },
            runOnRouter: okRouter
        });
        assert.ok(r.steps[0].detail.includes('ยังไม่ได้ตั้งรหัสผ่าน'));
        assert.ok(r.steps.length > 1, 'ต้องตรวจต่อ ไม่หยุดแค่เพราะไม่มีรหัสผ่าน');
    });

    it('ทุกชั้นผ่าน = success และมีข้อมูลเราท์เตอร์จริง', async () => {
        // ใช้พอร์ตที่เปิดจริงชั่วคราวเพื่อให้ชั้น 4 ผ่าน
        const srv = require('net').createServer();
        await new Promise((res) => srv.listen(0, '127.0.0.1', res));
        const port = srv.address().port;
        try {
            const r = await sd.diagnose({
                config: { name: 'x', host: '127.0.0.1', port, username: 'u', password: 'p' },
                runOnRouter: okRouter
            });
            assert.strictEqual(r.success, true);
            assert.strictEqual(r.steps.length, 4);
            const last = r.steps[3];
            assert.strictEqual(last.status, 'ok');
            assert.ok(last.detail.includes('TestRouter'));
            assert.ok(last.detail.includes('7.24.1'));
        } finally {
            srv.close();
        }
    });

    it('ล็อกอินไม่ผ่าน = fail และบอกชื่อผู้ใช้ที่ควรไปตรวจ', async () => {
        const srv = require('net').createServer();
        await new Promise((res) => srv.listen(0, '127.0.0.1', res));
        const port = srv.address().port;
        try {
            const r = await sd.diagnose({
                config: { name: 'x', host: '127.0.0.1', port, username: 'ddserviceapi', password: 'ผิด' },
                runOnRouter: async () => { throw new Error('invalid user name or password (6)'); }
            });
            assert.strictEqual(r.success, false);
            const last = r.steps[r.steps.length - 1];
            assert.ok(last.detail.includes('ddserviceapi'));
        } finally {
            srv.close();
        }
    });
});
