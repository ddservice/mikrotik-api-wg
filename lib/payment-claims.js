/**
 * lib/payment-claims.js — การแจ้งชำระเงินด้วยสลิปผ่าน LINE
 *
 * กติกาข้อเดียวที่สำคัญที่สุด: **ห้ามอนุมัติอัตโนมัติ**
 * ------------------------------------------------------
 * รูปสลิปไม่ใช่หลักฐานการชำระเงิน มันเป็นรูปภาพ แก้ไขได้ ส่งซ้ำได้ ส่งสลิปเก่าได้
 * และจำนวนเงินในรูปกับจำนวนเงินที่เข้าบัญชีจริงไม่จำเป็นต้องตรงกัน
 * ระบบนี้จึงทำได้แค่ "รับเรื่องไว้ ไม่ให้ตกหล่น" แล้วให้คนที่เปิดดูยอดเงินในบัญชีจริง
 * เป็นคนกรอกจำนวนและกดอนุมัติ — เป็นเหตุผลเดียวกับที่ Multi-WAN วิเคราะห์ให้ได้
 * แต่ไม่ซ่อมให้เอง: การวินิจฉัยปลอดภัยที่จะทำอัตโนมัติ การลงมือทำไม่ใช่
 *
 * สิ่งที่ระบบรับผิดชอบคือ "ไม่ทำหาย" — สลิปที่ส่งเข้ามาตอนตีสองต้องยังอยู่ตอนเช้า
 * พร้อมบอกว่าใครส่ง ห้องไหน เมื่อไหร่ และยังไม่มีใครดู
 */

'use strict';

const STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' };

/**
 * ดึงข้อมูลที่ใช้ได้จาก event ของ LINE
 *
 * @param {object} event  event จาก webhook
 * @param {object} binding  ผลจาก getLineUserBinding (null ถ้ายังไม่ผูกบัญชี)
 * @returns {object|null} null เมื่อไม่ใช่ event ที่เกี่ยวข้อง
 */
function claimFromEvent(event, binding) {
    if (!event || event.type !== 'message') return null;
    const msg = event.message || {};
    if (msg.type !== 'image') return null;
    if (!msg.id) return null;

    return {
        messageId: String(msg.id),
        lineUserId: (event.source && event.source.userId) || null,
        sourceId: (event.source && (event.source.groupId || event.source.roomId || event.source.userId)) || null,
        // ยังไม่ผูกบัญชี = ไม่รู้ว่าห้องไหน แต่ **ต้องรับเรื่องไว้อยู่ดี**
        // ทิ้งไปเท่ากับลูกค้าจ่ายเงินแล้วไม่มีใครรู้ ซึ่งแย่กว่าการมีเรื่องค้างให้ตรวจ
        username: binding ? binding.username : null,
        siteId: binding ? binding.siteId : null,
        siteName: binding ? binding.siteName : null,
        status: STATUS.PENDING,
        receivedAt: new Date(event.timestamp || Date.now()).toISOString()
    };
}

/** ข้อความตอบกลับลูกค้าทันทีที่ได้รับสลิป */
function ackMessage(claim) {
    if (!claim.username) {
        return 'ได้รับสลิปแล้วครับ ✅\n\n' +
               'แต่ยังไม่ทราบว่าเป็นห้องไหน — กรุณาพิมพ์ ผูกบัญชี <ชื่อห้อง> ' +
               'เช่น ผูกบัญชี rm301 เพื่อให้แอดมินตรวจสอบได้เร็วขึ้นครับ\n\n' +
               'แอดมินจะตรวจสอบและยืนยันให้อีกครั้ง ยังไม่ได้ต่ออายุจนกว่าจะยืนยันนะครับ';
    }
    return 'ได้รับสลิปของห้อง ' + claim.username + ' แล้วครับ ✅\n\n' +
           'แอดมินจะตรวจสอบยอดเงินแล้วยืนยันให้อีกครั้ง\n' +
           '**ยังไม่ได้ต่ออายุจนกว่าจะยืนยัน** — ถ้าเร่งด่วนติดต่อแอดมินได้เลยครับ';
}

/** ข้อความแจ้งลูกค้าเมื่ออนุมัติแล้ว */
function approvedMessage(o) {
    return 'ยืนยันการชำระเงินเรียบร้อยครับ ✅\n\n' +
           'ห้อง: ' + o.username + '\n' +
           'จำนวน: ' + Number(o.amount).toLocaleString('th-TH') + ' บาท\n' +
           'ต่ออายุ: ' + o.months + ' เดือน\n' +
           'ครบกำหนดถัดไป: ' + o.dueDate + '\n\nขอบคุณครับ 🙏';
}

/** ข้อความแจ้งลูกค้าเมื่อไม่อนุมัติ — ต้องบอกเหตุผลเสมอ */
function rejectedMessage(reason) {
    return 'ยังยืนยันการชำระเงินไม่ได้ครับ ⚠️\n\n' +
           'เหตุผล: ' + (String(reason || '').trim() || 'ไม่ระบุ') + '\n\n' +
           'รบกวนตรวจสอบและติดต่อแอดมินอีกครั้งนะครับ';
}

/**
 * ตรวจความถูกต้องก่อนอนุมัติ
 *
 * @returns {{ok: boolean, error?: string}}
 */
function validateApproval(claim, input) {
    if (!claim) return { ok: false, error: 'ไม่พบรายการแจ้งชำระนี้' };
    if (claim.status !== STATUS.PENDING) {
        // ปุ่มถูกกดสองครั้ง หรือแอดมินสองคนกดพร้อมกัน — ต้องไม่บันทึกเงินซ้ำ
        return { ok: false, error: 'รายการนี้ถูก' +
                 (claim.status === STATUS.APPROVED ? 'อนุมัติ' : 'ปฏิเสธ') + 'ไปแล้ว' };
    }
    const username = (input.username || claim.username || '').trim();
    if (!username) return { ok: false, error: 'ต้องระบุว่าเป็นห้องไหน — รายการนี้ยังไม่ได้ผูกบัญชี' };

    const amount = Number(input.amount);
    if (!isFinite(amount) || amount <= 0) return { ok: false, error: 'จำนวนเงินต้องมากกว่า 0' };

    const months = parseInt(input.months, 10) || 1;
    if (months < 1 || months > 24) return { ok: false, error: 'จำนวนเดือนต้องอยู่ระหว่าง 1–24' };

    return { ok: true, username, amount, months };
}

/** จัดกลุ่มให้หน้าจอ — ค้างอยู่ก่อน แล้วเรียงเก่าสุดขึ้นก่อนเพราะรอมานานสุด */
function sortClaims(claims) {
    const rank = { pending: 0, approved: 1, rejected: 2 };
    return (claims || []).slice().sort((a, b) => {
        const d = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
        if (d !== 0) return d;
        return a.status === STATUS.PENDING
            ? String(a.receivedAt).localeCompare(String(b.receivedAt))
            : String(b.receivedAt).localeCompare(String(a.receivedAt));
    });
}

module.exports = { STATUS, claimFromEvent, ackMessage, approvedMessage,
                   rejectedMessage, validateApproval, sortClaims };
