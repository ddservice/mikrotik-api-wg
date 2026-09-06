/**
 * เทสต์ lib/backup-manifest.js
 *
 * ที่มา (2026-09-06): ลองพิสูจน์ว่า backup กู้คืนได้จริง แล้วพบว่ากู้ไม่ได้เลย —
 * สำรองแต่ตาราง log เป็น CSV ส่วนสคริปต์กู้คืนคัดลอก *.json จากโฟลเดอร์ที่ไม่มี
 * ไฟล์ .json อยู่เลย แล้วพิมพ์ว่าสำเร็จเพราะมี `|| true` ปิดท้าย
 *
 * เทสต์ชุดนี้จึงมีหน้าที่เดียว: **ทำให้ "ผ่าน" โกหกไม่ได้**
 */

const assert = require('assert');
const mf = require('../lib/backup-manifest');

function buf(s) { return Buffer.from(s, 'utf8'); }

function fullSet() {
    return mf.PARTS.map((p) => ({
        part: p.key, name: p.key + '_2026-09-06.json', rows: 3, buffer: buf('data-' + p.key)
    }));
}

describe('backup-manifest — สร้าง manifest', () => {
    it('บันทึก hash และขนาดของทุกไฟล์', () => {
        const m = mf.buildManifest({ date: '2026-09-06', files: fullSet() });
        assert.strictEqual(m.files.length, mf.PARTS.length);
        m.files.forEach((f) => {
            assert.strictEqual(f.sha256.length, 64);
            assert.ok(f.bytes > 0);
        });
    });

    it('เขียนรายการสิ่งที่ต้องมีลงไปในไฟล์ด้วย', () => {
        // เพื่อให้คนที่เปิด backup เจอในอีกสองปีรู้ว่าควรมีอะไร โดยไม่ต้องมีซอร์สโค้ดรุ่นนี้
        const m = mf.buildManifest({ date: '2026-09-06', files: [] });
        assert.strictEqual(m.expectedParts.length, mf.PARTS.length);
        assert.ok(m.expectedParts.some((p) => p.key === 'sites' && p.critical));
    });
});

describe('backup-manifest — ตัดความลับออก', () => {
    it('แทนรหัสผ่านและ token ทุกชั้น', () => {
        const out = mf.redact({
            sites: [{ name: 'A4', host: '10.0.0.1', password: 'lib3', wireguardPrivateKey: 'aaa' }],
            line: { channelAccessToken: 'tok', enabled: true }
        });
        assert.strictEqual(out.sites[0].password, mf.REDACTED);
        assert.strictEqual(out.sites[0].wireguardPrivateKey, mf.REDACTED);
        assert.strictEqual(out.line.channelAccessToken, mf.REDACTED);
        // ของที่ไม่ใช่ความลับต้องอยู่ครบ ไม่งั้น backup ก็ไร้ประโยชน์
        assert.strictEqual(out.sites[0].host, '10.0.0.1');
        assert.strictEqual(out.line.enabled, true);
    });

    it('ค่าว่างไม่ถูกแทน — จะได้แยกออกว่า "ไม่มี" กับ "ตัดออก" ต่างกัน', () => {
        assert.strictEqual(mf.redact({ password: '' }).password, '');
    });
});

describe('backup-manifest — ตรวจว่ากู้คืนได้จริงไหม', () => {
    it('ครบทุกอย่าง = ผ่าน', () => {
        const files = fullSet();
        const m = mf.buildManifest({ date: '2026-09-06', files });
        const v = mf.verifyBackup(m, files);
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.restorable, true);
        assert.strictEqual(v.checked, mf.PARTS.length);
    });

    it('ไม่มี manifest = ไม่ผ่าน และยังบอกได้ว่าขาดอะไร', () => {
        // นี่คือสภาพจริงของ backup ทุกชุดใน R2 ก่อนวันนี้
        const v = mf.verifyBackup(null, [{ name: 'hotspot_logs_2026-09-05.csv', buffer: buf('x') }]);
        assert.strictEqual(v.restorable, false);
        assert.strictEqual(v.parts.length, mf.PARTS.length);
        assert.ok(v.parts.every((p) => !p.present));
    });

    it('มีแต่ log = ไม่ผ่าน เพราะกู้คืนแล้วระบบยังทำงานไม่ได้', () => {
        // จุดสำคัญที่สุดของทั้งไฟล์: log ครบทุกแถวก็ยังกู้ระบบไม่ได้
        const files = fullSet().filter((f) => {
            const p = mf.PARTS.find((x) => x.key === f.part);
            return p.kind === 'log';
        });
        const m = mf.buildManifest({ date: '2026-09-06', files });
        const v = mf.verifyBackup(m, files);
        assert.strictEqual(v.restorable, false);
        assert.ok(v.problems.some((p) => p.includes('sites')));
        assert.ok(v.problems.some((p) => p.includes('dashboard_users')));
        assert.ok(v.problems.some((p) => p.includes('app_settings')));
    });

    it('ไฟล์เพี้ยนแม้ไบต์เดียวต้องจับได้', () => {
        const files = fullSet();
        const m = mf.buildManifest({ date: '2026-09-06', files });
        const tampered = files.map((f, i) =>
            i === 0 ? { ...f, buffer: Buffer.concat([f.buffer, buf(' ')]) } : f);
        const v = mf.verifyBackup(m, tampered);
        assert.strictEqual(v.restorable, false);
        assert.ok(v.problems.some((p) => p.includes('เพี้ยน')));
    });

    it('ไฟล์หายต้องจับได้ ไม่ใช่ผ่านเพราะที่เหลือครบ', () => {
        const files = fullSet();
        const m = mf.buildManifest({ date: '2026-09-06', files });
        const v = mf.verifyBackup(m, files.slice(1));
        assert.strictEqual(v.restorable, false);
        assert.ok(v.problems.some((p) => p.startsWith('ขาดไฟล์')));
    });

    it('ไฟล์ว่างเปล่าทั้งที่ควรมีข้อมูล = ไม่ผ่าน', () => {
        const files = fullSet();
        const m = mf.buildManifest({ date: '2026-09-06', files });
        const empty = files.map((f, i) => (i === 2 ? { ...f, buffer: Buffer.alloc(0) } : f));
        const v = mf.verifyBackup(m, empty);
        assert.ok(v.problems.some((p) => p.includes('ว่างเปล่า') || p.includes('เพี้ยน')));
        assert.strictEqual(v.ok, false);
    });

    it('ขาดเฉพาะส่วนที่ไม่ critical = ยังกู้คืนได้ แต่รายงานว่าไม่ครบ', () => {
        const files = fullSet().filter((f) => f.part !== 'archived_hotspot_users' && f.part !== 'dns_query_logs');
        const m = mf.buildManifest({ date: '2026-09-06', files });
        const v = mf.verifyBackup(m, files);
        assert.strictEqual(v.restorable, true);
    });
});
