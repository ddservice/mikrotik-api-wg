#!/usr/bin/env node
/**
 * test/run.js — ตัวรันเทสต์เล็ก ๆ ไม่พึ่ง dependency ภายนอก
 *
 * ทำไมไม่ใช้ jest/vitest: root package.json คือไฟล์ที่ VPS ติดตั้งจาก
 * (`npm install --omit=dev`) กฎของโปรเจกต์คือห้ามให้มันมี build dependency เพิ่ม
 * และ Node มี `node:assert` มาให้อยู่แล้ว งานเท่านี้ไม่คุ้มที่จะเพิ่มเครื่องมือ
 *
 * รองรับเทสต์ที่เป็น async ด้วย — บางส่วนของระบบอ่านไฟล์แบบสตรีมเพื่อไม่ให้กิน
 * หน่วยความจำ จึงต้องเป็น async โดยธรรมชาติ วิธีทำคือเก็บเทสต์เข้าคิวตอน require
 * แล้วค่อยรันเรียงกันทีหลัง ผลลัพธ์จึงยังออกมาเรียงตามกลุ่มเหมือนเดิม
 *
 * ใช้: npm test
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

const queue = [];

function describe(name, fn) {
    queue.push({ type: 'group', name });
    currentGroup = name;
    fn();
}

function it(name, fn) {
    queue.push({ type: 'test', group: currentGroup, name, fn });
}

global.describe = describe;
global.it = it;

// สแกนไฟล์เทสต์เอง ไม่ใช้รายชื่อตายตัว
//
// เดิมเป็นรายชื่อ hardcode ผลคือเพิ่มไฟล์เทสต์ใหม่แล้วมันถูกข้ามเงียบ ๆ
// จำนวนเทสต์ยังขึ้นเท่าเดิม ดูผ่านหมดทุกอย่าง ทั้งที่ของใหม่ไม่ได้ถูกรันเลย —
// เป็นความล้มเหลวแบบเดียวกับที่เจอมาแล้วหลายรอบในโปรเจกต์นี้ คือสิ่งที่ควรทำงาน
// แต่ไม่มีใครตรวจว่ามันทำงานจริง
const FILES = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

if (FILES.length === 0) {
    console.error('ไม่พบไฟล์เทสต์เลย — น่าจะผิดปกติ');
    process.exit(1);
}

console.log('=== ชุดทดสอบ MikroTik Dashboard ===');
console.log(`พบไฟล์เทสต์ ${FILES.length} ไฟล์`);
FILES.forEach((f) => require(path.join(__dirname, f)));

(async () => {
    for (const item of queue) {
        if (item.type === 'group') {
            console.log('\n' + item.name);
            continue;
        }
        try {
            await item.fn();          // ใช้ได้ทั้งกับเทสต์ sync และ async
            passed++;
            console.log('  ✓ ' + item.name);
        } catch (e) {
            failed++;
            failures.push({ group: item.group, name: item.name, message: e.message });
            console.log('  ✗ ' + item.name);
            console.log('      ' + String(e.message).split('\n').join('\n      '));
        }
    }

    console.log('\n' + '-'.repeat(60));
    if (failed) {
        console.log(`✗ ผ่าน ${passed} ไม่ผ่าน ${failed}`);
        failures.forEach((f) => console.log(`   • [${f.group}] ${f.name}: ${f.message}`));
        process.exit(1);
    }
    console.log(`✓ ผ่านทั้งหมด ${passed} เทสต์`);
    process.exit(0);
})();
