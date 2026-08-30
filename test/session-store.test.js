/**
 * เทสต์ lib/session-store.js
 *
 * สิ่งที่ต้องมั่นใจ:
 *   1. ไฟล์ที่เขียนลงดิสก์ต้องไม่มี token ที่เอาไปใช้ล็อกอินได้
 *   2. ไฟล์เสียหายต้องไม่ทำให้ server สตาร์ตไม่ขึ้น — session หายแค่ต้องล็อกอินใหม่
 *      แต่ server ที่ขึ้นไม่ได้คือระบบล่มทั้งระบบ
 *   3. session ที่หมดอายุต้องไม่ถูกกู้กลับมา
 */

const assert = require('assert');
const st = require('../lib/session-store');

const HOUR = 3600000;
const user = { id: 'u1', username: 'admin', role: 'admin' };

function mapOf(entries) {
    return new Map(entries);
}

describe('lib/session-store — hashToken', () => {
    it('ค่าเดิมให้ผลเดิมเสมอ', () => {
        assert.strictEqual(st.hashToken('abc'), st.hashToken('abc'));
    });
    it('ค่าต่างกันให้ผลต่างกัน', () => {
        assert.notStrictEqual(st.hashToken('abc'), st.hashToken('abd'));
    });
    it('ได้ sha256 hex 64 ตัว', () => {
        assert.match(st.hashToken('abc'), /^[0-9a-f]{64}$/);
    });
    it('ผลลัพธ์ต้องไม่มี token ต้นฉบับอยู่ในนั้น', () => {
        const token = 'super-secret-token-value';
        assert.ok(!st.hashToken(token).includes(token));
    });
});

describe('lib/session-store — serialize', () => {
    const now = 1000000;

    it('เขียนเฉพาะ session ที่ยังไม่หมดอายุ', () => {
        const m = mapOf([
            ['h1', { user, expires: now + HOUR }],
            ['h2', { user, expires: now - HOUR }]      // หมดอายุแล้ว
        ]);
        const parsed = JSON.parse(st.serialize(m, now));
        assert.strictEqual(parsed.sessions.length, 1);
        assert.strictEqual(parsed.sessions[0].k, 'h1');
    });

    it('ไฟล์ที่ได้ต้องไม่มี token จริง มีแต่ค่าแฮช', () => {
        const token = 'aaaabbbbccccdddd';
        const m = mapOf([[st.hashToken(token), { user, expires: now + HOUR }]]);
        const raw = st.serialize(m, now);
        assert.ok(!raw.includes(token), 'ต้องไม่พบ token ต้นฉบับในไฟล์');
        assert.ok(raw.includes(st.hashToken(token)), 'ต้องพบค่าแฮช');
    });

    it('ข้าม entry ที่รูปแบบไม่ถูกต้องแทนที่จะพัง', () => {
        const m = mapOf([
            ['h1', { user, expires: now + HOUR }],
            ['h2', null],
            ['h3', { user }],                          // ไม่มี expires
            ['h4', { user, expires: 'ไม่ใช่ตัวเลข' }]
        ]);
        const parsed = JSON.parse(st.serialize(m, now));
        assert.strictEqual(parsed.sessions.length, 1);
    });

    it('Map ว่างได้ JSON ที่อ่านกลับได้', () => {
        const parsed = JSON.parse(st.serialize(new Map(), now));
        assert.deepStrictEqual(parsed.sessions, []);
    });
});

describe('lib/session-store — deserialize', () => {
    const now = 1000000;

    it('อ่านกลับได้ครบและใช้งานต่อได้', () => {
        const m = mapOf([['h1', { user, expires: now + HOUR }]]);
        const back = st.deserialize(st.serialize(m, now), now);
        assert.strictEqual(back.size, 1);
        assert.strictEqual(back.get('h1').user.username, 'admin');
        assert.strictEqual(back.get('h1').expires, now + HOUR);
    });

    it('ไม่กู้ session ที่หมดอายุระหว่างที่ server ดับอยู่', () => {
        const raw = st.serialize(mapOf([['h1', { user, expires: now + HOUR }]]), now);
        const back = st.deserialize(raw, now + 2 * HOUR);   // ผ่านไป 2 ชม.
        assert.strictEqual(back.size, 0);
    });

    // ข้อสำคัญที่สุด: ไฟล์พังต้องไม่ทำให้ server สตาร์ตไม่ขึ้น
    it('ไฟล์เสียหายทุกแบบต้องไม่โยน error', () => {
        ['', 'ไม่ใช่ json', '{', '[]', 'null', '{"sessions":"ไม่ใช่ array"}',
         '{"sessions":[null,123,"x"]}', '{"version":99}'].forEach((raw) => {
            assert.doesNotThrow(() => st.deserialize(raw, now), 'พังกับ: ' + raw);
            assert.ok(st.deserialize(raw, now) instanceof Map);
        });
    });

    it('ค่า null/undefined ได้ Map ว่าง', () => {
        assert.strictEqual(st.deserialize(null, now).size, 0);
        assert.strictEqual(st.deserialize(undefined, now).size, 0);
    });

    it('ข้าม entry ที่ไม่มี user หรือคีย์ไม่ใช่สตริง', () => {
        const raw = JSON.stringify({ sessions: [
            { k: 'ok', u: user, e: now + HOUR },
            { k: 'ไม่มี user', e: now + HOUR },
            { k: 123, u: user, e: now + HOUR }
        ] });
        assert.strictEqual(st.deserialize(raw, now).size, 1);
    });
});

describe('lib/session-store — prune', () => {
    const now = 1000000;

    it('ลบเฉพาะที่หมดอายุ', () => {
        const m = mapOf([
            ['a', { user, expires: now + HOUR }],
            ['b', { user, expires: now - 1 }],
            ['c', { user, expires: now - HOUR }]
        ]);
        assert.strictEqual(st.prune(m, now), 2);
        assert.strictEqual(m.size, 1);
        assert.ok(m.has('a'));
    });

    it('ลบ entry ที่รูปแบบเสียด้วย', () => {
        const m = mapOf([['a', null], ['b', { user }]]);
        assert.strictEqual(st.prune(m, now), 2);
        assert.strictEqual(m.size, 0);
    });

    it('Map ที่ทุกอันยังใช้ได้ ไม่ลบอะไรเลย', () => {
        const m = mapOf([['a', { user, expires: now + HOUR }]]);
        assert.strictEqual(st.prune(m, now), 0);
        assert.strictEqual(m.size, 1);
    });
});

describe('lib/session-store — วนครบรอบ (เขียน -> อ่าน)', () => {
    it('token เดิมยังเข้าได้หลังรีสตาร์ต แต่ token อื่นเข้าไม่ได้', () => {
        const now = 1000000;
        const token = 'e3b0c44298fc1c149afbf4c8996fb924';
        const sessions = new Map();
        sessions.set(st.hashToken(token), { user, expires: now + HOUR });

        // จำลอง: เขียนตอนปิด -> อ่านตอนเปิดใหม่
        const restored = st.deserialize(st.serialize(sessions, now), now);

        assert.ok(restored.has(st.hashToken(token)), 'token เดิมต้องยังใช้ได้');
        assert.ok(!restored.has(st.hashToken('token-ปลอม')), 'token อื่นต้องเข้าไม่ได้');
        assert.strictEqual(restored.get(st.hashToken(token)).user.role, 'admin');
    });
});
