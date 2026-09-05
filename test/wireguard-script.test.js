/**
 * เทสต์ lib/wireguard-script.js
 *
 * สคริปต์นี้คือสิ่งที่ถูกคัดลอกไปรันบนเราท์เตอร์จริงของลูกค้า ผิดหนึ่งบรรทัด = สาขาต่อไม่ได้
 * และก่อนหน้านี้ไม่มีเทสต์คุมเลยสักตัว
 *
 * เหตุการณ์จริงที่ทำให้ต้องมีไฟล์นี้ (EstiaHotel, 2026-09-05):
 * เราท์เตอร์มี WireGuard interface เดิมที่ใช้ listen-port 13231 อยู่แล้ว พอสคริปต์
 * สร้างตัวใหม่ด้วยพอร์ตเดียวกัน RouterOS รับคำสั่งไปแล้ว "ปิด" interface ใหม่ทิ้ง
 * ไม่มี error ไม่มีคำเตือน สคริปต์รันจบสวยงาม แต่ tunnel ไม่มีทางขึ้น
 * ใช้เวลาไล่หาสาเหตุนาน เพราะทุกอย่างดูถูกหมด
 */

const assert = require('assert');
const wg = require('../lib/wireguard-script');

const BASE = {
    wireguardIp: '10.10.88.5',
    apiPort: 8728,
    vpsPublicKey: 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK=',
    endpointHost: '157.85.108.84',
    endpointPort: 51820
};

describe('wireguard-script — กันพอร์ตชนกับ interface เดิม', () => {
    it('ไม่ hardcode พอร์ตตายตัวลงคำสั่ง add', () => {
        const s = wg.buildSetupScript(BASE);
        assert.ok(!/listen-port=13231\b/.test(s),
            'ถ้ายัง hardcode อยู่ จะไปชนกับ WireGuard เดิมของลูกค้าเหมือนเคส EstiaHotel');
        assert.ok(/listen-port=\$wgport/.test(s), 'ต้องใช้พอร์ตที่หามาได้ตอนรัน');
    });

    it('มีลูปหาพอร์ตว่าง โดยเริ่มจากค่าเริ่มต้นเดิม', () => {
        const s = wg.buildSetupScript(BASE);
        assert.ok(s.includes(':local wgport ' + wg.DEFAULT_LISTEN_PORT), 'เริ่มที่ค่าเดิมก่อน');
        assert.ok(/\/interface\/wireguard find listen-port=\$wgport/.test(s), 'ต้องเช็คว่าพอร์ตถูกใช้อยู่ไหม');
        assert.ok(/:set wgport \(\$wgport \+ 1\)/.test(s), 'ชนแล้วต้องขยับไปพอร์ตถัดไป');
    });

    it('ลูปมีตัวกันวนไม่รู้จบ — สคริปต์ที่ค้างบนเราท์เตอร์แย่กว่าสคริปต์ที่ล้มเหลว', () => {
        const s = wg.buildSetupScript(BASE);
        assert.ok(/\$guard < \d+/.test(s));
    });

    it('บอกผู้ใช้เมื่อต้องเปลี่ยนพอร์ต ไม่ใช่เปลี่ยนเงียบ ๆ', () => {
        const s = wg.buildSetupScript(BASE);
        assert.ok(/was in use by another WireGuard interface/.test(s));
    });

    it('ไม่ไปยุ่งกับ WireGuard เดิมของลูกค้า — ลบเฉพาะ interface ชื่อของเราเอง', () => {
        const s = wg.buildSetupScript(BASE);
        assert.ok(s.includes('/interface/wireguard/remove [find name=' + wg.IFACE + ']'));
        assert.ok(!/\/interface\/wireguard\/remove \[find\]\s*$/m.test(s),
            'ห้ามลบ WireGuard ทุกตัวบนเราท์เตอร์');
    });
});

describe('wireguard-script — ต้องไม่ล้มเหลวแบบเงียบ ๆ', () => {
    it('ตรวจหลังสร้างว่า interface ไม่ได้ถูกปิด', () => {
        const s = wg.buildSetupScript(BASE);
        assert.ok(/get \[find name=wg-gatekeeper\] disabled\] = true/.test(s),
            'นี่คือขั้นที่จะจับเคส EstiaHotel ได้ตั้งแต่ตอนรัน');
        assert.ok(/FAILED/.test(s), 'ต้องบอกดัง ๆ ว่าไม่สำเร็จ');
        assert.ok(/enable \[find name=wg-gatekeeper\]/.test(s), 'ต้องบอกวิธีแก้ต่อ');
    });

    it('พิมพ์ public key ออกมาเฉพาะตอนสำเร็จ', () => {
        const s = wg.buildSetupScript(BASE);
        const okBranch = s.slice(s.indexOf('} else={'));
        assert.ok(okBranch.includes('public-key'), 'คีย์ต้องอยู่ในสาขาที่สำเร็จเท่านั้น');
    });
});

