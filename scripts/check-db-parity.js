#!/usr/bin/env node
/**
 * check-db-parity.js — เช็คว่า db.js (Local JSON fallback) กับ db-supabase.js
 * (production) ยัง export ฟังก์ชันชุดเดียวกันและรับพารามิเตอร์จำนวนเท่ากันอยู่
 *
 * ทำไมต้องมี: CLAUDE.md ระบุว่าทุกฟังก์ชันต้องมีครบทั้งสองไฟล์ด้วย signature
 * และ return shape เดียวกัน แต่ production รันบน Supabase อย่างเดียว เวลาเพิ่ม
 * ฟังก์ชันใหม่จึงมักแก้แค่ db-supabase.js แล้ว db.js ค่อย ๆ drift ตามไม่ทัน
 * โดยไม่มีอะไรเตือน (ไม่มี test suite)
 *
 * ตรวจให้ 3 อย่าง:
 *   1. ฟังก์ชันที่มีอยู่ไฟล์เดียว (export ขาด)
 *   2. จำนวนพารามิเตอร์ไม่ตรงกัน — สัญญาณว่ามีคนเพิ่ม arg เช่น siteId ข้างเดียว
 *   3. ฝั่ง Supabase เป็น async แต่ฝั่ง JSON เป็น sync — อันนี้ "ปกติโดยดีไซน์"
 *      (server.js ใช้ await ครอบทั้งคู่) จึงรายงานเป็น INFO ไม่นับเป็น error
 *
 * ใช้: node scripts/check-db-parity.js   (หรือ npm run check-db-parity)
 * exit 0 = ผ่าน, exit 1 = เจอ export ขาด หรือ จำนวน arg ไม่ตรง
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_DB = path.join(ROOT, 'db.js');
const SUPABASE_DB = path.join(ROOT, 'db-supabase.js');

// ดึงชื่อที่ถูก export จาก object literal ของ module.exports
// รองรับทั้ง { a, b } (shorthand, db.js) และ { a: a, b: b } (db-supabase.js)
function exportedNames(source, file) {
    const m = /module\.exports\s*=\s*\{([\s\S]*?)\n\};?/.exec(source);
    if (!m) throw new Error(`หา module.exports object literal ใน ${file} ไม่เจอ`);
    const names = new Set();
    m[1].split(',').forEach((tok) => {
        const t = tok.replace(/\/\/[^\n]*/g, '').trim();
        if (!t) return;
        const shorthand = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
        const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_][A-Za-z0-9_]*$/.exec(t);
        if (shorthand) names.add(shorthand[1]);
        else if (pair) names.add(pair[1]);
    });
    return names;
}

// อ่าน signature ของ `function name(args)` แบบ top-level
function signatures(source) {
    const sigs = new Map();
    const re = /^(async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;
    let m;
    while ((m = re.exec(source)) !== null) {
        const [, isAsync, name, rawArgs] = m;
        const args = rawArgs
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean);
        sigs.set(name, { async: !!isAsync, argc: args.length, args });
    }
    return sigs;
}

const jsonSrc = fs.readFileSync(JSON_DB, 'utf8');
const supaSrc = fs.readFileSync(SUPABASE_DB, 'utf8');

const jsonExports = exportedNames(jsonSrc, 'db.js');
const supaExports = exportedNames(supaSrc, 'db-supabase.js');
const jsonSigs = signatures(jsonSrc);
const supaSigs = signatures(supaSrc);

const errors = [];
const info = [];
let asyncMismatch = 0;

const missingFromSupabase = [...jsonExports].filter((n) => !supaExports.has(n)).sort();
const missingFromJson = [...supaExports].filter((n) => !jsonExports.has(n)).sort();

missingFromSupabase.forEach((n) => {
    errors.push(`${n}() — มีใน db.js แต่ไม่มีใน db-supabase.js (production จะพังถ้ามีคนเรียก)`);
});
missingFromJson.forEach((n) => {
    errors.push(`${n}() — มีใน db-supabase.js แต่ไม่มีใน db.js (โหมด Local JSON จะพัง)`);
});

