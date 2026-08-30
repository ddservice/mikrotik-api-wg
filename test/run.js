#!/usr/bin/env node
/**
 * test/run.js — ตัวรันเทสต์เล็ก ๆ ไม่พึ่ง dependency ภายนอก
 *
 * ทำไมไม่ใช้ jest/vitest: root package.json คือไฟล์ที่ VPS ติดตั้งจาก
 * (`npm install --omit=dev`) กฎของโปรเจกต์คือห้ามให้มันมี build dependency เพิ่ม
 * และ Node มี `node:assert` มาให้อยู่แล้ว งานเท่านี้ไม่คุ้มที่จะเพิ่มเครื่องมือ
 *
 * ใช้: npm test
 */

const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

function describe(name, fn) {
    currentGroup = name;
    console.log('\n' + name);
    fn();
}

function it(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ✓ ' + name);
    } catch (e) {
        failed++;
        failures.push({ group: currentGroup, name, message: e.message });
        console.log('  ✗ ' + name);
        console.log('      ' + String(e.message).split('\n').join('\n      '));
    }
}

global.describe = describe;
global.it = it;

const FILES = [
    'time.test.js',
    'dns-log.test.js',
    'storage-monitor.test.js',
    'pppoe-iface.test.js'
];

console.log('=== ชุดทดสอบ MikroTik Dashboard ===');
FILES.forEach((f) => require(path.join(__dirname, f)));

console.log('\n' + '-'.repeat(60));
if (failed) {
    console.log(`✗ ผ่าน ${passed} ไม่ผ่าน ${failed}`);
    failures.forEach((f) => console.log(`   • [${f.group}] ${f.name}: ${f.message}`));
    process.exit(1);
}
console.log(`✓ ผ่านทั้งหมด ${passed} เทสต์`);
process.exit(0);
