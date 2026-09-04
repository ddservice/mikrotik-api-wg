/**
 * เทสต์ lib/csv-export.js
 *
 * ที่มา: เส้นทางส่งออกทุกตัวเคยดึงข้อมูลด้วย `limit: 99999` แล้วต่อเป็นสตริงเดียว
 * วัดจริง 2026-09-04: วันที่มี 120,000 แถว ได้ไฟล์ 99,999 แถว ขาดไป 20,001 แถว
 * โดยหน้าเว็บบอกว่ามี 120,000 และไม่มีคำเตือนใด ๆ — สำหรับหลักฐานตาม ม.26
 * ไฟล์ที่ไม่ครบแย่กว่าไม่มีไฟล์ เพราะมันดูน่าเชื่อถือทั้งที่ขาดหลักฐาน
 *
 * สิ่งที่ยึดไว้:
 *   1. escape ให้ถูกต้อง โดยเฉพาะช่องที่มี " , และขึ้นบรรทัดใหม่ (details เป็นข้อความอิสระ)
 *   2. forEachPage ต้องไล่จนครบ ไม่ตัดที่หน้าใดหน้าหนึ่ง และต้องไม่วนไม่รู้จบ
 */

const assert = require('assert');
const { csvCell, csvRow, forEachPage, streamCsv } = require('../lib/csv-export');

describe('lib/csv-export — csvCell', () => {
    it('ครอบด้วยเครื่องหมายคำพูดเสมอ', () => {
        assert.strictEqual(csvCell('abc'), '"abc"');
    });
    it('escape เครื่องหมายคำพูดเป็นสองตัว', () => {
        assert.strictEqual(csvCell('เขาบอกว่า "ok"'), '"เขาบอกว่า ""ok"""');
    });
    it('คอมมาอยู่ในช่องได้ ไม่ทำให้คอลัมน์เพี้ยน', () => {
        assert.strictEqual(csvCell('a,b'), '"a,b"');
    });
    it('ขึ้นบรรทัดใหม่ในช่องไม่ทำให้ไฟล์พัง', () => {
        assert.strictEqual(csvCell('a\nb'), '"a\nb"');
    });
    it('null / undefined / 0 กลายเป็นช่องว่างหรือเลข ไม่ใช่คำว่า null', () => {
        assert.strictEqual(csvCell(null), '""');
        assert.strictEqual(csvCell(undefined), '""');
        assert.strictEqual(csvCell(0), '"0"');
    });
});

describe('lib/csv-export — csvRow', () => {
    it('ต่อช่องด้วยคอมมาและปิดท้ายด้วย CRLF', () => {
        assert.strictEqual(csvRow(['a', 'b']), '"a","b"\r\n');
    });
});

describe('lib/csv-export — forEachPage', () => {
    // จำลองแหล่งข้อมูลที่แบ่งหน้าแบบเดียวกับ db.getXxx
    function source(total) {
        return ({ page, limit }) => {
            const start = (page - 1) * limit;
            const logs = [];
            for (let i = start; i < Math.min(start + limit, total); i++) logs.push({ i });
            return Promise.resolve({ logs, total });
        };
    }

    it('ได้ครบทุกแถวแม้เกิน 99,999 (เคสที่ทำให้ไฟล์หลักฐานขาด)', async () => {
        const seen = [];
        const n = await forEachPage(source(120000), (rows) => { rows.forEach((r) => seen.push(r.i)); }, 5000);
        assert.strictEqual(n, 120000);
        assert.strictEqual(seen.length, 120000);
        assert.strictEqual(seen[0], 0);
        assert.strictEqual(seen[119999], 119999);
        assert.strictEqual(new Set(seen).size, 120000, 'ต้องไม่มีแถวซ้ำ');
    });

    it('จำนวนไม่ลงตัวกับขนาดหน้า ก็ยังครบ', async () => {
        const n = await forEachPage(source(10001), () => {}, 1000);
        assert.strictEqual(n, 10001);
    });

    it('ไม่มีข้อมูลเลย = 0 ไม่โยน error', async () => {
        const n = await forEachPage(source(0), () => {}, 100);
        assert.strictEqual(n, 0);
    });

    it('หยุดเมื่อหน้าที่ได้มาว่าง แม้ total จะโม้ว่ามีมากกว่านั้น', async () => {
        // กันวนไม่รู้จบเมื่อ total เพี้ยน (เช่นข้อมูลถูกลบระหว่างไล่อ่าน)
        let calls = 0;
        const lying = ({ page }) => {
            calls++;
            return Promise.resolve({ logs: page === 1 ? [{ i: 1 }] : [], total: 999999 });
        };
        const n = await forEachPage(lying, () => {}, 1);
        assert.strictEqual(n, 1);
        assert.ok(calls < 10, 'ต้องไม่วนต่อเรื่อย ๆ (เรียกไป ' + calls + ' ครั้ง)');
    });
});

