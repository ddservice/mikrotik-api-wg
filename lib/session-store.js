/**
 * lib/session-store.js — ทำให้ session อยู่รอดข้ามการรีสตาร์ต
 *
 * ปัญหาที่แก้: activeSessions เป็น Map ในหน่วยความจำล้วน ทุกครั้งที่ deploy
 * (`pm2 reload`) ผู้ใช้ทุกคนหลุดออกจากระบบพร้อมกัน เป็นงานค้างที่ CLAUDE.md
 * ระบุไว้นานแล้ว และเป็นเหตุผลที่คนไม่อยากให้ deploy ตอนกลางวัน
 *
 * ทำไมเลือกวิธี "เก็บ Map ลงไฟล์" แทน token แบบเซ็นลายเซ็น (JWT-like):
 * ระบบเดิมมีพฤติกรรมที่ต้องรักษาไว้หลายอย่าง — ต่ออายุทุกครั้งที่ใช้งาน,
 * logout แล้วใช้ต่อไม่ได้ทันที, และการแก้/ลบบัญชีต้องเตะ session ของคนนั้นออก
 * ทั้งหมด token ไร้สถานะทำสองข้อหลังไม่ได้ถ้าไม่เพิ่มคอลัมน์ในฐานข้อมูล
 * และการแตะระบบ auth ยิ่งเปลี่ยนน้อยยิ่งดี
 *
 * เก็บเป็น "ค่าแฮชของ token" ไม่ใช่ token ตรง ๆ — ไฟล์นี้อยู่ในเครื่องเดียวกับ
 * db/config.json ที่มีรหัสเราท์เตอร์อยู่แล้ว แต่ถ้าไฟล์หลุด อย่างน้อยต้องเอาไป
 * ใช้ล็อกอินต่อไม่ได้ (แฮชทางเดียว) ซึ่งดีกว่าเก็บ bearer token ที่ใช้ได้จริง
 */

'use strict';

const crypto = require('crypto');

/** แฮชทางเดียว ใช้เป็นคีย์แทน token จริง */
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * แปลง Map เป็นรูปแบบที่เขียนลงไฟล์ได้ — ตัด session ที่หมดอายุแล้วทิ้งไปเลย
 * ไม่ต้องเขียนของที่โหลดกลับมาแล้วก็ใช้ไม่ได้
 */
function serialize(sessions, now = Date.now()) {
    const out = [];
    for (const [key, s] of sessions.entries()) {
        if (!s || typeof s.expires !== 'number' || s.expires <= now) continue;
        out.push({ k: key, u: s.user, e: s.expires });
    }
    return JSON.stringify({ version: 1, savedAt: new Date(now).toISOString(), sessions: out });
}

/**
 * อ่านกลับเป็น Map — ทิ้งของที่หมดอายุและของที่รูปแบบไม่ถูกต้อง
 *
 * ต้องไม่โยน error ไม่ว่าไฟล์จะเสียหายแค่ไหน: session ที่หายไปแค่ทำให้ต้อง
 * ล็อกอินใหม่ ส่วน server ที่สตาร์ตไม่ขึ้นเพราะไฟล์เสียคือระบบล่มทั้งระบบ
 */
function deserialize(raw, now = Date.now()) {
    const map = new Map();
    if (!raw) return map;

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        return map;
    }

    const list = (parsed && Array.isArray(parsed.sessions)) ? parsed.sessions : [];
    for (const item of list) {
        if (!item || typeof item.k !== 'string' || !item.u) continue;
        if (typeof item.e !== 'number' || item.e <= now) continue;
        map.set(item.k, { user: item.u, expires: item.e });
    }
    return map;
}

/** ลบ session ที่หมดอายุออกจาก Map คืนจำนวนที่ลบ */
function prune(sessions, now = Date.now()) {
    let removed = 0;
    for (const [key, s] of sessions.entries()) {
        if (!s || typeof s.expires !== 'number' || s.expires <= now) {
            sessions.delete(key);
            removed++;
        }
    }
    return removed;
}

module.exports = { hashToken, serialize, deserialize, prune };
