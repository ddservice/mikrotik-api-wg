/**
 * เทสต์ scripts/check-secrets.js
 *
 * กติกาของ repo นี้: guard ที่ยังไม่เคยถูกพิสูจน์ว่า fail กับความผิดจริง ไม่ใช่ guard
 * (เขียนไว้ตอน check-routes เมื่อ 2026-09-05) เทสต์นี้จึงต้องพิสูจน์ทั้งสองทาง —
 * เจอความลับจริง และไม่เตือน placeholder
 *
 * รันสคริปต์จริงในไดเรกทอรี git ชั่วคราว เพราะตัวสคริปต์อ่านจาก `git ls-files`
 * การ mock นั้นจะทำให้เทสต์ผ่านได้โดยที่ของจริงพัง
 */

const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-secrets.js');

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t.co && git config user.name t', { cwd: dir });
    return dir;
}

function commit(dir, name, content) {
    fs.writeFileSync(path.join(dir, name), content);
    execSync('git add -A', { cwd: dir });
}

// รันสคริปต์โดยหลอก ROOT ให้ชี้ไป repo ชั่วคราว
function run(dir) {
    try {
        const out = execSync('node "' + SCRIPT + '"', { cwd: dir, encoding: 'utf8' });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
}

describe('check-secrets — ต้อง fail กับความลับจริง', () => {
    it('เจอ JWT service key ในไฟล์ที่ track', () => {
        const dir = makeRepo();
        commit(dir, 'config.js',
            "const k = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnopqrstuvwxyz012345.sig';");
        const r = run(dir);
        assert.strictEqual(r.code, 1, 'ต้อง exit 1');
        assert.ok(/JWT|service key/i.test(r.out));
    });

    it('เจอ PEM private key', () => {
        const dir = makeRepo();
        commit(dir, 'key.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----');
        assert.strictEqual(run(dir).code, 1);
    });

    it('เจอคีย์ R2 ตัวที่เคยหลุดจริง', () => {
        const dir = makeRepo();
        commit(dir, 'backup.js', "const id = '78059e3268d79b09600de14776ad345a';");
        assert.strictEqual(run(dir).code, 1);
    });
});

describe('check-secrets — ต้องไม่เตือนของที่ไม่ใช่ความลับ', () => {
    it('placeholder ในไฟล์ template ต้องผ่าน', () => {
        const dir = makeRepo();
        commit(dir, 'ecosystem.example.js',
            "// SUPABASE_SERVICE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.YOUR_SERVICE_ROLE_KEY',");
        const r = run(dir);
        assert.strictEqual(r.code, 0, r.out);
    });

    it('โค้ดปกติที่พูดถึงชื่อตัวแปรเฉย ๆ ต้องผ่าน', () => {
        const dir = makeRepo();
        commit(dir, 'db.js',
            "const key = process.env.SUPABASE_SERVICE_KEY;\nif (!key) throw new Error('missing');");
        assert.strictEqual(run(dir).code, 0);
    });

    it('ไฟล์ที่ไม่ได้ track (แค่มีอยู่ในโฟลเดอร์) ต้องไม่ถูกตรวจ', () => {
        const dir = makeRepo();
        commit(dir, 'ok.js', 'const a = 1;');
        // ไฟล์นี้มีคีย์จริงแต่ไม่ได้ git add — เหมือน ecosystem.config.js บน VPS
        fs.writeFileSync(path.join(dir, 'secret.local.js'),
            "const k = 'eyJhbGciOiJIUzI1NiJ9.realkeyrealkeyrealkeyrealkey12345.sig';");
        const r = run(dir);
        assert.strictEqual(r.code, 0, 'ไฟล์ที่ไม่ track ต้องไม่ทำให้ fail: ' + r.out);
    });

    it('repo สะอาดผ่านและบอกจำนวนไฟล์', () => {
        const dir = makeRepo();
        commit(dir, 'a.js', 'const x = 1;');
        commit(dir, 'b.md', '# hello');
        const r = run(dir);
        assert.strictEqual(r.code, 0);
        assert.ok(/ไม่พบความลับ/.test(r.out));
    });
});