describe('lib/csv-export — streamCsv', () => {
    // response ปลอมที่จดทุกอย่างที่ถูกเขียน
    function fakeRes() {
        return {
            headers: {}, chunks: [], ended: false, destroyed: false,
            setHeader(k, v) { this.headers[k] = v; },
            write(s) { this.chunks.push(s); return true; },
            end() { this.ended = true; },
            once() {}
        };
    }

    it('ตั้ง header ของไฟล์และใส่ BOM ให้ Excel อ่านไทยได้', async () => {
        const res = fakeRes();
        await streamCsv(res, { filename: 'a.csv', headers: ['เวลา', 'ผู้ใช้'] }, async () => {});
        assert.match(res.headers['Content-Type'], /text\/csv/);
        assert.match(res.headers['Content-Disposition'], /filename="a\.csv"/);
        assert.ok(res.chunks[0].startsWith('﻿'), 'แถวหัวต้องขึ้นต้นด้วย BOM');
        assert.ok(res.ended);
    });

    it('ได้ข้อมูลครบทุกแถวและนับได้ถูก', async () => {
        const res = fakeRes();
        const n = await streamCsv(res, { filename: 'a.csv', headers: ['x'] }, async (writeRow) => {
            for (let i = 0; i < 2500; i++) await writeRow(['v' + i]);
        });
        assert.strictEqual(n, 2500);

        const out = res.chunks.join('');
        const lines = out.split('\r\n').filter(Boolean);
        assert.strictEqual(lines.length, 2501, 'แถวหัว 1 + ข้อมูล 2500');
        assert.strictEqual(lines[1], '"v0"');
        assert.strictEqual(lines[2500], '"v2499"');
    });

    it('รวมหลายแถวก่อนเขียนลง socket ไม่ใช่เขียนทีละแถว', async () => {
        // เขียนทีละแถวคือสาเหตุที่ไฟล์ 580,000 แถวใช้เวลา 40 วินาที ทั้งที่ฝั่งอ่านใช้ ~1 วินาที
        const res = fakeRes();
        await streamCsv(res, { filename: 'a.csv', headers: ['x'] }, async (writeRow) => {
            for (let i = 0; i < 20000; i++) await writeRow(['ค่าที่ยาวพอสมควรเพื่อให้ครบขนาดก้อน' + i]);
        });
        assert.ok(res.chunks.length < 200,
            'ควรเขียนเป็นก้อนไม่กี่ร้อยครั้ง แต่เขียนไป ' + res.chunks.length + ' ครั้ง');
        assert.ok(res.chunks.length > 1, 'ต้องไม่กองทั้งไฟล์ไว้ก้อนเดียวก่อนส่ง');
    });

    it('แถวที่ค้างอยู่ในก้อนสุดท้ายต้องถูกส่งก่อนปิด ไม่ตกหล่น', async () => {
        const res = fakeRes();
        await streamCsv(res, { filename: 'a.csv', headers: ['x'] }, async (writeRow) => {
            await writeRow(['เดียว']);   // เล็กกว่าขนาดก้อนมาก
        });
        assert.ok(res.chunks.join('').includes('"เดียว"'), 'แถวสุดท้ายต้องอยู่ในผลลัพธ์');
        assert.ok(res.ended);
    });

    it('client ปิดการเชื่อมต่อกลางคัน = โยน error ไม่ใช่เขียนต่อเงียบ ๆ', async () => {
        const res = fakeRes();
        res.destroyed = true;
        await assert.rejects(
            () => streamCsv(res, { filename: 'a.csv', headers: ['x'] }, async () => {}),
            /ปิดการเชื่อมต่อ/
        );
    });
});
