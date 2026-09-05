/**
 * เทสต์ lib/r2.js — ไคลเอนต์ Cloudflare R2 (เขียนลายเซ็น AWS SigV4 เอง ไม่มี dependency)
 *
 * ทดสอบเฉพาะส่วนที่ไม่ต้องต่อเน็ต: การอ่านค่าตั้งค่า และการปฏิเสธเมื่อยังไม่ได้ตั้งค่า
 * ส่วนลายเซ็นจริงพิสูจน์ได้ทางเดียวคือ R2 ยอมรับ ซึ่งเกิดขึ้นทุกคืนตอนอัปไฟล์ปิดผนึก
 *
 * สิ่งที่สำคัญที่สุดที่เทสต์นี้ยึด: **เมื่อยังไม่ได้ตั้งค่า ต้องปฏิเสธอย่างชัดเจน**
 * ไม่ใช่เงียบ ๆ แล้วทำเหมือนสำเร็จ — เพราะการสำรองไฟล์หลักฐาน ม.26 ที่ "คิดว่าอัปแล้ว"
 * แต่จริง ๆ ไม่ได้อัป จะรู้ตัวก็ต่อเมื่อ VPS พังและต้องไปกู้จาก R2
 */

const assert = require('assert');
const r2 = require('../lib/r2');

const KEYS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET'];
const saved = {};
KEYS.forEach((k) => { saved[k] = process.env[k]; });

function clear() { KEYS.forEach((k) => delete process.env[k]); }
function restore() {
    KEYS.forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    });
}

describe('lib/r2 — การอ่านค่าตั้งค่า', () => {
    it('ไม่ได้ตั้งอะไรเลย = ยังไม่พร้อมใช้', () => {
        clear();
        assert.strictEqual(r2.isConfigured(), false);
    });

    it('bucket มีค่าเริ่มต้นเป็น ddservicedb', () => {
        clear();
        assert.strictEqual(r2.cfg().bucket, 'ddservicedb');
    });

    it('ตั้ง bucket เองได้', () => {
        clear();
        process.env.R2_BUCKET = 'bucket-ของฉัน';
        assert.strictEqual(r2.cfg().bucket, 'bucket-ของฉัน');
    });

    it('ขาดคีย์ใดคีย์หนึ่งใน 3 ตัวที่จำเป็น = ยังไม่พร้อม', () => {
        const need = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'];
        for (const missing of need) {
            clear();
            need.forEach((k) => { if (k !== missing) process.env[k] = 'x'; });
            process.env.R2_ENDPOINT = missing === 'R2_ENDPOINT' ? '' : 'https://acc.r2.cloudflarestorage.com';
            assert.strictEqual(r2.isConfigured(), false, 'ขาด ' + missing + ' แล้วต้องยังไม่พร้อม');
        }
    });

    it('ครบทั้ง 3 ตัว = พร้อมใช้', () => {
        clear();
        process.env.R2_ACCESS_KEY_ID = 'AKIA_ตัวอย่าง';
        process.env.R2_SECRET_ACCESS_KEY = 'secret_ตัวอย่าง';
        process.env.R2_ENDPOINT = 'https://acc.r2.cloudflarestorage.com';
        assert.strictEqual(r2.isConfigured(), true);
    });
});

describe('lib/r2 — ยังไม่ได้ตั้งค่าแล้วสั่งงาน', () => {
    it('ต้องปฏิเสธพร้อมบอกชื่อตัวแปรที่ขาด ไม่ใช่เงียบ ๆ แล้วทำเหมือนสำเร็จ', async () => {
        clear();
        await assert.rejects(
            () => r2.request({ method: 'GET', key: 'a.txt' }),
            /R2_ACCESS_KEY_ID/
        );
    });

    it('putObject ก็ต้องปฏิเสธเช่นกัน — การสำรองที่ล้มเหลวต้องดังพอให้ได้ยิน', async () => {
        clear();
        await assert.rejects(() => r2.putObject('x/y.gz', Buffer.from('ทดสอบ')), /ยังไม่ได้ตั้งค่า R2/);
    });

    it('getObject ต้องปฏิเสธ ไม่ใช่คืน buffer ว่าง', async () => {
        clear();
        await assert.rejects(() => r2.getObject('x/y.gz'), /ยังไม่ได้ตั้งค่า R2/);
    });

    it('listObjects ต้องปฏิเสธ ไม่ใช่คืนลิสต์ว่าง (ว่างแปลว่า "ไม่มีไฟล์" ซึ่งคนละเรื่อง)', async () => {
        clear();
        await assert.rejects(() => r2.listObjects('prefix/'), /ยังไม่ได้ตั้งค่า R2/);
    });
});

process.on('exit', restore);
