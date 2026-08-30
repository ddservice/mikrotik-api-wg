/**
 * เทสต์ lib/storage-monitor.js
 *
 * โจทย์หลักคือ diskLevel: เกณฑ์แบบดูเปอร์เซ็นต์อย่างเดียวเตือนผิด — ดิสก์ 4 TB
 * ที่ใช้ไป 95% ยังเหลือ 200 GB ซึ่งไม่ด่วนเลย ส่วนดิสก์ 20 GB ที่ใช้ไป 90%
 * เหลือ 2 GB คือด่วนจริง สิ่งที่ทำให้ระบบพังคือไบต์ที่เหลือ ไม่ใช่เปอร์เซ็นต์
 */

const assert = require('assert');
const sm = require('../lib/storage-monitor');

const GB = 1024 * 1024 * 1024;

describe('lib/storage-monitor — diskLevel', () => {
    const cases = [
        ['VPS ปัจจุบัน 116GB ใช้ 19% เหลือ 94GB', 19, 94 * GB, 'ok'],
        ['ดิสก์ dev 4TB ใช้ 95% เหลือ 200GB (เคสที่เกณฑ์เดิมเตือนผิด)', 95, 200 * GB, 'ok'],
        ['ใช้ 85% เหลือ 17GB', 85, 17 * GB, 'warn'],
        ['ใช้ 90% เหลือ 11GB', 90, 11 * GB, 'critical'],
        ['ใช้ 97% เหลือ 2GB', 97, 2 * GB, 'critical'],
        ['ดิสก์เล็ก 20GB ใช้ 90% เหลือ 2GB', 90, 2 * GB, 'critical'],
        ['เหลือ 8GB แต่ใช้แค่ 50% (ที่ว่างสำคัญกว่าเปอร์เซ็นต์)', 50, 8 * GB, 'warn'],
        ['เหลือ 1GB ใช้แค่ 30%', 30, 1 * GB, 'critical']
    ];

    cases.forEach(([desc, pct, avail, want]) => {
        it(`${desc} -> ${want}`, () => {
            assert.strictEqual(sm.diskLevel(pct, avail), want);
        });
    });

    it('ที่ว่างเยอะ ต่อให้เปอร์เซ็นต์สูงก็ไม่เตือน', () => {
        assert.strictEqual(sm.diskLevel(99, 500 * GB), 'ok');
    });
});

describe('lib/storage-monitor — formatBytes', () => {
    it('0 และค่าติดลบ', () => {
        assert.strictEqual(sm.formatBytes(0), '0 B');
        assert.strictEqual(sm.formatBytes(-5), '0 B');
        assert.strictEqual(sm.formatBytes(null), '0 B');
    });
    it('ไบต์ไม่มีทศนิยม', () => assert.strictEqual(sm.formatBytes(512), '512 B'));
    it('กิโลไบต์', () => assert.strictEqual(sm.formatBytes(1536), '1.5 KB'));
    it('เมกะไบต์', () => assert.strictEqual(sm.formatBytes(1024 * 1024), '1.0 MB'));
    it('กิกะไบต์', () => assert.strictEqual(sm.formatBytes(22 * GB), '22.0 GB'));
    it('ค่าตั้งแต่ 100 ขึ้นไปตัดทศนิยมทิ้ง', () => {
        assert.strictEqual(sm.formatBytes(200 * GB), '200 GB');
    });
    it('ไม่เกินหน่วย TB', () => {
        assert.ok(sm.formatBytes(5000 * GB).endsWith('TB'));
    });
});

describe('lib/storage-monitor — โครงสร้างโมดูล', () => {
    it('export สิ่งที่ server.js เรียกใช้ครบ', () => {
        ['buildReport', 'formatAlert', 'getDiskUsage', 'getDirUsage', 'getR2Usage', 'formatBytes', 'diskLevel']
            .forEach((k) => assert.strictEqual(typeof sm[k], 'function', k + ' ต้องเป็นฟังก์ชัน'));
    });

    it('โฟลเดอร์ที่เฝ้าดูต้องระบุว่าตัวไหนโตขึ้นเรื่อย ๆ', () => {
        assert.ok(sm.WATCHED_DIRS.length > 0);
        const growing = sm.WATCHED_DIRS.filter((d) => d.growing).map((d) => d.key);
        ['archives', 'logs', 'backups'].forEach((k) => {
            assert.ok(growing.includes(k), k + ' ควรถูกทำเครื่องหมายว่าโตขึ้นเรื่อย ๆ');
        });
    });
});

describe('lib/storage-monitor — formatAlert', () => {
    const report = {
        level: 'critical',
        issues: [{ level: 'critical', area: 'ดิสก์ VPS', message: 'เหลือ 1 GB', action: 'ลบไฟล์เก่า' }],
        disk: { available: true, usedPercent: 97, human: { used: '19 GB', total: '20 GB', available: '1 GB' } },
        database: { totalRows: 1000, human: '5 MB', growthBytesPerDay: 1048576, growthHuman: '1.0 MB', daysUntilFull: 12 },
        r2: { configured: true, objects: 5, human: '2 MB' }
    };

    it('มีทั้งเรื่องที่ต้องทำและตัวเลขประกอบ', () => {
        const s = sm.formatAlert(report);
        assert.ok(s.includes('ดิสก์ VPS'), 'ต้องบอกว่าเรื่องอะไร');
        assert.ok(s.includes('ลบไฟล์เก่า'), 'ต้องบอกว่าต้องทำอะไร');
        assert.ok(s.includes('97%'), 'ต้องมีตัวเลขดิสก์');
    });

    it('บอกอัตราโตและวันที่จะเต็ม ไม่ใช่แค่ยอดปัจจุบัน', () => {
        const s = sm.formatAlert(report);
        assert.ok(s.includes('1.0 MB'), 'ต้องบอกอัตราโต');
        assert.ok(s.includes('12'), 'ต้องบอกจำนวนวันที่เหลือ');
    });

    it('ไม่พังเมื่ออ่านค่าดิสก์ไม่ได้', () => {
        const r = Object.assign({}, report, { disk: { available: false, reason: 'ไม่รองรับ' } });
        assert.doesNotThrow(() => sm.formatAlert(r));
    });
});
