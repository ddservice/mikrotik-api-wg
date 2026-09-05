/**
 * lib/multiwan-mangle.js — ปิด/คืนค่ากฎ mangle ที่ขวางการติดตั้ง failover
 *
 * ที่มา (2026-09-05): หน้า Multi-WAN อ่าน config มาแล้วบอกว่า "มีกฎ mangle mark-routing
 * อยู่ 6 rules ต้องปิดหรือลบก่อน" แล้วจบแค่นั้น ไม่มีปุ่มอะไรให้กดต่อ
 * คนใช้จึงรู้สึกว่า "กด Read มาเพื่อดูเฉย ๆ" ซึ่งถูกต้อง — มันเป็นทางตัน
 *
 * โมดูลนี้เติมขั้นที่หายไป โดยยึดกติกาเดียวกับส่วนอื่นของ Multi-WAN
 *
 *   ปิด ไม่ลบ        ลบแล้วคืนไม่ได้ ปิดแล้วคืนได้เสมอแม้ระบบนี้จะหายไป
 *   ติดป้ายทุกข้อ     ต่อท้าย comment ด้วย MARKER เพื่อให้ตอนคืนค่ารู้ว่าข้อไหนเรา
 *                    เป็นคนปิด จะได้ไม่ไปเปิดกฎที่ลูกค้าตั้งใจปิดไว้เองอยู่แล้ว
 *   คืนค่าให้ครบ      คืนทั้ง disabled และ comment เดิม ไม่ทิ้งป้ายไว้บนเราท์เตอร์
 *
 * ข้อควรรู้ที่ต้องบอกคนกด: การปิดกฎ PCC ทำให้ traffic ที่เคยถูกกระจายสองสาย
 * กลับไปออกสายเดียวทันที ความเร็วรวมจะลดลง ไม่ใช่แค่ "เตรียมพร้อม" เฉย ๆ
 */

'use strict';

const MARKER = '[DDS-OFF]';

/** กฎข้อนี้เราเป็นคนปิดไว้หรือเปล่า */
function isOurs(rule) {
    return String(rule.comment || '').includes(MARKER);
}

function isDisabled(rule) {
    return rule.disabled === 'true' || rule.disabled === true || rule.disabled === 'yes';
}

/**
 * คำสั่งสำหรับปิดกฎที่ขวางอยู่
 *
 * @param {Array} conflicts  กฎที่ analyze บอกว่าขวาง (เปิดใช้งานอยู่ทั้งหมด)
 * @returns {{steps: Array, count: number, notes: string[]}}
 */
function planDisable(conflicts) {
    const steps = [];
    const notes = [];
    let pcc = 0;

    (conflicts || []).forEach((m) => {
        if (isDisabled(m)) return;                 // ปิดอยู่แล้ว ไม่ต้องแตะ
        if (m['per-connection-classifier']) pcc += 1;
        const old = String(m.comment || '');
        steps.push({
            cmd: '/ip/firewall/mangle/set',
            args: {
                '.id': m['.id'],
                disabled: 'yes',
                // เก็บ comment เดิมไว้ในป้ายเลย จะได้คืนค่าได้แม้ฐานข้อมูลเราหาย
                comment: (old ? old + ' ' : '') + MARKER
            },
            id: m['.id'],
            was: old
        });
    });

    if (pcc > 0) {
        notes.push(`มีกฎ PCC ${pcc} ข้อในชุดนี้ — ปิดแล้ว traffic ที่เคยกระจายหลายสาย ` +
                   'จะกลับไปออกสายเดียว ความเร็วรวมจะลดลงทันที ไม่ใช่แค่การเตรียมพร้อม');
    }
    if (!steps.length) {
        notes.push('ไม่มีกฎที่ต้องปิด — ที่เห็นอาจถูกปิดไปแล้ว ลอง Read config ใหม่อีกครั้ง');
    }
    return { steps, count: steps.length, notes };
}

/**
 * คำสั่งสำหรับคืนค่ากฎที่เราปิดไว้ — แตะเฉพาะข้อที่มีป้ายของเรา
 *
 * @param {Array} allMangle  กฎ mangle ทั้งหมดบนเราท์เตอร์
 */
function planRestore(allMangle) {
    const steps = [];
    (allMangle || []).filter(isOurs).forEach((m) => {
        const restored = String(m.comment || '')
            .split(MARKER).join('')
            .replace(/\s+/g, ' ')
            .trim();
        steps.push({
            cmd: '/ip/firewall/mangle/set',
            args: { '.id': m['.id'], disabled: 'no', comment: restored },
            id: m['.id']
        });
    });
    return { steps, count: steps.length };
}

/** มีกฎที่เราปิดค้างไว้อยู่ไหม — ใช้ตัดสินว่าจะโชว์ปุ่มคืนค่าหรือไม่ */
function countOurs(allMangle) {
    return (allMangle || []).filter(isOurs).length;
}

module.exports = { MARKER, planDisable, planRestore, countOurs, isOurs };
