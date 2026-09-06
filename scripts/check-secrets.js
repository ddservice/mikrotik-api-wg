#!/usr/bin/env node
/**
 * scripts/check-secrets.js — กันความลับหลุดเข้า git ก่อนจะสาย
 *
 * ที่มา: repo นี้ commit ความลับลงไปแล้ว **สองครั้ง** —
 *   2026-07-30  db/config.json (รหัสผ่านเราท์เตอร์) + db/users.json (hash รหัส)
 *   2026-09-06  คีย์ Cloudflare R2 ใน backup.js / restore-from-r2.sh / setup-r2-backup.sh
 *               ซึ่งหนักเป็นพิเศษเพราะ repo เป็น public
 *
 * ทุกครั้งที่โปรเจกต์นี้เจอปัญหาจะเพิ่ม guard ที่ตรวจ invariant ของทั้งไฟล์ไว้
 * (validate-html, check-db-parity, check-routes, verify-backup) แต่ยังไม่เคยมีตัวกัน
 * ความลับ ทั้งที่เป็นความผิดพลาดที่เกิดซ้ำที่สุดและเสียหายมากที่สุด ตัวนี้คืออันนั้น
 *
 * ตรวจเฉพาะไฟล์ที่ **git ติดตามอยู่** (ผ่าน `git ls-files`) เพราะนั่นคือสิ่งเดียวที่
 * หลุดขึ้น GitHub ได้ ไฟล์ที่ gitignore ไว้ (ecosystem.config.js, db/*.json, slips/)
 * มีความลับจริงได้ตามปกติ และต้องไม่ทำให้ guard นี้ fail
 *
 * อ่านอย่างเดียว ไม่แก้ไฟล์ ไม่แตะ git
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ยึด git repo ของไดเรกทอรีที่รันอยู่ (process.cwd()) ไม่ใช่ที่ตั้งไฟล์ตายตัว —
// ไม่งั้นสคริปต์จะสแกน repo จริงเสมอ และเทสต์ (ที่รันในไดเรกทอรีชั่วคราว) จะไร้ความหมาย
// ทุกคำสั่ง git ต้องส่ง cwd ตัวนี้เข้าไป — ถ้าปล่อยให้ inherit บน Windows ที่ cwd เป็น
// UNC path (ไดรฟ์ที่ map ไว้) cmd.exe จะ chdir ไม่ได้และ git พังทั้งหมด
const GIT_CWD = process.cwd();
let ROOT;
try {
    ROOT = execSync('git rev-parse --show-toplevel', { cwd: GIT_CWD, encoding: 'utf8' }).trim();
} catch (e) {
    ROOT = path.join(__dirname, '..');
}

// รูปแบบความลับที่เคยหลุดจริง หรือหลุดแล้วเสียหายหนัก
// แต่ละอันมีเหตุผลว่าทำไมถึงเป็นความลับ ไม่ใช่แค่ "ดูเหมือน key"
const PATTERNS = [
    { name: 'คีย์ R2 access key ที่เคยหลุด',
      re: /78059e3268d79b09600de14776ad345a/, hard: true },
    { name: 'คีย์ R2 secret ที่เคยหลุด',
      re: /d2f634ec540b296b0fb6323254aee1e6b59788d9ea9702318cf8603f344c0d64/, hard: true },
    { name: 'Supabase/JWT service key (ขึ้นต้น eyJ ยาว)',
      re: /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/, hard: true },
    { name: 'AWS/R2 secret access key (40 ตัวอักษร base64)',
      re: /aws_secret|secret[_-]?access[_-]?key\s*[:=]\s*['"][A-Za-z0-9/+]{40}['"]/i, hard: true },
    { name: 'PEM private key',
      re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, hard: true },
    { name: 'Slack bot token', re: /xoxb-[0-9]{6,}-[0-9A-Za-z-]{6,}/, hard: true },
    { name: 'OpenAI/ผู้ให้บริการ API key (sk-...)', re: /\bsk-[A-Za-z0-9]{32,}/, hard: true },
    { name: 'LINE Channel Access Token (ยาวผิดปกติในซอร์ส)',
      re: /channelAccessToken\s*[:=]\s*['"][A-Za-z0-9+/=]{100,}['"]/, hard: true }
];

// ไฟล์ที่ยกเว้น: ตัว guard เอง (มีสตริงคีย์เก่าไว้ตรวจ) และ change log ที่บันทึกเหตุการณ์
const ALLOW = new Set([
    'scripts/check-secrets.js',
    'test/check-secrets.test.js',
    'CLAUDE.md'   // change log พูดถึงคีย์ที่เคยหลุด (เป็นสตริงบางส่วน ไม่ใช่คีย์เต็ม)
]);

// นามสกุลไฟล์ไบนารีที่ข้าม — คีย์ไม่ได้อยู่ในนั้น และอ่านมาเทียบ regex เปลืองเปล่า
const SKIP_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf|zip|gz|mp4|lock)$/i;

function trackedFiles() {
    const out = execSync('git ls-files', { cwd: GIT_CWD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function main() {
    let files;
    try {
        files = trackedFiles();
    } catch (e) {
        console.error('อ่านรายการไฟล์จาก git ไม่ได้:', e.message);
        process.exit(2);
    }

    const findings = [];
    for (const rel of files) {
        if (ALLOW.has(rel) || SKIP_EXT.test(rel)) continue;
        const full = path.join(ROOT, rel);
        let text;
        try {
            const buf = fs.readFileSync(full);
            if (buf.includes(0)) continue;   // ไบนารีที่นามสกุลไม่บอก
            text = buf.toString('utf8');
        } catch (e) {
            continue;   // ไฟล์หายระหว่างสแกน (git ls-files แต่ถูกลบ) ไม่ใช่เรื่องของ guard นี้
        }
        for (const p of PATTERNS) {
            const m = text.match(p.re);
            if (m) {
                // ค่าตัวอย่างที่จงใจใส่ในไฟล์ template ไม่ใช่ความลับจริง
                if (/YOUR_|EXAMPLE|PLACEHOLDER|xxxx|<[A-Za-z]/.test(m[0])) continue;
                const line = text.slice(0, m.index).split('\n').length;
                findings.push({ file: rel, line, name: p.name });
            }
        }
    }

    if (findings.length) {
        console.error('✗ พบความลับในไฟล์ที่ git ติดตามอยู่ — ห้าม commit:\n');
        findings.forEach((f) => console.error('  ' + f.file + ':' + f.line + '  — ' + f.name));
        console.error('\nไฟล์ที่ git ติดตามจะหลุดขึ้น GitHub ได้ (repo นี้เคยเป็น public)');
        console.error('ถ้าเป็นความลับจริง: ย้ายค่าไป env / ecosystem.config.js (gitignore ไว้)');
        console.error('แล้ว **หมุนค่านั้นเสมอ** — ถอดออกจากไฟล์ไม่ได้ทำให้ค่าที่หลุดไปแล้วปลอดภัยขึ้น');
        process.exit(1);
    }

    console.log('✓ ไม่พบความลับในไฟล์ที่ git ติดตาม (' + files.length + ' ไฟล์)');
}

main();
