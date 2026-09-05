/**
 * เทสต์ lib/script-env.js — ตัวโหลดคีย์ Supabase/R2 ให้สคริปต์ใน scripts/
 *
 * ที่มา: 2026-08-28 production ตกไปใช้ Local JSON เงียบ ๆ นานหลายสัปดาห์ เพราะ
 * ecosystem.config.js ยังเป็นค่า placeholder (`YOUR_PROJECT_ID`) แล้วโค้ดโหลดมาใช้
 * โดยไม่ตรวจ ผลคือ DNS log ไม่ถูกบันทึกเลยตลอดช่วงนั้น — เป็นช่องว่างของหลักฐาน ม.26
 * ที่ย้อนไปเก็บไม่ได้
 *
 * โมดูลนี้จึงมีหน้าที่เดียวที่ต้องไม่พลาด: **ห้ามให้ค่า placeholder หลุดเข้า env**
 */

const assert = require('assert');
const { loadScriptEnv, usingSupabase, PLACEHOLDER } = require('../lib/script-env');

// เก็บ env เดิมไว้คืนหลังเทสต์ — เทสต์ตัวนี้แก้ process.env จริง
const KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'R2_ACCESS_KEY_ID'];
const saved = {};
KEYS.forEach((k) => { saved[k] = process.env[k]; });

function restore() {
    KEYS.forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    });
}

describe('lib/script-env — จับค่า placeholder', () => {
    it('รูปแบบ placeholder ที่เคยหลุดขึ้น production จริง ต้องถูกจับได้ทุกตัว', () => {
        assert.ok(PLACEHOLDER.test('https://YOUR_PROJECT_ID.supabase.co'));
        assert.ok(PLACEHOLDER.test('YOUR_SERVICE_ROLE_KEY'));
        assert.ok(PLACEHOLDER.test('YOUR_ANYTHING_AT_ALL'));
    });

    it('ค่าจริงต้องไม่ถูกมองว่าเป็น placeholder', () => {
        assert.ok(!PLACEHOLDER.test('https://abcdefghijkl.supabase.co'));
        assert.ok(!PLACEHOLDER.test('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx'));
        // คำว่า your ตัวเล็กในค่าจริงต้องไม่ทำให้เข้าใจผิด (regex เป็น case-sensitive)
        assert.ok(!PLACEHOLDER.test('https://your-real-project.supabase.co'));
    });
});

describe('lib/script-env — usingSupabase', () => {
    it('ไม่ได้ตั้ง SUPABASE_URL = ไม่ได้ใช้ Supabase', () => {
        delete process.env.SUPABASE_URL;
        assert.strictEqual(usingSupabase(), false);
    });

    it('ตั้งเป็น placeholder = ยังถือว่าไม่ได้ใช้ Supabase (นี่คือบั๊กปี 2026-08-28)', () => {
        process.env.SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
        assert.strictEqual(usingSupabase(), false,
            'ถ้าอันนี้คืน true ระบบจะคิดว่าต่อ Supabase อยู่ทั้งที่จริงเขียนลง JSON');
    });

    it('ตั้งค่าจริง = ใช้ Supabase', () => {
        process.env.SUPABASE_URL = 'https://realproject.supabase.co';
        assert.strictEqual(usingSupabase(), true);
    });

    it('ค่าว่างเปล่า = ไม่ได้ใช้', () => {
        process.env.SUPABASE_URL = '';
        assert.strictEqual(usingSupabase(), false);
    });
});

describe('lib/script-env — loadScriptEnv', () => {
    it('ตั้งค่าจริงมาแล้ว = ไม่ไปอ่านไฟล์ทับ (สั่งรันด้วย env ของตัวเองได้)', () => {
        process.env.SUPABASE_URL = 'https://mine.supabase.co';
        const loaded = loadScriptEnv();
        assert.strictEqual(loaded, false);
        assert.strictEqual(process.env.SUPABASE_URL, 'https://mine.supabase.co',
            'ค่าที่ผู้ใช้ตั้งเองต้องไม่ถูกเขียนทับ');
    });

    it('ค่าที่ตั้งไว้เป็น placeholder = ไม่นับว่าตั้งแล้ว ต้องพยายามอ่านไฟล์', () => {
        process.env.SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
        loadScriptEnv();

        // จงใจไม่ยืนยันค่าที่ "โหลดได้/ไม่ได้" เพราะ ecosystem.config.js เป็นไฟล์ gitignored
        // ที่แต่ละเครื่องมีเนื้อหาต่างกัน (เครื่อง dev เครื่องนี้มีคีย์ R2 จริงอยู่ด้วย)
        // เทสต์ที่ผูกกับเนื้อหาไฟล์นั้นจะผ่านบ้างไม่ผ่านบ้างแล้วแต่เครื่อง
        //
        // สิ่งที่ต้องจริงเสมอไม่ว่าไฟล์จะมีอะไรคือ: ไม่มีค่า placeholder หลุดเข้า env
        ['SUPABASE_SERVICE_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT']
            .forEach((k) => {
                if (process.env[k]) {
                    assert.ok(!PLACEHOLDER.test(process.env[k]),
                        k + ' ถูกโหลดมาทั้งที่เป็นค่า placeholder — นี่คือบั๊กปี 2026-08-28');
                }
            });
    });

    it('ไม่โยน error เมื่อไม่มี ecosystem.config.js (เครื่อง dev ปกติ)', () => {
        delete process.env.SUPABASE_URL;
        assert.doesNotThrow(() => loadScriptEnv({ match: /^ไม่มีคีย์ชื่อนี้แน่นอน/ }));
    });

    it('จำกัดคีย์ที่โหลดด้วย match ได้', () => {
        delete process.env.SUPABASE_URL;
        assert.doesNotThrow(() => loadScriptEnv({ match: /^R2_/ }));
    });
});

process.on('exit', restore);
