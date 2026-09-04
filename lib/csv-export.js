/**
 * lib/csv-export.js — ส่งออก CSV แบบสตรีม
 *
 * ทำไมต้องมี: ของเดิมทุกเส้นทางส่งออกดึงข้อมูลมาทั้งก้อนด้วย `limit: 99999` แล้วต่อเป็น
 * สตริงเดียวก่อนส่ง ซึ่งพังสองทาง
 *   1. ตัดข้อมูลเงียบ ๆ ที่ 99,999 แถว — วัดจริง: วันที่มี 120,000 แถว ได้ไฟล์ 99,999 แถว
 *      โดยหน้าเว็บยังบอกว่า 120,000 และไม่มีคำเตือนใด ๆ ปัจจุบันสาขารวมกันผลิต DNS log
 *      ราว 580,000 แถว/วัน แปลว่า "ส่งออกวันเดียว" ก็ไม่ครบแล้ว
 *   2. กองทั้งไฟล์ไว้ในหน่วยความจำก่อนส่ง ซึ่ง PM2 ตั้ง max_memory_restart ไว้ 500M
 *
 * สำหรับบันทึกตาม พรบ. ม.26 ไฟล์ที่ไม่ครบแย่กว่าไม่มีไฟล์ เพราะมันดูน่าเชื่อถือทั้งที่
 * ขาดหลักฐาน — เป็นความผิดพลาดแบบเดียวกับที่เคยเจอตอน PostgREST cap 1000 แถว
 * (2026-08-29) ซึ่งตอนนั้นแก้เฉพาะตัวปิดผนึก ไม่ได้แก้เส้นทางส่งออก
 */

'use strict';

/** ครอบเครื่องหมายคำพูดให้ทุกช่อง และ escape " เป็น "" ตามมาตรฐาน CSV */
function csvCell(v) {
    return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
}

function csvRow(cells) {
    return cells.map(csvCell).join(',') + '\r\n';
}

/**
 * เขียน CSV ลง response แบบสตรีม
 *
 * รอ 'drain' เมื่อบัฟเฟอร์เต็ม ไม่งั้นถ้าปลายทางรับช้า ข้อมูลจะไปกองในหน่วยความจำของ
 * server แทน ซึ่งก็คือปัญหาเดิมที่ตั้งใจจะหนีมา
 *
 * produce(writeRow, writeRaw) เป็นคนไล่ข้อมูล คืนจำนวนแถวที่เขียน
 *   writeRow(cells)  — ส่ง array ของช่อง ให้ฟังก์ชันนี้จัดรูปแบบ CSV ให้
 *   writeRaw(line)   — ส่งบรรทัดที่จัดรูปแบบมาแล้ว (ปิดท้ายด้วย CRLF แล้ว)
 *                      มีไว้ให้ฝั่งที่จัดรูปแบบไว้ล่วงหน้าเพื่อประหยัดหน่วยความจำตอนเรียงลำดับ
 */
