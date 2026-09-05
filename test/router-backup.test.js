/**
 * เทสต์ lib/router-backup.js
 *
 * ปุ่มสำรองเดิมสั่ง /system/backup/save ซึ่งเก็บไฟล์ไว้ "บนตัวเราท์เตอร์เอง"
 * เราท์เตอร์พังเมื่อไหร่ไฟล์สำรองพังไปด้วย — เป็นความรู้สึกปลอดภัยที่ไม่มีของจริงรองรับ
 *
 * สิ่งที่เทสต์นี้ยึดหนักที่สุด: **ห้ามบันทึกว่าสำรองสำเร็จถ้าไม่ได้คอนฟิกมาจริง**
 * ไฟล์สำรองที่ว่างเปล่าแย่กว่าไม่มีไฟล์ เพราะจะรู้ตอนที่ต้องใช้กู้เท่านั้น ซึ่งสายไปแล้ว
 * (บทเรียนเดียวกับ CSV ที่ตัดข้อมูลเงียบ ๆ และไฟล์ปิดผนึกที่เคยขาดไป 200 แถว)
 */

const assert = require('assert');
const zlib = require('zlib');
const crypto = require('crypto');
const rb = require('../lib/router-backup');

// คอนฟิกตัวอย่างที่มีรูปร่างเหมือนของจริง
const CONFIG = [
    '# sep/05/2026 08:30:00 by RouterOS 7.24.1',
    '/interface bridge',
    'add name=bridge-lan comment="LAN"',
    '/interface wireguard',
    'add name=wg-gatekeeper listen-port=13231',
    '/ip address',
    'add address=10.10.88.5/24 interface=wg-gatekeeper comment="WireGuard VPN IP"',
    'add address=192.168.88.1/24 interface=bridge-lan',
    '/ip dhcp-server',
    'add name=dhcp1 interface=bridge-lan address-pool=dhcp_pool0',
    '/ip firewall filter',
    'add chain=input action=accept connection-state=established,related',
    '/system identity',
    'set name=EstiaHotel'
].join('\n');

describe('router-backup — อ่านผลลัพธ์ /export ที่มาได้หลายรูปแบบ', () => {
    it('มาเป็นข้อความก้อนเดียว', () => {
        assert.strictEqual(rb.parseExport(CONFIG), CONFIG);
    });

    it('มาเป็นหลาย sentence ในฟิลด์ ret', () => {
        const rows = CONFIG.split('\n').map((l) => ({ ret: l }));
        assert.strictEqual(rb.parseExport(rows), CONFIG);
    });

    it('มาในฟิลด์ section (บางเวอร์ชัน)', () => {
        const rows = [{ section: '/ip address' }, { section: 'add address=1.2.3.4/24' }];
        assert.strictEqual(rb.parseExport(rows), '/ip address\nadd address=1.2.3.4/24');
    });

    it('อาร์เรย์ของสตริงล้วน', () => {
        assert.strictEqual(rb.parseExport(['/ip address', 'add address=1.2.3.4/24']),
            '/ip address\nadd address=1.2.3.4/24');
    });

    it('ค่าที่อ่านไม่ออกคืนสตริงว่าง ไม่โยน error', () => {
        assert.strictEqual(rb.parseExport(null), '');
        assert.strictEqual(rb.parseExport(undefined), '');
        assert.strictEqual(rb.parseExport([{ '.id': '*1' }]), '');
    });
});