describe('wireguard-script — ค่าที่ใส่เข้าไปต้องไปโผล่ถูกที่', () => {
    it('IP ของสาขาไปอยู่ทั้งที่ ip/address และหัวสคริปต์', () => {
        const s = wg.buildSetupScript(BASE);
        assert.ok(s.includes('address=10.10.88.5/24'));
        assert.ok(s.includes('Targeted IP: 10.10.88.5'));
    });

    it('endpoint ของ VPS ตั้งค่าได้ ไม่ได้ตายตัวในโค้ด', () => {
        const s = wg.buildSetupScript(Object.assign({}, BASE, {
            endpointHost: '203.0.113.9', endpointPort: 51999
        }));
        assert.ok(s.includes('endpoint-address="203.0.113.9"'));
        assert.ok(s.includes('endpoint-port=51999'));
        assert.ok(!s.includes('157.85.108.84'), 'ต้องไม่มี IP เดิมหลงเหลือ');
    });

    it('พอร์ต API ที่ล็อกไว้ตรงกับที่สั่ง', () => {
        const s = wg.buildSetupScript(Object.assign({}, BASE, { apiPort: 8291 }));
        assert.ok(s.includes('port=8291'));
        assert.ok(s.includes('address=10.10.88.0/24'), 'API ต้องเข้าได้เฉพาะในอุโมงค์');
    });

    it('ต่อบล็อกลงทะเบียนอัตโนมัติเข้าไปได้', () => {
        const s = wg.buildSetupScript(Object.assign({}, BASE, {
            callbackBlock: '\n/tool/fetch url="https://x/y" output=none'
        }));
        assert.ok(s.includes('/tool/fetch url="https://x/y"'));
    });

    it('ไม่ใส่บล็อกลงทะเบียน ก็ยังได้สคริปต์ที่ใช้ได้', () => {
        const s = wg.buildSetupScript(BASE);
        assert.ok(!s.includes('/tool/fetch'));
        assert.ok(s.includes('/interface/wireguard/add'));
    });
});

describe('wireguard-script — ปฏิเสธ input ที่ไม่ครบ แทนที่จะสร้างสคริปต์พัง', () => {
    it('ไม่มี IP', () => {
        assert.throws(() => wg.buildSetupScript(Object.assign({}, BASE, { wireguardIp: '' })), /wireguardIp/);
    });
    it('ไม่มี endpoint ของ VPS', () => {
        assert.throws(() => wg.buildSetupScript(Object.assign({}, BASE, { endpointHost: '' })), /endpointHost/);
    });
    it('ไม่มี public key ของ VPS — สำคัญที่สุด เพราะ peer ที่คีย์ว่างจะไม่มีทางเชื่อมต่อ', () => {
        assert.throws(() => wg.buildSetupScript(Object.assign({}, BASE, { vpsPublicKey: '' })), /vpsPublicKey/);
    });
});

describe('wireguard-script — สคริปต์ถอนการติดตั้ง', () => {
    it('ลบเฉพาะของเรา ไม่แตะ WireGuard ตัวอื่นของลูกค้า', () => {
        const s = wg.buildUninstallScript();
        assert.ok(s.includes('/interface/wireguard/remove [find name=' + wg.IFACE + ']'));
        assert.ok(s.includes('[find comment="' + wg.IP_COMMENT + '"]'));
    });

    it('ใช้ชื่อ interface และคอมเมนต์ชุดเดียวกับตอนติดตั้ง', () => {
        const setup = wg.buildSetupScript(BASE);
        const un = wg.buildUninstallScript();
        assert.ok(setup.includes(wg.IFACE) && un.includes(wg.IFACE));
        assert.ok(setup.includes(wg.IP_COMMENT) && un.includes(wg.IP_COMMENT),
            'ถ้าสองฝั่งใช้คนละคอมเมนต์ การถอนจะเก็บกวาดไม่หมด');
    });
});
