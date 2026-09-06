/**
 * lib/backup-manifest.js — อะไรบ้างที่ต้องอยู่ใน backup และจะรู้ได้ยังไงว่ามันใช้กู้คืนได้จริง
 *
 * ที่มา (2026-09-06): ลองพิสูจน์ว่ากู้คืนได้จริงตามที่แนะนำไว้ แล้วพบว่ากู้ไม่ได้เลย
 *
 *   - `backup.js` อัปโหลดเฉพาะ **ตาราง log 4 ตาราง เป็น CSV**
 *   - `scripts/restore-from-r2.sh` สั่ง `cp "$RESTORE_TMP/"*.json db/` ตามด้วย `|| true`
 *   - ใน R2 ไม่มีไฟล์ `.json` แม้แต่ไฟล์เดียว (ตรวจจริง: 118 ไฟล์ = 44 csv + 73 jsonl.gz + 1 txt)
 *   - glob ไม่ตรงอะไรเลย `|| true` กลืน error แล้วสคริปต์พิมพ์ว่า
 *     "🎉 Disaster Recovery Restore completed successfully!"
 *
 * แปลว่า **การกู้คืนไม่เคยทำงาน และไม่เคยมีทางทำงานได้** และจะรู้ตัวก็วันที่ต้องใช้จริง
 * เป็นความล้มเหลวแบบ "รายงานว่าสำเร็จทั้งที่ไม่ได้ทำอะไร" ชุดเดียวกับที่โปรเจกต์นี้เจอมาหลายรอบ
 * แต่รอบนี้อยู่บนเส้นทางกู้ภัย ซึ่งเป็นที่ที่แย่ที่สุดที่จะมีปัญหาแบบนี้
 *
 * เรื่องที่ใหญ่กว่านั้น: สิ่งที่ backup อยู่คือ log ล้วน ๆ ซึ่ง **กู้คืนแล้วระบบยังทำงานไม่ได้**
 * ตารางที่ทำให้ระบบทำงานได้จริงไม่เคยถูกสำรองเลยสักครั้ง — sites (host/รหัสผ่าน/คีย์ WireGuard),
 * dashboard_users (บัญชีเข้าระบบ), app_settings (token LINE/Telegram, สิทธิ์เมนู)
 */

'use strict';

const crypto = require('crypto');

/**
 * ชุดข้อมูลที่ backup ต้องมี
 *
 * kind: 'config' = สิ่งที่ทำให้ระบบกลับมาทำงานได้ (เล็ก แต่ขาดไม่ได้)
 *       'log'    = ข้อมูลย้อนหลัง (ใหญ่ แต่ระบบทำงานได้โดยไม่มีมัน)
 *
 * critical: ขาดแล้วถือว่า backup ชุดนั้นใช้กู้คืนไม่ได้ ไม่ใช่แค่ไม่ครบ
 */
const PARTS = [
    { key: 'sites',                    kind: 'config', critical: true,
      label: 'ทะเบียนสาขา + ข้อมูลเชื่อมต่อเราท์เตอร์' },
    { key: 'dashboard_users',          kind: 'config', critical: true,
      label: 'บัญชีผู้ใช้ของแดชบอร์ด' },
    { key: 'app_settings',             kind: 'config', critical: true,
      label: 'การตั้งค่าระบบ (LINE, Telegram, สิทธิ์เมนู)' },
    { key: 'archived_hotspot_users',   kind: 'config', critical: false,
      label: 'คูปองที่ถูกลบ (ไว้กู้คืนรายคน)' },
    { key: 'log_archives',             kind: 'config', critical: true,
      label: 'ทะเบียน archive ม.26 พร้อมค่า SHA-256' },
    { key: 'activity_logs',            kind: 'log',    critical: false, label: 'บันทึกการใช้งานระบบ' },
    { key: 'hotspot_logs',             kind: 'log',    critical: false, label: 'log Hotspot' },
    { key: 'pppoe_usage_logs',         kind: 'log',    critical: false, label: 'log การใช้งานห้อง PPPoE' },
    { key: 'dns_query_logs',           kind: 'log',    critical: false, label: 'log DNS (ของเก่าที่ยังอยู่ใน DB)' }
];

/**
 * ฟิลด์ที่เป็นความลับ — ถ้าไม่ได้เปิด BACKUP_INCLUDE_SECRETS จะถูกแทนที่
 *
 * เหตุผลที่ค่าเริ่มต้นคือ "ไม่เอาความลับขึ้น": bucket ที่เก็บ backup เคยมีคีย์เข้าถึง
 * ฝังอยู่ในไฟล์ที่ commit ลง git (scripts/restore-from-r2.sh) ตราบใดที่คีย์ชุดนั้น
 * ยังไม่ถูกเปลี่ยน การเอารหัสผ่านเราท์เตอร์กับ token ขึ้นไปวางไว้ที่นั่นคือการขยายความเสียหาย
 *
 * ข้อแลกเปลี่ยนที่ต้องรู้: backup ที่ไม่มีความลับ กู้คืนแล้วต้องพิมพ์รหัสผ่านเราท์เตอร์
 * และ token ใหม่เอง — โครงสร้างทุกอย่างกลับมาครบ แต่ต่อเราท์เตอร์ไม่ได้จนกว่าจะใส่รหัส
 * **คีย์ WireGuard ส่วนตัวพิมพ์กลับเองไม่ได้** ถ้าจะพึ่ง backup ชุดนี้จริงต้องเปลี่ยนคีย์ R2
 * ก่อน แล้วค่อยเปิด BACKUP_INCLUDE_SECRETS
 */