const shared = [...jsonExports].filter((n) => supaExports.has(n)).sort();
shared.forEach((name) => {
    const a = jsonSigs.get(name);
    const b = supaSigs.get(name);
    if (!a || !b) return; // อาจเป็น arrow function / const — ข้ามไป ไม่เดา
    if (a.argc !== b.argc) {
        errors.push(
            `${name}() — จำนวนพารามิเตอร์ไม่ตรงกัน: db.js รับ ${a.argc} ` +
            `(${a.args.join(', ') || '-'}) แต่ db-supabase.js รับ ${b.argc} ` +
            `(${b.args.join(', ') || '-'})`
        );
    }
    if (a.async !== b.async) asyncMismatch++;
});

// db.js เป็น sync ทั้งไฟล์ / db-supabase.js เป็น async ทั้งไฟล์ = ดีไซน์ของโปรเจกต์นี้
// ไม่ต้องรายงานทีละตัว รายงานแค่ตอนที่มันไม่สม่ำเสมอ (แปลว่ามีอะไรผิดปกติ)
if (asyncMismatch && asyncMismatch !== shared.length) {
    info.push(
        `${asyncMismatch}/${shared.length} ฟังก์ชัน sync/async ไม่ตรงกัน — ` +
        `ปกติควรเป็น 0 (เหมือนกันหมด) หรือ ${shared.length} (JSON sync ทั้งไฟล์, ` +
        `Supabase async ทั้งไฟล์) ตัวเลขกลาง ๆ แปลว่ามีฟังก์ชันที่หลุดแพตเทิร์น`
    );
} else if (asyncMismatch) {
    info.push(
        `db.js เป็น sync ทั้ง ${shared.length} ฟังก์ชัน / db-supabase.js เป็น async ทั้งหมด ` +
        `— ปกติโดยดีไซน์ call site ต้องมี await ครอบเสมอ`
    );
}

// เช็คบั๊กแบบ 2026-08-13 (6): เรียก .then/.catch/.finally ตรง ๆ บน db.xxx()
// ใน Supabase mode ได้ Promise จริงเลยผ่าน แต่ใน Local JSON ได้ object ธรรมดา
// -> "db.getPppoeUsageLogs(...).catch is not a function"
const serverPath = path.join(ROOT, 'server.js');
if (fs.existsSync(serverPath)) {
    const serverSrc = fs.readFileSync(serverPath, 'utf8');
    const lines = serverSrc.split('\n');
    lines.forEach((line, i) => {
        const m = /(?<!Promise\.resolve\()\bdb\.([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\.\s*(then|catch|finally)\b/.exec(line);
        if (!m) return;
        // ถ้าบรรทัดนั้นมี Promise.resolve( ครอบอยู่แล้วก็ปลอดภัย
        if (/Promise\.resolve\s*\(\s*db\./.test(line)) return;
        errors.push(
            `server.js:${i + 1} — เรียก .${m[2]}() ตรง ๆ บน db.${m[1]}() ` +
            `ซึ่งใน db.js (Local JSON) เป็น sync คืนค่าธรรมดา ไม่ใช่ Promise ` +
            `ให้ครอบด้วย Promise.resolve(db.${m[1]}(...)) หรือใช้ await`
        );
    });
}

console.log(
    `db.js: ${jsonExports.size} exports | db-supabase.js: ${supaExports.size} exports | ` +
    `ตรงกัน ${shared.length}`
);

if (info.length) {
    console.log(`\nINFO (ไม่ใช่ error):`);
    info.forEach((i) => console.log(`    • ${i}`));
}

if (errors.length) {
    console.error(`\n✗ เจอ ${errors.length} ปัญหา parity:`);
    errors.forEach((e) => console.error(`    • ${e}`));
    process.exit(1);
}

console.log('\n✓ db.js กับ db-supabase.js parity ครบ');
