/**
 * lib/expiry.js — อ่านวันหมดอายุออกจาก comment ของเราท์เตอร์
 *
 * เรื่องที่ต้องรู้ก่อนแก้อะไรในนี้
 * -------------------------------
 * **วันครบกำหนดของทุกห้องเช่าและทุกคูปอง เก็บอยู่ในช่องข้อความอิสระบนเราท์เตอร์**
 * (`/ppp/secret` และ `/ip/hotspot/user` ฟิลด์ `comment`) ไม่ได้อยู่ในฐานข้อมูล
 * ของระบบนี้เลย ไฟล์นี้จึงเป็นสิ่งเดียวที่ทำให้ข้อมูลการเงินของธุรกิจอ่านออกได้
 *
 * ผลที่ตามมาซึ่งต้องเข้าใจ:
 *   - พิมพ์วันที่ผิดรูปแบบ หรือลืมใส่ = ห้องนั้น **หายไปจากรายงานเงียบ ๆ**
 *     ไม่มีใครทวง ไม่มี error ไม่มีอะไรบอก — เป็นรายได้ที่รั่วโดยไม่มีร่องรอย
 *     ฟังก์ชัน `summarise()` จึงนับ "ไม่มีวันหมดอายุ" แยกออกมาให้เห็น
 *     แทนที่จะกรองทิ้งเหมือนที่โค้ดเดิมทำ
 *   - เราท์เตอร์ถูก reset หรือเปลี่ยนเครื่อง = วันครบกำหนดของทุกห้องหายพร้อมกัน
 *
 * บั๊กที่แก้ตอนแยกไฟล์นี้ออกมา (2026-09-06)
 * ------------------------------------------
 * ของเดิมใช้ `new Date(year, month, day, 23, 59, 59)` ซึ่งอิง **เวลาของเครื่อง VPS**
 * และไม่มีที่ไหนในโปรเจกต์ปักหมุด `TZ` ไว้เลย ถ้าเครื่องรันเป็น UTC วันหมดอายุ
 * จะเลื่อนไป 7 ชั่วโมง — ห้องที่หมดอายุแล้วยังอ่านว่าใช้งานได้จนถึงเช้าอีกวัน
 * repo นี้มี `lib/time.js` อยู่แล้วเพราะเคยเจอบั๊กชนิดเดียวกัน (การผนึก log ปิดผิดวัน
 * อยู่นานโดยไม่มีใครรู้) แต่โค้ดส่วนนี้ไม่เคยถูกย้ายมาใช้
 * ตอนนี้คำนวณเป็นเวลาไทยเสมอ ไม่ว่าเครื่องจะตั้งไทม์โซนอะไร
 */

'use strict';

const BKK_OFFSET_MIN = 7 * 60;   // ไทยไม่มี DST จึงเป็นค่าคงที่ได้

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6,
                 aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** แปลงเวลาไทยตามปฏิทิน เป็น epoch ms — ไม่พึ่งไทม์โซนของเครื่อง */
function bangkokToEpoch(year, month, day, hour, min, sec) {
    const utc = Date.UTC(year, month, day, hour, min, sec);
    const t = utc - BKK_OFFSET_MIN * 60 * 1000;
    // ตรวจว่าวันที่มีอยู่จริง (31 ก.พ. ต้องไม่ผ่าน)
    const back = new Date(utc);
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month || back.getUTCDate() !== day) {
        return null;
    }
    return t;
}

/**
 * อ่านวันหมดอายุจาก comment
 *
 * รองรับรูปแบบที่พนักงานพิมพ์กันจริง: 2026-08-30, 30/08/2026, 30/08/2569 (พ.ศ.),
 * และรูปแบบของ MikroTik เอง (aug/28/2026 14:00)
 * ไม่ระบุเวลา = สิ้นวันตามเวลาไทย (23:59:59) ซึ่งตรงกับที่คนเข้าใจว่า "หมดอายุวันที่ X"
 *
 * @returns {number|null} epoch ms หรือ null ถ้าอ่านไม่ได้
 */