describe('router-backup — ปฏิเสธสิ่งที่ไม่ใช่คอนฟิก', () => {
    it('คอนฟิกจริงผ่าน', () => {
        const r = rb.looksLikeConfig(CONFIG);
        assert.strictEqual(r.ok, true);
        assert.ok(r.commandLines >= 3);
    });

    it('ข้อความว่าง = ไม่ผ่าน', () => {
        assert.strictEqual(rb.looksLikeConfig('').ok, false);
        assert.strictEqual(rb.looksLikeConfig('   \n  ').ok, false);
    });

    it('ข้อความ error สั้น ๆ = ไม่ผ่าน (นี่คือเคสที่อันตรายที่สุด)', () => {
        const r = rb.looksLikeConfig('failure: not enough permissions (9)');
        assert.strictEqual(r.ok, false);
        assert.ok(r.reason.includes('สั้นผิดปกติ'));
    });

    it('ข้อความยาวแต่ไม่มีคำสั่งคอนฟิกเลย = ไม่ผ่าน', () => {
        const noise = 'x'.repeat(400) + '\nthis is prose, not configuration\n' + 'y'.repeat(200);
        const r = rb.looksLikeConfig(noise);
        assert.strictEqual(r.ok, false);
        assert.ok(r.reason.includes('ไม่พบคำสั่งคอนฟิก'));
    });

    it('buildBackup ต้องโยน error ไม่ใช่สร้างไฟล์เปล่า', () => {
        assert.throws(() => rb.buildBackup('A4', ''), /ไม่สมบูรณ์/);
        assert.throws(() => rb.buildBackup('A4', 'failure: not enough permissions'), /ไม่สมบูรณ์/);
    });
});

describe('router-backup — ไฟล์ที่ได้ต้องกู้คืนได้จริงและตรวจสอบได้', () => {
    const at = new Date('2026-09-05T08:30:00.000Z');

    it('คลายไฟล์แล้วได้คอนฟิกเดิมทุกตัวอักษร', () => {
        const b = rb.buildBackup('EstiaHotel', CONFIG, { now: at });
        assert.strictEqual(zlib.gunzipSync(b.buffer).toString('utf8'), CONFIG);
    });

    it('SHA-256 เป็นของไฟล์ .gz เอง ผู้รับตรวจด้วย sha256sum ได้เลย', () => {
        const b = rb.buildBackup('EstiaHotel', CONFIG, { now: at });
        const onDisk = crypto.createHash('sha256').update(b.buffer).digest('hex');
        assert.strictEqual(onDisk, b.sha256,
            'ถ้า hash เป็นของข้อความก่อนบีบอัด ผู้รับจะตรวจไฟล์ที่ได้ไม่ได้');
    });

    it('ชื่อไฟล์มีชื่อสาขาและเวลา และไม่มีอักขระที่ใช้ในชื่อไฟล์ไม่ได้', () => {
        const b = rb.buildBackup('สาขา A4/หลัก', CONFIG, { now: at });
        assert.ok(b.fileName.endsWith('.rsc.gz'));
        assert.ok(b.fileName.includes('2026-09-05'));
        assert.ok(!/[/\\:*?"<>|]/.test(b.fileName), 'ชื่อไฟล์ต้องปลอดภัยกับทุกระบบไฟล์');
    });

    it('บีบอัดแล้วเล็กลงจริง และรายงานทั้งขนาดก่อนและหลัง', () => {
        const b = rb.buildBackup('A4', CONFIG, { now: at });
        assert.ok(b.sizeBytes < b.rawBytes);
        assert.strictEqual(b.rawBytes, Buffer.byteLength(CONFIG, 'utf8'));
    });
});

describe('router-backup — ไม่เก็บซ้ำถ้าคอนฟิกไม่เปลี่ยน', () => {
    const at = new Date('2026-09-05T08:30:00.000Z');

    it('ยังไม่เคยมีชุดก่อนหน้า = ต้องเก็บ', () => {
        const b = rb.buildBackup('A4', CONFIG, { now: at });
        assert.strictEqual(rb.hasChanged(null, b), true);
    });

    it('คอนฟิกเหมือนเดิม = ข้าม ไม่ต้องเก็บซ้ำทุกวัน', () => {
        const b = rb.buildBackup('A4', CONFIG, { now: at });
        assert.strictEqual(rb.hasChanged(b.sha256, b), false);
    });

    it('คอนฟิกเปลี่ยนไปแม้บรรทัดเดียว = ต้องเก็บชุดใหม่', () => {
        const before = rb.buildBackup('A4', CONFIG, { now: at });
        const after = rb.buildBackup('A4', CONFIG + '\n/ip firewall filter\nadd chain=input action=drop', { now: at });
        assert.strictEqual(rb.hasChanged(before.sha256, after), true);
    });
});
