/**
 * scripts/check-routes.js — กันไม่ให้ route หายไปเงียบ ๆ
 *
 * ที่มา: 2026-09-05 การแก้ server.js ด้วยสคริปต์ที่ตัดข้อความด้วย index ลบ route ไป
 * 70 ตัวจาก 115 (server.js เหลือ 3,181 บรรทัดจาก 5,509) แล้ว commit + deploy ขึ้น
 * production ทำให้ทุกหน้าขึ้น "Cannot GET /api/..." — และไม่มีอะไรจับได้เลย:
 *
 *   - `node -c` ผ่าน เพราะไฟล์ที่มี route น้อยลงก็ยังถูกไวยากรณ์
 *   - `npm test` ไม่แตะ server.js เลย (require แล้วมันเปิด listener)
 *   - endpoint ที่ไล่เช็คหลังแก้ คือ 4 ตัวที่เพิ่งเขียนใหม่ ซึ่งอยู่ต้นไฟล์ทั้งหมด
 *
 * บทเรียน: หลังแก้ไฟล์ด้วยสคริปต์ ต้องตรวจ "คุณสมบัติของทั้งไฟล์" ไม่ใช่แค่จุดที่แก้
 * สำหรับ server.js คุณสมบัตินั้นคือรายชื่อ route
 *
 * ตัวเลขด้านล่างเป็นขั้นต่ำ ไม่ใช่ค่าตายตัว — เพิ่ม route ใหม่ได้โดยไม่ต้องแก้อะไร
 * แต่ถ้าหายไปจะ fail ทันที ถ้าตั้งใจลบ route จริง ๆ ให้ลดตัวเลขนี้พร้อมกับ commit นั้น
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');

// จำนวน route ณ ตอนที่กู้คืนสำเร็จ (115 เดิม + app.get('/') ที่เพิ่มใหม่)
const MIN_ROUTES = 116;

// route ที่ถ้าหายแปลว่าหน้าเว็บใช้งานไม่ได้เลย — ทั้งหมดนี้เคยหายไปจริงในเหตุการณ์นั้น
const MUST_HAVE = [
    "app.get('/api/sites'",
    "app.get('/api/users'",
    "app.get('/api/mikrotik/status'",
    "app.get('/api/mikrotik/interfaces'",
    "app.get('/api/mikrotik/hotspot/users'",
    "app.get('/api/mikrotik/hotspot/active'",
    "app.get('/api/mikrotik/pppoe/users'",
    "app.get('/api/mikrotik/pppoe/active'",
    "app.get('/api/mikrotik/firewall/status'",
    "app.get('/api/dns-logs'",
    "app.get('/api/hotspot-logs'",
    "app.get('/health'"
];

const src = fs.readFileSync(SERVER, 'utf8');
const routes = src.match(/^app\.(get|post|put|patch|delete)\('[^']+'/gm) || [];

const problems = [];

if (routes.length < MIN_ROUTES) {
    problems.push(`มี route ${routes.length} ตัว น้อยกว่าขั้นต่ำ ${MIN_ROUTES} — น่าจะมีอะไรถูกลบไป`);
}

for (const r of MUST_HAVE) {
    if (!src.includes(r)) problems.push(`หา route สำคัญไม่เจอ: ${r}`);
}

// route ซ้ำ = ตัวหลังไม่มีวันถูกเรียก มักเกิดตอน copy/paste หรือแก้อัตโนมัติผิด
const seen = new Map();
for (const r of routes) seen.set(r, (seen.get(r) || 0) + 1);
for (const [r, n] of seen) if (n > 1) problems.push(`route ซ้ำ ${n} ครั้ง: ${r}`);

if (problems.length) {
    console.error('✗ server.js มีปัญหา:\n');
    problems.forEach((p) => console.error('    • ' + p));
    console.error(`\n  ไฟล์: ${routes.length} route, ${src.split('\n').length} บรรทัด`);
    process.exit(1);
}

console.log(`✓ server.js — ${routes.length} route, ครบทุกตัวที่จำเป็น, ไม่มีตัวซ้ำ`);
