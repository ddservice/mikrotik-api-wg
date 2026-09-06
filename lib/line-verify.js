/**
 * lib/line-verify.js — ตรวจว่า webhook ที่เข้ามาส่งมาจาก LINE จริง
 *
 * ที่มา (2026-09-06): `POST /api/line/webhook` เป็น endpoint สาธารณะ (ต้องเป็น เพราะ
 * เซิร์ฟเวอร์ของ LINE เป็นคนเรียก) และ **ไม่เคยตรวจลายเซ็นเลย** ใครก็ตามที่รู้ URL
 * จึงยิง event ปลอมเข้ามาได้ ที่ผ่านมาความเสียหายจำกัด — ปลอมได้แค่ผูกบัญชี LINE
 * กับชื่อผู้ใช้ใดก็ได้ แล้วอ่านเวลาคงเหลือของบัญชีนั้น (รหัสผ่านไม่เคยถูกส่งออกไป)
 *
 * แต่พอ webhook เริ่ม**สร้างรายการทางการเงิน** (แจ้งชำระด้วยสลิป) การตรวจลายเซ็น
 * กลายเป็นเรื่องบังคับ ไม่ใช่เรื่องน่าจะมี
 *
 * วิธีของ LINE: HMAC-SHA256 ของ **raw body** ด้วย channel secret แล้วเข้ารหัส base64
 * เทียบกับเฮดเดอร์ `x-line-signature`
 *
 * ต้องใช้ raw body ไม่ใช่ JSON ที่ parse แล้ว — `JSON.stringify(req.body)` ให้ผลต่างจาก
 * ไบต์ที่ LINE ส่งมาจริง (ลำดับคีย์ ช่องว่าง ยูนิโค้ด) แล้วลายเซ็นจะไม่มีวันตรงเลย
 */

'use strict';

const crypto = require('crypto');

/**
 * @param {Buffer|string} rawBody  ไบต์ดิบของ request body
 * @param {string} signature       ค่าจากเฮดเดอร์ x-line-signature
 * @param {string} channelSecret   channel secret ของ LINE
 * @returns {boolean}
 */
function verifySignature(rawBody, signature, channelSecret) {
    if (!channelSecret || !signature || rawBody === undefined || rawBody === null) return false;

    const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    const expected = crypto.createHmac('sha256', channelSecret).update(buf).digest('base64');

    // เทียบแบบเวลาคงที่ — การเทียบสตริงธรรมดาหลุดเร็วขึ้นเมื่อไบต์แรกไม่ตรง
    // ซึ่งเปิดทางให้เดาลายเซ็นทีละไบต์จากเวลาที่ใช้ตอบ
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signature), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/** สร้างลายเซ็นแบบเดียวกับที่ LINE ส่งมา — ใช้ในเทสต์เท่านั้น */
function signBody(rawBody, channelSecret) {
    const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    return crypto.createHmac('sha256', channelSecret).update(buf).digest('base64');
}

module.exports = { verifySignature, signBody };
