/**
 * lib/router-backup.js — เก็บคอนฟิกเราท์เตอร์ออกมาไว้นอกตัวเราท์เตอร์
 *
 * ทำไมต้องมี: ปุ่ม "สำรองคอนฟิก" เดิมสั่ง /system/backup/save ซึ่งสร้างไฟล์ไว้
 * **บนตัวเราท์เตอร์เอง** ถ้าเราท์เตอร์พัง ถูกขโมย หรือโดนรีเซ็ต ไฟล์สำรองก็หายไปด้วย
 * นั่นไม่ใช่การสำรองข้อมูล แต่เป็นความรู้สึกปลอดภัยที่ไม่มีของจริงรองรับ
 *
 * ตัวนี้ดึง `/export` ออกมาเป็นข้อความ ซึ่งดีกว่าไฟล์ .backup สำหรับงานกู้คืนจริง:
 *   - อ่านได้ด้วยตา รู้ว่าเปลี่ยนอะไรไปบ้างเมื่อเทียบกับเมื่อวาน
 *   - เอาไปวางลงเราท์เตอร์ตัวใหม่ได้เลย ไม่ผูกกับรุ่น/เวอร์ชันเหมือนไฟล์ .backup
 *   - เป็นข้อความ จึงบีบอัดได้ดีและตรวจ SHA-256 ได้เหมือนไฟล์ปิดผนึก ม.26
 *
 * หลักที่ยึด: **ห้ามบันทึกว่าสำรองสำเร็จ ถ้าไม่ได้เนื้อคอนฟิกมาจริง**
 * การมีไฟล์สำรองที่ว่างเปล่าแย่กว่าไม่มีไฟล์ เพราะจะรู้ตอนที่ต้องใช้กู้เท่านั้น
 */

'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

/**
 * RouterOS ตอบ /export ต่างกันไปตามเวอร์ชันและไลบรารี — บางทีมาเป็นหลาย sentence
 * บางทีมาก้อนเดียวในฟิลด์ ret จึงรวบทุกค่าที่เป็นข้อความออกมาแทนที่จะยึดรูปแบบเดียว
 */
function parseExport(rows) {
    if (typeof rows === 'string') return rows;
    if (!Array.isArray(rows)) return '';

    const parts = [];
    rows.forEach((r) => {
        if (typeof r === 'string') { parts.push(r); return; }
        if (!r || typeof r !== 'object') return;
        // ฟิลด์ที่ RouterOS ใช้ส่งเนื้อ export กลับมา
        ['ret', 'section', 'message', 'data'].forEach((k) => {
            if (typeof r[k] === 'string' && r[k]) parts.push(r[k]);
        });
    });
    return parts.join('\n');
}

/**
 * ตรวจว่าที่ได้มาเป็นคอนฟิกจริง ไม่ใช่ข้อความว่างหรือ error
 *
 * เกณฑ์ตั้งจากรูปร่างของ export จริง: ต้องยาวพอ และต้องมีคำสั่งที่ขึ้นต้นด้วย /
 * อย่างน้อยไม่กี่บรรทัด เราท์เตอร์ที่ตั้งค่าน้อยที่สุดก็ยังมี /interface กับ /ip
 */
function looksLikeConfig(text) {
    const s = String(text || '');
    if (s.trim().length < 200) {
        return { ok: false, reason: 'เนื้อหาสั้นผิดปกติ (' + s.trim().length + ' ตัวอักษร) — น่าจะไม่ได้คอนฟิกมาจริง' };
    }
    const commandLines = s.split('\n').filter((l) => /^\s*\//.test(l)).length;
    if (commandLines < 3) {
        return { ok: false, reason: 'ไม่พบคำสั่งคอนฟิก (เจอ ' + commandLines + ' บรรทัด) — น่าจะเป็นข้อความ error' };
    }
    return { ok: true, commandLines };
}

/**
 * เตรียมไฟล์สำรองหนึ่งชุด: บีบอัด + คำนวณ SHA-256
 *
 * hash คิดจากไฟล์ .gz ที่จะถูกเก็บจริง ไม่ใช่จากข้อความก่อนบีบอัด — ผู้รับจึงตรวจ
 * ได้ด้วย `sha256sum <file>` ตรง ๆ โดยไม่ต้องคลายไฟล์ก่อน (หลักเดียวกับไฟล์ปิดผนึก)
 */
function buildBackup(siteName, text, opts = {}) {
    const check = looksLikeConfig(text);
    if (!check.ok) throw new Error('คอนฟิกที่อ่านมาไม่สมบูรณ์: ' + check.reason);

    const at = opts.now instanceof Date ? opts.now : new Date();
    const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const safeSite = String(siteName || 'site').replace(/[^A-Za-z0-9_.-]/g, '_');

    const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
    return {
        fileName: `${safeSite}-${stamp}.rsc.gz`,
        buffer: gz,
        sha256: crypto.createHash('sha256').update(gz).digest('hex'),
        sizeBytes: gz.length,
        rawBytes: Buffer.byteLength(text, 'utf8'),
        commandLines: check.commandLines,
        createdAt: at.toISOString()
    };
}

/**
 * เทียบกับชุดก่อนหน้าว่าคอนฟิกเปลี่ยนไปไหม
 * ใช้ตัดสินว่าจะเก็บชุดใหม่หรือข้าม — เราท์เตอร์ที่ไม่มีใครแตะไม่ควรกินที่วันละไฟล์
 */
function hasChanged(previousSha256, current) {
    return !previousSha256 || previousSha256 !== current.sha256;
}

module.exports = { parseExport, looksLikeConfig, buildBackup, hasChanged };