async function streamCsv(res, opts, produce) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + opts.filename + '"');

    // คืน null เมื่อเขียนได้ทันที และคืน promise เฉพาะตอนบัฟเฟอร์เต็มจริง ๆ
    // ผู้เรียกจึง await เฉพาะเท่าที่จำเป็น — การสร้าง promise ให้ทุกแถวเป็นค่าใช้จ่าย
    // ที่มองไม่เห็นแต่แพงมากเมื่อไฟล์มีหลายแสนแถว
    const write = (s) => {
        if (res.destroyed) throw new Error('client ปิดการเชื่อมต่อไปแล้ว');
        if (res.write(s)) return null;
        return new Promise((resolve) => res.once('drain', resolve));
    };

    // รวมหลายแถวก่อนเขียนลง socket หนึ่งครั้ง
    //
    // วัดจริงกับไฟล์ 580,000 แถว: เขียนทีละแถวใช้เวลา 40 วินาที ขณะที่ฝั่งอ่านและ
    // จัดรูปแบบข้อมูลใช้แค่ ~1 วินาที — เวลาเกือบทั้งหมดหมดไปกับจำนวนครั้งที่เรียก
    // res.write() ไม่ใช่กับปริมาณข้อมูล การรวมเป็นก้อนละ 256 KB ลดจาก 580,000 ครั้ง
    // เหลือหลักร้อย โดยยังคุม backpressure ได้เหมือนเดิมเพราะยังเช็คค่าที่ write() คืนมา
    const FLUSH_BYTES = 256 * 1024;
    let pending = [];
    let pendingLen = 0;

    const push = (s) => {
        pending.push(s);
        pendingLen += s.length;
        if (pendingLen < FLUSH_BYTES) return null;
        const chunk = pending.join('');
        pending = [];
        pendingLen = 0;
        return write(chunk);
    };

    const flushPending = async () => {
        if (!pending.length) return;
        const chunk = pending.join('');
        pending = [];
        pendingLen = 0;
        const p = write(chunk);
        if (p) await p;
    };

    // BOM ให้ Excel อ่านภาษาไทยถูก (เหมือนของเดิม)
    push('﻿' + opts.headers.map(csvCell).join(',') + '\r\n');

    let count = 0;
    const writeRow = (cells) => { count++; return push(csvRow(cells)); };
    const writeRaw = (line) => { count++; return push(line); };
    await produce(writeRow, writeRaw);

    await flushPending();
    res.end();
    return count;
}

/**
 * ไล่อ่านทีละหน้าจนหมด แทนที่จะขอทีเดียวด้วย limit มหาศาล
 *
 * fetchPage({ page, limit }) ต้องคืน { logs, total } แบบเดียวกับ db.getXxx
 * หยุดเมื่อได้ครบตามยอดรวม หรือเมื่อหน้าที่ได้มาว่าง (กันวนไม่รู้จบถ้ายอดรวมเพี้ยน)
 */
async function forEachPage(fetchPage, onRows, chunkSize = 5000) {
    let page = 1;
    let seen = 0;
    let total = null;

    for (;;) {
        const res = await fetchPage({ page, limit: chunkSize });
        const logs = (res && res.logs) || [];
        if (total === null) total = (res && res.total) || 0;
        if (!logs.length) break;

        await onRows(logs);
        seen += logs.length;

        if (total && seen >= total) break;
        if (logs.length < chunkSize) break;   // หน้าไม่เต็ม = หมดแล้ว
        page++;
    }
    return seen;
}

/**
 * ไล่อ่านทีละหน้าแบบ "ย้อนจากหน้าสุดท้ายมาหน้าแรก" แล้วกลับลำดับในแต่ละหน้า
 *
 * ใช้เมื่อแหล่งข้อมูลเรียงใหม่->เก่า (เหมือน db.getDnsQueryLogs) แต่ปลายทางต้องการ
 * เก่า->ใหม่ การกลับลำดับทั้งชุดต้องโหลดทุกแถวเข้าหน่วยความจำก่อน ซึ่งเป็นสิ่งที่
 * ตั้งใจหนีมา — วิธีนี้ถือไว้แค่หน้าเดียวต่อครั้ง
 *
 * fetchPage({ offset, limit }) ต้องรองรับ offset ตรง ๆ ไม่ใช่แค่เลขหน้า
 */
async function forEachPageReverse(fetchPage, onRows, chunkSize = 5000) {
    const first = await fetchPage({ offset: 0, limit: 1 });
    const total = (first && first.total) || 0;
    if (!total) return 0;

    let seen = 0;
    let offset = Math.floor((total - 1) / chunkSize) * chunkSize;
    for (; offset >= 0; offset -= chunkSize) {
        const res = await fetchPage({ offset, limit: chunkSize });
        const logs = (res && res.logs) || [];
        if (!logs.length) continue;
        await onRows(logs.slice().reverse());
        seen += logs.length;
    }
    return seen;
}

module.exports = { csvCell, csvRow, streamCsv, forEachPage, forEachPageReverse };