const SECRET_FIELDS = [
    'password', 'api_password', 'passwordHash', 'password_hash',
    'channelAccessToken', 'channel_access_token', 'botToken', 'bot_token',
    'wireguardPrivateKey', 'wireguard_private_key', 'privateKey', 'private_key',
    'serviceKey', 'service_key'
];

const REDACTED = '__REDACTED__';

/** แทนที่ค่าที่เป็นความลับ แบบลงลึกทุกชั้นของ object */
function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_FIELDS.includes(k) && v ? REDACTED : redact(v);
        }
        return out;
    }
    return value;
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * สร้าง manifest ของ backup หนึ่งชุด
 *
 * manifest คือสิ่งที่ทำให้ "ตรวจสอบได้" ต่างจากการดูว่ามีไฟล์อยู่:
 * มันบอกว่าควรมีอะไรบ้าง แต่ละไฟล์ควรมีกี่แถว และ hash ควรเป็นอะไร
 * ไฟล์ที่ดาวน์โหลดมาแล้วขาดหรือเพี้ยนจึงตรวจเจอได้ก่อนวันที่ต้องใช้จริง
 *
 * @param {object} o  { date, files: [{part, name, rows, buffer}], includesSecrets, backend }
 */
function buildManifest(o) {
    const files = (o.files || []).map((f) => ({
        part: f.part,
        name: f.name,
        rows: f.rows,
        bytes: f.buffer ? f.buffer.length : 0,
        sha256: f.buffer ? sha256(f.buffer) : null
    }));
    return {
        version: 1,
        date: o.date,
        createdAt: new Date().toISOString(),
        backend: o.backend || 'unknown',
        includesSecrets: !!o.includesSecrets,
        // เขียนไว้ในไฟล์เลย เพื่อให้คนที่เปิด backup เจอในอีก 2 ปีรู้ว่าต้องมีอะไรบ้าง
        // โดยไม่ต้องมีซอร์สโค้ดรุ่นนี้อยู่ในมือ
        expectedParts: PARTS.map((p) => ({ key: p.key, kind: p.kind, critical: p.critical, label: p.label })),
        files
    };
}

/**
 * ตรวจว่า backup ชุดที่ดาวน์โหลดมาใช้กู้คืนได้จริงหรือไม่
 *
 * @param {object} manifest  manifest.json ที่อ่านมาได้ (null ถ้าไม่มี)
 * @param {Array}  actual    [{name, buffer}] ไฟล์ที่ดาวน์โหลดมาได้จริง
 * @returns {{ok, restorable, problems, checked, parts}}
 */
function verifyBackup(manifest, actual) {
    const problems = [];
    const got = new Map((actual || []).map((f) => [f.name, f.buffer]));

    if (!manifest) {
        // ยังต้องบอกให้เห็นว่าขาดอะไรบ้าง ไม่ใช่แค่บอกว่าไม่มี manifest
        // คนที่รันคำสั่งนี้กำลังถามว่า "กู้คืนได้ไหม" ไม่ได้ถามว่า "ไฟล์ครบไหม"
        return {
            ok: false, restorable: false, checked: 0,
            parts: PARTS.map((p) => ({ ...p, present: false })),
            problems: ['ไม่มี manifest.json ในชุดนี้ — เป็น backup รุ่นเก่าที่ตรวจสอบความครบถ้วนไม่ได้ ' +
                       'และไม่มีตารางตั้งค่า (sites / dashboard_users / app_settings) อยู่ในนั้นเลย']
        };
    }

    let checked = 0;
    for (const f of manifest.files || []) {
        const buf = got.get(f.name);
        if (!buf) { problems.push('ขาดไฟล์ ' + f.name); continue; }
        checked += 1;
        if (f.sha256 && sha256(buf) !== f.sha256) {
            problems.push('ไฟล์ ' + f.name + ' เพี้ยน — SHA-256 ไม่ตรงกับตอนสำรอง');
        }
        if (buf.length === 0 && f.bytes > 0) problems.push('ไฟล์ ' + f.name + ' ว่างเปล่า');
    }

    const partsPresent = new Set((manifest.files || []).map((f) => f.part));
    const parts = PARTS.map((p) => ({ ...p, present: partsPresent.has(p.key) }));
    parts.filter((p) => p.critical && !p.present).forEach((p) => {
        problems.push('ขาดข้อมูลที่ขาดไม่ได้: ' + p.label + ' (' + p.key + ')');
    });

    // ขาดตารางตั้งค่า = กู้คืนแล้วระบบยังทำงานไม่ได้ ต่อให้ log ครบทุกแถว
    const restorable = !parts.some((p) => p.critical && !p.present) &&
                       !problems.some((m) => m.includes('เพี้ยน') || m.startsWith('ขาดไฟล์'));

    return { ok: problems.length === 0, restorable, problems, checked, parts };
}

module.exports = { PARTS, SECRET_FIELDS, REDACTED, redact, sha256, buildManifest, verifyBackup };
