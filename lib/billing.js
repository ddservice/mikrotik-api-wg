/**
 * lib/billing.js — รอบบิลค่าเช่าห้อง: คิดวันครบกำหนดใหม่ และสรุปยอด
 *
 * ทำไมต้องมีตารางแยก ทั้งที่วันครบกำหนดอยู่บนเราท์เตอร์อยู่แล้ว
 * ---------------------------------------------------------------
 * จนถึง 2026-09-06 วันครบกำหนดของทุกห้องอยู่ในช่อง `comment` ของ `/ppp/secret`
 * ซึ่งแปลว่า:
 *   - พิมพ์ผิดหรือลืมใส่ = ห้องนั้นหายไปจากรายงานเงียบ ๆ ไม่มีใครตามเก็บเงิน
 *   - เราท์เตอร์ถูก reset หรือเปลี่ยนเครื่อง = วันครบกำหนดของทุกห้องหายพร้อมกัน
 *   - ตอบไม่ได้เลยว่าเดือนนี้เก็บได้เท่าไหร่ ใครยังค้าง เพราะไม่มีที่ไหนบันทึกการชำระ
 *
 * ตารางเป็นแหล่งความจริง แต่ **ยังเขียน comment กลับลงเราท์เตอร์เหมือนเดิม**
 * เหตุผลสองข้อ: ของเดิมทั้งหมดยังทำงานต่อได้โดยไม่ต้องแก้ และคนที่เปิด WinBox
 * ดูก็ยังเห็นวันครบกำหนดตรงที่เคยเห็น — ไม่บังคับให้ทุกคนเปลี่ยนวิธีทำงานพร้อมกัน
 *
 * โมดูลนี้ไม่แตะฐานข้อมูลและไม่แตะเราท์เตอร์ — คำนวณล้วน ๆ เพื่อให้เทสต์ได้
 */

'use strict';

const BKK_OFFSET_MIN = 7 * 60;

/** YYYY-MM-DD ของเวลาไทย จาก epoch ms */
function bkkDateStr(ms) {
    return new Date(ms + BKK_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD -> epoch ms ที่สิ้นวันตามเวลาไทย (23:59:59) */
function dueDateToEpoch(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const utc = Date.UTC(y, mo - 1, d, 23, 59, 59);
    const back = new Date(utc);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return utc - BKK_OFFSET_MIN * 60000;
}

/**
 * บวกเดือนแบบที่คนคิด: 31 ม.ค. + 1 เดือน = 28/29 ก.พ. ไม่ใช่ 3 มี.ค.
 *
 * ถ้าปล่อยให้ Date เลื่อนเอง ห้องที่ครบกำหนดวันที่ 31 จะค่อย ๆ เลื่อนวันครบกำหนด
 * ไปเรื่อย ๆ ทุกเดือนที่มี 30 วัน ซึ่งลูกค้าจะทักมาก่อนที่เราจะรู้ตัว
 */
function addMonths(dateStr, months) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    const y = +m[1];
    const mo = +m[2] - 1;
    const d = +m[3];
    const target = new Date(Date.UTC(y, mo + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    const day = Math.min(d, lastDay);
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day))
        .toISOString().slice(0, 10);
}

/**
 * คิดวันครบกำหนดใหม่หลังรับชำระ
 *
 * กติกา: ต่อจาก "วันครบกำหนดเดิม" ไม่ใช่จากวันที่จ่าย — ลูกค้าที่จ่ายช้า 5 วัน
 * ต้องไม่ได้เดือนนั้นยาวขึ้น 5 วันฟรี ซึ่งเป็นสิ่งที่เกิดขึ้นถ้านับจากวันจ่าย
 *
 * ยกเว้นกรณีที่ค้างมานานจนเลยกำหนดเกินหนึ่งรอบเต็ม — การไล่บวกจากของเดิมจะได้
 * วันครบกำหนดที่ยังอยู่ในอดีต ทำให้จ่ายแล้วยังขึ้นว่าค้างอยู่ดี จึงเริ่มนับจาก
 * วันที่จ่ายแทน และคืน `resetFromPayment: true` เพื่อให้บันทึกไว้ว่าทำไมข้ามไป
 *
 * @param {object} o { currentDue: 'YYYY-MM-DD'|null, paidOn: 'YYYY-MM-DD', months: number }
 */
function nextDueDate(o) {
    const months = Math.max(1, Math.min(24, parseInt(o.months, 10) || 1));
    const paidOn = o.paidOn;
    if (!o.currentDue) {
        // ห้องที่ไม่เคยมีวันครบกำหนด — เริ่มนับจากวันที่จ่าย
        return { dueDate: addMonths(paidOn, months), months, resetFromPayment: true };
    }
    let next = addMonths(o.currentDue, months);
    if (next && paidOn && next < paidOn) {
        return { dueDate: addMonths(paidOn, months), months, resetFromPayment: true };
    }
    return { dueDate: next, months, resetFromPayment: false };
}

/**
 * ข้อความที่จะเขียนกลับลง comment ของเราท์เตอร์
 *
 * เก็บข้อความเดิมของพนักงานไว้เสมอ (ชื่อผู้เช่า เบอร์โทร ฯลฯ) แล้วแทนเฉพาะส่วนวันที่
 * การเขียนทับทั้งช่องจะทำให้ข้อมูลที่พนักงานจดไว้หายไป ซึ่งคนจะไม่ยอมใช้ระบบอีก
 */
const DUE_TAG = 'ครบกำหนด';

function buildComment(oldComment, dueDate) {
    const base = String(oldComment || '')
        // ลบส่วน "ครบกำหนด <วันที่>" เดิมออก ไม่ว่ารูปแบบไหน
        .replace(new RegExp(DUE_TAG + '\\s*[0-9]{1,4}[-/][0-9]{1,2}[-/][0-9]{1,4}', 'g'), '')
        // และลบวันที่ลอย ๆ ที่ไม่มีคำนำหน้า เพราะ parser เดิมอ่านมันเป็นวันครบกำหนด
        .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, '')
        .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return (base ? base + ' ' : '') + DUE_TAG + ' ' + dueDate;
}

