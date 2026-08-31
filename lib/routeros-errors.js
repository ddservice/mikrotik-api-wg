/**
 * lib/routeros-errors.js — แปลข้อความ error ดิบของ RouterOS เป็นสิ่งที่แก้ได้จริง
 *
 * ที่มา: กด "อัปเกรด 1 คลิก" แล้วขึ้น "not enough permissions (9)" ซึ่งเป็นข้อความ
 * ที่ RouterOS ส่งมาตรง ๆ คนอ่านแล้วไม่รู้ว่าต้องไปทำอะไรต่อ — ไม่รู้ว่าเป็นสิทธิ์ของ
 * ผู้ใช้คนไหน ขาดสิทธิ์อะไร และต้องไปแก้ที่ไหน
 *
 * ตรวจจริงเมื่อ 2026-08-31: API user `ddserviceapi` อยู่ในกลุ่มที่จำกัดสิทธิ์
 * ทำให้ขาด `reboot` (อัปเกรดต้องรีบูต) และ `test` (คำสั่งที่ต้องออกไปติดต่อเครือข่าย)
 *
 * วิธีพิสูจน์ว่าขาด test ไม่ใช่ policy: บนสาขาที่พัง คำสั่งกลุ่ม read ใช้ได้ปกติ
 * แต่ทั้ง /ping และ check-for-updates พังด้วยข้อความเดียวกัน ซึ่ง /ping ผูกกับ
 * สิทธิ์ test โดยตรง — เป็นการชี้จากพฤติกรรมจริง ไม่ใช่เดาจากชื่อสิทธิ์
 *
 * หลักการ: ข้อความ error ที่ดีต้องบอกสามอย่าง — เกิดอะไรขึ้น, ทำไม, และต้องทำอะไรต่อ
 * ข้อความดิบของอุปกรณ์มักบอกแค่อย่างแรก
 */

'use strict';

/** สิทธิ์ที่แต่ละงานต้องใช้ ใช้ประกอบข้อความแนะนำ */
const POLICY_HINTS = {
    upgrade: {
        need: ['write', 'reboot', 'test'],
        what: 'อัปเกรด RouterOS / เฟิร์มแวร์',
        why: 'การอัปเกรดจะรีบูตเราท์เตอร์เอง (ต้องมี reboot) และการเช็คเวอร์ชันใหม่' +
             'ต้องออกไปติดต่อเซิร์ฟเวอร์ของ MikroTik ซึ่งนับเป็นคำสั่งกลุ่ม test'
    },
    // ping / bandwidth-test / traceroute อยู่ในกลุ่มเดียวกันหมด
    // พิสูจน์แล้ว 2026-08-31: /ping กับ check-for-updates พังด้วยข้อความเดียวกัน
    // บนสาขาที่ไม่มี test ขณะที่คำสั่งกลุ่ม read ใช้ได้ปกติ
    nettest: {
        need: ['test'],
        what: 'ทดสอบ Ping / คุณภาพสาย',
        why: 'RouterOS จัดคำสั่งทดสอบเครือข่ายไว้ในสิทธิ์ test'
    },
    reboot: {
        need: ['reboot'],
        what: 'สั่งรีบูตเราท์เตอร์',
        why: 'เป็นคำสั่งที่ทำให้เราท์เตอร์เริ่มระบบใหม่'
    },
    backup: {
        need: ['write', 'sensitive'],
        what: 'สำรองค่าเราท์เตอร์',
        why: 'ไฟล์สำรองมีข้อมูลที่ถือว่าละเอียดอ่อน'
    },
    multiwan: {
        need: ['write', 'policy'],
        what: 'ตั้งค่า Multi-WAN',
        why: 'ต้องแก้ตารางเส้นทาง firewall mangle และ NAT ซึ่งนับเป็นการแก้ค่าระบบ'
    },
    user: {
        need: ['write', 'policy'],
        what: 'แก้ไขผู้ใช้บนเราท์เตอร์',
        why: 'การแก้ผู้ใช้/สิทธิ์ต้องมี policy'
    }
};

const PERMISSION_RE = /not enough permissions|permission denied|\(9\)/i;

/**
 * แปลง error ให้อ่านแล้วแก้ได้
 *
 * @param {Error|string} err
 * @param {object} [opts]
 * @param {string} [opts.task]     คีย์ใน POLICY_HINTS
 * @param {string} [opts.username] ชื่อผู้ใช้ API ที่ใช้อยู่
 * @param {string} [opts.siteName]
 * @returns {string}
 */
function explain(err, opts = {}) {
    const raw = String((err && err.message) || err || '').trim();
    if (!raw) return 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';

    if (PERMISSION_RE.test(raw)) {
        const hint = POLICY_HINTS[opts.task] || null;
        const who = opts.username ? `"${opts.username}"` : 'ที่ใช้เชื่อมต่อ';
        const where = opts.siteName ? ` ของสาขา ${opts.siteName}` : '';

        const lines = [
            `เราท์เตอร์ปฏิเสธคำสั่งเพราะผู้ใช้ API ${who}${where} มีสิทธิ์ไม่พอ`
        ];
        if (hint) {
            lines.push(`งานนี้ (${hint.what}) ต้องการสิทธิ์: ${hint.need.join(', ')} — ${hint.why}`);
        }
        lines.push(
            'วิธีแก้: เปิด WinBox ด้วยบัญชีผู้ดูแล ไปที่ System → Users → Groups ' +
            `แล้วเพิ่มสิทธิ์ที่ขาดให้กลุ่มของผู้ใช้ ${who} ` +
            '(หรือย้ายผู้ใช้ไปกลุ่มที่มีสิทธิ์ครบ)'
        );
        lines.push(`ข้อความจากเราท์เตอร์: ${raw}`);
        return lines.join('\n');
    }

    if (/invalid user name or password/i.test(raw)) {
        return 'ชื่อผู้ใช้หรือรหัสผ่านของ API ไม่ถูกต้อง — แก้ได้ที่หน้าตั้งค่า → สาขา\n' +
               `ข้อความจากเราท์เตอร์: ${raw}`;
    }

    if (/timeout|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/i.test(raw)) {
        return 'ติดต่อเราท์เตอร์ไม่ได้ — ใช้ปุ่ม "วินิจฉัยการเชื่อมต่อ" เพื่อดูว่าติดชั้นไหน\n' +
               `รายละเอียด: ${raw}`;
    }

    return raw;
}

/** true ถ้า error นี้เกิดจากสิทธิ์ไม่พอ */
function isPermissionError(err) {
    return PERMISSION_RE.test(String((err && err.message) || err || ''));
}

module.exports = { explain, isPermissionError, POLICY_HINTS };
