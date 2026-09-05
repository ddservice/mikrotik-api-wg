/**
 * เทสต์ lib/firewall-services.js
 *
 * ที่มา (2026-09-05): รายการบริการที่บล็อกได้มีสองชุด — ใน server.js กับใน
 * FirewallPage.vue คีย์ต้องตรงกันเป๊ะ ไม่งั้น server ตอบ "Invalid service"
 * ซึ่งไม่มีอะไรจับได้ตอน build และไม่มีใครรู้จนกดปุ่มนั้นจริง ๆ
 * เทสต์นี้อ่านไฟล์ .vue มาเทียบตรง ๆ เพราะเป็นทางเดียวที่ยืนยันได้โดยไม่ต้อง build
 *
 * และปัญหาลำดับกฎชุดเดียวกับ Hardened Preset: กฎ drop ที่ต่อท้าย chain forward
 * หลังกฎ accept กว้าง ๆ จะไม่มีวันถูกเรียก = ขึ้นว่าบล็อกแล้วแต่ยังเข้าเว็บได้
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const fw = require('../lib/firewall-services');

describe('firewall-services — รายการบริการ', () => {
    it('ทุกบริการมีฟิลด์ครบและโดเมนไม่ว่าง', () => {
        Object.entries(fw.SERVICES).forEach(([key, s]) => {
            ['group', 'label', 'icon', 'color', 'comment', 'listName'].forEach((f) =>
                assert.ok(s[f], key + ' ขาดฟิลด์ ' + f));
            assert.ok(Array.isArray(s.domains) && s.domains.length, key + ' ไม่มีโดเมน');
        });
    });

    it('listName กับ comment ห้ามซ้ำกันข้ามบริการ', () => {
        // ซ้ำ = กดบล็อกตัวหนึ่งแล้วไปแก้กฎของอีกตัว โดยไม่มีอาการอะไรให้เห็น
        ['listName', 'comment'].forEach((f) => {
            const vals = Object.values(fw.SERVICES).map((s) => s[f]);
            assert.strictEqual(new Set(vals).size, vals.length, 'มี ' + f + ' ซ้ำ');
        });
    });

    it('ทุก group ต้องมีอยู่ใน GROUPS จริง', () => {
        const keys = fw.GROUPS.map((g) => g.key);
        Object.entries(fw.SERVICES).forEach(([k, s]) =>
            assert.ok(keys.includes(s.group), k + ' อยู่หมวด ' + s.group + ' ซึ่งไม่มีใน GROUPS'));
    });

    it('โดเมนต้องเป็นชื่อโดเมนล้วน ไม่มี http:// หรือ path หรือ *', () => {
        // RouterOS รับ address-list เป็นชื่อโฮสต์ ถ้าใส่ URL หรือ wildcard มันจะ
        // ปฏิเสธทั้งรายการ แล้วบริการนั้นจะบล็อกไม่ครบโดยไม่มีอะไรบอก
        Object.entries(fw.SERVICES).forEach(([k, s]) => {
            s.domains.forEach((d) => {
                assert.ok(/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d), k + ': โดเมนไม่ถูกรูปแบบ -> ' + d);
            });
        });
    });

    it('ไม่มีโดเมนซ้ำข้ามบริการ', () => {
        // ซ้ำ = เลิกบล็อกตัวหนึ่งแล้ว address-list ของอีกตัวถูกลบตามไปด้วย
        const seen = new Map();
        Object.entries(fw.SERVICES).forEach(([k, s]) => {
            s.domains.forEach((d) => {
                assert.ok(!seen.has(d), d + ' อยู่ทั้งใน ' + seen.get(d) + ' และ ' + k);
                seen.set(d, k);
            });
        });
    });

    it('มีหมวด VPN — ถ้าไม่มี หมวดอื่นทั้งหมดไร้ผลเมื่อลูกค้าลงแอป VPN', () => {
        assert.ok(fw.SERVICES.vpn, 'ต้องมีบริการ vpn');
        assert.ok(fw.SERVICES.vpn.domains.length >= 8);
    });

    it('listServices() เรียงตามลำดับหมวด', () => {
        const order = fw.GROUPS.map((g) => g.key);
        const got = fw.listServices().map((s) => order.indexOf(s.group));
        assert.deepStrictEqual(got, got.slice().sort((a, b) => a - b));
    });
});

describe('firewall-services — หน้าเว็บ v2 ต้องมีคีย์ตรงกับ server', () => {
    it('คีย์ใน FirewallPage.vue ตรงกับ lib ทุกตัว', () => {
        const p = path.join(__dirname, '..', 'frontend', 'src', 'components', 'FirewallPage.vue');
        const src = fs.readFileSync(p, 'utf8');
        const block = src.slice(src.indexOf('const SERVICES = ['), src.indexOf('];', src.indexOf('const SERVICES = [')));
        const keys = [...block.matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]);
        assert.ok(keys.length, 'อ่านคีย์จาก .vue ไม่ได้ — เทสต์นี้จะไร้ความหมายทันทีถ้าปล่อยผ่าน');
        assert.deepStrictEqual(keys.slice().sort(), Object.keys(fw.SERVICES).sort());
    });
});

describe('firewall-services — ลำดับกฎใน chain forward', () => {
    it('มีกฎ accept อยู่ก่อน = ต้องแทรกเหนือมัน', () => {
        const rules = [
            { '.id': '*1', chain: 'forward', action: 'fasttrack-connection' },
            { '.id': '*2', chain: 'forward', action: 'accept', 'connection-state': 'established,related' },
            { '.id': '*3', chain: 'forward', action: 'drop', 'connection-state': 'invalid' }
        ];
        assert.strictEqual(fw.placeBeforeFor(rules, 'forward'), '*1');
    });

    it('ข้ามกฎของ chain อื่น', () => {
        const rules = [
            { '.id': '*9', chain: 'input', action: 'accept' },
            { '.id': '*1', chain: 'forward', action: 'drop', 'connection-state': 'invalid' },
            { '.id': '*2', chain: 'forward', action: 'accept' }
        ];
        assert.strictEqual(fw.placeBeforeFor(rules, 'forward'), '*2');
    });

    it('chain ว่าง = null (place-before=0 จะ error บน chain ที่ยังไม่มีกฎ)', () => {
        assert.strictEqual(fw.placeBeforeFor([], 'forward'), null);
        assert.strictEqual(fw.placeBeforeFor([{ '.id': '*1', chain: 'input', action: 'accept' }], 'forward'), null);
    });

    it('มีแต่กฎ drop = ต่อท้ายได้ ไม่ต้องแทรก', () => {
        const rules = [{ '.id': '*1', chain: 'forward', action: 'drop', 'connection-state': 'invalid' }];
        assert.strictEqual(fw.placeBeforeFor(rules, 'forward'), null);
    });
});