/**
 * สรุปยอดของช่วงเวลาหนึ่ง
 *
 * @param {Array} rooms     [{username, rent, dueDate, active}]
 * @param {Array} payments  [{username, amount, paidOn}]
 * @param {string} monthStr 'YYYY-MM'
 */
function summariseRevenue(rooms, payments, monthStr, todayStr) {
    const inMonth = (payments || []).filter((p) => String(p.paidOn || '').startsWith(monthStr));
    const collected = inMonth.reduce((n, p) => n + (Number(p.amount) || 0), 0);

    const activeRooms = (rooms || []).filter((r) => r.active !== false);
    const expected = activeRooms.reduce((n, r) => n + (Number(r.rent) || 0), 0);

    // ค้างชำระ = ห้องที่วันครบกำหนดผ่านไปแล้ว หรือไม่เคยตั้งวันครบกำหนดไว้เลย
    // ข้อหลังสำคัญ: ปล่อยไว้เท่ากับห้องนั้นไม่เคยถูกตามเก็บและไม่มีใครรู้
    const overdue = activeRooms.filter((r) => !r.dueDate || r.dueDate < todayStr);
    const noDue = activeRooms.filter((r) => !r.dueDate);

    return {
        month: monthStr,
        collected,
        expected,
        paymentCount: inMonth.length,
        roomCount: activeRooms.length,
        overdueCount: overdue.length,
        overdueAmount: overdue.reduce((n, r) => n + (Number(r.rent) || 0), 0),
        noDueDateCount: noDue.length,
        overdue: overdue.map((r) => ({ username: r.username, rent: r.rent || 0,
                                       dueDate: r.dueDate || null,
                                       daysOverdue: r.dueDate ? daysBetween(r.dueDate, todayStr) : null }))
    };
}

function daysBetween(fromStr, toStr) {
    const a = dueDateToEpoch(fromStr);
    const b = dueDateToEpoch(toStr);
    if (a === null || b === null) return null;
    return Math.round((b - a) / 86400000);
}

module.exports = { addMonths, nextDueDate, buildComment, summariseRevenue,
                   dueDateToEpoch, bkkDateStr, daysBetween, DUE_TAG };
