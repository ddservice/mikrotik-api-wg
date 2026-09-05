/**
 * scripts/smoke-routes.js — บูต server จริงแล้วยิงทุก route ดูว่ายังมีอยู่
 *
 * ที่มา: 2026-09-05 การแก้ไฟล์ด้วยสคริปต์ลบ route ไป 70 ตัวแล้ว deploy ขึ้น production
 * โดยไม่มีอะไรจับได้ ตอนนั้นมี scripts/check-routes.js ตามมาแก้ ซึ่งอ่าน "ข้อความ" ในไฟล์
 * ตัวนี้ต่างออกไป: มันบูตแอปขึ้นมาจริงแล้วถามผ่าน HTTP ว่า route นั้นตอบไหม
 *
 * ทำไมต้องมีทั้งสองอย่าง — check-routes อ่านว่า "โค้ดเขียนไว้" แต่ตัวนี้ตอบว่า
 * "ลงทะเบียนสำเร็จตอนรันจริง" ซึ่งไม่เหมือนกัน route ที่อยู่ในบล็อกที่โยน error
 * ตอนบูต หรือถูกบังด้วย middleware ที่ตอบไปก่อน จะผ่านตัวแรกแต่ตกตัวนี้
 *
 * **สำคัญ: รายชื่อ route ต้องมาจากไฟล์ manifest ที่ commit ไว้ ไม่ใช่จาก server.js**
 * เวอร์ชันแรกของสคริปต์นี้ดึงรายชื่อจาก server.js เองแล้วเช็คว่า route เหล่านั้นตอบไหม
 * ซึ่งเป็นการวนกลับมาถามตัวเอง — พอลองกับคอมมิตที่พังจริง (e42ee7f ที่เหลือ 45 route)
 * มัน "ผ่าน" สบาย ๆ เพราะ 45 ตัวที่เหลือก็ตอบครบ 45 ตัว ตรวจไม่เจอสิ่งที่หายไปเลย
 * ตัวเทียบต้องอยู่นอกไฟล์ที่กำลังตรวจเสมอ
 *
 * วิธีตรวจ: ยิงแบบ "ไม่ล็อกอิน" ทุก route ใน manifest
 *   - route ที่ต้องล็อกอิน ต้องตอบ 401/403  = มีอยู่
 *   - 404 = หายไป  <-- นี่คือสิ่งที่ตามหา
 * จึงไม่แตะฐานข้อมูล ไม่ต่อเราท์เตอร์ และไม่ต้องมี token
 *
 * ควรรันบนเครื่อง dev ไม่ใช่บน VPS — การบูต server จะรัน syncAllWireguardPeersOnStartup
 * ซึ่งบน VPS จะไปแตะ wg0 จริง
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 3199);
const SERVER = path.join(__dirname, '..', 'server.js');

// route สาธารณะที่มีผลข้างเคียง — ตรวจว่ามีอยู่จากตัวไฟล์ก็พอ ไม่ต้องยิงจริง
// (webhook อาจไปตอบกลับ LINE, callback-register แตะ wg0)
const SKIP_CALL = new Set([
    'POST /api/line/webhook',
    'POST /api/wireguard/callback-register'
]);

const MANIFEST = path.join(__dirname, '..', 'test', 'routes.manifest.json');

/** route ที่ "ต้องมี" — อ่านจากไฟล์ที่ commit ไว้ ไม่ใช่จาก server.js ที่กำลังตรวจ */
function expectedRoutes() {
    const data = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return (data.routes || []).map((line) => {
        const sp = line.indexOf(' ');
        return { method: line.slice(0, sp), routePath: line.slice(sp + 1) };
    });
}

/** route ที่เขียนอยู่ใน server.js จริง ๆ — ใช้เตือนว่ามีของใหม่ที่ยังไม่ได้ใส่ manifest */
function routesInSource(src) {
    const out = new Set();
    const re = /^app\.(get|post|put|patch|delete)\('([^']+)'/gm;
    let m;
    while ((m = re.exec(src))) out.add(m[1].toUpperCase() + ' ' + m[2]);
    return out;
}

/** แทนค่า :param ด้วยค่าสมมติ เพื่อให้ path จริงยิงได้ */
function concretePath(p) {
    return p.replace(/:[A-Za-z0-9_]+/g, 'smoke-test-value');
}

function request(method, p) {
    return new Promise((resolve) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: p, method, timeout: 15000 },
            (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            }
        );
        req.on('timeout', () => { req.destroy(); resolve(0); });
        req.on('error', () => resolve(0));
        if (method !== 'GET' && method !== 'DELETE') req.setHeader('Content-Type', 'application/json');
        req.end(method === 'GET' || method === 'DELETE' ? undefined : '{}');
    });
}

async function waitReady(child, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (child.exitCode !== null) return false;
        const code = await request('GET', '/health');
        if (code === 200) return true;
        await new Promise((r) => setTimeout(r, 400));
    }
    return false;
}

(async () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    const routes = expectedRoutes();
    if (!routes.length) {
        console.error('✗ manifest ว่าง — ' + MANIFEST);
        process.exit(1);
    }

    // route ใหม่ที่ยังไม่ได้ใส่ manifest = เตือน ไม่ใช่ error (คนเพิ่มของใหม่ตามปกติ)
    const inSource = routesInSource(src);
    const notInManifest = [...inSource].filter((k) => !routes.some((r) => r.method + ' ' + r.routePath === k));
    if (notInManifest.length) {
        console.log('  (มี route ใหม่ที่ยังไม่ได้ใส่ manifest ' + notInManifest.length + ' ตัว — ' + notInManifest.join(', ') + ')');
    }

    console.log(`กำลังบูต server ที่พอร์ต ${PORT} เพื่อยิง ${routes.length} route...`);
    const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let bootLog = '';
    child.stdout.on('data', (d) => { bootLog += d; });
    child.stderr.on('data', (d) => { bootLog += d; });

    const stop = () => { try { child.kill(); } catch (_) {} };
    process.on('exit', stop);

    if (!(await waitReady(child))) {
        console.error('✗ server บูตไม่ขึ้นภายในเวลาที่กำหนด\n');
        console.error(bootLog.slice(-2000));
        stop();
        process.exit(1);
    }

    const missing = [];
    const unreachable = [];
    let checked = 0;

    for (const r of routes) {
        const key = `${r.method} ${r.routePath}`;
        if (SKIP_CALL.has(key)) continue;

        const code = await request(r.method, concretePath(r.routePath));
        checked++;
        if (code === 404) missing.push(key);   // อยู่ใน manifest แต่ระบบไม่รู้จัก = หายไป
        else if (code === 0) unreachable.push(key);
    }

    stop();

    if (missing.length || unreachable.length) {
        console.error(`\n✗ smoke test ไม่ผ่าน (ยิงไป ${checked} route)\n`);
        missing.forEach((k) => console.error(`    • 404 ไม่มี route นี้: ${k}`));
        unreachable.forEach((k) => console.error(`    • ต่อไม่ได้/หมดเวลา: ${k}`));
        process.exit(1);
    }

    console.log(`✓ smoke test ผ่าน — ${checked} route ตอบครบ ไม่มีตัวไหนคืน 404`);
    process.exit(0);
})();
