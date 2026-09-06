#!/usr/bin/env node
/**
 * scripts/verify-backup.js — พิสูจน์ว่า backup ที่มีอยู่ "กู้คืนได้จริง" ไม่ใช่แค่ "มีไฟล์อยู่"
 *
 *   npm run verify-backup            ตรวจชุดล่าสุด
 *   npm run verify-backup 2026-09-05 ตรวจชุดของวันนั้น
 *   npm run verify-backup -- --list  ดูว่ามีชุดไหนบ้าง
 *   npm run verify-backup -- --out D:\somewhere   ดาวน์โหลดเก็บไว้ด้วย
 *
 * อ่านอย่างเดียว ไม่เขียนอะไรลงฐานข้อมูล ไม่แตะเราท์เตอร์ ไม่ลบไฟล์บน R2
 *
 * ที่มา (2026-09-06): ลองพิสูจน์การกู้คืนตามที่แนะนำไว้ แล้วพบว่า
 * `restore-from-r2.sh` คัดลอก `*.json` จากโฟลเดอร์ที่มีแต่ `.csv` โดยมี `|| true`
 * ปิดท้าย จึงพิมพ์ว่า "🎉 completed successfully" ทั้งที่ไม่ได้กู้อะไรเลย
 * เครื่องมือตัวนี้จึงมีกติกาข้อเดียว: **ห้ามบอกว่าผ่าน ถ้ายังไม่ได้ตรวจของจริง**
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadScriptEnv } = require('../lib/script-env');
const mf = require('../lib/backup-manifest');

loadScriptEnv();
const r2 = require('../lib/r2');

const PREFIX = (process.env.R2_SITE_NAME || 'Mikrotikapi-db') + '/';
const args = process.argv.slice(2);
const wantList = args.includes('--list') || args.includes('-l');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

function fail(msg) {
    console.error('\n✗ ' + msg);
    process.exit(1);
}

async function main() {
    if (!r2.isConfigured()) {
        fail('ยังไม่ได้ตั้งค่า R2 (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT) — ' +
             'ตรวจไม่ได้ว่ามีสำเนานอกเครื่องอยู่จริงหรือไม่');
    }

    const objects = await r2.listObjects(PREFIX);
    if (!objects.length) fail('ไม่พบไฟล์ใด ๆ ใน R2 ที่ ' + PREFIX + ' — ไม่มีสำเนานอกเครื่องเลย');

    // โฟลเดอร์รายวันของ backup ฐานข้อมูล (log-archives เป็นคนละเรื่อง ไม่นับที่นี่)
    const days = [...new Set(objects
        .map((o) => (o.key.slice(PREFIX.length).match(/^(\d{4}-\d{2}-\d{2})\//) || [])[1])
        .filter(Boolean))].sort();

    if (wantList) {
        console.log('ชุด backup ที่มีใน R2: ' + days.length + ' ชุด');
        days.slice(-14).forEach((d) => {
            const n = objects.filter((o) => o.key.includes('/' + d + '/')).length;
            console.log('  ' + d + '  (' + n + ' ไฟล์)');
        });
        if (days.length > 14) console.log('  … และก่อนหน้านั้นอีก ' + (days.length - 14) + ' ชุด');
        return;
    }

    if (!days.length) fail('ไม่พบโฟลเดอร์ backup รายวันเลย');
    const target = dateArg || days[days.length - 1];
    if (!days.includes(target)) fail('ไม่มี backup ของวันที่ ' + target + ' (ล่าสุดคือ ' + days[days.length - 1] + ')');

    const keys = objects.filter((o) => o.key.includes('/' + target + '/'));
    console.log('ตรวจ backup ชุดวันที่ ' + target + ' — ' + keys.length + ' ไฟล์\n');

    // ดาวน์โหลดของจริง แล้วคำนวณ hash จากไบต์ที่ได้มา
    // การเชื่อค่าที่บันทึกไว้โดยไม่อ่านไฟล์จริง ทำให้การตรวจไม่มีความหมาย
    const downloaded = [];
    for (const o of keys) {
        const name = o.key.split('/').pop();
        process.stdout.write('  ดาวน์โหลด ' + name + ' … ');
        const buf = await r2.getObject(o.key);
        downloaded.push({ name, buffer: buf });
        console.log(buf.length.toLocaleString() + ' bytes');
        if (outDir) {
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, name), buf);
        }
    }

    let manifest = null;
    const mFile = downloaded.find((f) => f.name === 'manifest.json');
    if (mFile) {
        try { manifest = JSON.parse(mFile.buffer.toString('utf8')); }
        catch (e) { console.error('  manifest.json อ่านไม่ออก: ' + e.message); }
    }

    const v = mf.verifyBackup(manifest, downloaded);

    console.log('\nสิ่งที่ต้องมีใน backup:');
    v.parts.forEach((p) => {
        const mark = p.present ? '✓' : (p.critical ? '✗' : '·');
        console.log('  ' + mark + ' ' + (p.critical ? '[ขาดไม่ได้] ' : '            ') + p.label);
    });

    if (manifest) {
        console.log('\nรายละเอียดชุดนี้: backend=' + manifest.backend +
                    ' · รวมความลับ=' + (manifest.includesSecrets ? 'ใช่' : 'ไม่') +
                    ' · ตรวจ hash แล้ว ' + v.checked + '/' + (manifest.files || []).length + ' ไฟล์');
    }

    if (v.problems.length) {
        console.log('\nปัญหาที่พบ:');
        v.problems.forEach((p) => console.log('  - ' + p));
    }

    if (outDir) console.log('\nไฟล์ถูกเก็บไว้ที่ ' + outDir);

    if (!v.restorable) {
        fail('backup ชุดนี้ **กู้คืนระบบให้กลับมาทำงานไม่ได้** — ' +
             'ดูรายการข้างบนว่าขาดอะไร');
    }
    console.log('\n✓ backup ชุดวันที่ ' + target + ' ครบและตรวจสอบแล้วว่าใช้กู้คืนได้');
}

main().catch((e) => fail(e.message));