function parseExpiry(comment) {
    if (!comment) return null;
    const str = String(comment).trim();

    // ISO: 2026-08-30 หรือ 2026/08/30
    let m = str.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/);
    if (m) {
        const t = bangkokToEpoch(+m[1], +m[2] - 1, +m[3],
                                 m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, 59);
        if (t !== null) return t;
    }

    // DD/MM/YYYY — รวมปี พ.ศ.
    m = str.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2}))?/);
    if (m) {
        let year = +m[3];
        if (year > 2500) year -= 543;
        const t = bangkokToEpoch(year, +m[2] - 1, +m[1],
                                 m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, 59);
        if (t !== null) return t;
    }

    // แบบ MikroTik: aug/28/2026 14:00 หรือ aug/28
    m = str.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[/ ](\d{1,2})(?:[/ ](\d{4}))?(?:\s+(\d{1,2}):(\d{1,2}))?/i);
    if (m) {
        const year = m[3] ? +m[3] : new Date().getUTCFullYear();
        const t = bangkokToEpoch(year, MONTHS[m[1].toLowerCase()], +m[2],
                                 m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, 59);
        if (t !== null) return t;
    }

    return null;
}

/** คำที่พนักงานเขียนกำกับว่าถูกตัดสัญญาณแล้ว */
const SUSPENDED_WORDS = ['expired', 'หมดอายุ', 'ค้างชำระ', 'ตัดสัญญาณ', 'ระงับ'];

function looksSuspended(comment, disabled) {
    if (disabled === true || disabled === 'true' || disabled === 'yes') return true;
    const c = String(comment || '').toLowerCase();
    return SUSPENDED_WORDS.some((w) => c.includes(w.toLowerCase()));
}

/**
 * จัดสถานะของบัญชีหนึ่งรายการ
 *
 * @param {object} o { name, comment, disabled }
 * @param {number} now epoch ms
 * @param {number} soonDays กี่วันถือว่า "ใกล้หมด"
 */
function classify(o, now, soonDays = 7) {
    const expiry = parseExpiry(o.comment);
    const suspended = looksSuspended(o.comment, o.disabled);

    if (expiry === null) {
        // ไม่ใช่ "ปกติ" และไม่ใช่ "หมดอายุ" — มันคือ "ไม่รู้" ซึ่งเป็นสถานะที่ต้องแก้
        // ปล่อยไว้เท่ากับบัญชีนี้จะไม่โผล่ในรายงานไหนเลยตลอดไป
        return { name: o.name, status: suspended ? 'suspended' : 'no-expiry',
                 expiry: null, daysLeft: null, comment: o.comment || '' };
    }

    const daysLeft = Math.floor((expiry - now) / 86400000);
    let status;
    if (suspended) status = 'suspended';
    else if (expiry <= now) status = 'expired';
    else if (daysLeft <= soonDays) status = 'soon';
    else status = 'active';

    return { name: o.name, status, expiry, daysLeft, comment: o.comment || '' };
}

/**
 * สรุปทั้งสาขา — เรียงตามความเร่งด่วน และแยก "ไม่มีวันหมดอายุ" ออกมาให้เห็น
 */
function summarise(accounts, now, soonDays = 7) {
    const items = (accounts || []).map((a) => classify(a, now, soonDays));
    const order = { expired: 0, soon: 1, 'no-expiry': 2, suspended: 3, active: 4 };
    items.sort((a, b) => (order[a.status] - order[b.status]) ||
                         ((a.daysLeft ?? 9e9) - (b.daysLeft ?? 9e9)));

    const counts = { expired: 0, soon: 0, 'no-expiry': 0, suspended: 0, active: 0 };
    items.forEach((i) => { counts[i.status] += 1; });

    return {
        total: items.length,
        counts,
        items,
        // สิ่งที่ควรทำก่อน — ถ้ามีบัญชีที่ไม่มีวันหมดอายุ นั่นคือรายได้ที่ยังไม่มีใครตามอยู่
        needsAttention: items.filter((i) => i.status === 'expired' || i.status === 'soon' ||
                                            i.status === 'no-expiry')
    };
}

module.exports = { parseExpiry, classify, summarise, looksSuspended,
                   SUSPENDED_WORDS, BKK_OFFSET_MIN };
